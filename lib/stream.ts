// The loopback event stream: Fleet's events pushed to agents and monitors as they happen, instead
// of each one polling. `GET /events` is Server-Sent Events, `GET /events/ws` a WebSocket; both send
// one message per event (the journal's events, as fleet_events returns them), webhook state changes,
// and a compact `status` heartbeat every N seconds so a quiet stream still shows liveness. The wire
// messages and their line form are lib/stream-format.ts.
//
// Query: `kinds=` (event kinds, `hooks`, and `problems` = warn / bad events and stale webhooks),
// `repo=` (`owner/name` or `name`), `pool=`, `branch=`, `since_seq=` (replay from the journal so a
// reconnect misses nothing; SSE's `Last-Event-ID` does the same), `format=line` (one human-readable
// line per message) or JSON (the default).
//
// Guards: the per-install token (`Authorization: Bearer`, or `?token=`), compared in constant time;
// the Host and Origin headers must name a loopback host (a DNS-rebinding page names its own); at
// most `maxClients` clients; a client that doesn't keep up loses messages (never blocks the others)
// and is told how many, with the `seq` range to replay. Bound to 127.0.0.1 by lib/deno-stream.ts.
//
// Pure apart from the Web APIs: the events, the replay and the status come in as functions, so the
// tests drive it with a fake clock and no app.

import { type FleetEvent, isProblem } from "./events.ts";
import type { Snapshot } from "./model.ts";
import { eventOut, repoMatches } from "../mcp/queries.ts";
import {
  formatLine,
  type WireDropped,
  type WireEvent,
  type WireHooks,
  type WireMessage,
  type WireStatus,
} from "./stream-format.ts";

/** Event kinds a `kinds=` filter takes, besides `problems`. */
export const STREAM_KINDS: readonly string[] = [
  "queued",
  "started",
  "finished",
  "stalled",
  "queued-long",
  "run-completed",
  "run-cancelled",
  "pool-health",
  "alert",
  "action",
  "hooks",
];

/** A client's SSE queue (messages) past which new messages are dropped. */
export const SSE_MAX_QUEUE = 256;
/** A WebSocket's unsent bytes past which new messages are dropped. */
export const WS_MAX_BUFFERED = 1024 * 1024;
/** A replay sends at most this many events; past it the client is told to page on. */
export const MAX_REPLAY = 5000;

/** A client's filters. */
export interface StreamFilter {
  /** Kinds asked for (`null`: every kind). */
  readonly kinds: ReadonlySet<string> | null;
  /** `problems` was asked for. */
  readonly problems: boolean;
  readonly repo: string | null;
  readonly pool: string | null;
  readonly branch: string | null;
}

/** What a request asks for. */
export interface StreamRequest {
  readonly filter: StreamFilter;
  readonly sinceSeq: number | null;
  readonly format: "json" | "line";
}

const short = (v: string | null, max = 200) => (v !== null && v.length <= max ? v : null);

/** The query (and SSE's `Last-Event-ID`), or what's wrong with it. */
export function parseStreamRequest(url: URL, lastEventId: string | null): StreamRequest | string {
  const q = url.searchParams;
  let kinds: Set<string> | null = null;
  let problems = false;
  const rawKinds = q.get("kinds");
  if (rawKinds !== null && rawKinds.trim() !== "") {
    kinds = new Set();
    for (const k of rawKinds.split(",").map((s) => s.trim()).filter(Boolean)) {
      if (k === "problems") problems = true;
      else if (STREAM_KINDS.includes(k)) kinds.add(k);
      else return `unknown kind ${JSON.stringify(k.slice(0, 40))}`;
    }
    if (kinds.size === 0) kinds = problems ? new Set() : null;
  }
  for (const k of ["repo", "pool", "branch"]) {
    const v = q.get(k);
    if (v !== null && short(v) === null) return `${k} is too long`;
  }
  const since = q.get("since_seq") ?? lastEventId;
  let sinceSeq: number | null = null;
  if (since !== null && since !== "") {
    if (!/^\d{1,15}$/.test(since)) return "since_seq must be a whole number";
    sinceSeq = Number(since);
  }
  const format = q.get("format") ?? "json";
  if (format !== "json" && format !== "line") return "format must be json or line";
  return {
    filter: {
      kinds,
      problems,
      repo: q.get("repo") || null,
      pool: q.get("pool") || null,
      branch: q.get("branch") || null,
    },
    sinceSeq,
    format,
  };
}

/**
 * An event's pool: its own field (job lines), a pool line's `pool <id>`, else the pool its text
 * names (`started on <pool>`, `queued for <pool>`, `… min on <pool>`, `no runner (<pool>`).
 */
export function eventPool(e: Pick<FleetEvent, "pool" | "workflow" | "text">): string | null {
  if (e.pool) return e.pool;
  const w = /^pool (\S+)$/.exec(e.workflow);
  if (w) return w[1];
  const t = /(?:started on|queued for|min on) (\S+)|no runner \((\S+?)[),\s]/.exec(e.text);
  const p = t?.[1] ?? t?.[2] ?? null;
  return p === "GitHub-hosted" ? "github" : p;
}

/** Whether a message passes a client's filters (status / hello / dropped / gap always do). */
export function matches(f: StreamFilter, m: WireMessage): boolean {
  if (m.type !== "event" && m.type !== "hooks") return true;
  if (m.type === "hooks") {
    if (f.repo || f.pool || f.branch) return false;
    if (!f.kinds) return true;
    return f.kinds.has("hooks") || (f.problems && m.sev === "warn");
  }
  if (f.repo && !repoMatches(f.repo, m.repo)) return false;
  if (f.branch && m.branch !== f.branch) return false;
  if (f.pool && (m.pool ?? null)?.toLowerCase() !== f.pool.toLowerCase()) return false;
  if (!f.kinds) return true;
  return f.kinds.has(m.kind) || (f.problems && isProblem({ sev: m.sev as FleetEvent["sev"] }));
}

/**
 * An event as the stream sends it: fleet_events's form (capped, control characters stripped; a
 * fork / pull_request_target run's text never carries its failed step or annotation), plus the pool.
 */
export function wireEvent(e: FleetEvent): WireEvent {
  const out = eventOut(e);
  const pool = eventPool(e);
  return { type: "event", ...out, ...(pool ? { pool } : {}) } as WireEvent;
}

/** The heartbeat from the backend's snapshot. */
export function statusMessage(snap: Snapshot, lastSeq: number, now: number): WireStatus {
  return {
    type: "status",
    at: new Date(now).toISOString(),
    running: snap.summary.running,
    queued: snap.summary.queued,
    severity: snap.summary.severity,
    reasons: snap.summary.reasons.slice(0, 10).map((r) => String(r).slice(0, 200)),
    pools: snap.pools.map((p) => ({
      id: p.id,
      state: p.state,
      busy: p.busy,
      slots: p.slots,
      queued: p.queued,
    })),
    hooks: snap.hooks?.state ?? "off",
    auth: snap.auth,
    poll_ok: snap.poll.ok,
    last_seq: lastSeq,
  };
}

/** A webhook state change, as the stream sends it. */
export function hooksMessage(state: string, previous: string, now: number): WireHooks {
  return {
    type: "hooks",
    at: new Date(now).toISOString(),
    sev: state === "live" ? "ok" : state === "stale" ? "warn" : "muted",
    state,
    previous,
  };
}

/**
 * The events after `since` for a replay: from the in-memory log when it still holds `since + 1`,
 * else from the journal (both files), oldest first.
 */
export async function replayFrom(
  log: { events: readonly FleetEvent[]; lastSeq: number },
  since: number,
  journal: () => Promise<readonly FleetEvent[]>,
): Promise<FleetEvent[]> {
  if (since >= log.lastSeq) return [];
  const held = log.events.filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
  if (held.length > 0 && held[0].seq <= since + 1) return held;
  return (await journal()).filter((e) => e.seq > since).sort((a, b) => a.seq - b.seq);
}

/** Where a client's frames go (an SSE body, a WebSocket, a test's array). */
export interface StreamSink {
  /** Room for one more message now (a lagging client has none). */
  canSend(): boolean;
  write(frame: string): void;
  close(): void;
}

/** What the stream needs from the app. */
export interface StreamDeps {
  /** The token every request must carry. */
  readonly token: string;
  /** Events after `since`, oldest first (the in-memory log, else the journal). */
  readonly replay: (since: number) => Promise<readonly FleetEvent[]>;
  /** The log's last `seq`. */
  readonly lastSeq: () => number;
  /** The heartbeat's content. */
  readonly status: () => WireStatus;
  readonly heartbeatMs: number;
  readonly maxClients: number;
  readonly now?: () => number;
  /** SSE queue length (messages) before dropping. */
  readonly maxQueue?: number;
  /** WebSocket unsent bytes before dropping. */
  readonly wsMaxBuffered?: number;
  readonly maxReplay?: number;
}

/** One frame of a message: an SSE record, or a WebSocket message's text. */
export function frame(m: WireMessage, format: "json" | "line", sse: boolean): string {
  const payload = format === "line" ? formatLine(m) : JSON.stringify(m);
  if (!sse) return payload;
  const id = m.type === "event" ? `id: ${m.seq}\n` : "";
  return `${id}event: ${m.type}\ndata: ${payload}\n\n`;
}

interface Client {
  readonly req: StreamRequest;
  readonly sink: StreamSink;
  readonly sse: boolean;
  /** Replay done: live messages go straight out (before, they wait in `pending`). */
  ready: boolean;
  pending: WireMessage[];
  /** The last event `seq` sent (live messages at or below it are a replay's duplicates). */
  sentSeq: number;
  dropped: { count: number; first: number | null; last: number | null } | null;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** A Host header's host name (port and case aside). */
function hostName(host: string): string {
  const h = host.trim().toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.replace(/:\d+$/, "");
}

/** Constant-time string equality (length aside). */
function sameToken(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const text = (status: number, body: string, headers: Record<string, string> = {}) =>
  new Response(body + "\n", {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });

/**
 * Why a request is refused (a Response), or `null`: a non-loopback Host or Origin (403), a missing
 * or wrong token (401).
 */
export function refuse(req: Request, token: string): Response | null {
  const host = req.headers.get("host");
  if (!host || !LOOPBACK.has(hostName(host))) return text(403, "forbidden: host");
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let ok = false;
    try {
      const u = new URL(origin);
      ok = (u.protocol === "http:" || u.protocol === "https:") && LOOPBACK.has(u.hostname);
    } catch {
      ok = false;
    }
    if (!ok) return text(403, "forbidden: origin");
  }
  const auth = req.headers.get("authorization");
  const given = auth?.startsWith("Bearer ")
    ? auth.slice(7).trim()
    : new URL(req.url).searchParams.get("token");
  if (!given || !sameToken(given, token)) {
    return text(401, "unauthorized", { "www-authenticate": 'Bearer realm="fleet"' });
  }
  return null;
}

/** The stream: an HTTP handler, and the app's side (publish, heartbeat, stop). */
export function createStream(deps: StreamDeps) {
  const now = deps.now ?? Date.now;
  const maxQueue = deps.maxQueue ?? SSE_MAX_QUEUE;
  const wsMax = deps.wsMaxBuffered ?? WS_MAX_BUFFERED;
  const maxReplay = deps.maxReplay ?? MAX_REPLAY;
  const clients = new Set<Client>();
  let beat: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  const enc = new TextEncoder();

  const drop = (c: Client, m: WireMessage) => {
    const d = c.dropped ?? { count: 0, first: null, last: null };
    d.count++;
    if (m.type === "event") {
      d.first ??= m.seq;
      d.last = m.seq;
    }
    c.dropped = d;
  };

  const write = (c: Client, m: WireMessage) => {
    try {
      c.sink.write(frame(m, c.req.format, c.sse));
    } catch {
      remove(c);
    }
  };

  /** Send now, or drop when the client lags (it hears how many once it has room again). */
  const push = (c: Client, m: WireMessage) => {
    if (m.type === "event" && m.seq <= c.sentSeq) return;
    if (!c.sink.canSend()) return drop(c, m);
    if (c.dropped) {
      const d: WireDropped = {
        type: "dropped",
        count: c.dropped.count,
        first_seq: c.dropped.first,
        last_seq: c.dropped.last,
      };
      c.dropped = null;
      write(c, d);
    }
    write(c, m);
    if (m.type === "event") c.sentSeq = m.seq;
  };

  const deliver = (c: Client, m: WireMessage) => {
    if (!matches(c.req.filter, m)) return;
    if (c.ready) return push(c, m);
    if (c.pending.length >= maxQueue) return drop(c, m);
    c.pending.push(m);
  };

  const heartbeat = () => {
    if (clients.size === 0) return;
    let m: WireStatus;
    try {
      m = deps.status();
    } catch {
      return;
    }
    for (const c of [...clients]) deliver(c, m);
  };

  const ensureBeat = () => {
    if (beat === null && clients.size > 0 && !stopped) {
      beat = setInterval(heartbeat, deps.heartbeatMs);
    }
  };

  function remove(c: Client): void {
    if (!clients.delete(c)) return;
    try {
      c.sink.close();
    } catch {
      // Already closed.
    }
    if (clients.size === 0 && beat !== null) {
      clearInterval(beat);
      beat = null;
    }
  }

  /**
   * Attach a client: hello and a status at once, then the replay (when `sinceSeq` is set), then
   * live messages. Live messages that arrive during the replay wait and are de-duplicated by `seq`.
   * `null` when the stream is full or stopped.
   */
  function connect(sink: StreamSink, req: StreamRequest, sse: boolean): Client | null {
    if (stopped || clients.size >= deps.maxClients) return null;
    const c: Client = {
      req,
      sink,
      sse,
      ready: false,
      pending: [],
      sentSeq: req.sinceSeq ?? deps.lastSeq(),
      dropped: null,
    };
    clients.add(c);
    ensureBeat();
    write(c, {
      type: "hello",
      v: 1,
      last_seq: deps.lastSeq(),
      heartbeat_s: Math.round(deps.heartbeatMs / 1000),
    });
    try {
      write(c, deps.status());
    } catch {
      // No status yet: the first heartbeat brings one.
    }
    void (async () => {
      if (req.sinceSeq !== null) {
        let events: readonly FleetEvent[] = [];
        try {
          events = await deps.replay(req.sinceSeq);
        } catch {
          events = [];
        }
        const first = events[0]?.seq;
        if (first !== undefined && req.sinceSeq + 1 < first) {
          write(c, { type: "gap", from_seq: req.sinceSeq + 1, to_seq: first - 1 });
        }
        let n = 0;
        for (let i = 0; i < events.length; i++) {
          const e = events[i];
          if (!clients.has(c)) return;
          if (e.seq <= c.sentSeq) continue;
          const m = wireEvent(e);
          if (!matches(req.filter, m)) {
            c.sentSeq = e.seq;
            continue;
          }
          // The replay ignores the queue limit (the client hasn't had a chance to read yet); it is
          // bounded by maxReplay instead: past it, the client is told where to page on from.
          if (++n > maxReplay) {
            write(c, {
              type: "dropped",
              count: events.length - i,
              first_seq: e.seq,
              last_seq: events.at(-1)!.seq,
            });
            c.sentSeq = events.at(-1)!.seq;
            break;
          }
          c.sentSeq = e.seq;
          write(c, m);
        }
      }
      c.ready = true;
      const held = c.pending;
      c.pending = [];
      for (const m of held) push(c, m);
    })();
    return c;
  }

  /** `GET /events` (SSE). */
  function sse(req: Request, r: StreamRequest): Response {
    let client: Client | null = null;
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
      cancel() {
        closed = true;
        if (client) remove(client);
      },
    }, new CountQueuingStrategy({ highWaterMark: maxQueue }));
    const sink: StreamSink = {
      canSend: () => !closed && (ctrl.desiredSize ?? 0) > 0,
      write: (f) => {
        if (!closed) ctrl.enqueue(enc.encode(f));
      },
      close: () => {
        if (closed) return;
        closed = true;
        try {
          ctrl.close();
        } catch {
          // Errored or already closed.
        }
      },
    };
    // A reconnect after 3 s by default (an EventSource honours it).
    sink.write("retry: 3000\n\n");
    client = connect(sink, r, true);
    if (!client) return text(503, "too many clients", { "retry-after": "10" });
    req.signal?.addEventListener("abort", () => client && remove(client), { once: true });
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    });
  }

  /** `GET /events/ws` (WebSocket). */
  function ws(req: Request, r: StreamRequest): Response {
    if ((req.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
      return text(426, "upgrade required: websocket", { upgrade: "websocket" });
    }
    if (stopped || clients.size >= deps.maxClients) {
      return text(503, "too many clients", { "retry-after": "10" });
    }
    const { socket, response } = Deno.upgradeWebSocket(req, { idleTimeout: 0 });
    let client: Client | null = null;
    const sink: StreamSink = {
      canSend: () => socket.readyState === WebSocket.OPEN && socket.bufferedAmount < wsMax,
      write: (f) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(f);
      },
      close: () => {
        try {
          socket.close(1000, "bye");
        } catch {
          // Already closing.
        }
      },
    };
    socket.onopen = () => {
      client = connect(sink, r, false);
      if (!client) socket.close(1013, "too many clients");
    };
    const gone = () => {
      if (client) remove(client);
    };
    socket.onclose = gone;
    socket.onerror = gone;
    // Messages from the client are ignored (the filters are in the URL).
    socket.onmessage = () => {};
    return response;
  }

  /** The HTTP handler: the guards, then `/events` or `/events/ws`. */
  function handler(req: Request): Response {
    const host = req.headers.get("host");
    if (!host || !LOOPBACK.has(hostName(host))) return text(403, "forbidden: host");
    const url = new URL(req.url);
    if (url.pathname !== "/events" && url.pathname !== "/events/ws") {
      return text(404, "not found");
    }
    if (req.method !== "GET") return text(405, "method not allowed", { allow: "GET" });
    const refused = refuse(req, deps.token);
    if (refused) return refused;
    const r = parseStreamRequest(url, req.headers.get("last-event-id"));
    if (typeof r === "string") return text(400, r);
    return url.pathname === "/events" ? sse(req, r) : ws(req, r);
  }

  return {
    handler,
    /** Newly logged events, in `seq` order (the journal's appends). */
    publish(events: readonly FleetEvent[]): void {
      for (const e of events) {
        const m = wireEvent(e);
        for (const c of [...clients]) deliver(c, m);
      }
    },
    /** A webhook state change. */
    publishHooks(state: string, previous: string): void {
      const m = hooksMessage(state, previous, now());
      for (const c of [...clients]) deliver(c, m);
    },
    /** Send the heartbeat now (the timer does it every `heartbeatMs`). */
    heartbeat,
    /** Attach a client directly (tests). */
    connect,
    /** Close every client (they reconnect with `since_seq`). */
    disconnectAll(): void {
      for (const c of [...clients]) remove(c);
    },
    get clientCount(): number {
      return clients.size;
    },
    /** Stop: close every client, refuse new ones, stop the heartbeat. */
    stop(): void {
      stopped = true;
      for (const c of [...clients]) remove(c);
      if (beat !== null) clearInterval(beat);
      beat = null;
    },
  };
}

/** The stream (createStream's result). */
export type FleetStream = ReturnType<typeof createStream>;
