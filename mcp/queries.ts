// The MCP server's answers, pure: freshness, the tools' filters, event paging and fleet_wait's
// trigger. The files come in as values (mcp/fleet-mcp.ts reads them), the clock as a number, so
// the tests drive every tool from fixtures.

import type { AgentJob, AgentRun, AgentSnapshot } from "../lib/agent-snapshot.ts";
import type { FleetEvent } from "../lib/events.ts";

/** Fleet counts as running while it wrote the snapshot this recently. */
export const RUNNING_WITHIN_MS = 2 * 60_000;
/** Older than this, the data is stale: agents should fall back to the GitHub API. */
export const STALE_AFTER_MS = 5 * 60_000;
/** fleet_wait's longest wait. */
export const MAX_WAIT_S = 1800;
/** fleet_wait's default wait. */
export const DEFAULT_WAIT_S = 600;

/** Every answer's freshness block. */
export interface Freshness {
  /** When the data last changed hands (Fleet's last poll or webhook update), ISO, or `null`. */
  readonly as_of: string | null;
  /** Seconds since `as_of`. */
  readonly age_s: number | null;
  /** When Fleet last wrote the snapshot (every update and a heartbeat each minute). */
  readonly written_at: string | null;
  /** Fleet wrote the snapshot in the last 2 min. */
  readonly fleet_running: boolean;
  /** Don't rely on this answer: see `warning`. */
  readonly stale: boolean;
  readonly warning?: string;
}

const FALLBACK = "Fall back to gh / the GitHub API for anything that matters.";

/**
 * How fresh the snapshot is. Stale when Fleet hasn't written it for 5 min (not running), or when
 * its data is over 5 min old and webhooks aren't live (with live webhooks a quiet fleet changes
 * nothing, and the heartbeat says Fleet is still listening).
 */
export function freshness(snap: AgentSnapshot | null, now: number): Freshness {
  if (!snap) {
    return {
      as_of: null,
      age_s: null,
      written_at: null,
      fleet_running: false,
      stale: true,
      warning:
        `STALE: Fleet has written no snapshot (not running, or a build without the MCP files). ${FALLBACK}`,
    };
  }
  const updated = Date.parse(snap.updated_at);
  const written = Date.parse(snap.written_at ?? snap.updated_at);
  const age = Number.isFinite(updated) ? now - updated : Infinity;
  const writtenAge = Number.isFinite(written) ? now - written : Infinity;
  const running = writtenAge < RUNNING_WITHIN_MS;
  const stale = writtenAge > STALE_AFTER_MS ||
    (snap.hooks?.state !== "live" && age > STALE_AFTER_MS);
  const min = (ms: number) => Number.isFinite(ms) ? `${Math.round(ms / 60_000)} min` : "unknown";
  const out: Freshness = {
    as_of: snap.updated_at,
    age_s: Number.isFinite(age) ? Math.round(age / 1000) : null,
    written_at: snap.written_at ?? null,
    fleet_running: running,
    stale,
  };
  if (stale) {
    return {
      ...out,
      warning: `STALE: Fleet's data is ${min(age)} old and it last wrote ${min(writtenAge)} ago; ${
        running ? "its polls are failing or slowed" : "Fleet may not be running"
      }. ${FALLBACK}`,
    };
  }
  if (snap.auth === "needs-token" || snap.auth === "invalid") {
    return {
      ...out,
      warning: `Fleet has no usable GitHub token (${snap.auth}): no data. ${FALLBACK}`,
    };
  }
  if (!snap.poll.ok && snap.poll.message) {
    return { ...out, warning: `Fleet's last poll failed: ${snap.poll.message}` };
  }
  return out;
}

// ---- argument checking (the JSON schemas in fleet-mcp.ts say the same) ----

/** A tool argument error: the server answers it as a tool error the agent can read. */
export class ArgError extends Error {}

type Args = Record<string, unknown>;

function optString(a: Args, k: string): string | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length > 200) throw new ArgError(`${k} must be a string`);
  return v;
}

function optInt(a: Args, k: string, min: number, max: number): number | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
    throw new ArgError(`${k} must be an integer from ${min} to ${max}`);
  }
  return v;
}

function optIds(a: Args, k: string): number[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 200 || !v.every((n) => Number.isSafeInteger(n) && n > 0)) {
    throw new ArgError(`${k} must be an array of positive integer ids`);
  }
  return v as number[];
}

function optStrings(a: Args, k: string): string[] | undefined {
  const v = a[k];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > 50 || !v.every((s) => typeof s === "string")) {
    throw new ArgError(`${k} must be an array of strings`);
  }
  return v as string[];
}

/** `Brainwires/denext`, or `denext` for any owner. Case-insensitive. */
export function repoMatches(filter: string, repo: string): boolean {
  const f = filter.toLowerCase();
  const r = repo.toLowerCase();
  return r === f || r.endsWith(`/${f}`);
}

/** A run or job status filter: a GitHub status, or `active` for anything not completed. */
function statusMatches(filter: string, status: string): boolean {
  if (filter === "active") return status !== "completed";
  return status === filter;
}

/** Conclusions that count as a failure. */
export const FAILED_CONCLUSIONS: ReadonlySet<string> = new Set([
  "failure",
  "timed_out",
  "startup_failure",
]);

const isFailed = (c: string | null) => c !== null && FAILED_CONCLUSIONS.has(c);

// ---- fleet_status ----

/** The watchdog's local health file (`~/.denext-runners/health.json`), as read. */
export interface WatchdogFile {
  readonly checked_at_epoch?: unknown;
  readonly pools?: Record<string, unknown>;
}

/** fleet_status's answer. */
export function statusResult(
  snap: AgentSnapshot | null,
  now: number,
  extra: { watchdog: WatchdogFile | null; hooksSpoolAt: number | null },
) {
  const fresh = freshness(snap, now);
  const wd = extra.watchdog;
  const wdAt = typeof wd?.checked_at_epoch === "number" ? wd.checked_at_epoch * 1000 : null;
  const watchdog = wd && wdAt !== null
    ? {
      checked_at: new Date(wdAt).toISOString(),
      age_s: Math.round((now - wdAt) / 1000),
      pools: Object.fromEntries(
        Object.entries(wd.pools ?? {}).map(([id, raw]) => {
          const p = (raw ?? {}) as Record<string, unknown>;
          return [id, {
            healthy: p.healthy === true,
            ...(typeof p.reason === "string" && p.reason ? { reason: p.reason } : {}),
          }];
        }),
      ),
    }
    : null;
  const hooksSpool = extra.hooksSpoolAt === null ? null : {
    last_write_at: new Date(extra.hooksSpoolAt).toISOString(),
    age_s: Math.round((now - extra.hooksSpoolAt) / 1000),
  };
  if (!snap) return { ...fresh, watchdog, hooks_spool: hooksSpool };
  const waitS = (iso: string | null) =>
    iso === null ? null : Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  const pools = snap.pools.map((p) => ({ ...p, oldest_wait_s: waitS(p.oldest_queued_since) }));
  let oldest: { pool: string; wait_s: number } | null = null;
  for (const p of pools) {
    if (p.oldest_wait_s !== null && (!oldest || p.oldest_wait_s > oldest.wait_s)) {
      oldest = { pool: p.id, wait_s: p.oldest_wait_s };
    }
  }
  return {
    ...fresh,
    fleet: {
      auth: snap.auth,
      poll: snap.poll,
      hooks: snap.hooks,
      health: snap.health,
      severity: snap.summary.severity,
      reasons: snap.summary.reasons,
    },
    rate: snap.rate,
    queue: {
      running: snap.summary.running,
      queued: snap.summary.queued,
      oldest_wait_s: oldest?.wait_s ?? null,
      oldest_wait_pool: oldest?.pool ?? null,
    },
    pools,
    hosts: snap.hosts,
    alerts: snap.alerts.slice(0, 5),
    watchdog,
    hooks_spool: hooksSpool,
  };
}

// ---- fleet_runs / fleet_jobs ----

/** A run with its jobs' counts. */
function runWithCounts(run: AgentRun, jobs: readonly AgentJob[]) {
  const mine = jobs.filter((j) => j.run_id === run.run_id);
  const count = (f: (j: AgentJob) => boolean) => mine.filter(f).length;
  return {
    ...run,
    jobs: {
      total: mine.length,
      queued: count((j) => j.status !== "completed" && j.status !== "in_progress"),
      in_progress: count((j) => j.status === "in_progress"),
      completed: count((j) => j.status === "completed"),
      failed: mine.filter((j) => isFailed(j.conclusion)).map((j) => ({
        job_id: j.job_id,
        name: j.name,
        failed_step: j.failed_step,
      })),
    },
  };
}

/** fleet_runs's answer. */
export function runsResult(snap: AgentSnapshot | null, now: number, args: Args) {
  const repo = optString(args, "repo");
  const branch = optString(args, "branch");
  const sha = optString(args, "sha");
  const status = optString(args, "status");
  const limit = optInt(args, "limit", 1, 200) ?? 50;
  const fresh = freshness(snap, now);
  const all = (snap?.runs ?? []).filter((r) =>
    (!repo || repoMatches(repo, r.repo)) &&
    (!branch || r.branch === branch) &&
    (!sha || r.sha.toLowerCase().startsWith(sha.toLowerCase())) &&
    (!status || statusMatches(status, r.status))
  );
  return {
    ...fresh,
    total: all.length,
    truncated: all.length > limit,
    runs: all.slice(0, limit).map((r) => runWithCounts(r, snap?.jobs ?? [])),
  };
}

/** A job for an answer: steps only for a failed job, or when asked for one run's jobs. */
function jobOut(j: AgentJob, steps: boolean) {
  if (steps || isFailed(j.conclusion)) return j;
  const { steps: _omit, ...rest } = j;
  return rest;
}

/** fleet_jobs's answer. */
export function jobsResult(snap: AgentSnapshot | null, now: number, args: Args) {
  const runId = optInt(args, "run_id", 1, Number.MAX_SAFE_INTEGER);
  const repo = optString(args, "repo");
  const status = optString(args, "status");
  const conclusion = optString(args, "conclusion");
  const pool = optString(args, "pool");
  const limit = optInt(args, "limit", 1, 500) ?? 100;
  const fresh = freshness(snap, now);
  const all = (snap?.jobs ?? []).filter((j) =>
    (runId === undefined || j.run_id === runId) &&
    (!repo || repoMatches(repo, j.repo)) &&
    (!status || statusMatches(status, j.status)) &&
    (!conclusion ||
      (conclusion === "failed" ? isFailed(j.conclusion) : j.conclusion === conclusion)) &&
    (!pool || j.pool === pool)
  );
  return {
    ...fresh,
    total: all.length,
    truncated: all.length > limit,
    jobs: all.slice(0, limit).map((j) => jobOut(j, runId !== undefined)),
  };
}

// ---- fleet_events ----

/** An event for an answer (its time as ISO). */
export function eventOut(e: FleetEvent) {
  return { ...e, at: new Date(e.at).toISOString() };
}

/** The run and job an event is about: its own fields, else parsed from its link. */
export function eventIds(e: FleetEvent): { run: number | null; job: number | null } {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(e.url ?? "");
  return {
    run: e.run_id ?? (m ? Number(m[1]) : null),
    job: e.job_id ?? (m?.[2] ? Number(m[2]) : null),
  };
}

/** fleet_events's answer: page forward from `since_seq` with `next_seq`. */
export function eventsResult(
  snap: AgentSnapshot | null,
  events: readonly FleetEvent[],
  now: number,
  args: Args,
) {
  const since = optInt(args, "since_seq", 0, Number.MAX_SAFE_INTEGER);
  const kinds = optStrings(args, "kinds");
  const repo = optString(args, "repo");
  const limit = optInt(args, "limit", 1, 500) ?? 100;
  const last = events.at(-1)?.seq ?? 0;
  const first = events[0]?.seq ?? 0;
  const match = (e: FleetEvent) =>
    (!kinds || kinds.includes(e.kind)) && (!repo || repoMatches(repo, e.repo));
  let out: FleetEvent[];
  let next: number;
  let more = false;
  if (since === undefined) {
    // No cursor: the newest `limit` matches, and the cursor to follow from here.
    out = events.filter(match).slice(-limit);
    next = Math.max(last, snap?.event_seq ?? 0);
  } else {
    const after = events.filter((e) => e.seq > since && match(e));
    out = after.slice(0, limit);
    more = after.length > limit;
    // With nothing more to return, skip past what didn't match so the next call starts there.
    next = more ? out.at(-1)!.seq : Math.max(since, last);
  }
  return {
    ...freshness(snap, now),
    events: out.map(eventOut),
    next_seq: next,
    has_more: more,
    ...(since !== undefined && events.length > 0 && since + 1 < first
      ? { gap: `events ${since + 1}..${first - 1} are no longer kept` }
      : {}),
  };
}

// ---- fleet_wait ----

/** What fleet_wait waits for. */
export type WaitUntil = "any_failure" | "completed" | "first_event";

/** fleet_wait's checked arguments. */
export interface WaitArgs {
  readonly runIds: readonly number[];
  readonly jobIds: readonly number[];
  readonly until: WaitUntil;
  readonly timeoutS: number;
}

/** Check fleet_wait's arguments. */
export function waitArgs(args: Args): WaitArgs {
  const runIds = optIds(args, "run_ids") ?? [];
  const jobIds = optIds(args, "job_ids") ?? [];
  const until = args.until;
  if (until !== "any_failure" && until !== "completed" && until !== "first_event") {
    throw new ArgError(`until must be "any_failure", "completed" or "first_event"`);
  }
  if (until !== "first_event" && runIds.length === 0 && jobIds.length === 0) {
    throw new ArgError(`until "${until}" needs run_ids or job_ids`);
  }
  const timeoutS = optInt(args, "timeout_s", 1, MAX_WAIT_S) ?? DEFAULT_WAIT_S;
  return { runIds, jobIds, until, timeoutS };
}

/** Why fleet_wait returned. */
export type WaitTrigger = "failure" | "completed" | "event" | "timeout" | "stale";

/** The targeted runs and jobs now. */
function targets(snap: AgentSnapshot | null, w: WaitArgs) {
  const runs = (snap?.runs ?? []).filter((r) => w.runIds.includes(r.run_id));
  const jobs = (snap?.jobs ?? []).filter((j) =>
    w.jobIds.includes(j.job_id) || w.runIds.includes(j.run_id)
  );
  return {
    runs,
    jobs,
    missingRuns: w.runIds.filter((id) => !runs.some((r) => r.run_id === id)),
    missingJobs: w.jobIds.filter((id) => !jobs.some((j) => j.job_id === id)),
  };
}

/**
 * Whether the wait is over: `null` while it isn't. `events` are those logged since the wait began.
 * A failure (a targeted job, or a targeted run, concluding failure / timed_out / startup_failure)
 * ends `any_failure`; every target completed ends `any_failure` and `completed`; a new event about
 * a target (any event without targets) ends `first_event`.
 */
export function waitTrigger(
  snap: AgentSnapshot | null,
  events: readonly FleetEvent[],
  w: WaitArgs,
): WaitTrigger | null {
  if (w.until === "first_event") {
    return events.some((e) => eventMatches(e, w)) ? "event" : null;
  }
  const t = targets(snap, w);
  if (
    w.until === "any_failure" &&
    (t.jobs.some((j) => isFailed(j.conclusion)) || t.runs.some((r) => isFailed(r.conclusion)))
  ) {
    return "failure";
  }
  const done = t.missingRuns.length === 0 && t.missingJobs.length === 0 &&
    t.runs.every((r) => r.status === "completed") &&
    w.jobIds.every((id) => t.jobs.find((j) => j.job_id === id)?.status === "completed");
  return done ? "completed" : null;
}

function eventMatches(e: FleetEvent, w: WaitArgs): boolean {
  if (w.runIds.length === 0 && w.jobIds.length === 0) return true;
  const ids = eventIds(e);
  return (ids.run !== null && w.runIds.includes(ids.run)) ||
    (ids.job !== null && w.jobIds.includes(ids.job));
}

/** fleet_wait's answer. */
export function waitResult(
  snap: AgentSnapshot | null,
  events: readonly FleetEvent[],
  w: WaitArgs,
  triggered: WaitTrigger,
  now: number,
  waitedMs: number,
  lastSeq: number,
) {
  const t = targets(snap, w);
  const job = (j: AgentJob) => ({
    job_id: j.job_id,
    run_id: j.run_id,
    name: j.name,
    status: j.status,
    conclusion: j.conclusion,
    ...(isFailed(j.conclusion)
      ? { failed_step: j.failed_step, failure_annotation: j.failure_annotation }
      : {}),
    html_url: j.html_url,
  });
  const matching = events.filter((e) => eventMatches(e, w));
  return {
    triggered,
    waited_s: Math.round(waitedMs / 1000),
    ...freshness(snap, now),
    runs: t.runs,
    failed_jobs: t.jobs.filter((j) => isFailed(j.conclusion)).map(job),
    // Every targeted job not yet successful (all of them for job_ids), to keep the answer short.
    jobs: t.jobs
      .filter((j) => w.jobIds.includes(j.job_id) || j.conclusion !== "success")
      .map(job),
    jobs_succeeded: t.jobs.filter((j) => j.conclusion === "success").length,
    events: matching.slice(-50).map(eventOut),
    // The cursor for fleet_events from here.
    next_seq: lastSeq,
    ...(t.missingRuns.length || t.missingJobs.length
      ? {
        missing: {
          run_ids: t.missingRuns,
          job_ids: t.missingJobs,
          note:
            "Not in Fleet's snapshot (not seen yet, or finished over 2 h ago): check with gh if it persists.",
        },
      }
      : {}),
  };
}
