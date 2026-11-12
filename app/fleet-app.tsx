"use client";
// The page's state: the snapshot from the backend (refreshed on its `changed` event, and every few
// seconds while visible, which also tells the backend to poll GitHub at the visible rate), a 1 s
// clock for the ticking times, and the token screen when Fleet has no token.

import { useCallback, useEffect, useRef, useState } from "denext";
import { onDesktopEvent } from "denext/desktop/client";
import { openExternal } from "denext/mobile";
import { type FleetEvent, LOG_LIMIT, mergeEvents } from "../lib/events.ts";
import type { Snapshot } from "../lib/model.ts";
import { CHANGED_EVENT, errorText, fleet } from "./fleet-client.ts";
import { FleetView } from "./fleet-view.tsx";
import { type ControlRequest, DispatchPanel, type PoolRequest } from "./controls.tsx";
import type { ControlResult } from "../lib/control-runner.ts";
import { TokenScreen } from "./token-screen.tsx";

/** How often the page reads the (in-process) snapshot while visible. */
const READ_MS = 5000;

/** Open a github.com URL in the system browser. */
function openUrl(url: string): void {
  if (!url.startsWith("https://github.com/")) return;
  void openExternal(url).catch((err) => console.error("fleet: open:", errorText(err)));
}

const visibleNow = () => typeof document === "undefined" || document.visibilityState === "visible";

export function FleetApp() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<FleetEvent[]>([]);
  const [pools, setPools] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const busy = useRef(false);

  /** Run a control: the backend checks it and asks in a system dialog; show its outcome. */
  const act = useCallback(async (call: () => Promise<ControlResult>) => {
    if (busy.current) return;
    busy.current = true;
    try {
      const r = await call();
      // A dialog the user dismissed is no news.
      if (!(r.ok === false && r.cancelled)) setMessage({ ok: r.ok, text: r.message });
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) });
    } finally {
      busy.current = false;
    }
  }, []);
  const lastSeq = useRef(0);
  const fetching = useRef(false);

  /** New events since the last one held (all of them after a restart of the backend's log). */
  const pullEvents = useCallback(async () => {
    if (fetching.current) return;
    fetching.current = true;
    try {
      const r = await fleet.events({ after: lastSeq.current });
      const reset = r.lastSeq < lastSeq.current ||
        (r.events.length > 0 && r.events[0].seq <= lastSeq.current);
      lastSeq.current = r.lastSeq;
      // By time: back-filled lines (from while Fleet was closed) land at their real times.
      setEvents((prev) => mergeEvents(reset ? [] : prev, r.events).slice(-LOG_LIMIT));
    } catch {
      // The next snapshot tries again.
    } finally {
      fetching.current = false;
    }
  }, []);

  const read = useCallback(async () => {
    try {
      const s = await fleet.snapshot({ visible: visibleNow() });
      setSnap(s);
      setError("");
      if (s.eventSeq !== lastSeq.current) void pullEvents();
    } catch (err) {
      setError(errorText(err));
    }
  }, [pullEvents]);

  useEffect(() => {
    void fleet.capabilities().then((c) => setPools(c.pools)).catch(() => {});
  }, []);

  useEffect(() => {
    void read();
    const poll = setInterval(() => {
      if (visibleNow()) void read();
    }, READ_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVis = () => {
      const visible = visibleNow();
      void fleet.visibility({ visible }).catch(() => {});
      if (visible) void read();
    };
    document.addEventListener("visibilitychange", onVis);
    const stop = onDesktopEvent("fleet", CHANGED_EVENT, () => void read());
    return () => {
      clearInterval(poll);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVis);
      stop();
    };
  }, [read]);

  if (error && !snap) {
    return (
      <div class="signin">
        <div class="signin-card">
          <h1 class="signin-title">Fleet</h1>
          <p class="signin-lead">{error}</p>
        </div>
      </div>
    );
  }
  if (!snap || snap.auth === "pending") {
    return <div class="loading" aria-busy="true">Looking for a GitHub token…</div>;
  }
  if (snap.auth === "needs-token" || snap.auth === "invalid") {
    return (
      <TokenScreen
        auth={snap.auth}
        submit={async (token) => {
          const r = await fleet.setToken({ token });
          await read();
          return r;
        }}
        retryGh={async () => {
          const ok = await fleet.retryGh();
          await read();
          return ok;
        }}
        usePublic={async () => {
          await fleet.usePublic();
          await read();
        }}
        onOpen={openUrl}
      />
    );
  }
  return (
    <FleetView
      snapshot={snap}
      now={now}
      onOpen={openUrl}
      refreshing={refreshing}
      events={events}
      controls={{
        onControl: (c: ControlRequest) => void act(() => fleet.control(c)),
        ...(pools ? { onPool: (c: PoolRequest) => void act(() => fleet.poolControl(c)) } : {}),
        onDispatch: () => {
          setDispatching(true);
          void fleet.repos().then(setRepos).catch(() => {});
        },
        message,
      }}
      dispatchPanel={dispatching
        ? (
          <DispatchPanel
            api={{
              repos,
              workflows: (r) => fleet.workflows({ repo: r }),
              submit: (c) => void act(() => fleet.control(c)),
              close: () => setDispatching(false),
            }}
          />
        )
        : null}
      onRefresh={async () => {
        setRefreshing(true);
        try {
          setSnap(await fleet.refresh());
        } catch (err) {
          setError(errorText(err));
        } finally {
          setRefreshing(false);
        }
      }}
    />
  );
}
