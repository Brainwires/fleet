// Where the history comes from: the poller's finished jobs (live), its pool cards (samples), and,
// for the first-run back-fill, the jobs' intervals as the event journal and the webhook spool tell
// them. Pure apart from the pool lookups (lib/pools.ts), which follow the current settings.

import { classifyJob, githubImage, time } from "./classify.ts";
import type { FleetEvent } from "./events.ts";
import type { GhJob, GhRun } from "./github-types.ts";
import type { HookDelivery } from "./hooks.ts";
import type { JobInterval, JobRecord, PoolSample } from "./history.ts";
import { imageKey } from "./history.ts";
import type { JobRow, PoolCard } from "./model.ts";
import { GITHUB_POOL } from "./pools.ts";

/** A completed job as the poller saw it: the record the history keeps. */
export function jobRecord(
  repo: string,
  run: Pick<GhRun, "name">,
  job: GhJob,
  pool: string,
): JobRecord | null {
  const completed = time(job.completed_at);
  if (job.status !== "completed" || completed === null || job.conclusion === "skipped") return null;
  return {
    id: job.id,
    runId: job.run_id,
    repo,
    workflow: run.name ?? job.workflow_name ?? "workflow",
    name: job.name,
    pool,
    image: pool === GITHUB_POOL ? githubImage(job.labels) : null,
    runner: job.runner_name || null,
    created: time(job.created_at),
    // GitHub stamps `started_at` on a job that never got a runner (cancelled while queued): it
    // didn't run, so it has no start and no length.
    started: job.runner_name ? time(job.started_at) : null,
    completed,
    conclusion: job.conclusion ?? "unknown",
    url: job.html_url ?? null,
  };
}

/**
 * The samples of one moment: every pool card, plus one per GitHub image that has a running or
 * queued job, and a zero for each image series held that has none now (so it drops to idle).
 */
export function poolSamples(
  cards: readonly PoolCard[],
  running: readonly JobRow[],
  queued: readonly JobRow[],
  now: number,
  heldImages: readonly string[] = [],
): PoolSample[] {
  const out: PoolSample[] = cards.map((c) => ({
    key: c.id,
    busy: c.busy,
    slots: c.slots,
    queued: c.queued,
    waitMs: c.oldestQueuedSince === null ? 0 : Math.max(0, now - c.oldestQueuedSince),
    paused: c.state === "paused",
    unhealthy: c.state === "unhealthy",
  }));
  const images = new Map<string, { busy: number; queued: number; oldest: number | null }>();
  const at = (img: string) => {
    let v = images.get(img);
    if (!v) images.set(img, v = { busy: 0, queued: 0, oldest: null });
    return v;
  };
  for (const r of running) if (r.target === "github" && r.image) at(r.image).busy++;
  for (const r of queued) {
    if (r.target !== "github" || !r.image) continue;
    const v = at(r.image);
    v.queued++;
    v.oldest = v.oldest === null ? r.since : Math.min(v.oldest, r.since);
  }
  for (const k of heldImages) {
    const img = k.startsWith("github:") ? k.slice(7) : k;
    if (!images.has(img)) images.set(img, { busy: 0, queued: 0, oldest: null });
  }
  for (const [img, v] of images) {
    out.push({
      key: imageKey(img),
      busy: v.busy,
      slots: null,
      queued: v.queued,
      waitMs: v.oldest === null ? 0 : Math.max(0, now - v.oldest),
    });
  }
  return out;
}

/** A spool delivery's job, or `null` for anything else. */
function spoolJob(d: HookDelivery): { repo: string; job: GhJob } | null {
  if (d.event !== "workflow_job") return null;
  const p = d.payload as { workflow_job?: unknown; repository?: { full_name?: unknown } };
  const j = p.workflow_job as GhJob | undefined;
  const repo = typeof p.repository?.full_name === "string" ? p.repository.full_name : null;
  if (!j || typeof j.id !== "number" || !repo) return null;
  return { repo, job: j };
}

/** Where a job ran or would run: its pool id, or `github`. */
function poolOf(job: GhJob): string {
  const c = classifyJob({
    ...job,
    status: job.status === "completed" ? (job.started_at ? "in_progress" : "queued") : job.status,
  });
  return c?.pool ?? GITHUB_POOL;
}

/** The intervals the webhook spool records (each job's newest delivery wins). */
export function intervalsFromSpool(deliveries: readonly HookDelivery[]): Map<number, JobInterval> {
  const out = new Map<number, JobInterval>();
  for (const d of deliveries) {
    const s = spoolJob(d);
    if (!s) continue;
    const { job, repo } = s;
    const prev = out.get(job.id);
    const created = time(job.created_at) ?? prev?.created ?? null;
    // `started_at` counts only once a runner took the job (GitHub stamps it on queued jobs too).
    const started = (job.runner_name ? time(job.started_at) : null) ?? prev?.started ?? null;
    const completed = job.status === "completed"
      ? time(job.completed_at) ?? prev?.completed ?? null
      : prev?.completed ?? null;
    const pool = job.runner_name || !prev ? poolOf(job) : prev.pool;
    out.set(job.id, {
      id: job.id,
      runId: job.run_id,
      repo,
      workflow: job.workflow_name ?? prev?.workflow ?? "workflow",
      name: job.name,
      pool,
      image: pool === GITHUB_POOL ? githubImage(job.labels) ?? prev?.image ?? null : null,
      runner: job.runner_name || prev?.runner || null,
      created,
      started,
      completed,
      conclusion: job.status === "completed"
        ? job.conclusion ?? "unknown"
        : prev?.conclusion ?? null,
      url: job.html_url ?? prev?.url ?? null,
    });
  }
  return out;
}

/** `queued for <pool>` / `started on <pool>[ on <runner>]` / `finished: <conclusion>`. */
const QUEUED = /^queued for (\S+)/;
const STARTED = /^started on (\S+)(?: on (.+))?$/;
const FINISHED = /^finished: (\S+)/;

/** The pool id a journal line names (`GitHub-hosted` is `github`). */
const journalPool = (s: string) => (s === "GitHub-hosted" ? GITHUB_POOL : s);

/** The intervals the event journal records (queued / started / finished lines by job id). */
export function intervalsFromJournal(events: readonly FleetEvent[]): Map<number, JobInterval> {
  type Draft = {
    -readonly [K in keyof JobInterval]: JobInterval[K];
  };
  const out = new Map<number, Draft>();
  for (const e of events) {
    // A run that completed or was cancelled ends its jobs still open (a burst of cancellations is
    // logged as one run line, with no line per job).
    if ((e.kind === "run-completed" || e.kind === "run-cancelled") && e.run_id !== undefined) {
      for (const d of out.values()) {
        if (d.runId !== e.run_id || d.completed !== null) continue;
        d.completed = e.at;
        if (e.kind === "run-cancelled") d.conclusion = "cancelled";
      }
      continue;
    }
    if (typeof e.job_id !== "number") continue;
    let d = out.get(e.job_id);
    if (!d) {
      d = {
        id: e.job_id,
        runId: e.run_id ?? 0,
        repo: e.repo,
        workflow: e.workflow,
        name: e.job ?? "job",
        pool: "",
        image: null,
        runner: null,
        created: null,
        started: null,
        completed: null,
        conclusion: null,
        url: e.url,
      };
      out.set(e.job_id, d);
    }
    let m: RegExpExecArray | null;
    if (e.kind === "queued" && (m = QUEUED.exec(e.text))) {
      d.created = e.at;
      if (!d.pool) d.pool = journalPool(m[1]);
    } else if (e.kind === "started" && (m = STARTED.exec(e.text))) {
      d.started = e.at;
      d.pool = journalPool(m[1]);
      d.runner = m[2] ?? null;
    } else if (e.kind === "finished" && (m = FINISHED.exec(e.text))) {
      d.completed = e.at;
      d.conclusion = m[1];
    }
  }
  for (const [id, d] of out) if (!d.pool) out.delete(id);
  return out as Map<number, JobInterval>;
}

/**
 * The back-fill's intervals: the spool's where it has the job (GitHub's own times), the journal's
 * otherwise. A job with neither a start nor an end (queued only, long ago) is left out.
 */
export function backfillIntervals(
  journal: readonly FleetEvent[],
  spool: readonly HookDelivery[],
  now: number,
): JobInterval[] {
  const merged = intervalsFromJournal(journal);
  for (const [id, j] of intervalsFromSpool(spool)) merged.set(id, j);
  const stale = 6 * 3600_000;
  return [...merged.values()].filter((j) => {
    if (j.conclusion === "skipped") return false; // never ran (the live records skip them too)
    if (j.completed !== null) return true;
    // Never finished in the records: still running / queued only when recent, else lost.
    const since = j.started ?? j.created;
    return since !== null && now - since < stale;
  });
}
