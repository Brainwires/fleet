// fleet_pool_history and fleet_runner_log's answers, pure where they can be: the history file comes
// in as a value; the runner log reader is lib/deno-logs.ts (bounded, redacted).

import type { AgentSnapshot } from "../lib/agent-snapshot.ts";
import { AGENT_NAME_MAX, capText } from "../lib/agent-snapshot.ts";
import {
  HISTORY_RANGES,
  type HistoryRange,
  type HistoryStore,
  poolHistory,
} from "../lib/history.ts";
import { ArgError, freshness } from "./queries.ts";

/** fleet_runner_log's default and largest tail (lines), and its byte cap. */
export const RUNNER_LOG_TAIL = 200;
export const RUNNER_LOG_TAIL_MAX = 2000;
export const RUNNER_LOG_MAX_BYTES = 256 * 1024;

const POOL = /^[\w.+:-]{1,120}$/;

/** fleet_pool_history's arguments. */
export function historyArgs(a: Record<string, unknown>): { pool: string; range: HistoryRange } {
  const pool = a.pool;
  if (typeof pool !== "string" || !POOL.test(pool)) {
    throw new ArgError("pool must be a pool short name, `github`, or `github:<image>`");
  }
  const range = a.range ?? "24h";
  if (!HISTORY_RANGES.includes(range as HistoryRange)) {
    throw new ArgError(`range must be one of ${HISTORY_RANGES.join(", ")}`);
  }
  return { pool, range: range as HistoryRange };
}

const iso = (t: number) => new Date(t).toISOString();
const sec = (ms: number | null) => (ms === null ? null : Math.round(ms / 1000));

/**
 * A pool's bucketed history over a range (at most 168 points): per point the average busy slots,
 * capacity, utilization, queue, longest wait, jobs started / finished by conclusion, minutes and
 * median / p90 duration; the range's totals and duration histogram; its 20 latest finished jobs.
 */
export function poolHistoryResult(
  store: HistoryStore | null,
  snap: AgentSnapshot | null,
  now: number,
  args: { pool: string; range: HistoryRange },
): Record<string, unknown> {
  const fresh = freshness(snap, now);
  if (!store) {
    return {
      ...fresh,
      pool: args.pool,
      range: args.range,
      points: [],
      warning:
        "No history file yet: Fleet writes fleet-history.json a few minutes after it starts.",
    };
  }
  const h = poolHistory(store, args.pool, args.range, now);
  const known = store.keys().sort();
  return {
    ...fresh,
    pool: args.pool,
    range: args.range,
    step_s: h.stepMs / 1000,
    from: iso(h.from),
    to: iso(h.to),
    ...(known.includes(args.pool)
      ? {}
      : { note: `No history for that pool. Known: ${known.join(", ")}` }),
    totals: {
      ...h.totals,
      p50_s: sec(h.totals.p50),
      p90_s: sec(h.totals.p90),
      max_wait_s: sec(h.totals.maxWaitMs),
      avg_wait_s: sec(h.totals.avgWaitMs),
      p50: undefined,
      p90: undefined,
      maxWaitMs: undefined,
      avgWaitMs: undefined,
    },
    histogram: {
      upper_edges_s: h.histogram.edgesMs.map((e) => e / 1000),
      counts: h.histogram.counts,
    },
    // One row per point: [start, busy, slots, utilization, queued, wait_max_s, started, ok,
    // failed, cancelled, other, minutes, p50_s, p90_s] (nulls where nothing was sampled).
    columns: [
      "t",
      "busy",
      "slots",
      "utilization",
      "queued",
      "wait_max_s",
      "started",
      "ok",
      "failed",
      "cancelled",
      "other",
      "minutes",
      "p50_s",
      "p90_s",
    ],
    points: h.points.map((p) => [
      iso(p.t),
      p.busy,
      p.slots,
      p.utilization,
      p.queued,
      sec(p.waitMax),
      p.started,
      p.ok,
      p.failed,
      p.cancelled,
      p.other,
      p.minutes,
      sec(p.p50),
      sec(p.p90),
    ]),
    recent_jobs: store.jobs([args.pool], 20).map((j) => ({
      id: j.id,
      run_id: j.runId,
      repo: j.repo,
      workflow: capText(j.workflow, AGENT_NAME_MAX),
      name: capText(j.name, AGENT_NAME_MAX),
      runner: j.runner,
      image: j.image ?? null,
      conclusion: j.conclusion,
      started_at: j.started === null ? null : iso(j.started),
      completed_at: iso(j.completed),
      duration_s: j.started === null ? null : sec(j.completed - j.started),
    })),
  };
}

/** fleet_runner_log's arguments. */
export function runnerLogArgs(
  a: Record<string, unknown>,
): { pool: string | null; jobId: number | null; file: string | null; tail: number } {
  const pool = typeof a.pool === "string" && POOL.test(a.pool) ? a.pool : null;
  if (a.pool !== undefined && pool === null) throw new ArgError("pool must be a pool short name");
  const jobId = typeof a.job_id === "number" && Number.isSafeInteger(a.job_id) && a.job_id > 0
    ? a.job_id
    : null;
  const file = typeof a.file === "string" && a.file.length <= 200 ? a.file : null;
  if (jobId === null && file === null) throw new ArgError("give job_id, or file (with pool)");
  if (file !== null && pool === null) throw new ArgError("file needs pool");
  const t = a.tail ?? RUNNER_LOG_TAIL;
  if (typeof t !== "number" || !Number.isInteger(t) || t < 1 || t > RUNNER_LOG_TAIL_MAX) {
    throw new ArgError(`tail must be 1 to ${RUNNER_LOG_TAIL_MAX}`);
  }
  return { pool, jobId, file, tail: t };
}
