// The machines integration's machine side (lib/machines.ts has the model): the read token from its
// file, the live stream (one long HTTP response, reconnected with `since` so nothing is lost), a
// machine's history, and `machines.json` for agents. The token is read each time it is needed and
// never kept in the settings, a log, the snapshot or the agents' file.

import {
  isMachineRange,
  type MachineSeries,
  MachinesState,
  type MachinesView,
  parseSeries,
  sseFrames,
  TRAIL_MS,
} from "./machines.ts";
import { expandHome, type MachinesIntegration } from "./settings.ts";

/** What the stream needs from the machine. */
export interface MachinesDeps {
  /** The integration, as the settings have it now (`null`: off). */
  integration(): MachinesIntegration | null;
  home(): string | null;
  /** The token file's text, or `null` when it can't be read. */
  readFile(path: string): Promise<string | null>;
  fetch: typeof fetch;
  now(): number;
  /** The view changed (the page is told; the agents' file is rewritten). */
  onChange(view: MachinesView): void;
  /** A pause that ends early when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

/** The running stream. */
export interface MachinesStream {
  view(): MachinesView;
  history(host: string, range: unknown): Promise<MachineSeries | { error: string }>;
  stop(): void;
}

const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

/** The service's token from its file, or why not (never the token in a message). */
export async function readToken(
  d: Pick<MachinesDeps, "home" | "readFile">,
  i: MachinesIntegration,
): Promise<{ token: string } | { error: string }> {
  const path = expandHome(i.tokenFile, d.home());
  if (!path) return { error: "The machines service's token file has no usable path." };
  const text = await d.readFile(path);
  if (text === null) {
    return {
      error:
        "The machines service's token file can't be read (is the service set up on this machine?).",
    };
  }
  const token = text.trim();
  return TOKEN.test(token)
    ? { token }
    : { error: "The machines service's token file doesn't hold a token." };
}

/** A failed request, in plain words. */
function failure(status: number): string {
  if (status === 401 || status === 403) return "The machines service refused Fleet's token.";
  if (status === 429) return "The machines service has too many live streams open.";
  return `The machines service answered ${status}.`;
}

/** Start the stream: it runs until `stop()`, reconnecting by itself. */
export function startMachinesStream(d: MachinesDeps): MachinesStream {
  const state = new MachinesState();
  const stop = new AbortController();
  let lastEmit = 0;
  const emit = (force = false) => {
    // The page redraws at most once a second (frames arrive in bursts of one per machine).
    const now = d.now();
    if (!force && now - lastEmit < 1000) return;
    lastEmit = now;
    d.onChange(state.view(d.integration() !== null));
  };
  const fail = (why: string) => {
    const changed = state.connected || state.error !== why;
    state.connected = false;
    state.error = why;
    if (changed) emit(true);
  };

  const once = async (i: MachinesIntegration): Promise<void> => {
    const t = await readToken(d, i);
    if ("error" in t) return fail(t.error);
    // What a reconnect missed; on the first connection the last minutes, so the sparklines start drawn.
    const since = state.newest() || d.now() - TRAIL_MS;
    const ac = new AbortController();
    const onStop = () => ac.abort();
    stop.signal.addEventListener("abort", onStop, { once: true });
    // A stream that says nothing for 45 s is dead (the service sends the machines every 10 s).
    let idle = setTimeout(() => ac.abort(), 45_000);
    try {
      const res = await d.fetch(`${i.url}/api/telemetry/stream${since ? `?since=${since}` : ""}`, {
        headers: { authorization: `Bearer ${t.token}`, accept: "text/event-stream" },
        signal: ac.signal,
        redirect: "error",
      });
      if (!res.ok || !res.body) {
        await res.body?.cancel().catch(() => {});
        return fail(failure(res.status));
      }
      state.connected = true;
      state.error = "";
      let buf = "";
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        clearTimeout(idle);
        idle = setTimeout(() => ac.abort(), 45_000);
        const { frames, rest } = sseFrames(buf + value);
        buf = rest;
        let changed = false;
        for (const f of frames) changed = state.apply(f, d.now()) || changed;
        if (changed) emit();
      }
      fail("The machines service closed the stream; reconnecting.");
    } catch (err) {
      if (stop.signal.aborted) return;
      const name = err instanceof Error ? err.name : "";
      fail(
        name === "AbortError"
          ? "The machines service went quiet; reconnecting."
          : name === "NotCapable" || name === "PermissionDenied"
          ? "This build of Fleet may not connect to the machines service (an internal build bakes its address)."
          : "The machines service can't be reached (is it running?).",
      );
    } finally {
      clearTimeout(idle);
      stop.signal.removeEventListener("abort", onStop);
    }
  };

  void (async () => {
    let backoff = 2_000;
    while (!stop.signal.aborted) {
      const i = d.integration();
      if (!i) {
        if (state.connected || state.error) {
          state.connected = false;
          state.error = "";
          emit(true);
        }
        await d.sleep(5_000, stop.signal);
        continue;
      }
      const began = d.now();
      await once(i);
      if (stop.signal.aborted) return;
      backoff = d.now() - began > 60_000 ? 2_000 : Math.min(backoff * 2, 30_000);
      await d.sleep(backoff, stop.signal);
    }
  })();

  return {
    view: () => state.view(d.integration() !== null),
    async history(host, range) {
      const i = d.integration();
      if (!i) return { error: "The machines integration isn't set up." };
      if (typeof host !== "string" || !/^[\w.+-]{1,100}$/.test(host) || !isMachineRange(range)) {
        return { error: "No such machine or range." };
      }
      const t = await readToken(d, i);
      if ("error" in t) return { error: t.error };
      try {
        const res = await d.fetch(
          `${i.url}/api/telemetry/history?host=${encodeURIComponent(host)}&range=${range}`,
          {
            headers: { authorization: `Bearer ${t.token}` },
            signal: AbortSignal.timeout(20_000),
            redirect: "error",
          },
        );
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return { error: failure(res.status) };
        }
        return parseSeries(await res.json()) ??
          { error: "The machines service's history wasn't understood." };
      } catch {
        return { error: "The machines service can't be reached (is it running?)." };
      }
    },
    stop: () => stop.abort(),
  };
}
