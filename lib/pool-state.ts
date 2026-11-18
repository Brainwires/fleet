// WHY a pool does not start its queued jobs: the runner scheduler's own per-pool decision, read from
// the `pool-state.json` it writes beside its health file every tick (never guessed here). Schema:
// {"checked_at":epoch,"queue_known":bool,"queue_unknown_since":epoch|null,"pools":{"<pool>":{label,
// state,code,reason,detail,state_since,reason_since,slots,busy,free,queued,unvetted,
// blocked_jobs:[{repo,run_id,job_id,name,queued_at,waiting_s}],slot_states:[{slot,phase,since,job}]}}}.
// `state` is healthy / degraded / blocked / down / paused: a pool whose job runs fine but which cannot
// START the next one is degraded (every slot busy), blocked (a free slot, a gate holds the launch),
// paused or down, never healthy. Pure: the file comes in as a value; garbage parses to `null`.

/** Whether a pool can start jobs. */
export type StartState = "healthy" | "degraded" | "blocked" | "down" | "paused";

/** A queued job the pool cannot start now. */
export interface BlockedJob {
  readonly repo: string;
  readonly runId: number;
  readonly jobId: number;
  readonly name: string;
  /** Epoch ms, or `null`. */
  readonly queuedAt: number | null;
}

/** One slot that is busy. */
export interface SlotState {
  readonly slot: number;
  /** booting / ready / registering / listening / running. */
  readonly phase: string;
  /** Epoch ms the phase's clock started, or `null`. */
  readonly since: number | null;
}

/** One pool's start state, as the scheduler decided it. */
export interface PoolStart {
  readonly state: StartState;
  /** A stable code: ram, disk, vm-limit, shared-budget, capacity, host-unreachable, paused, ... */
  readonly code: string;
  /** Plain words with the numbers ("waiting for RAM: 12 of 16 GB in use by ..., needs 8"). */
  readonly reason: string;
  /** The scheduler's own log text for the gate, when one spoke. */
  readonly detail: string | null;
  /** Epoch ms the state began / the reason code began. */
  readonly stateSince: number | null;
  readonly reasonSince: number | null;
  readonly slots: number | null;
  readonly busy: number | null;
  readonly free: number | null;
  /** Vetted queued jobs on the pool's label. */
  readonly queued: number;
  readonly blockedJobs: readonly BlockedJob[];
  readonly slotStates: readonly SlotState[];
}

/** The parsed file. */
export interface PoolStateDoc {
  /** Epoch ms of the scheduler's tick. */
  readonly checkedAt: number;
  /** False while the scheduler cannot read GitHub's queue (it launches nothing then). */
  readonly queueKnown: boolean;
  readonly queueUnknownSince: number | null;
  readonly pools: Readonly<Record<string, PoolStart>>;
}

/** Older than this the scheduler is not ticking: its reasons are not shown as current. */
export const POOL_STATE_STALE_MS = 5 * 60_000;

const STATES = new Set<StartState>(["healthy", "degraded", "blocked", "down", "paused"]);
const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const ms = (secs: number | null): number | null => (secs === null ? null : secs * 1000);

function parseIso(v: unknown): number | null {
  if (typeof v !== "string" || !v) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Parse the scheduler's pool-state file; `null` when it is not one. */
export function parsePoolState(data: unknown): PoolStateDoc | null {
  if (!isObj(data)) return null;
  const checked = num(data.checked_at);
  if (checked === null || !isObj(data.pools)) return null;
  const pools: Record<string, PoolStart> = {};
  for (const [id, raw] of Object.entries(data.pools)) {
    if (!isObj(raw)) continue;
    const state = str(raw.state) as StartState;
    if (!STATES.has(state)) continue;
    const blocked: BlockedJob[] = [];
    if (Array.isArray(raw.blocked_jobs)) {
      for (const j of raw.blocked_jobs) {
        if (!isObj(j)) continue;
        const runId = num(j.run_id);
        const jobId = num(j.job_id);
        if (runId === null || jobId === null) continue;
        blocked.push({
          repo: str(j.repo),
          runId,
          jobId,
          name: str(j.name),
          queuedAt: parseIso(j.queued_at),
        });
      }
    }
    const slotStates: SlotState[] = [];
    if (Array.isArray(raw.slot_states)) {
      for (const s of raw.slot_states) {
        if (!isObj(s)) continue;
        const slot = num(s.slot);
        if (slot === null) continue;
        slotStates.push({ slot, phase: str(s.phase), since: ms(num(s.since)) });
      }
    }
    pools[id] = {
      state,
      code: str(raw.code),
      reason: str(raw.reason),
      detail: str(raw.detail) || null,
      stateSince: ms(num(raw.state_since)),
      reasonSince: ms(num(raw.reason_since)),
      slots: num(raw.slots),
      busy: num(raw.busy),
      free: num(raw.free),
      queued: num(raw.queued) ?? 0,
      blockedJobs: blocked,
      slotStates,
    };
  }
  return {
    checkedAt: checked * 1000,
    queueKnown: data.queue_known !== false,
    queueUnknownSince: ms(num(data.queue_unknown_since)),
    pools,
  };
}

/** The doc's pools while it is current; none once the scheduler stopped ticking. */
export function currentPoolStarts(
  doc: PoolStateDoc | null,
  now: number,
): Readonly<Record<string, PoolStart>> {
  if (!doc || now - doc.checkedAt > POOL_STATE_STALE_MS) return {};
  if (doc.queueKnown) return doc.pools;
  // The queue is unknown: nothing launches anywhere, whatever each pool last said.
  const since = doc.queueUnknownSince ?? doc.checkedAt;
  const out: Record<string, PoolStart> = {};
  for (const [id, p] of Object.entries(doc.pools)) {
    out[id] = p.state === "paused" ? p : {
      ...p,
      state: "blocked",
      code: "queue-unknown",
      reason: "the scheduler cannot read GitHub's queue (API errors): nothing launches",
      stateSince: since,
      reasonSince: since,
    };
  }
  return out;
}

/** "3 min", "2 h 5 min", "40 s". */
function span(msSpan: number): string {
  const s = Math.max(0, Math.round(msSpan / 1000));
  if (s < 90) return `${s} s`;
  const m = Math.round(s / 60);
  return m < 120 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

/**
 * The one line a pool card shows: empty for a healthy pool, else the state, the reason and for how
 * long ("blocked 12 min: waiting for RAM: 12 of 16 GB in use by ..., needs 8 (3 jobs wait)").
 */
export function startLine(p: PoolStart | null | undefined, now: number): string {
  if (!p || p.state === "healthy") return "";
  const forHow = p.stateSince !== null && now - p.stateSince >= 60_000
    ? ` ${span(now - p.stateSince)}`
    : "";
  const n = p.blockedJobs.length;
  const jobs = n > 0 ? ` (${n} job${n === 1 ? "" : "s"} wait${n === 1 ? "s" : ""})` : "";
  return `${p.state}${forHow}: ${p.reason}${jobs}`;
}

/**
 * Pools blocked or down with a free slot and waiting jobs for at least `afterMs`: what deserves an
 * alert (the scheduler raises the same condition in its own alert log).
 */
export function longBlocked(
  pools: Readonly<Record<string, PoolStart>>,
  now: number,
  afterMs: number,
): { readonly pool: string; readonly start: PoolStart; readonly forMs: number }[] {
  const out = [];
  for (const [pool, start] of Object.entries(pools)) {
    if (start.state !== "blocked" && start.state !== "down") continue;
    if ((start.free ?? 0) <= 0 || start.blockedJobs.length === 0) continue;
    const forMs = start.stateSince === null ? 0 : now - start.stateSince;
    if (forMs >= afterMs) out.push({ pool, start, forMs });
  }
  return out;
}
