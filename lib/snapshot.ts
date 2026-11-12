// Build the page's Snapshot from the poller's state: pool cards (health variable + our jobs), the
// lanes, the summary (tray text and severity). Pure.

import { type ActiveRun, groupLanes, jobWarning, type UsualLookup } from "./classify.ts";
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
import { GITHUB_POOL, poolFromRunnerName, poolIdOfLabel, POOLS } from "./pools.ts";

/** What the builder reads. */
export interface SnapshotInput {
  readonly now: number;
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
}

/** Every job row of a lane. */
export function rowsOf(groups: readonly RepoGroup[]): JobRow[] {
  return groups.flatMap((g) => g.runs.flatMap((r) => r.jobs));
}

/** The pool cards: every known pool, any other pool a job targets, then GitHub-hosted. */
export function poolCards(
  running: readonly JobRow[],
  queued: readonly JobRow[],
  health: HealthState,
  runners: readonly GhRunner[] | null,
): PoolCard[] {
  const fresh = health.state === "ok" ? health.doc : null;
  const stale = health.state === "stale" ? health.doc : null;
  const ids = [...POOLS.map((p) => p.id)];
  for (const r of [...running, ...queued]) {
    if (r.pool !== GITHUB_POOL && !ids.includes(r.pool)) ids.push(r.pool);
  }
  // Health for a pool the variable names that we don't know (a new pool): a card too.
  for (const label of Object.keys((fresh ?? stale)?.pools ?? {})) {
    const id = poolIdOfLabel(label);
    if (!ids.includes(id)) ids.push(id);
  }
  // Online, busy runners per pool from the org's runner list (ephemeral runners register per job).
  const busyRunners = new Map<string, number>();
  for (const r of runners ?? []) {
    const id = poolFromRunnerName(r.name);
    if (id && r.busy) busyRunners.set(id, (busyRunners.get(id) ?? 0) + 1);
  }
  const cards: PoolCard[] = ids.map((id) => {
    const def = POOLS.find((p) => p.id === id);
    const label = def?.label ?? id;
    const h = fresh?.pools[label] ?? null;
    const sh = stale?.pools[label] ?? null;
    const run = running.filter((r) => r.pool === id).length;
    const q = queued.filter((r) => r.pool === id);
    let state: PoolCard["state"] = "unknown";
    let reason = "";
    if (h) {
      state = !h.ok ? "unhealthy" : h.paused ? "paused" : "ok";
      reason = h.reason;
    } else if (sh) {
      reason = "health is stale";
    }
    return {
      id,
      title: id,
      label,
      slots: h?.slots ?? sh?.slots ?? def?.slots ?? null,
      busy: h?.busy ?? Math.max(run, busyRunners.get(id) ?? 0),
      running: run,
      queued: q.length,
      state,
      reason,
      since: h?.since ?? null,
      oldestQueuedSince: q.length ? Math.min(...q.map((r) => r.since)) : null,
    };
  });
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
 * queued over 15 min, amber (`warn`) for a paused pool, a job over its usual length, stale health
 * or a failing poll.
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
  const late = queued.filter((r) => jobWarning(r, now) === "queued-long").length;
  if (late) {
    raise("alert");
    reasons.push(`${late} job${late === 1 ? "" : "s"} queued over 15 min`);
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
  const { running, queued } = groupLanes(input.runs, input.jobsByRun, input.usual);
  const runRows = rowsOf(running);
  const qRows = rowsOf(queued);
  const pools = poolCards(runRows, qRows, input.health, input.runners);
  const h = input.health;
  const doc = h.state === "ok" || h.state === "stale" ? h.doc : null;
  const alerts: AlertRow[] = doc ? doc.alerts.map((a) => ({ ...a })) : [];
  const summary = summarize(runRows, qRows, pools, input.now, {
    pollOk: input.poll.ok,
    healthStale: h.state === "stale",
  });
  return {
    at: input.now,
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
    eventSeq: 0,
    notificationsPaused: false,
    hooks: { state: "off", lastDeliveryAt: null },
  };
}
