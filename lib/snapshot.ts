// Build the page's Snapshot from the poller's state: pool cards (health variable + our jobs), the
// lanes, the summary (tray text and severity). Pure.

import {
  type ActiveRun,
  groupLanes,
  jobWarning,
  poolIsFull,
  type UsualLookup,
} from "./classify.ts";
import type { GhJob, GhRunner } from "./github-types.ts";
import type { HealthState } from "./health.ts";
import type {
  AlertRow,
  AuthState,
  FinishedJob,
  JobRow,
  PoolCard,
  RateInfo,
  RepoGroup,
  Severity,
  Snapshot,
  Summary,
} from "./model.ts";
import {
  currentPools,
  GITHUB_POOL,
  labelIsShared,
  poolFromRunnerName,
  poolIdOfLabel,
} from "./pools.ts";
import { startLine } from "./pool-state.ts";
import { poolStatus } from "./pool-status.ts";

/** A pool blocked (a free slot, jobs waiting) this long shows in the summary. */
export const POOL_BLOCKED_WARN_MS = 15 * 60_000;

/** What the builder reads. */
export interface SnapshotInput {
  /** This machine's clock. */
  readonly now: number;
  /** GitHub's clock minus ours (ms): GitHub timestamps are compared with `now + clockOffsetMs`. */
  readonly clockOffsetMs?: number;
  readonly auth: AuthState;
  readonly poll: Snapshot["poll"];
  readonly rate: RateInfo | null;
  readonly health: HealthState;
  readonly runs: readonly ActiveRun[];
  readonly jobsByRun: ReadonlyMap<number, readonly GhJob[]>;
  readonly runners: readonly GhRunner[] | null;
  readonly finished: readonly FinishedJob[];
  readonly usual: UsualLookup;
  readonly repos: readonly string[];
  /** The watched owners' logins. */
  readonly owners?: readonly string[];
}

/** Every job row of a lane. */
export function rowsOf(groups: readonly RepoGroup[]): JobRow[] {
  return groups.flatMap((g) => g.runs.flatMap((r) => r.jobs));
}

/** The queued groups with `capacityWait` set on every row whose pool is full. */
export function markCapacityWaits(
  groups: readonly RepoGroup[],
  pools: readonly PoolCard[],
): RepoGroup[] {
  const full = new Set(pools.filter(poolIsFull).map((p) => p.id));
  if (full.size === 0) return [...groups];
  return groups.map((g) => ({
    ...g,
    runs: g.runs.map((r) => ({
      ...r,
      jobs: r.jobs.map((j) => (full.has(j.pool) ? { ...j, capacityWait: true } : j)),
    })),
  }));
}

/**
 * The pool cards: every pool of the current list (one per host), any other pool a job targets, then
 * GitHub-hosted. A pool whose label it shares with another gets its own numbers, never the label's
 * merged ones: its `hosts` entry when the watchdog publishes one, else its own slots, busy runners by
 * runner name and the label's health. Queued jobs of a shared label sit on its first pool's card
 * (a queued job's label can't say which host takes it).
 */
export function poolCards(
  running: readonly JobRow[],
  queued: readonly JobRow[],
  health: HealthState,
  runners: readonly GhRunner[] | null,
): PoolCard[] {
  const fresh = health.state === "ok" ? health.doc : null;
  const stale = health.state === "stale" ? health.doc : null;
  const defs = currentPools();
  const ids = [...defs.map((p) => p.id)];
  for (const r of [...running, ...queued]) {
    if (r.pool !== GITHUB_POOL && !ids.includes(r.pool)) ids.push(r.pool);
  }
  // Health for a label the pool list doesn't know (a new pool): a card too.
  for (const label of Object.keys((fresh ?? stale)?.pools ?? {})) {
    const id = poolIdOfLabel(label);
    if (!ids.includes(id)) ids.push(id);
  }
  // Online, busy runners per pool from the orgs' runner lists (ephemeral runners register per job).
  const busyRunners = new Map<string, number>();
  const onlineRunners = new Map<string, number>();
  for (const r of runners ?? []) {
    const id = poolFromRunnerName(r.name);
    if (id && r.busy) busyRunners.set(id, (busyRunners.get(id) ?? 0) + 1);
    if (id && r.status === "online") onlineRunners.set(id, (onlineRunners.get(id) ?? 0) + 1);
  }
  const cards: PoolCard[] = ids.map((id) => {
    const def = defs.find((p) => p.id === id);
    const label = def?.label ?? id;
    const shared = def ? labelIsShared(label, defs) : false;
    const host = fresh?.hosts?.[id] ?? null;
    const h = host ?? fresh?.pools[label] ?? null;
    const sh = stale?.hosts?.[id] ?? stale?.pools[label] ?? null;
    const run = running.filter((r) => r.pool === id).length;
    const q = queued.filter((r) => r.pool === id);
    let state: PoolCard["state"] = "unknown";
    let reason = "";
    if (h) {
      ({ state, reason } = poolStatus(h, host?.start ?? null));
    } else if (sh) {
      reason = "health is stale";
    } else if (def?.labels && runners) {
      // A pool grouped from the runners, with no health variable: its runners say.
      const online = onlineRunners.get(id) ?? 0;
      state = online > 0 ? "ok" : "unhealthy";
      reason = online > 0 ? "" : "no runner online";
    }
    const ownBusy = Math.max(run, busyRunners.get(id) ?? 0);
    const perHost = host !== null || !shared;
    return {
      id,
      title: id,
      label,
      slots: perHost ? h?.slots ?? sh?.slots ?? def?.slots ?? null : def?.slots ?? null,
      busy: perHost ? h?.busy ?? ownBusy : ownBusy,
      running: run,
      queued: q.length,
      state,
      reason,
      since: h?.since ?? null,
      oldestQueuedSince: q.length ? Math.min(...q.map((r) => r.since)) : null,
      start: host?.start ?? null,
    };
  });
  // Pools that share a machine share its capacity: sum their busy slots against the largest slot count.
  const hostOf = (id: string) => defs.find((p) => p.id === id)?.host;
  const byHost = new Map<string, PoolCard[]>();
  for (const c of cards) {
    const hn = hostOf(c.id);
    if (hn) byHost.set(hn, [...(byHost.get(hn) ?? []), c]);
  }
  for (const [hn, group] of byHost) {
    const caps = group.map((c) => c.slots).filter((s): s is number => s !== null && s > 0);
    if (group.length < 2 || caps.length === 0) continue;
    const info = {
      host: hn,
      hostBusy: group.reduce((n, c) => n + c.busy, 0),
      hostSlots: Math.max(...caps),
    };
    for (const c of group) cards[cards.indexOf(c)] = { ...c, ...info };
  }
  const ghRun = running.filter((r) => r.pool === GITHUB_POOL).length;
  const ghQ = queued.filter((r) => r.pool === GITHUB_POOL);
  cards.push({
    id: GITHUB_POOL,
    title: "GitHub-hosted",
    label: null,
    slots: null,
    busy: ghRun,
    running: ghRun,
    queued: ghQ.length,
    state: "ok",
    reason: "",
    since: null,
    oldestQueuedSince: ghQ.length ? Math.min(...ghQ.map((r) => r.since)) : null,
  });
  return cards;
}

/**
 * The summary: `N running · M queued`, red (`alert`) when a pool is unhealthy or a job has been
 * queued over 15 min (a wait for a free slot on a full pool is only noted: "N waiting for
 * capacity", no severity), amber (`warn`) for a paused pool, a pool blocked for a while (a free slot,
 * jobs waiting), a job over its usual length, stale health or a failing poll. A busy pool (every slot
 * busy) is no severity; only `unhealthy` (a real failure) is red (lib/pool-status.ts).
 */
export function summarize(
  running: readonly JobRow[],
  queued: readonly JobRow[],
  pools: readonly PoolCard[],
  now: number,
  extra: { pollOk: boolean; healthStale: boolean },
): Summary {
  const reasons: string[] = [];
  let severity: Severity = "ok";
  const raise = (s: Severity) => {
    if (s === "alert" || (s === "warn" && severity === "ok")) severity = s;
  };
  for (const p of pools) {
    if (p.state === "unhealthy") {
      raise("alert");
      reasons.push(`${p.title} unhealthy${p.reason ? `: ${p.reason}` : ""}`);
    } else if (p.state === "paused") {
      raise("warn");
      reasons.push(`${p.title} paused`);
    }
  }
  // A pool blocked from STARTING its queued jobs (the scheduler's own reason), for a while.
  for (const p of pools) {
    const st = p.start;
    if (!st || p.state !== "blocked") continue;
    if ((st.free ?? 0) <= 0 || st.blockedJobs.length === 0) continue;
    if (st.stateSince === null || now - st.stateSince < POOL_BLOCKED_WARN_MS) continue;
    raise("warn");
    reasons.push(`${p.title} ${startLine(st, now)}`);
  }
  const late = queued.filter((r) => jobWarning(r, now) === "queued-long").length;
  if (late) {
    raise("alert");
    reasons.push(`${late} job${late === 1 ? "" : "s"} queued over 15 min`);
  }
  const waiting = queued.filter((r) => jobWarning(r, now) === "queued-capacity").length;
  if (waiting) {
    const hosts = new Map<string, string>();
    for (const p of pools) {
      if (p.host && p.hostSlots !== undefined && poolIsFull(p)) {
        hosts.set(p.host, `${p.host} ${p.hostBusy}/${p.hostSlots}`);
      }
    }
    reasons.push(
      `${waiting} waiting for capacity${
        hosts.size ? ` (host ${[...hosts.values()].join(", ")})` : ""
      }`,
    );
  }
  const slow = running.filter((r) => jobWarning(r, now) === "over-usual").length;
  if (slow) {
    raise("warn");
    reasons.push(`${slow} job${slow === 1 ? "" : "s"} past usual length`);
  }
  if (extra.healthStale) {
    raise("warn");
    reasons.push("pool health is stale");
  }
  if (!extra.pollOk) {
    raise("warn");
    reasons.push("GitHub poll failing");
  }
  return { running: running.length, queued: queued.length, severity, reasons };
}

/** The tray's tooltip text. */
export function trayText(summary: Summary): string {
  const head = `${summary.running} running · ${summary.queued} queued`;
  return summary.reasons.length ? `${head}\n${summary.reasons.join("\n")}` : head;
}

/** Build the snapshot. */
export function buildSnapshot(input: SnapshotInput): Snapshot {
  const offset = input.clockOffsetMs ?? 0;
  const ghNow = input.now + offset;
  const { running, queued: queuedRaw } = groupLanes(
    input.runs,
    input.jobsByRun,
    input.usual,
    ghNow,
  );
  const runRows = rowsOf(running);
  const pools = poolCards(runRows, rowsOf(queuedRaw), input.health, input.runners);
  const queued = markCapacityWaits(queuedRaw, pools);
  const qRows = rowsOf(queued);
  const h = input.health;
  const doc = h.state === "ok" || h.state === "stale" ? h.doc : null;
  const alerts: AlertRow[] = doc ? doc.alerts.map((a) => ({ ...a })) : [];
  const summary = summarize(runRows, qRows, pools, ghNow, {
    pollOk: input.poll.ok,
    healthStale: h.state === "stale",
  });
  return {
    at: input.now,
    clockOffsetMs: offset,
    auth: input.auth,
    poll: input.poll,
    rate: input.rate,
    health: {
      state: h.state,
      checkedAt: doc?.checkedAt ?? null,
      message: h.state === "unavailable" || h.state === "invalid"
        ? h.message
        : h.state === "stale"
        ? "pool health is stale (watchdog quiet over 30 min)"
        : "",
    },
    pools,
    running,
    queued,
    finished: [...input.finished].sort((a, b) => b.completedAt - a.completedAt),
    alerts,
    summary,
    repos: input.repos,
    owners: input.owners ?? [],
    eventSeq: 0,
    notificationsPaused: false,
    hooks: { state: "off", lastDeliveryAt: null },
  };
}
