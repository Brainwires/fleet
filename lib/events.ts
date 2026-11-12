// The event log: one line per thing that happened, derived by diffing successive polls. Pure: the
// tracker's state is plain JSON (persisted beside the log), the clock comes in the observation.
//
// - job queued, started (runner / pool), finished (conclusion; for a failure the failed step and
//   the first failure annotation);
// - job STALLED (running past 75 min) and QUEUED-LONG (past 25 min with no runner), once each and
//   again every 30 min;
// - run completed with its conclusion; a burst of cancelled jobs from one run in one round is ONE
//   line ("run N cancelled (14 jobs)");
// - pool health changes and new alerts from DENEXT_POOL_HEALTH.
//
// The first observation (and the first after a restart with state older than RESEED_MS) only
// records: no flood of "queued" / "started" lines for everything already in flight.

import { classifyJob, poolIsFull, runProvenance, time } from "./classify.ts";
import type { GhJob, GhRun } from "./github-types.ts";
import type { HealthState } from "./health.ts";
import type { Observation } from "./poller.ts";
import { currentPools, GITHUB_POOL, poolIdOfLabel, runnerHostRule } from "./pools.ts";

/** A line's severity: drawn as a colour AND a glyph. */
export type EventSeverity = "info" | "ok" | "warn" | "bad" | "muted";

/** What kind of event. */
export type EventKind =
  | "queued"
  | "started"
  | "finished"
  | "stalled"
  | "queued-long"
  | "run-completed"
  | "run-cancelled"
  | "pool-health"
  | "alert"
  | "action";

/** One log line. */
export interface FleetEvent {
  /** Increasing; the page asks for events after the last one it has. */
  readonly seq: number;
  readonly at: number;
  readonly sev: EventSeverity;
  readonly kind: EventKind;
  /** `Brainwires/denext`, or `""` for a pool event. */
  readonly repo: string;
  readonly workflow: string;
  readonly job: string | null;
  readonly text: string;
  readonly url: string | null;
  readonly branch?: string;
  /** The workflow run this line is about (job and run lines). */
  readonly run_id?: number;
  /** The job this line is about (job lines). */
  readonly job_id?: number;
  /** Logged for something the user did in Fleet (a control). */
  readonly user?: boolean;
  /**
   * Back-filled at startup from the webhook spool: it happened while Fleet was closed, and `at` is
   * the delivery's real time (no notification is ever posted for it).
   */
  readonly backfill?: boolean;
  /**
   * About a fork or `pull_request_target` run: its names are someone else's text, and its failed
   * step and annotation are left out of `text`.
   */
  readonly untrusted?: boolean;
}

/** An event before the log numbers it. */
export type NewEvent = Omit<FleetEvent, "seq">;

/** Running longer than this is STALLED. */
export const STALL_MS = 75 * 60_000;
/** Queued with no runner longer than this is QUEUED-LONG. */
export const QUEUE_LONG_MS = 25 * 60_000;
/** STALLED / QUEUED-LONG repeat this often. */
export const REPEAT_MS = 30 * 60_000;
/** Tracker state older than this at a restart is re-seeded silently (no catch-up flood). */
export const RESEED_MS = 15 * 60_000;
/** The log keeps this many lines. */
export const LOG_LIMIT = 2000;

interface TrackedJob {
  status: string;
  /** When the last STALLED / QUEUED-LONG line went out. */
  warnedAt?: number;
}

/** The tracker's state: plain JSON. */
export interface TrackerState {
  readonly v: 1;
  savedAt: number;
  seeded: boolean;
  jobs: Record<string, TrackedJob>;
  runs: Record<string, { status: string }>;
  pools: Record<string, { ok: boolean; paused: boolean }>;
  /** Alert keys seen (the newest 200). */
  alerts: string[];
}

/** A fresh tracker. */
export function newTracker(): TrackerState {
  return { v: 1, savedAt: 0, seeded: false, jobs: {}, runs: {}, pools: {}, alerts: [] };
}

/**
 * A tracker restored from storage: garbage gives a fresh one, and one saved longer than
 * {@linkcode RESEED_MS} ago is re-seeded (it records the next observation without events).
 */
export function restoreTracker(raw: unknown, now: number): TrackerState {
  const t = raw as Partial<TrackerState> | null;
  if (!t || t.v !== 1 || typeof t.jobs !== "object" || typeof t.runs !== "object") {
    return newTracker();
  }
  const state: TrackerState = {
    v: 1,
    savedAt: typeof t.savedAt === "number" ? t.savedAt : 0,
    seeded: t.seeded === true,
    jobs: t.jobs ?? {},
    runs: t.runs ?? {},
    pools: typeof t.pools === "object" && t.pools ? t.pools : {},
    alerts: Array.isArray(t.alerts) ? t.alerts.filter((a) => typeof a === "string") : [],
  };
  if (now - state.savedAt > RESEED_MS) state.seeded = false;
  return state;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

function conclusionSev(c: string | null | undefined): EventSeverity {
  if (c === "success") return "ok";
  if (c && FAILED.has(c)) return "bad";
  if (c === "action_required") return "warn";
  return "muted"; // cancelled, skipped, neutral, stale
}

/** Where a job runs or waits: its pool's short name, or `GitHub-hosted`. */
export function poolText(job: GhJob): string {
  const c = classifyJob({
    ...job,
    status: job.status === "completed" ? "in_progress" : job.status,
  });
  return c?.pool === GITHUB_POOL ? "GitHub-hosted" : c?.pool ?? "?";
}

/** The failed step's name, if the job JSON has steps. */
export function failedStep(job: GhJob): string | null {
  const s = job.steps?.find((x) => x.conclusion === "failure" || x.conclusion === "timed_out");
  return s?.name ?? null;
}

/**
 * Diff an observation against the tracker: the new state (mutated in place and returned) and the
 * events, oldest first.
 */
export function diffObservation(state: TrackerState, obs: Observation): NewEvent[] {
  const now = obs.now;
  /** GitHub's now: job ages compare GitHub's timestamps with it. */
  const ghNow = now + (obs.clockOffsetMs ?? 0);
  const out: NewEvent[] = [];
  const seeding = !state.seeded;
  const seenJobs = new Set<string>();
  const seenRuns = new Set<string>();

  for (const { repo, run, jobs } of obs.runs) {
    const base = runBase(repo, run);
    const host = runnerHostRule(repo, run.name ?? "workflow") !== undefined;
    const cancelled: GhJob[] = [];
    const lines: NewEvent[] = [];
    for (const job of jobs) {
      const key = String(job.id);
      seenJobs.add(key);
      const prev = state.jobs[key];
      const tracked: TrackedJob = prev ?? { status: job.status };
      if (seeding) {
        // Recorded as is; a job already late gets its first warning a full period from now.
        tracked.status = job.status;
        if (!host && lateNow(job, ghNow)) tracked.warnedAt = now;
        state.jobs[key] = tracked;
        continue;
      }
      const ev = (sev: EventSeverity, kind: EventKind, text: string): NewEvent => ({
        ...base,
        at: now,
        sev,
        kind,
        job: job.name,
        job_id: job.id,
        text,
        url: job.html_url ?? run.html_url,
      });
      const was = prev?.status ?? null;
      if (job.status !== was) {
        if (job.status === "completed") {
          if (job.conclusion === "cancelled") cancelled.push(job);
          else if (job.conclusion !== "skipped" || was !== null) {
            let text = `finished: ${job.conclusion ?? "unknown"}`;
            if (FAILED.has(job.conclusion ?? "") && !base.untrusted) {
              const step = failedStep(job);
              if (step) text += ` at step "${step}"`;
              const note = obs.annotations.get(job.id);
              if (note) text += ` (${note})`;
            }
            lines.push(ev(conclusionSev(job.conclusion), "finished", text));
          }
        } else if (job.status === "in_progress") {
          const runner = job.runner_name ? ` on ${job.runner_name}` : "";
          lines.push(ev("info", "started", `started on ${poolText(job)}${runner}`));
        } else if (was === null) {
          lines.push(ev("info", "queued", `queued for ${poolText(job)}`));
        }
        tracked.status = job.status;
        tracked.warnedAt = undefined;
      }
      // Timers: STALLED and QUEUED-LONG, then every REPEAT_MS.
      const late = host ? null : lateNow(job, ghNow, obs.health);
      if (late && (tracked.warnedAt === undefined || now - tracked.warnedAt >= REPEAT_MS)) {
        tracked.warnedAt = now;
        lines.push(ev(late.capacity ? "info" : "warn", late.kind, late.text));
      }
      state.jobs[key] = tracked;
    }

    // Cancellations: two or more in one run in one round are one line.
    const runKey = String(run.id);
    seenRuns.add(runKey);
    const prevRun = state.runs[runKey];
    const runDone = run.status === "completed" && prevRun?.status !== "completed";
    if (!seeding) {
      if (
        cancelled.length >= 2 ||
        (cancelled.length >= 1 && runDone && run.conclusion === "cancelled")
      ) {
        lines.push({
          ...base,
          at: now,
          sev: "muted",
          kind: "run-cancelled",
          job: null,
          text: `run ${run.id} cancelled (${cancelled.length} job${
            cancelled.length === 1 ? "" : "s"
          })`,
          url: run.html_url,
        });
      } else {
        for (const job of cancelled) {
          lines.push({
            ...base,
            at: now,
            sev: "muted",
            kind: "finished",
            job: job.name,
            job_id: job.id,
            text: "finished: cancelled",
            url: job.html_url ?? run.html_url,
          });
        }
      }
      const groupedCancel = lines.some((l) => l.kind === "run-cancelled");
      if (runDone && prevRun && !(groupedCancel && run.conclusion === "cancelled")) {
        lines.push({
          ...base,
          at: now,
          sev: conclusionSev(run.conclusion),
          kind: "run-completed",
          job: null,
          text: `run ${run.id} completed: ${run.conclusion ?? "unknown"}`,
          url: run.html_url,
        });
      }
    }
    state.runs[runKey] = { status: run.status ?? "unknown" };
    out.push(...lines);
  }

  // Forget what is no longer observed (finished runs were seen one last time above).
  for (const k of Object.keys(state.jobs)) if (!seenJobs.has(k)) delete state.jobs[k];
  for (const k of Object.keys(state.runs)) if (!seenRuns.has(k)) delete state.runs[k];

  out.push(...healthEvents(state, obs, seeding));
  state.seeded = true;
  state.savedAt = now;
  return out;
}

function runBase(repo: string, run: GhRun) {
  const untrusted = runProvenance(repo, run).untrusted;
  return {
    repo,
    workflow: run.name ?? "workflow",
    branch: run.head_branch ?? "",
    run_id: run.id,
    ...(untrusted ? { untrusted: true } : {}),
  };
}

/** Whether the job's pool is ok with every slot busy, by the fresh health variable. */
function jobPoolFull(job: GhJob, health: HealthState): boolean {
  if (health.state !== "ok") return false;
  const c = classifyJob({ ...job, status: "queued" });
  if (!c || c.pool === GITHUB_POOL) return false;
  const label = currentPools().find((p) => p.id === c.pool)?.label ?? c.pool;
  const h = health.doc.hosts?.[c.pool] ?? health.doc.pools[label];
  if (!h) return false;
  return poolIsFull({
    id: c.pool,
    state: !h.ok ? "unhealthy" : h.paused ? "paused" : "ok",
    slots: h.slots,
    busy: h.busy ?? 0,
  });
}

/** A job late right now: running past STALL_MS, or queued with no runner past QUEUE_LONG_MS. */
function lateNow(
  job: GhJob,
  now: number,
  health?: HealthState,
): { kind: "stalled" | "queued-long"; text: string; capacity?: boolean } | null {
  if (job.status === "in_progress") {
    const started = time(job.started_at) ?? time(job.created_at);
    if (started !== null && now - started > STALL_MS) {
      return {
        kind: "stalled",
        text: `STALLED: running ${Math.floor((now - started) / 60_000)} min on ${poolText(job)}`,
      };
    }
  } else if (job.status !== "completed" && !job.runner_name) {
    const created = time(job.created_at);
    if (created !== null && now - created > QUEUE_LONG_MS) {
      return {
        kind: "queued-long",
        text: `QUEUED-LONG: ${Math.floor((now - created) / 60_000)} min with no runner (${
          poolText(job)
        }${health && jobPoolFull(job, health) ? "; pool full, capacity wait" : ""})`,
        capacity: !!health && jobPoolFull(job, health),
      };
    }
  }
  return null;
}

function healthEvents(state: TrackerState, obs: Observation, seeding: boolean): NewEvent[] {
  const h = obs.health;
  if (h.state !== "ok") return [];
  const out: NewEvent[] = [];
  const pool = (label: string, sev: EventSeverity, text: string): NewEvent => ({
    at: obs.now,
    sev,
    kind: "pool-health",
    repo: "",
    workflow: `pool ${poolIdOfLabel(label)}`,
    job: null,
    text,
    url: null,
  });
  for (const [label, p] of Object.entries(h.doc.pools)) {
    const prev = state.pools[label];
    if (prev && !seeding) {
      const id = poolIdOfLabel(label);
      if (prev.ok && !p.ok) {
        out.push(pool(label, "bad", `${id} unhealthy${p.reason ? `: ${p.reason}` : ""}`));
      }
      if (!prev.ok && p.ok) out.push(pool(label, "ok", `${id} healthy again`));
      if (!prev.paused && p.paused) out.push(pool(label, "warn", `${id} paused`));
      if (prev.paused && !p.paused) out.push(pool(label, "info", `${id} resumed`));
    }
    state.pools[label] = { ok: p.ok, paused: p.paused };
  }
  const known = new Set(state.alerts);
  for (const a of [...h.doc.alerts].sort((x, y) => x.at - y.at)) {
    const key = `${a.at}|${a.pool}|${a.msg}`;
    if (known.has(key)) continue;
    known.add(key);
    state.alerts.push(key);
    if (seeding) continue;
    out.push({
      at: obs.now,
      sev: a.msg.startsWith("RECOVERED") ? "ok" : "warn",
      kind: "alert",
      repo: "",
      workflow: a.pool === "fleet" ? "fleet" : `pool ${a.pool}`,
      job: null,
      text: a.msg,
      url: null,
    });
  }
  if (state.alerts.length > 200) state.alerts = state.alerts.slice(-200);
  return out;
}

/** The bounded log. */
export class EventLog {
  #events: FleetEvent[];
  #seq: number;

  constructor(events: readonly FleetEvent[] = [], seq = 0) {
    this.#events = events.slice(-LOG_LIMIT);
    this.#seq = Math.max(seq, ...this.#events.map((e) => e.seq), 0);
  }

  /** Append, numbering each event; returns the appended events. */
  append(events: readonly NewEvent[]): FleetEvent[] {
    const added = events.map((e) => ({ ...e, seq: ++this.#seq }));
    this.#events.push(...added);
    if (this.#events.length > LOG_LIMIT) this.#events = this.#events.slice(-LOG_LIMIT);
    return added;
  }

  /**
   * Insert events that happened earlier (the back-fill), numbering each after the last `seq` (so
   * the page and the journal still see them as new) and placing them by `at` among the lines held.
   */
  insert(events: readonly NewEvent[]): FleetEvent[] {
    const added = events.map((e) => ({ ...e, seq: ++this.#seq }));
    this.#events = mergeEvents(this.#events, added).slice(-LOG_LIMIT);
    return added;
  }

  /** The events after `seq` (all when `seq` is 0 or from another run of the log). */
  after(seq: number): FleetEvent[] {
    if (seq > this.#seq) return [...this.#events];
    return this.#events.filter((e) => e.seq > seq);
  }

  get lastSeq(): number {
    return this.#seq;
  }

  get size(): number {
    return this.#events.length;
  }

  /** Plain JSON for storage. */
  toJSON(): { seq: number; events: FleetEvent[] } {
    return { seq: this.#seq, events: this.#events };
  }

  /** Restore from storage (garbage gives an empty log). */
  static from(raw: unknown): EventLog {
    const r = raw as { seq?: unknown; events?: unknown } | null;
    if (!r || !Array.isArray(r.events)) return new EventLog();
    const events = r.events.filter((e): e is FleetEvent =>
      typeof e === "object" && e !== null && typeof (e as FleetEvent).seq === "number" &&
      typeof (e as FleetEvent).text === "string"
    );
    return new EventLog(events, typeof r.seq === "number" ? r.seq : 0);
  }
}

/**
 * Merge two event lists in time order (`at`, then `seq`), each seq once: the page adds what it
 * pulls with this, so back-filled lines land at their real times.
 */
export function mergeEvents(
  held: readonly FleetEvent[],
  more: readonly FleetEvent[],
): FleetEvent[] {
  const bySeq = new Map<number, FleetEvent>();
  for (const e of held) bySeq.set(e.seq, e);
  for (const e of more) bySeq.set(e.seq, e);
  return [...bySeq.values()].sort((a, b) => a.at - b.at || a.seq - b.seq);
}

/** Problems: what the "problems only" filter keeps. */
export function isProblem(e: Pick<FleetEvent, "sev">): boolean {
  return e.sev === "warn" || e.sev === "bad";
}
