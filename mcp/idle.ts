// Idle runners: when the self-hosted pools have nothing to do, so an agent can queue work. Pure:
// the snapshot and events come in as values, the clock as a number. `fleet_wait({ until: "idle" })`
// and `fleet_watch_idle` (mcp/fleet-mcp.ts) feed an {@linkcode IdleTracker} from the same
// file-watch-driven snapshot stream the other fleet_wait conditions read.
//
// A pool is idle when it runs nothing and has nothing queued (`busy == 0 && queued == 0`); in mode
// `any`, when it has a free slot and nothing queued (`slots - busy > 0 && queued == 0`). The
// condition must hold for `idle_for_s` before it triggers. When the tracker first sees a pool idle,
// the time it went idle is estimated from Fleet's own records (the pool's last job timestamp in the
// snapshot, its last logged event), so a pool already idle long enough triggers at once; a pool the
// tracker has seen busy starts its clock when it is next seen idle.

import type { AgentPool, AgentSnapshot } from "../lib/agent-snapshot.ts";
import type { FleetEvent } from "../lib/events.ts";
import { GITHUB_POOL } from "../lib/pools.ts";
import { ArgError, freshness } from "./queries.ts";

/** The condition holds this long by default before it triggers (s). */
export const DEFAULT_IDLE_FOR_S = 120;
/** …and at most. */
export const MAX_IDLE_FOR_S = 1800;
/**
 * A pool with no job or event in Fleet's records counts as idle at least this long: the snapshot
 * keeps runs that finished in the last 2 h.
 */
export const NO_ACTIVITY_LOOKBACK_MS = 2 * 60 * 60_000;

/** Every pool idle, or at least one. */
export type IdleMode = "all" | "any";

/** The idle condition's checked arguments. */
export interface IdleArgs {
  /** Pool short names, or `null` for every self-hosted pool that is not paused and has slots. */
  readonly pools: readonly string[] | null;
  readonly idleForS: number;
  readonly mode: IdleMode;
}

type Args = Record<string, unknown>;

/** Check the idle condition's arguments (fleet_wait's `until: "idle"`, fleet_watch_idle). */
export function idleArgs(args: Args): IdleArgs {
  let pools: string[] | null = null;
  const p = args.pools;
  if (p !== undefined && p !== null) {
    if (
      !Array.isArray(p) || p.length === 0 || p.length > 50 ||
      !p.every((s) => typeof s === "string" && s.length > 0 && s.length <= 100)
    ) {
      throw new ArgError("pools must be a non-empty array of pool short names");
    }
    if (p.includes(GITHUB_POOL)) {
      throw new ArgError("`github` is GitHub-hosted, not a runner pool: it is never idle-watched");
    }
    pools = [...new Set(p as string[])];
  }
  let idleForS = DEFAULT_IDLE_FOR_S;
  const f = args.idle_for_s;
  if (f !== undefined && f !== null) {
    if (typeof f !== "number" || !Number.isInteger(f) || f < 0 || f > MAX_IDLE_FOR_S) {
      throw new ArgError(`idle_for_s must be an integer from 0 to ${MAX_IDLE_FOR_S}`);
    }
    idleForS = f;
  }
  const m = args.mode ?? "all";
  if (m !== "all" && m !== "any") throw new ArgError(`mode must be "all" or "any"`);
  return { pools, idleForS, mode: m };
}

/** Pool short names in `a.pools` that the snapshot doesn't have (none for the default set). */
export function unknownPools(snap: AgentSnapshot | null, a: IdleArgs): string[] {
  if (!snap || !a.pools) return [];
  return a.pools.filter((id) => !snap.pools.some((p) => p.id === id));
}

/** Whether a pool is paused (its badge, or the watchdog's host). */
function isPaused(snap: AgentSnapshot, p: AgentPool): boolean {
  return p.state === "paused" || snap.hosts.some((h) => h.id === p.id && h.paused);
}

/**
 * The pools the condition looks at now: self-hosted (never `github`), not paused, with slots;
 * narrowed to `a.pools` when given.
 */
export function watchedPools(snap: AgentSnapshot | null, a: IdleArgs): AgentPool[] {
  if (!snap) return [];
  return snap.pools.filter((p) =>
    p.id !== GITHUB_POOL && typeof p.slots === "number" && p.slots > 0 && !isPaused(snap, p) &&
    (a.pools === null || a.pools.includes(p.id))
  );
}

/** Whether one pool is idle in the mode. */
export function poolIsIdle(p: AgentPool, mode: IdleMode): boolean {
  if (p.queued !== 0) return false;
  return mode === "all" ? p.busy === 0 : (p.slots ?? 0) - p.busy > 0;
}

/**
 * When the pool was last active by Fleet's records (local epoch ms), or `null`: its jobs' latest
 * created / started / completed time in the snapshot (GitHub's clock, shifted to this machine's)
 * and its latest logged event.
 */
export function lastActivity(
  snap: AgentSnapshot,
  events: readonly FleetEvent[],
  pool: string,
): number | null {
  let last: number | null = null;
  const offset = snap.clock_offset_ms ?? 0;
  for (const j of snap.jobs) {
    if (j.pool !== pool) continue;
    for (const iso of [j.created_at, j.started_at, j.completed_at]) {
      const t = iso ? Date.parse(iso) : NaN;
      if (Number.isFinite(t) && (last === null || t - offset > last)) last = t - offset;
    }
  }
  for (const e of events) {
    if (e.pool === pool && (last === null || e.at > last)) last = e.at;
  }
  return last;
}

/** One watched pool in an answer. */
export interface IdlePoolOut {
  readonly id: string;
  readonly slots: number | null;
  readonly busy: number;
  readonly queued: number;
  readonly state: string;
}

/** What one step of the tracker saw. */
export interface IdleView {
  /** The condition holds now (maybe not for long enough yet). */
  readonly holding: boolean;
  /** The watched pools idle now, however long. */
  readonly idleNow: readonly string[];
  /** It has held for `idle_for_s`. */
  readonly triggered: boolean;
  /** The pools it triggered for (all watched in mode `all`; each pool idle long enough in `any`). */
  readonly idlePools: readonly string[];
  /** Since when the condition held for those pools (local ms), or `null`. */
  readonly idleSince: number | null;
  /** When it would trigger if nothing changes (local ms), or `null` (not holding / triggered). */
  readonly dueAt: number | null;
  readonly pools: readonly IdlePoolOut[];
}

/** Follows the idle condition across snapshots; one per waiter or watch. */
export class IdleTracker {
  readonly args: IdleArgs;
  /** Watched pool → when it went idle (local ms). */
  #since = new Map<string, number>();
  /** Pools this tracker has seen not idle (their clock starts when next seen idle). */
  #seenBusy = new Set<string>();

  constructor(args: IdleArgs) {
    this.args = args;
  }

  /** Look at one snapshot. */
  step(snap: AgentSnapshot | null, events: readonly FleetEvent[], now: number): IdleView {
    const a = this.args;
    const ws = watchedPools(snap, a);
    const ids = new Set(ws.map((p) => p.id));
    // A pool that left the set (paused, no slots, gone) starts over when it comes back.
    for (const id of [...this.#since.keys()]) {
      if (!ids.has(id)) {
        this.#since.delete(id);
        this.#seenBusy.add(id);
      }
    }
    const idle: AgentPool[] = [];
    for (const p of ws) {
      if (!poolIsIdle(p, a.mode)) {
        this.#since.delete(p.id);
        this.#seenBusy.add(p.id);
        continue;
      }
      if (!this.#since.has(p.id)) {
        const est = this.#seenBusy.has(p.id)
          ? now
          : Math.min(now, lastActivity(snap!, events, p.id) ?? now - NO_ACTIVITY_LOOKBACK_MS);
        this.#since.set(p.id, est);
      }
      idle.push(p);
    }
    const forMs = a.idleForS * 1000;
    const pools = ws.map((p) => ({
      id: p.id,
      slots: p.slots,
      busy: p.busy,
      queued: p.queued,
      state: p.state,
    }));
    const idleNow = idle.map((p) => p.id);
    if (a.mode === "all") {
      const holding = ws.length > 0 && idle.length === ws.length;
      if (!holding) {
        return {
          holding,
          idleNow,
          triggered: false,
          idlePools: [],
          idleSince: null,
          dueAt: null,
          pools,
        };
      }
      const since = Math.max(...idle.map((p) => this.#since.get(p.id)!));
      const triggered = now - since >= forMs;
      return {
        holding,
        idleNow,
        triggered,
        idlePools: triggered ? ws.map((p) => p.id) : [],
        idleSince: since,
        dueAt: triggered ? null : since + forMs,
        pools,
      };
    }
    const ready = idle.filter((p) => now - this.#since.get(p.id)! >= forMs);
    const waiting = idle.filter((p) => !ready.includes(p));
    const dues = waiting.map((p) => this.#since.get(p.id)! + forMs);
    return {
      holding: idle.length > 0,
      idleNow,
      triggered: ready.length > 0,
      idlePools: ready.map((p) => p.id),
      idleSince: ready.length ? Math.min(...ready.map((p) => this.#since.get(p.id)!)) : null,
      dueAt: dues.length ? Math.min(...dues) : null,
      pools,
    };
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** fleet_wait's answer for `until: "idle"`. */
export function idleWaitResult(
  snap: AgentSnapshot | null,
  view: IdleView | null,
  a: IdleArgs,
  triggered: "idle" | "timeout" | "stale",
  now: number,
  waitedMs: number,
) {
  return {
    triggered,
    waited_s: Math.round(waitedMs / 1000),
    ...freshness(snap, now),
    mode: a.mode,
    idle_for_s: a.idleForS,
    idle_pools: triggered === "idle" ? view?.idlePools ?? [] : [],
    idle_since: triggered === "idle" ? iso(view?.idleSince ?? null) : null,
    pools: view?.pools ?? [],
    ...(view && view.pools.length === 0
      ? { note: "No self-hosted pool to watch: every one is paused, has no slots, or none known." }
      : {}),
  };
}

/** The data a `fleet_watch_idle` notification (or the built-in idle event) carries. */
export function idleNotice(view: IdleView, now: number) {
  return {
    idle_pools: view.idlePools,
    idle_since: iso(view.idleSince),
    as_of: new Date(now).toISOString(),
    pools: view.pools,
  };
}
