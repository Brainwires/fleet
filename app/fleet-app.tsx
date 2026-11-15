"use client";
// The page's state: the snapshot from the backend (refreshed on its `changed` event, and every few
// seconds while visible, which also tells the backend to poll GitHub at the visible rate), a 1 s
// clock for the ticking times (stopped while the window is hidden), the first-run wizard until
// Fleet is set up, the token screen when a set-up Fleet has no token, and the Settings view (the
// header's button, or the tray's Settings…). GitHub links from the main view open in the in-app
// GitHub browser (app/web-panel/) where this window hosts web views, else in the system browser.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "denext";
import { onDesktopEvent } from "denext/desktop/client";
import { closeWindow } from "denext/desktop/window";
import { onAppMenuItem, setAppMenu } from "denext/desktop/app";
import { openExternal } from "denext/mobile";
import { type FleetEvent, LOG_LIMIT, mergeEvents } from "../lib/events.ts";
import type { Snapshot } from "../lib/model.ts";
import { CHANGED_EVENT, errorText, fleet } from "./fleet-client.ts";
import { FleetView } from "./fleet-view.tsx";
import { type ControlRequest, DispatchPanel, type PoolRequest } from "./controls.tsx";
import type { ControlResult } from "../lib/control-runner.ts";
import { TokenScreen } from "./token-screen.tsx";
import { type MachineInfo, type SettingsApi, SettingsView, SetupWizard } from "./settings-view.tsx";
import type { FleetSettings } from "../lib/settings.ts";
import { visibleClock } from "./visible-clock.ts";
import { browserShortcut, windowShortcut } from "../lib/shortcuts.ts";
import { GitHubBrowser, isGitHubUrl } from "./web-panel/github-browser.ts";
import { GitHubPanel } from "./web-panel/github-panel.tsx";
import { connectBrowserMenu } from "./web-panel/browser-menu.ts";
import { type LogsApi, PoolDetailView } from "./pool-detail.tsx";
import type { PoolDetail } from "../lib/pool-detail.ts";
import type { HistoryRange } from "../lib/history.ts";

/** The detail screen's loaders (the backend's log methods). */
const LOGS: LogsApi = {
  runnerLogList: (pool) => fleet.runnerLogList({ pool }),
  poolLogLines: (pool) => fleet.poolLogLines({ pool }),
  runnerLog: (pool, file, opts) => fleet.runnerLog({ pool, file, ...opts }),
  runnerLogForJob: (jobId) => fleet.runnerLogForJob({ jobId }),
  jobLog: (repo, jobId) => fleet.jobLog({ repo, jobId }),
};

/** How often the page reads the (in-process) snapshot while visible. */
const READ_MS = 5000;

/** Open a github.com URL in the system browser (the screens the GitHub panel can't show over). */
function openInBrowser(url: string): void {
  if (!isGitHubUrl(url)) return;
  void openExternal(url).catch((err) => console.error("fleet: open:", errorText(err)));
}

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);

/** The view lost the keyboard: focus the panel when nothing of Fleet's took it, so keys reach us. */
function takeKeyboardBack(): void {
  if (typeof document === "undefined") return;
  const active = document.activeElement;
  if (active && active !== document.body) return;
  document.querySelector<HTMLElement>(".webpanel")?.focus();
}

/** Whether the window shows: visible, or focused (insurance for an engine slow to flip visibility). */
const visibleNow = () =>
  typeof document === "undefined" || document.visibilityState === "visible" ||
  document.hasFocus?.() === true;

/**
 * Whether a screen the GitHub panel doesn't show over replaces the dashboard / pool screens: the
 * loading screen, the wizard, the token screen, or Settings (FleetApp's render order).
 */
export function panelCovered(
  snap: Pick<Snapshot, "auth" | "setupComplete"> | null,
  screen: "main" | "settings" | "wizard",
  detailPool: string | null,
): boolean {
  if (!snap || snap.setupComplete === false || screen === "wizard") return true;
  if (snap.auth === "pending" || snap.auth === "needs-token" || snap.auth === "invalid") {
    return true;
  }
  return screen === "settings" && detailPool === null;
}

export function FleetApp() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [events, setEvents] = useState<FleetEvent[]>([]);
  const [pools, setPools] = useState<{ pools: boolean; restart?: boolean; watchdog?: boolean }>({
    pools: false,
  });
  /** The settings and machine facts while a settings screen is open (`null`: not loaded). */
  const [config, setConfig] = useState<{ settings: FleetSettings; machine: MachineInfo } | null>(
    null,
  );
  /** Which settings screen shows over the main view. */
  const [screen, setScreen] = useState<"main" | "settings" | "wizard">("main");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [repos, setRepos] = useState<string[]>([]);
  const busy = useRef(false);
  /** The pool detail screen (`null`: the dashboard), its range and its data. */
  const [detailPool, setDetailPool] = useState<string | null>(null);
  const [range, setRange] = useState<HistoryRange>("24h");
  const [detail, setDetail] = useState<PoolDetail | null>(null);
  const [detailError, setDetailError] = useState("");
  /** The in-app GitHub browser (one web view for the page's life) and what its panel shows. */
  const [browser] = useState(() =>
    new GitHubBrowser({ openExternal, onViewBlur: takeKeyboardBack })
  );
  const [web, setWeb] = useState(browser.state);
  useEffect(() => {
    const stop = browser.subscribe(setWeb);
    const stopMenu = connectBrowserMenu(browser, { setAppMenu, onAppMenuItem }, isMac());
    return () => {
      stop();
      stopMenu();
      browser.dispose();
    };
  }, [browser]);
  /** A GitHub link from the main view: the panel, or the system browser without web views. */
  const openUrl = useCallback((url: string) => void browser.open(url), [browser]);

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
    void fleet.capabilities().then(setPools).catch(() => {});
  }, []);

  // The detail screen's data: on open, on a range change, and with every snapshot change.
  const wanted = useRef<{ pool: string | null; range: HistoryRange }>({ pool: null, range });
  wanted.current = { pool: detailPool, range };
  const loadDetail = useCallback(async (pool: string, r: HistoryRange) => {
    try {
      const d = await fleet.poolDetail({ pool, range: r });
      // A late answer for another pool or range (the user moved on) is dropped.
      if (wanted.current.pool !== pool || wanted.current.range !== r) return;
      setDetail(d);
      setDetailError("");
    } catch (err) {
      setDetailError(errorText(err));
    }
  }, []);
  useEffect(() => {
    if (detailPool === null) return;
    setDetail((d) => (d && d.pool === detailPool && d.range === range ? d : null));
    void loadDetail(detailPool, range);
  }, [detailPool, range, snap?.at, loadDetail]);

  const loadConfig = useCallback(async () => {
    try {
      setConfig(await fleet.settings());
    } catch (err) {
      setError(errorText(err));
    }
  }, []);

  // The wizard (not set up yet) and the Settings view read the settings when they open.
  const needsSetup = snap?.setupComplete === false;
  useEffect(() => {
    if (needsSetup || screen !== "main") void loadConfig();
  }, [needsSetup, screen, loadConfig]);

  // The tray's Settings…: show the view, then tell the backend it was shown.
  useEffect(() => {
    if (!snap?.settingsRequested) return;
    if (!needsSetup) setScreen("settings");
    void fleet.settingsShown().catch(() => {});
  }, [snap?.settingsRequested, needsSetup]);

  // Cmd+W and Cmd+Q close the window (macOS): an accessory app has no menu bar to own them, and a
  // quit Fleet didn't ask for closes to the tray anyway (lib/quit-guard.ts). While the GitHub panel
  // shows, Cmd+[ / Cmd+] (Ctrl off macOS) go back / forward and Esc returns to Fleet's view: these
  // reach the page only while the keyboard is in Fleet's HTML (the app menu carries back / forward
  // while the web view has it: app/web-panel/browser-menu.ts).
  useEffect(() => {
    const mac = /Mac/.test(navigator.userAgent);
    const onKey = (e: KeyboardEvent) => {
      const nav = browser.showing ? browserShortcut(e, mac) : null;
      if (nav) {
        e.preventDefault();
        browser.command(nav, "page");
        return;
      }
      const shortcut = windowShortcut(e, mac);
      if (!shortcut) return;
      e.preventDefault();
      void closeWindow().catch((err) => console.error("fleet: shortcut:", errorText(err)));
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [browser]);

  // The native web view draws above all HTML: hidden while a screen the panel doesn't show over
  // (loading, the wizard, the token screen, Settings) replaces the dashboard / pool screens.
  const covered = panelCovered(snap, screen, detailPool);
  useEffect(() => browser.setCovered(covered), [browser, covered]);

  useEffect(() => {
    void read();
    const poll = setInterval(() => {
      if (visibleNow()) void read();
    }, READ_MS);
    // The 1 s clock runs only while the window shows: hidden, nothing ticks (or re-renders).
    const clock = visibleClock(setNow, { visible: visibleNow });
    const onVis = () => {
      const visible = visibleNow();
      clock.update();
      void fleet.visibility({ visible }).catch(() => {});
      if (visible) void read();
    };
    document.addEventListener("visibilitychange", onVis);
    // Insurance: the window coming to the front, or a page restored from the back-forward cache,
    // reads the current state too (a read is an in-process call).
    const onShow = () => {
      if (visibleNow()) onVis();
    };
    globalThis.addEventListener?.("focus", onShow);
    globalThis.addEventListener?.("pageshow", onShow);
    const stop = onDesktopEvent("fleet", CHANGED_EVENT, () => void read());
    return () => {
      clearInterval(poll);
      clock.stop();
      document.removeEventListener("visibilitychange", onVis);
      globalThis.removeEventListener?.("focus", onShow);
      globalThis.removeEventListener?.("pageshow", onShow);
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
  const signIn = {
    submit: async (token: string) => {
      const r = await fleet.setToken({ token });
      await read();
      return r;
    },
    retryGh: async () => {
      const ok = await fleet.retryGh();
      await read();
      return ok;
    },
    usePublic: async () => {
      await fleet.usePublic();
      await read();
    },
  };
  const settingsApi: SettingsApi = {
    save: async (settings) => {
      const r = await fleet.saveSettings({ settings });
      if (r.ok) setConfig((c) => (c ? { ...c, settings: r.settings } : c));
      await read();
      return r;
    },
    tokenInfo: () => fleet.tokenInfo(),
    ownerRepos: (owner, kind) => fleet.ownerRepos({ owner, kind }),
    onOpen: openInBrowser,
  };
  if (needsSetup || screen === "wizard") {
    if (!config) return <div class="loading" aria-busy="true">Loading the settings…</div>;
    return (
      <SetupWizard
        settings={config.settings}
        machine={config.machine}
        auth={snap.auth}
        api={settingsApi}
        signIn={signIn}
        onDone={() => setScreen("main")}
      />
    );
  }
  if (snap.auth === "needs-token" || snap.auth === "invalid") {
    return <TokenScreen auth={snap.auth} {...signIn} onOpen={openInBrowser} />;
  }
  // The GitHub panel shows over the dashboard and the pool screens (their links open in it), which
  // stay mounted underneath with their state.
  const withPanel = (content: ReactNode) => (
    <>
      {web.open ? <GitHubPanel browser={browser} state={web} mac={isMac()} /> : null}
      <div class="main-host" hidden={web.open}>{content}</div>
    </>
  );
  if (detailPool !== null) {
    return withPanel(
      <PoolDetailView
        key={detailPool}
        pool={detailPool}
        detail={detail && detail.pool === detailPool ? detail : null}
        range={range}
        onRange={setRange}
        onBack={() => {
          setDetailPool(null);
          setDetail(null);
        }}
        onOpen={openUrl}
        now={now + (snap.clockOffsetMs ?? 0)}
        error={detailError}
        logs={LOGS}
        controls={pools.pools
          ? {
            onControl: (c: ControlRequest) => void act(() => fleet.control(c)),
            onPool: (c: PoolRequest) => void act(() => fleet.poolControl(c)),
            message,
          }
          : { onControl: (c: ControlRequest) => void act(() => fleet.control(c)), message }}
      />,
    );
  }
  if (screen === "settings") {
    if (!config) return <div class="loading" aria-busy="true">Loading the settings…</div>;
    return (
      <SettingsView
        settings={config.settings}
        machine={config.machine}
        auth={snap.auth}
        api={settingsApi}
        signIn={signIn}
        onClose={() => setScreen("main")}
        onRerun={() => setScreen("wizard")}
      />
    );
  }
  const main = (
    <FleetView
      snapshot={snap}
      now={now}
      onOpen={openUrl}
      refreshing={refreshing}
      events={events}
      onSettings={() => setScreen("settings")}
      onPoolDetail={(pool) => setDetailPool(pool)}
      controls={{
        onControl: (c: ControlRequest) => void act(() => fleet.control(c)),
        ...(pools.pools
          ? {
            onPool: (c: PoolRequest) => void act(() => fleet.poolControl(c)),
            scheduler: { restart: pools.restart !== false, watchdog: pools.watchdog !== false },
          }
          : {}),
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
  return withPanel(main);
}
