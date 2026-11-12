// The back-fill: what happened while Fleet was closed, from the webhook spool
// (`~/.denext-runners/hooks/events.jsonl` and its rotated `.1`), which the launchd receiver keeps
// writing whether Fleet runs or not. At startup (and when the spool is first found) the job queued /
// started / finished lines and run completions newer than the log's last line become log lines at
// their real times, marked `backfill`, de-duplicated against the log, capped. Pure: no clock, no I/O.
//
// Notifications are never derived from these lines (they come from the live snapshot only), so a
// back-filled failure is in the log without a banner.

import { failedStep, type FleetEvent, type NewEvent, poolText } from "./events.ts";
import { type HookDelivery, payloadRepo } from "./hooks.ts";
import { asJob, asRun } from "./poller.ts";
import { runProvenance } from "./classify.ts";

/** Back-fill at most this far back (24 h)… */
export const BACKFILL_WINDOW_MS = 24 * 60 * 60_000;
/** …and at most this many lines (the newest). */
export const BACKFILL_MAX = 500;

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

function conclusionSev(c: string | null | undefined): FleetEvent["sev"] {
  if (c === "success") return "ok";
  if (c && FAILED.has(c)) return "bad";
  if (c === "action_required") return "warn";
  return "muted";
}

/** A line's identity for de-duplication: job lifecycle by job and kind, run lines by run. */
function keyOf(e: Pick<FleetEvent, "kind" | "job_id" | "run_id" | "text">): string | null {
  if ((e.kind === "queued" || e.kind === "started" || e.kind === "finished") && e.job_id) {
    return `job:${e.job_id}:${e.kind}`;
  }
  if (e.kind === "run-completed" && e.run_id) return `run:${e.run_id}:${e.text}`;
  if (e.kind === "run-cancelled" && e.run_id) return `run:${e.run_id}:cancelled`;
  return null;
}

/**
 * Drop the job lifecycle lines (queued / started / finished) the log already has for the same job:
 * after a back-fill, the first poll's diff must not log a job's start a second time.
 */
export function dropLogged(events: readonly NewEvent[], held: readonly FleetEvent[]): NewEvent[] {
  const logged = new Set<string>();
  for (const e of held) {
    if (e.kind === "queued" || e.kind === "started" || e.kind === "finished") {
      const k = keyOf(e);
      if (k) logged.add(k);
    }
  }
  return events.filter((e) => {
    if (e.kind !== "queued" && e.kind !== "started" && e.kind !== "finished") return true;
    const k = keyOf(e);
    return !k || !logged.has(k);
  });
}

/** Options for {@linkcode backfillEvents}. */
export interface BackfillOptions {
  /** The log's last line's time before this start (`null` for an empty log). */
  readonly since: number | null;
  readonly now: number;
  readonly windowMs?: number;
  readonly max?: number;
}

/** The earliest delivery time a back-fill reads (exclusive). */
export function backfillFrom(o: BackfillOptions): number {
  return Math.max(o.since ?? -Infinity, o.now - (o.windowMs ?? BACKFILL_WINDOW_MS));
}

/**
 * The log lines for spool deliveries newer than the log's last line (and the window), oldest
 * first, newest `max` kept: each marked `backfill`, at its delivery's time, none the log (or an
 * earlier delivery) already has. Two or more cancelled jobs of one run become one line, as live.
 */
export function backfillEvents(
  deliveries: readonly HookDelivery[],
  held: readonly FleetEvent[],
  o: BackfillOptions,
): NewEvent[] {
  const from = backfillFrom(o);
  const seenIds = new Set<string>();
  const ds = deliveries
    .filter((d) => d.receivedAt > from && d.receivedAt <= o.now)
    .filter((d) => !seenIds.has(d.id) && (seenIds.add(d.id), true))
    .sort((a, b) => a.receivedAt - b.receivedAt);

  const logged = new Set<string>();
  for (const e of held) {
    const k = keyOf(e);
    if (k) logged.add(k);
  }
  // Already-known jobs (queued or started): a later "skipped" for them is worth a line, as live.
  const known = new Set<number>();
  for (const e of held) {
    if (e.job_id && (e.kind === "queued" || e.kind === "started")) known.add(e.job_id);
  }

  // First pass: cancelled jobs per run (grouped when two or more).
  const cancelledByRun = new Map<number, Set<number>>();
  for (const d of ds) {
    if (d.event !== "workflow_job") continue;
    const job = asJob(d.payload.workflow_job);
    if (job?.status === "completed" && job.conclusion === "cancelled") {
      const s = cancelledByRun.get(job.run_id) ?? new Set();
      s.add(job.id);
      cancelledByRun.set(job.run_id, s);
    }
  }
  const grouped = (runId: number) => (cancelledByRun.get(runId)?.size ?? 0) >= 2;
  // Fork / pull_request_target runs, as their workflow_run deliveries say (a workflow_job payload
  // doesn't name the head repo): their jobs' step names stay out of the text.
  const untrusted = new Set<number>();
  for (const d of ds) {
    if (d.event !== "workflow_run") continue;
    const repo = payloadRepo(d.payload);
    const run = asRun(d.payload.workflow_run);
    if (repo && run && runProvenance(repo, run).untrusted) untrusted.add(run.id);
  }

  const out: NewEvent[] = [];
  const push = (e: NewEvent) => {
    const k = keyOf(e);
    if (k) {
      if (logged.has(k)) return;
      logged.add(k);
    }
    out.push(e);
  };
  const groupAt = new Map<number, { at: number; count: number; base: NewEvent }>();

  for (const d of ds) {
    const repo = payloadRepo(d.payload);
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) continue;
    if (d.event === "workflow_run") {
      const run = asRun(d.payload.workflow_run);
      if (!run || run.status !== "completed") continue;
      if (run.conclusion === "cancelled" && grouped(run.id)) continue;
      push({
        at: d.receivedAt,
        sev: conclusionSev(run.conclusion),
        kind: "run-completed",
        repo,
        workflow: run.name ?? "workflow",
        branch: run.head_branch ?? "",
        run_id: run.id,
        job: null,
        text: `run ${run.id} completed: ${run.conclusion ?? "unknown"}`,
        url: run.html_url,
        backfill: true,
        ...(untrusted.has(run.id) ? { untrusted: true } : {}),
      });
      continue;
    }
    const job = asJob(d.payload.workflow_job);
    if (!job) continue;
    const runUrl = `https://github.com/${repo}/actions/runs/${job.run_id}`;
    const ev = (sev: FleetEvent["sev"], kind: FleetEvent["kind"], text: string): NewEvent => ({
      at: d.receivedAt,
      sev,
      kind,
      repo,
      workflow: job.workflow_name ?? "workflow",
      branch: job.head_branch ?? "",
      run_id: job.run_id,
      job: job.name,
      job_id: job.id,
      text,
      url: job.html_url ?? runUrl,
      backfill: true,
      ...(untrusted.has(job.run_id) ? { untrusted: true } : {}),
    });
    if (job.status === "completed") {
      const c = job.conclusion ?? null;
      if (c === "cancelled" && grouped(job.run_id)) {
        const g = groupAt.get(job.run_id);
        const base = ev("muted", "run-cancelled", "");
        groupAt.set(job.run_id, {
          at: d.receivedAt,
          count: (g?.count ?? 0) + 1,
          base: g?.base ?? base,
        });
        continue;
      }
      if (c === "skipped" && !known.has(job.id)) continue;
      let text = `finished: ${c ?? "unknown"}`;
      if (c && FAILED.has(c) && !untrusted.has(job.run_id)) {
        const step = failedStep(job);
        if (step) text += ` at step "${step}"`;
      }
      push(ev(conclusionSev(c), "finished", text));
    } else if (job.status === "in_progress") {
      known.add(job.id);
      const runner = job.runner_name ? ` on ${job.runner_name}` : "";
      push(ev("info", "started", `started on ${poolText(job)}${runner}`));
    } else {
      known.add(job.id);
      push(ev("info", "queued", `queued for ${poolText(job)}`));
    }
  }
  for (const [runId, g] of groupAt) {
    push({
      ...g.base,
      at: g.at,
      job: null,
      job_id: undefined,
      text: `run ${runId} cancelled (${g.count} jobs)`,
      url: `https://github.com/${g.base.repo}/actions/runs/${runId}`,
    });
  }
  out.sort((a, b) => a.at - b.at);
  return out.slice(-(o.max ?? BACKFILL_MAX));
}
