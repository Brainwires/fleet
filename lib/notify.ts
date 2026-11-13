// Which native notifications to post for a snapshot: a pool that went unhealthy, a job past 15 min
// queued, a job on a protected branch that failed. Each condition has a key, posted once: the keys
// are remembered (and persisted by the caller), so a re-poll, a reload or a relaunch never repeats
// one. A kind turned off in the settings (`notifications`) is still marked seen, so turning it back
// on doesn't replay the past.

import { jobWarning } from "./classify.ts";
import type { Snapshot } from "./model.ts";
import { rowsOf } from "./snapshot.ts";
import { type FleetSettings, settings } from "./settings.ts";

/** A notification to post. */
export interface FleetNotification {
  readonly key: string;
  readonly title: string;
  readonly body: string;
}

/** Conclusions that count as a failure. */
const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** At most this many separate "queued over 15 min" notices per poll; more become one summary. */
export const MAX_QUEUED_NOTICES = 3;

/** Remembered keys, epoch ms of posting (kept 48 h). */
export type SeenKeys = Map<string, number>;

/** How long a key is remembered. */
export const SEEN_TTL_MS = 48 * 3600_000;

/**
 * The notifications `snap` calls for that `seen` hasn't had, marking them seen.
 *
 * @param snap The new snapshot.
 * @param seen The keys posted before (mutated: new keys added, old ones pruned).
 * @param startedAt When Fleet started: a failure that finished before it is old news.
 */
export function pendingNotifications(
  snap: Snapshot,
  seen: SeenKeys,
  startedAt: number,
  prefs: FleetSettings["notifications"] = settings().notifications,
): FleetNotification[] {
  const now = snap.at;
  // Queue ages and completion times are GitHub's: compared on GitHub's clock.
  const offset = snap.clockOffsetMs ?? 0;
  const ghNow = now + offset;
  for (const [k, t] of seen) if (now - t > SEEN_TTL_MS) seen.delete(k);
  const out: FleetNotification[] = [];
  const add = (n: FleetNotification, on: boolean) => {
    if (seen.has(n.key)) return;
    seen.set(n.key, now);
    if (on) out.push(n);
  };

  // Only trust health that is fresh.
  if (snap.health.state === "ok") {
    for (const p of snap.pools) {
      if (p.state !== "unhealthy") continue;
      add({
        key: `pool:${p.label ?? p.id}:${p.since ?? "?"}`,
        title: `Pool ${p.title} is unhealthy`,
        body: p.reason || "The runner watchdog reports it unhealthy.",
      }, prefs.poolUnhealthy);
    }
  }

  const late = rowsOf(snap.queued).filter((r) =>
    jobWarning(r, ghNow) === "queued-long" && !seen.has(`queued:${r.id}`)
  );
  if (late.length > MAX_QUEUED_NOTICES) {
    for (const r of late) seen.set(`queued:${r.id}`, now);
    const pools = [...new Set(late.map((r) => r.pool))].join(", ");
    if (prefs.queuedLong) {
      out.push({
        key: `queued-batch:${late.map((r) => r.id).join(",")}`,
        title: `${late.length} jobs queued over 15 min`,
        body: `Waiting for ${pools}.`,
      });
    }
  } else {
    for (const r of late) {
      add({
        key: `queued:${r.id}`,
        title: "Job queued over 15 min",
        body: `${r.name} is waiting for ${r.pool}.`,
      }, prefs.queuedLong);
    }
  }

  for (const f of snap.finished) {
    // A protected-branch failure only: by provenance (a fork PR's branch named `main` isn't the
    // repo's).
    if (!f.defaultBranch || f.fork || !FAILED.has(f.conclusion)) continue;
    if (f.completedAt - offset < startedAt - 60_000) continue;
    add({
      key: `fail:${f.id}`,
      title: `${f.repo.split("/")[1]} ${f.branch}: job failed`,
      body: `${f.workflow} / ${f.name} (${f.conclusion.replace("_", " ")})`,
    }, prefs.protectedFailure);
  }
  return out;
}
