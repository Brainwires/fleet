// The agents' snapshot: what Fleet writes to `snapshot.json` in its data folder after every
// poll and every webhook-driven update, for the read-only MCP server (mcp/fleet-mcp.ts). Agents read
// CI state from it instead of each polling the GitHub API (whose 5,000-an-hour budget the runner
// scheduler shares). Plain JSON, snake_case like GitHub's own; times are ISO strings. Never a token,
// header or secret: only what the page's snapshot shows plus the runs' and jobs' public fields.
// Pure: the clock and the poller's state come in as values.

import { classifyJob } from "./classify.ts";
import { failedStep } from "./events.ts";
import type { GhJob, GhRun } from "./github-types.ts";
import type { HostHealth } from "./health.ts";
import type { Snapshot } from "./model.ts";
import { GITHUB_POOL, poolFromLabels, poolFromRunnerName } from "./pools.ts";

/** Finished runs stay in the file this long. */
export const AGENT_FINISHED_KEEP_MS = 2 * 60 * 60_000;
/** The backend rewrites the file at least this often (bumping `written_at`) while it runs. */
export const AGENT_HEARTBEAT_MS = 60_000;

/** One step of a job. */
export interface AgentStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
}

/** One workflow run. */
export interface AgentRun {
  readonly repo: string;
  readonly run_id: number;
  readonly workflow: string;
  readonly title: string;
  readonly branch: string;
  readonly sha: string;
  readonly event: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly attempt: number | null;
  readonly created_at: string | null;
  readonly started_at: string | null;
  /** The run's `updated_at` once it completed (GitHub has no `completed_at` on a run). */
  readonly completed_at: string | null;
  readonly html_url: string;
}

/** One job. */
export interface AgentJob {
  readonly repo: string;
  readonly run_id: number;
  readonly job_id: number;
  readonly name: string;
  readonly workflow: string;
  readonly branch: string;
  readonly sha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly created_at: string | null;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly html_url: string | null;
  readonly labels: readonly string[];
  readonly runner_name: string | null;
  /** The pool's short name (`mac-arm`), `github`, or `null` when nothing says. */
  readonly pool: string | null;
  readonly steps: readonly AgentStep[];
  /** For a failed job: the step that failed, when the job lists its steps. */
  readonly failed_step: string | null;
  /** For a failed job: the first failure annotation's first line, when Fleet read it. */
  readonly failure_annotation: string | null;
}

/** One pool card, as the window shows it. */
export interface AgentPool {
  readonly id: string;
  readonly label: string | null;
  readonly state: string;
  readonly reason: string;
  readonly slots: number | null;
  readonly busy: number;
  readonly running: number;
  readonly queued: number;
  readonly state_since: string | null;
  readonly oldest_queued_since: string | null;
}

/** One host (a pool on one machine) as the watchdog publishes it. */
export interface AgentHost {
  readonly id: string;
  readonly label: string | null;
  readonly ok: boolean;
  readonly paused: boolean;
  readonly reason: string;
  readonly slots: number | null;
  readonly busy: number | null;
  readonly since: string | null;
}

/** The whole file. */
export interface AgentSnapshot {
  readonly v: 1;
  /** When the data last changed hands: the last poll or webhook update. */
  readonly updated_at: string;
  /** When the backend last wrote the file (every update, and a heartbeat while it runs). */
  readonly written_at: string;
  readonly source: "poll" | "hook";
  readonly auth: string;
  readonly poll: {
    readonly ok: boolean;
    readonly message: string;
    readonly last_success_at: string | null;
    readonly interval_ms: number;
    readonly slow: string | null;
  };
  readonly rate:
    | { readonly remaining: number; readonly limit: number; readonly reset: string }
    | null;
  readonly hooks: { readonly state: string; readonly last_delivery_at: string | null };
  readonly health: {
    readonly state: string;
    readonly checked_at: string | null;
    readonly message: string;
  };
  readonly summary: {
    readonly running: number;
    readonly queued: number;
    readonly severity: string;
    readonly reasons: readonly string[];
  };
  readonly pools: readonly AgentPool[];
  readonly hosts: readonly AgentHost[];
  readonly alerts: readonly { readonly at: string; readonly pool: string; readonly msg: string }[];
  /** The event log's last `seq` when this was written. */
  readonly event_seq: number;
  readonly runs: readonly AgentRun[];
  readonly jobs: readonly AgentJob[];
}

/** A run the poller knows, with its jobs (active, or finished in the last 2 h). */
export interface KnownRun {
  readonly repo: string;
  readonly run: GhRun;
  readonly jobs: readonly GhJob[];
}

/** What the builder reads. */
export interface AgentSnapshotInput {
  readonly now: number;
  /** When the data last changed (the last poll or hook). */
  readonly updatedAt: number;
  readonly source: "poll" | "hook";
  readonly snapshot: Snapshot;
  readonly hosts: Readonly<Record<string, HostHealth>>;
  readonly runs: readonly KnownRun[];
  readonly annotations: ReadonlyMap<number, string>;
}

const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** A job's pool: the runner's name first, then its labels, else GitHub-hosted when it ran. */
function jobPool(job: GhJob): string | null {
  if (job.status !== "completed") return classifyJob(job)?.pool ?? null;
  const byRunner = job.runner_name ? poolFromRunnerName(job.runner_name) : null;
  if (byRunner) return byRunner;
  const byLabel = poolFromLabels(job.labels ?? []);
  if (byLabel) return byLabel;
  return job.runner_name ? GITHUB_POOL : null;
}

function agentRun(repo: string, run: GhRun): AgentRun {
  const done = run.status === "completed";
  return {
    repo,
    run_id: run.id,
    workflow: run.name ?? "workflow",
    title: run.display_title ?? "",
    branch: run.head_branch ?? "",
    sha: run.head_sha ?? "",
    event: run.event ?? "",
    status: run.status ?? "unknown",
    conclusion: run.conclusion ?? null,
    attempt: run.run_attempt ?? null,
    created_at: run.created_at ?? null,
    started_at: run.run_started_at ?? null,
    completed_at: done ? run.updated_at ?? null : null,
    html_url: run.html_url,
  };
}

function agentJob(
  repo: string,
  run: GhRun,
  job: GhJob,
  annotations: ReadonlyMap<number, string>,
): AgentJob {
  const failed = job.status === "completed" && FAILED.has(job.conclusion ?? "");
  return {
    repo,
    run_id: job.run_id,
    job_id: job.id,
    name: job.name,
    workflow: job.workflow_name ?? run.name ?? "workflow",
    branch: job.head_branch ?? run.head_branch ?? "",
    sha: run.head_sha ?? "",
    status: job.status,
    conclusion: job.conclusion ?? null,
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    html_url: job.html_url ?? null,
    labels: [...(job.labels ?? [])],
    runner_name: job.runner_name ?? null,
    pool: jobPool(job),
    steps: (job.steps ?? []).map((s) => ({
      name: s.name,
      status: s.status,
      conclusion: s.conclusion ?? null,
    })),
    failed_step: failed ? failedStep(job) : null,
    failure_annotation: failed ? annotations.get(job.id) ?? null : null,
  };
}

/** Build the file's content (`written_at` is `now`). */
export function buildAgentSnapshot(input: AgentSnapshotInput): AgentSnapshot {
  const s = input.snapshot;
  const runs = [...input.runs].sort((a, b) =>
    Date.parse(b.run.created_at) - Date.parse(a.run.created_at) || b.run.id - a.run.id
  );
  return {
    v: 1,
    updated_at: iso(input.updatedAt) ?? new Date(input.now).toISOString(),
    written_at: new Date(input.now).toISOString(),
    source: input.source,
    auth: s.auth,
    poll: {
      ok: s.poll.ok,
      message: s.poll.message,
      last_success_at: iso(s.poll.lastSuccessAt),
      interval_ms: s.poll.intervalMs,
      slow: s.poll.slow,
    },
    rate: s.rate
      ? { remaining: s.rate.remaining, limit: s.rate.limit, reset: iso(s.rate.resetAt) ?? "" }
      : null,
    hooks: { state: s.hooks.state, last_delivery_at: iso(s.hooks.lastDeliveryAt) },
    health: {
      state: s.health.state,
      checked_at: iso(s.health.checkedAt),
      message: s.health.message,
    },
    summary: {
      running: s.summary.running,
      queued: s.summary.queued,
      severity: s.summary.severity,
      reasons: [...s.summary.reasons],
    },
    pools: s.pools.map((p) => ({
      id: p.id,
      label: p.label,
      state: p.state,
      reason: p.reason,
      slots: p.slots,
      busy: p.busy,
      running: p.running,
      queued: p.queued,
      state_since: iso(p.since),
      oldest_queued_since: iso(p.oldestQueuedSince),
    })),
    hosts: Object.entries(input.hosts).map(([id, h]) => ({
      id,
      label: h.label,
      ok: h.ok,
      paused: h.paused,
      reason: h.reason,
      slots: h.slots,
      busy: h.busy,
      since: iso(h.since),
    })),
    alerts: s.alerts.map((a) => ({ at: iso(a.at) ?? "", pool: a.pool, msg: a.msg })),
    event_seq: s.eventSeq,
    runs: runs.map((r) => agentRun(r.repo, r.run)),
    jobs: runs.flatMap((r) => r.jobs.map((j) => agentJob(r.repo, r.run, j, input.annotations))),
  };
}
