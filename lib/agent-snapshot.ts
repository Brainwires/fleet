// The agents' snapshot: what Fleet writes to `snapshot.json` in its data folder after every
// poll and every webhook-driven update, for the read-only MCP server (mcp/fleet-mcp.ts). Agents read
// CI state from it instead of each polling the GitHub API (whose 5,000-an-hour budget the runner
// scheduler shares). Plain JSON, snake_case like GitHub's own; times are ISO strings. Never a token,
// header or secret: only what the page's snapshot shows plus the runs' and jobs' public fields.
// Pure: the clock and the poller's state come in as values.
//
// Run, job, step and branch names, titles and annotations are CI output: text whoever pushed or
// opened a PR chose, and data to an agent, never instructions. Every free-text string is capped
// (names 120, annotations 300) and stripped of control characters; for a fork or
// `pull_request_target` run (`untrusted: true`) the title, step names, failed step and annotation
// are wrapped as `{ untrusted: "<text>" }`, so no agent reads them as plain prose.

import { runProvenance } from "./classify.ts";

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

/** Names (runs, jobs, steps, branches, workflows) are at most this long in the file. */
export const AGENT_NAME_MAX = 120;
/** Annotations and other longer free text are at most this long. */
export const AGENT_NOTE_MAX = 300;

/** Text from a fork / pull_request_target run: someone else's, wrapped so it can't pass as prose. */
export interface UntrustedText {
  readonly untrusted: string;
}

/** A free-text field: plain (capped), or wrapped when the run is untrusted. */
export type AgentText = string | UntrustedText;

/**
 * Free text fit for an agent: control characters (newlines included) and bidi overrides become
 * spaces, runs of space collapse, capped at `max` with "…".
 */
export function capText(text: string, max: number): string {
  const t = text
    .replace(/[\p{Cc}\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Capped text, wrapped when `untrusted`. */
export function agentText(text: string, max: number, untrusted: boolean): AgentText {
  const t = capText(text, max);
  return untrusted ? { untrusted: t } : t;
}

/** One step of a job. */
export interface AgentStep {
  readonly name: AgentText;
  readonly status: string;
  readonly conclusion: string | null;
}

/** One workflow run. */
export interface AgentRun {
  readonly repo: string;
  readonly run_id: number;
  readonly workflow: string;
  /** The run's title (a commit message or PR title): wrapped for an untrusted run. */
  readonly title: AgentText;
  readonly branch: string;
  readonly sha: string;
  readonly event: string;
  // The provenance fields are always written; optional only because a file from an older Fleet
  // build lacks them.
  /** Who started this attempt, when GitHub reports it. */
  readonly actor?: string | null;
  /** The repo the head commit came from (`owner/name`), when reported. */
  readonly head_repository?: string | null;
  /** The head repo isn't this repo: a fork PR. */
  readonly fork?: boolean;
  /** A fork or pull_request_target run: its free text is someone else's (wrapped). */
  readonly untrusted?: boolean;
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
  /** The run's event, actor and provenance (see AgentRun; always written by this build). */
  readonly event?: string;
  readonly actor?: string | null;
  readonly head_repository?: string | null;
  readonly fork?: boolean;
  readonly untrusted?: boolean;
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
  readonly failed_step: AgentText | null;
  /** For a failed job: the first failure annotation's first line (≤ 300), when Fleet read it. */
  readonly failure_annotation: AgentText | null;
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
  /** GitHub's clock minus this machine's (ms): add it to now before aging a GitHub timestamp. */
  readonly clock_offset_ms?: number;
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

const name = (s: string) => capText(s, AGENT_NAME_MAX);

/** A run's provenance fields, shared by the run and its jobs. */
function provenanceOf(repo: string, run: GhRun) {
  const p = runProvenance(repo, run);
  return {
    event: capText(p.event, 40),
    actor: p.actor === null ? null : name(p.actor),
    head_repository: p.headRepo === null ? null : name(p.headRepo),
    fork: p.fork,
    untrusted: p.untrusted,
  };
}

function agentRun(repo: string, run: GhRun): AgentRun {
  const done = run.status === "completed";
  const prov = provenanceOf(repo, run);
  return {
    repo,
    run_id: run.id,
    workflow: name(run.name ?? "workflow"),
    title: agentText(run.display_title ?? "", AGENT_NAME_MAX, prov.untrusted),
    branch: name(run.head_branch ?? ""),
    sha: run.head_sha ?? "",
    ...prov,
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
  const prov = provenanceOf(repo, run);
  const step = failed ? failedStep(job) : null;
  const note = failed ? annotations.get(job.id) ?? null : null;
  return {
    repo,
    run_id: job.run_id,
    job_id: job.id,
    name: name(job.name),
    workflow: name(job.workflow_name ?? run.name ?? "workflow"),
    branch: name(job.head_branch ?? run.head_branch ?? ""),
    sha: run.head_sha ?? "",
    ...prov,
    status: job.status,
    conclusion: job.conclusion ?? null,
    created_at: job.created_at ?? null,
    started_at: job.started_at ?? null,
    completed_at: job.completed_at ?? null,
    html_url: job.html_url ?? null,
    labels: (job.labels ?? []).map(name),
    runner_name: job.runner_name ? name(job.runner_name) : null,
    pool: jobPool(job),
    steps: (job.steps ?? []).map((s) => ({
      name: agentText(s.name, AGENT_NAME_MAX, prov.untrusted),
      status: s.status,
      conclusion: s.conclusion ?? null,
    })),
    failed_step: step === null ? null : agentText(step, AGENT_NAME_MAX, prov.untrusted),
    failure_annotation: note === null ? null : agentText(note, AGENT_NOTE_MAX, prov.untrusted),
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
      message: capText(s.poll.message, AGENT_NOTE_MAX),
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
      message: capText(s.health.message, AGENT_NOTE_MAX),
    },
    summary: {
      running: s.summary.running,
      queued: s.summary.queued,
      severity: s.summary.severity,
      reasons: s.summary.reasons.map((r) => capText(r, AGENT_NOTE_MAX)),
    },
    pools: s.pools.map((p) => ({
      id: p.id,
      label: p.label,
      state: p.state,
      reason: capText(p.reason, AGENT_NOTE_MAX),
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
      reason: capText(h.reason, AGENT_NOTE_MAX),
      slots: h.slots,
      busy: h.busy,
      since: iso(h.since),
    })),
    alerts: s.alerts.map((a) => ({
      at: iso(a.at) ?? "",
      pool: name(a.pool),
      msg: capText(a.msg, AGENT_NOTE_MAX),
    })),
    event_seq: s.eventSeq,
    clock_offset_ms: s.clockOffsetMs ?? 0,
    runs: runs.map((r) => agentRun(r.repo, r.run)),
    jobs: runs.flatMap((r) => r.jobs.map((j) => agentJob(r.repo, r.run, j, input.annotations))),
  };
}
