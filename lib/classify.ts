// Job classification, queue ages, warnings and the lanes' grouping. Pure: no clock, no I/O.

import type { GhJob, GhRun } from "./github-types.ts";
import type { JobRow, JobTarget, Lane, PoolCard, RepoGroup, RunGroup } from "./model.ts";
import {
  CORE_REPOS,
  DEFAULT_BRANCHES,
  GITHUB_POOL,
  poolFromLabels,
  poolFromRunnerName,
} from "./pools.ts";

/** A job queued longer than this is late (15 min). */
export const QUEUED_WARN_MS = 15 * 60_000;

/**
 * A queued run with no jobs older than this is a ghost (10 min): GitHub keeps reporting some runs as
 * `queued` with a jobs list that never fills. A just-dispatched run has no jobs for a few seconds,
 * so a younger one still shows ("queued, no jobs yet").
 */
export const GHOST_RUN_MS = 10 * 60_000;

/** Whether a queued run with no jobs is a ghost: older than GHOST_RUN_MS (by its latest start). */
export function isGhostRun(run: GhRun, now: number): boolean {
  const created = time(run.created_at);
  const started = time(run.run_started_at);
  const since = Math.max(created ?? -Infinity, started ?? -Infinity);
  return Number.isFinite(since) && now - since > GHOST_RUN_MS;
}

/** Running past this multiple of its usual length is late. */
export const OVER_USUAL_FACTOR = 1.5;

/** …and at least this much past it (short jobs jitter). */
export const OVER_USUAL_SLACK_MS = 3 * 60_000;

/** A job's lane, or `null` once it completed. */
export function laneOf(status: string): Lane | null {
  if (status === "in_progress") return "running";
  if (status === "completed") return null;
  // queued, waiting, pending, requested
  return "queued";
}

/** How a job is classified. */
export interface JobClass {
  readonly lane: Lane;
  readonly target: JobTarget;
  /** The pool's short name, or `github`. */
  readonly pool: string;
}

/**
 * Classify an active job: running on our pool (runner `denext-*`, pool from its `denext-…` label),
 * running GitHub-hosted, queued for our pool (labels include `self-hosted` / `denext-*`), or queued
 * GitHub-hosted. `null` for a completed job.
 */
export function classifyJob(job: GhJob): JobClass | null {
  const lane = laneOf(job.status);
  if (!lane) return null;
  const labels = job.labels ?? [];
  const labelPool = poolFromLabels(labels);
  if (lane === "running") {
    const runner = job.runner_name ?? "";
    if (runner.startsWith("denext-")) {
      return {
        lane,
        target: "pool",
        // The runner's name first: pools that share a label (win-x64, win-x64-brain) differ there.
        pool: poolFromRunnerName(runner) ?? labelPool ?? "self-hosted",
      };
    }
    if (!runner && (labelPool || labels.includes("self-hosted"))) {
      // Assigned but the runner name isn't reported yet.
      return { lane, target: "pool", pool: labelPool ?? "self-hosted" };
    }
    return { lane, target: "github", pool: GITHUB_POOL };
  }
  if (labelPool || labels.includes("self-hosted")) {
    return { lane, target: "pool", pool: labelPool ?? "self-hosted" };
  }
  return { lane, target: "github", pool: GITHUB_POOL };
}

/** Parse an ISO time to epoch ms (`null` for missing / garbage). */
export function time(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** When the job's wait or run began: `created_at` while queued, `started_at` while running. */
export function jobSince(job: GhJob, lane: Lane): number {
  const created = time(job.created_at) ?? 0;
  return lane === "running" ? time(job.started_at) ?? created : created;
}

/** Queue age (queued) or elapsed (running), ms, never negative. */
export function jobAge(since: number, now: number): number {
  return Math.max(0, now - since);
}

/** A self-hosted pool that is ok with every slot busy: its queue is waiting for capacity. */
export function poolIsFull(p: Pick<PoolCard, "id" | "state" | "slots" | "busy">): boolean {
  return p.id !== GITHUB_POOL && p.state === "ok" && p.slots !== null && p.slots > 0 &&
    p.busy >= p.slots;
}

/** A row's warning at `now`. */
export type JobWarning = "queued-long" | "queued-capacity" | "over-usual" | null;

/**
 * Whether a row is late: queued > 15 min (`queued-capacity` when its pool is full, which is just a
 * wait for a free slot), or running past its usual length.
 */
export function jobWarning(
  row: Pick<JobRow, "lane" | "since" | "usualMs" | "capacityWait">,
  now: number,
): JobWarning {
  const age = jobAge(row.since, now);
  if (row.lane === "queued") {
    if (age <= QUEUED_WARN_MS) return null;
    return row.capacityWait ? "queued-capacity" : "queued-long";
  }
  if (row.usualMs !== null && row.usualMs > 0) {
    const limit = Math.max(row.usualMs * OVER_USUAL_FACTOR, row.usualMs + OVER_USUAL_SLACK_MS);
    if (age > limit) return "over-usual";
  }
  return null;
}

/** The key the usual-length history is kept under. */
export function durationKey(repo: string, workflow: string, job: string): string {
  return `${repo}\u0000${workflow}\u0000${job}`;
}

/** The median of a list (`null` when empty). */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** A run being watched, with its repo. */
export interface ActiveRun {
  readonly repo: string;
  readonly run: GhRun;
}

/** The usual length lookup (median ms or `null`). */
export type UsualLookup = (repo: string, workflow: string, job: string) => number | null;

/** A run's group header. */
function runHeader(a: ActiveRun): Omit<RunGroup, "jobs" | "pendingJobs"> {
  const branch = a.run.head_branch ?? "";
  return {
    id: a.run.id,
    repo: a.repo,
    workflow: a.run.name ?? "workflow",
    title: a.run.display_title ?? "",
    branch,
    sha: a.run.head_sha.slice(0, 7),
    event: a.run.event,
    url: a.run.html_url,
    defaultBranch: DEFAULT_BRANCHES.has(branch),
  };
}

/** Repo order: the core repos first (in their order), then alphabetical. */
export function repoOrder(a: string, b: string): number {
  const ia = CORE_REPOS.indexOf(a);
  const ib = CORE_REPOS.indexOf(b);
  if (ia !== -1 || ib !== -1) return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  return a.localeCompare(b);
}

/**
 * Group the active runs' jobs into the Running and Queued lanes: repo → run → job. A run appears
 * in each lane it has jobs in; a queued run GitHub hasn't expanded into jobs yet appears in Queued
 * with `pendingJobs`, unless it is a ghost (no jobs past GHOST_RUN_MS: left out entirely). Runs
 * sort oldest first (by their oldest job), jobs by `since`.
 *
 * @param runs The active runs.
 * @param jobsByRun Each run's jobs (every status; completed ones are left out here).
 * @param usual The usual-length lookup.
 * @param now The clock, for the ghost-run cut-off.
 */
export function groupLanes(
  runs: readonly ActiveRun[],
  jobsByRun: ReadonlyMap<number, readonly GhJob[]>,
  usual: UsualLookup,
  now: number,
): { running: RepoGroup[]; queued: RepoGroup[] } {
  const lanes: Record<Lane, Map<string, RunGroup[]>> = { running: new Map(), queued: new Map() };
  for (const a of runs) {
    const header = runHeader(a);
    const jobs = jobsByRun.get(a.run.id) ?? [];
    const rows: Record<Lane, JobRow[]> = { running: [], queued: [] };
    for (const job of jobs) {
      const c = classifyJob(job);
      if (!c) continue;
      rows[c.lane].push({
        id: job.id,
        name: job.name,
        url: job.html_url ?? null,
        lane: c.lane,
        target: c.target,
        pool: c.pool,
        runner: c.lane === "running" ? job.runner_name || null : null,
        since: jobSince(job, c.lane),
        usualMs: usual(a.repo, header.workflow, job.name),
      });
    }
    const runStatus = laneOf(a.run.status ?? "queued");
    const noJobsYet = jobs.length === 0 && runStatus === "queued";
    if (noJobsYet && isGhostRun(a.run, now)) continue;
    for (const lane of ["running", "queued"] as const) {
      const list = rows[lane].sort((x, y) => x.since - y.since || x.id - y.id);
      if (list.length === 0 && !(lane === "queued" && noJobsYet)) continue;
      const repoRuns = lanes[lane].get(a.repo) ?? [];
      repoRuns.push({ ...header, pendingJobs: list.length === 0, jobs: list });
      lanes[lane].set(a.repo, repoRuns);
    }
  }
  const out = (m: Map<string, RunGroup[]>, runs: readonly ActiveRun[]): RepoGroup[] => {
    const created = new Map(runs.map((r) => [r.run.id, time(r.run.created_at) ?? 0]));
    const first = (g: RunGroup) => g.jobs[0]?.since ?? created.get(g.id) ?? 0;
    return [...m.entries()]
      .sort(([a], [b]) => repoOrder(a, b))
      .map(([repo, rs]) => ({
        repo,
        runs: rs.sort((x, y) => first(x) - first(y) || x.id - y.id),
      }));
  };
  return { running: out(lanes.running, runs), queued: out(lanes.queued, runs) };
}
