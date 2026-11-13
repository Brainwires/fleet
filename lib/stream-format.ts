// The loopback event stream's wire messages (lib/stream.ts sends them, mcp/fleet-stream.ts reads
// them) and their one-line, human-readable form (`format=line`, and the CLI's output). Pure: no
// I/O, no Deno APIs. Every free-text field is already capped and stripped of control characters by
// the server (mcp/queries.ts eventOut, the same as the MCP answers); the line form strips them
// again, so a line is always one line whatever a client hands it.

/** An event as the stream sends it: the journal's event, as fleet_events returns it. */
export interface WireEvent {
  readonly type: "event";
  readonly seq: number;
  /** ISO time. */
  readonly at: string;
  readonly sev: string;
  readonly kind: string;
  readonly repo: string;
  readonly workflow: string;
  readonly job: string | null;
  readonly text: string;
  readonly url: string | null;
  readonly branch?: string;
  readonly run_id?: number;
  readonly job_id?: number;
  readonly pool?: string;
  readonly user?: boolean;
  readonly backfill?: boolean;
  readonly untrusted?: boolean;
}

/** One pool in a status heartbeat. */
export interface WirePool {
  readonly id: string;
  readonly state: string;
  readonly busy: number;
  readonly slots: number | null;
  readonly queued: number;
}

/** The periodic heartbeat: a quiet stream still shows Fleet is alive. */
export interface WireStatus {
  readonly type: "status";
  readonly at: string;
  readonly running: number;
  readonly queued: number;
  readonly severity: string;
  readonly reasons: readonly string[];
  readonly pools: readonly WirePool[];
  readonly hooks: string;
  readonly auth: string;
  readonly poll_ok: boolean;
  readonly last_seq: number;
}

/** Webhook delivery state changed (live / stale / off). Not journaled: no `seq`. */
export interface WireHooks {
  readonly type: "hooks";
  readonly at: string;
  readonly sev: string;
  readonly state: string;
  readonly previous: string;
}

/** The first message on a connection. */
export interface WireHello {
  readonly type: "hello";
  readonly v: 1;
  readonly last_seq: number;
  readonly heartbeat_s: number;
}

/** The client lagged and these messages were dropped: reconnect with `since_seq` to refill. */
export interface WireDropped {
  readonly type: "dropped";
  readonly count: number;
  /** The first and last dropped event `seq` (`null` when only heartbeats were dropped). */
  readonly first_seq: number | null;
  readonly last_seq: number | null;
}

/** A replay asked for events the journal no longer keeps. */
export interface WireGap {
  readonly type: "gap";
  readonly from_seq: number;
  readonly to_seq: number;
}

/** Any message on the stream. */
export type WireMessage = WireEvent | WireStatus | WireHooks | WireHello | WireDropped | WireGap;

/** The severity glyphs the event log draws. */
const GLYPH: Readonly<Record<string, string>> = {
  ok: "✓",
  bad: "✕",
  warn: "▲",
  info: "•",
  muted: "⊘",
};

/** One line: control characters, line and bidi separators become spaces; capped. */
function clean(text: unknown, max = 400): string {
  const t = String(text ?? "")
    .replace(/[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** `HH:MM:SSZ` of an ISO time (UTC), or the text as is. */
function clock(iso: string): string {
  const m = /T(\d\d:\d\d:\d\d)/.exec(iso);
  return m ? `${m[1]}Z` : clean(iso, 30);
}

/**
 * The message as one line, for a terminal or an agent's monitor:
 *
 *     #812 14:02:11Z ✕ finished acme/web · CI / windows-tests: finished: failure at step "Run tests" https://…
 *     · status 14:03:00Z running=3 queued=1 severity=ok hooks=live pools: mac-arm ok 2/4 q0, …
 *
 * A fork / pull_request_target run's line says `[untrusted]` before its names: the names are
 * someone else's text (and its failed step / annotation are not in the text at all).
 */
export function formatLine(m: WireMessage): string {
  switch (m.type) {
    case "event": {
      const where = [
        m.repo ? clean(m.repo, 140) : "",
        [m.workflow, m.job].filter((x) => x).map((x) => clean(x, 120)).join(" / "),
      ].filter((x) => x).join(" · ");
      const tags = [
        m.untrusted ? "[untrusted]" : "",
        m.backfill ? "[while closed]" : "",
        m.user ? "[you]" : "",
      ].filter((x) => x).join(" ");
      return [
        `#${m.seq}`,
        clock(m.at),
        GLYPH[m.sev] ?? "•",
        clean(m.kind, 20),
        tags,
        `${where}:`,
        clean(m.text),
        m.url ? clean(m.url, 300) : "",
      ].filter((x) => x).join(" ");
    }
    case "status": {
      const pools = m.pools.map((p) =>
        `${clean(p.id, 40)} ${clean(p.state, 20)} ${p.busy}/${p.slots ?? "-"} q${p.queued}`
      ).join(", ");
      return [
        "· status",
        clock(m.at),
        `running=${m.running}`,
        `queued=${m.queued}`,
        `severity=${clean(m.severity, 20)}`,
        `hooks=${clean(m.hooks, 20)}`,
        ...(m.poll_ok ? [] : ["poll=failing"]),
        ...(m.auth === "needs-token" || m.auth === "invalid" ? [`auth=${clean(m.auth, 20)}`] : []),
        ...(pools ? [`pools: ${pools}`] : []),
      ].join(" ");
    }
    case "hooks":
      return `${GLYPH[m.sev] ?? "•"} hooks ${clock(m.at)} webhooks ${clean(m.state, 20)} (was ${
        clean(m.previous, 20)
      })`;
    case "hello":
      return `# connected to Fleet (last_seq ${m.last_seq}, status every ${m.heartbeat_s} s)`;
    case "dropped":
      return `! dropped ${m.count} message${m.count === 1 ? "" : "s"} (client lagging)${
        m.first_seq !== null
          ? `: events ${m.first_seq}..${m.last_seq}; reconnect with since_seq=${m.first_seq - 1}`
          : ""
      }`;
    case "gap":
      return `! events ${m.from_seq}..${m.to_seq} are no longer kept`;
    default:
      return clean(JSON.stringify(m));
  }
}

/** Whether a parsed value looks like a stream message (the CLI checks what it reads). */
export function isWireMessage(v: unknown): v is WireMessage {
  if (typeof v !== "object" || v === null) return false;
  const t = (v as { type?: unknown }).type;
  return t === "event" || t === "status" || t === "hooks" || t === "hello" || t === "dropped" ||
    t === "gap";
}
