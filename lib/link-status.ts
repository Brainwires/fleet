// A GitHub run or job link's status from Fleet's snapshot, for the in-app panel's reopen rule
// (app/web-panel/reopen-policy.ts): "live" while the run or job is queued or running, "done" once
// finished (the snapshot's finished jobs, the last 30 minutes), `null` when Fleet doesn't know it
// (another page, or a run that left the snapshot).

import type { LinkStatus } from "../app/web-panel/reopen-policy.ts";
import type { Snapshot } from "./model.ts";

/** `url` without its hash and query (a `#step:N:L` link is the same job). */
function bare(url: string): string {
  const cut = url.search(/[?#]/);
  return (cut < 0 ? url : url.slice(0, cut)).replace(/\/+$/, "");
}

/** The run id and job id in an Actions URL (`…/actions/runs/<run>[/job/<job>]`). */
function idsOf(url: string): { run: number; job: number | null } | null {
  const m = /\/actions\/runs\/(\d+)(?:\/job\/(\d+))?(?:\/attempts\/\d+)?$/.exec(url);
  return m ? { run: Number(m[1]), job: m[2] ? Number(m[2]) : null } : null;
}

/** The status of the run or job `url` names, from `snap`. */
export function linkStatus(
  snap: Pick<Snapshot, "running" | "queued" | "finished"> | null,
  url: string,
): LinkStatus {
  const ids = snap ? idsOf(bare(url)) : null;
  if (!snap || !ids) return null;
  if (isLive(snap, ids)) return "live";
  const done = ids.job === null
    ? snap.finished.some((j) => j.runId === ids.run)
    : snap.finished.some((j) => j.id === ids.job);
  return done ? "done" : null;
}

/** Whether the run (or its job) is in the running or queued lanes. */
function isLive(
  snap: Pick<Snapshot, "running" | "queued">,
  ids: { run: number; job: number | null },
): boolean {
  const runs = [...snap.running, ...snap.queued].flatMap((g) => g.runs);
  return runs.some((r) =>
    r.id === ids.run && (ids.job === null || r.jobs.some((j) => j.id === ids.job))
  );
}
