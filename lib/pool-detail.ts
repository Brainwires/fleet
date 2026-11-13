// The pool detail screen's data, from the usage history, the snapshot and the event log: the
// pool's card, its labels and machine, its history over a range (and its machine's combined
// history when pools share one), its recent jobs and events. Pure apart from the pool and settings
// lookups.

import type { FleetEvent } from "./events.ts";
import {
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryStore,
  type JobRecord,
  type PoolHistory,
  poolHistory,
} from "./history.ts";
import type { PoolCard, Snapshot } from "./model.ts";
import { currentPools, GITHUB_POOL } from "./pools.ts";
import { settings } from "./settings.ts";

/** GitHub images shown as their own series in the GitHub-hosted detail (the rest are "other"). */
export const TOP_IMAGES = 5;
/** Recent jobs and events the detail lists. */
export const DETAIL_JOBS = 50;
export const DETAIL_EVENTS = 100;

/** Pools that share one machine (the settings' `host`), or `null`. */
export interface SharedHost {
  readonly host: string;
  readonly pools: readonly string[];
}

/** One GitHub image's history (the GitHub-hosted detail). */
export interface ImageHistory {
  readonly image: string;
  readonly history: PoolHistory;
}

/** What the detail screen shows. */
export interface PoolDetail {
  readonly pool: string;
  readonly title: string;
  readonly range: HistoryRange;
  /** When it was built (this machine's clock). */
  readonly at: number;
  readonly card: PoolCard | null;
  readonly labels: readonly string[];
  /** The machine (settings `host`), when named. */
  readonly host: string | null;
  readonly shared: SharedHost | null;
  readonly history: PoolHistory;
  /** The shared machine's pools combined (`null` without one). */
  readonly combined: PoolHistory | null;
  /** GitHub-hosted only: the busiest images over the range, by minutes. */
  readonly images: readonly ImageHistory[];
  readonly jobs: readonly JobRecord[];
  readonly events: readonly FleetEvent[];
  /** The runner scheduler's logs are configured (the Logs tab lists runner logs). */
  readonly runnerLogs: boolean;
  /** When the history was back-filled from the journal and the spool (`null`: never). */
  readonly backfilledAt: number | null;
}

/** A range from a request (`24h` when it isn't one). */
export function asRange(v: unknown): HistoryRange {
  return HISTORY_RANGES.includes(v as HistoryRange) ? v as HistoryRange : "24h";
}

/** The pools that share `pool`'s machine (settings `integrations.runnerScheduler.pools[].host`). */
export function sharedHost(pool: string): SharedHost | null {
  const defs = settings().integrations.runnerScheduler?.pools ?? [];
  const host = defs.find((p) => p.id === pool)?.host;
  if (!host) return null;
  const pools = defs.filter((p) => p.host === host).map((p) => p.id);
  return pools.length > 1 ? { host, pools } : null;
}

const STARTED = /^started on (\S+)/;
const QUEUED = /^queued for (\S+)/;

/** The event log's lines about a pool: its health and alerts, and its jobs. */
export function poolEvents(
  events: readonly FleetEvent[],
  pool: string,
  jobIds: ReadonlySet<number>,
  limit = DETAIL_EVENTS,
): FleetEvent[] {
  const name = pool === GITHUB_POOL ? "GitHub-hosted" : pool;
  const out: FleetEvent[] = [];
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i];
    const m = STARTED.exec(e.text) ?? QUEUED.exec(e.text);
    if (
      (pool !== GITHUB_POOL && e.workflow === `pool ${pool}`) ||
      (m && m[1] === name) ||
      (e.job_id !== undefined && jobIds.has(e.job_id))
    ) out.push(e);
  }
  return out;
}

/** The detail of `pool` over `range`. */
export function poolDetail(input: {
  readonly store: HistoryStore;
  readonly snapshot: Snapshot;
  readonly events: readonly FleetEvent[];
  readonly pool: string;
  readonly range: HistoryRange;
  readonly now: number;
}): PoolDetail {
  const { store, snapshot, pool, range, now } = input;
  const card = snapshot.pools.find((p) => p.id === pool) ?? null;
  const def = currentPools().find((p) => p.id === pool);
  const shared = pool === GITHUB_POOL ? null : sharedHost(pool);
  const jobs = store.jobs([pool], DETAIL_JOBS);
  let images: ImageHistory[] = [];
  if (pool === GITHUB_POOL) {
    images = store.keys()
      .filter((k) => k.startsWith("github:"))
      .map((k) => ({ image: k.slice(7), history: poolHistory(store, k, range, now) }))
      .filter((i) => i.history.totals.sampled > 0 || i.history.totals.finished > 0)
      .sort((a, b) =>
        b.history.totals.minutes - a.history.totals.minutes || a.image.localeCompare(b.image)
      )
      .slice(0, TOP_IMAGES);
  }
  return {
    pool,
    title: card?.title ?? (pool === GITHUB_POOL ? "GitHub-hosted" : pool),
    range,
    at: now,
    card,
    labels: def ? [...(def.labels ?? [def.label])] : card?.label ? [card.label] : [],
    host: shared?.host ??
      settings().integrations.runnerScheduler?.pools.find((p) => p.id === pool)?.host ?? null,
    shared,
    history: poolHistory(store, pool, range, now),
    combined: shared ? poolHistory(store, shared.pools, range, now) : null,
    images,
    jobs,
    events: poolEvents(input.events, pool, new Set(store.jobs([pool], 200).map((j) => j.id))),
    runnerLogs: pool !== GITHUB_POOL && !!settings().integrations.runnerScheduler?.logsDir,
    backfilledAt: store.backfilledAt,
  };
}
