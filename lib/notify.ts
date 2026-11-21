// Which native notifications to post for a snapshot: a pool that went unhealthy, a job past 15 min
// queued, a job on a protected branch that failed. Each condition has a key, posted once: the keys
// are remembered (and persisted by the caller), so a re-poll, a reload or a relaunch never repeats
// one. A kind turned off in the settings (`notifications`) is still marked seen, so turning it back
// on doesn't replay the past. Where the runner watchdog posts its alerts through Fleet Notifier
// (lib/notifier.ts), a job queued over 15 min on a self-hosted pool is the watchdog's `stuck:<pool>`
// alert already: Fleet marks it seen and leaves its own notice out, so the condition shows once.
//
// Machine updates (kind `updates`, one toggle): a machine entering warn posts once per machine and
// cause; entering bad posts again, then once a week while it lasts. Those keys live while their
// cause does (and 48 h after), so a cause that clears and comes back posts again. Ten minutes
// before a restart window's run, each run's outcome, and three busy windows in a row post once
// each. The machine Fleet runs on gets the same notices, and never more than notices.

import { jobWarning } from "./classify.ts";
import type { Snapshot } from "./model.ts";
import { rowsOf } from "./snapshot.ts";
import { type FleetSettings, settings } from "./settings.ts";
import type { SeverityCause } from "./updates/model.ts";
import type { SchedulerEvent } from "./updates/scheduler.ts";
import { ageText, type UpdatesMachineView } from "./updates/view.ts";

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

/** How the notices are chosen. */
export interface NotifyOptions {
  /**
   * The watchdog notifies through Fleet Notifier: no "queued over 15 min" notice for a self-hosted
   * pool's job (the watchdog's own alert covers it). GitHub-hosted jobs keep theirs.
   */
  readonly watchdogNotifies?: boolean;
}

/**
 * The "queued over 15 min" notices: one per job, or one summary for more than
 * {@linkcode MAX_QUEUED_NOTICES}. A self-hosted pool's job is the watchdog's `stuck:<pool>` alert
 * when the watchdog notifies through Fleet Notifier: marked seen, not shown.
 */
function queuedNotices(
  snap: Snapshot,
  seen: SeenKeys,
  ghNow: number,
  on: boolean,
  opts: NotifyOptions,
  add: (n: FleetNotification, on: boolean) => void,
): FleetNotification[] {
  const now = snap.at;
  const overdue = rowsOf(snap.queued).filter((r) =>
    jobWarning(r, ghNow) === "queued-long" && !seen.has(`queued:${r.id}`)
  );
  const byWatchdog = (r: (typeof overdue)[number]) =>
    opts.watchdogNotifies === true && r.target === "pool";
  for (const r of overdue) if (byWatchdog(r)) seen.set(`queued:${r.id}`, now);
  const late = overdue.filter((r) => !byWatchdog(r));
  if (late.length <= MAX_QUEUED_NOTICES) {
    for (const r of late) {
      add({
        key: `queued:${r.id}`,
        title: "Job queued over 15 min",
        body: `${r.name} is waiting for ${r.pool}.`,
      }, on);
    }
    return [];
  }
  for (const r of late) seen.set(`queued:${r.id}`, now);
  if (!on) return [];
  const pools = [...new Set(late.map((r) => r.pool))].join(", ");
  return [{
    key: `queued-batch:${late.map((r) => r.id).join(",")}`,
    title: `${late.length} jobs queued over 15 min`,
    body: `Waiting for ${pools}.`,
  }];
}

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
  opts: NotifyOptions = {},
): FleetNotification[] {
  const now = snap.at;
  // Queue ages and completion times are GitHub's: compared on GitHub's clock.
  const offset = snap.clockOffsetMs ?? 0;
  const ghNow = now + offset;
  // Update keys (`upd:`) last while their cause does: updateNotifications prunes them.
  for (const [k, t] of seen) if (!k.startsWith(UPDATE_KEY) && now - t > SEEN_TTL_MS) seen.delete(k);
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

  out.push(...queuedNotices(snap, seen, ghNow, prefs.queuedLong, opts, add));

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

// ---- machine updates ----

/** The prefix of a machine-update condition key (`upd:<machine>:<cause>`). */
export const UPDATE_KEY = "upd:";
/** A bad condition posts again this often while it lasts. */
export const BAD_REPEAT_MS = 7 * 24 * 3600_000;

const BAD_CAUSES = new Set<SeverityCause>([
  "security-old",
  "reboot-old",
  "no-check",
  "held-after-failure",
]);
const WARN_CAUSES = new Set<SeverityCause>([
  "security-pending",
  "reboot-required",
  "check-stale",
  "index-stale",
]);

/** A cause's notice for a machine. */
function causeNotice(m: UpdatesMachineView, cause: SeverityCause, now: number) {
  const h = m.status.host;
  const sec = h?.pending.security ?? 0;
  const since = (t: number | null) => (t === null ? "" : ` for ${ageText(now - t)}`);
  switch (cause) {
    case "security-pending":
      return {
        title: `${m.id}: security updates pending`,
        body: `${sec} security update${sec === 1 ? "" : "s"} wait to install.`,
      };
    case "security-old":
      return {
        title: `${m.id}: security updates still pending`,
        body: `${sec} security update${sec === 1 ? "" : "s"} pending${
          since(m.status.firstSeen.security)
        }.`,
      };
    case "reboot-required":
      return { title: `${m.id}: restart pending`, body: "An installed update needs a restart." };
    case "reboot-old":
      return {
        title: `${m.id}: restart still pending`,
        body: `A restart has been pending${
          since(m.status.firstSeen.reboot ?? h?.reboot.since ?? null)
        }.`,
      };
    case "check-stale":
    case "index-stale":
      return {
        title: `${m.id}: update status is old`,
        body: cause === "index-stale"
          ? "Its package index hasn't been refreshed in over a day."
          : "Fleet couldn't check it in over a day.",
      };
    case "no-check":
      return {
        title: `${m.id}: no update check`,
        body: m.status.error
          ? `The checks fail: ${m.status.error}`
          : "No successful check for days.",
      };
    case "held-after-failure":
      return {
        title: `${m.id}: pools still held`,
        body: `A failed update left ${m.status.heldPools.join(", ")} held; resume them in Fleet.`,
      };
    default:
      return null;
  }
}

/**
 * The notices the machines' update levels call for: a warn cause once (while it lasts), a bad
 * cause on entering and weekly after. With the kind off (`on` false) the keys are marked all the
 * same, so turning it on doesn't replay them.
 */
export function updateNotifications(
  machines: readonly UpdatesMachineView[],
  seen: SeenKeys,
  now: number,
  on: boolean,
): FleetNotification[] {
  const live = new Set<string>();
  const out: FleetNotification[] = [];
  for (const m of machines) {
    for (const cause of m.causes) {
      const bad = BAD_CAUSES.has(cause);
      if (!bad && !WARN_CAUSES.has(cause)) continue;
      const key = `${UPDATE_KEY}${m.id}:${cause}`;
      live.add(key);
      const last = seen.get(key);
      if (last !== undefined && !(bad && now - last >= BAD_REPEAT_MS)) continue;
      seen.set(key, now);
      const n = causeNotice(m, cause, now);
      if (on && n) out.push({ key, ...n });
    }
  }
  for (const [k, t] of seen) {
    if (k.startsWith(UPDATE_KEY) && !live.has(k) && now - t > SEEN_TTL_MS) seen.delete(k);
  }
  return out;
}

/** A run's end, as the notices take it. */
export interface RunOutcomeEvent {
  readonly kind: "outcome";
  readonly runId: string;
  readonly machine: string;
  readonly action: "install" | "restart";
  readonly outcome: string;
}

const OUTCOME_TEXT: Record<string, string> = {
  "succeeded": "done",
  "nothing-to-do": "nothing to do",
  "aborted": "stopped before installing anything",
  "cancelled": "cancelled",
  "deferred-busy": "still busy at the drain cap: nothing installed, tried again later",
  "install-failed": "the install failed",
  "reboot-pending": "installed; a restart is pending (next restart window, or Restart now)",
  "host-down": "it didn't come back after the restart; its pools stay held",
  "verify-failed": "it failed verify; its pools stay held",
  "resume-failed": "done, but a pool couldn't be resumed",
};

/** The notice for a scheduler event or a run's end (once per key), or `null`. */
export function updateEventNotification(
  e: SchedulerEvent | RunOutcomeEvent,
  seen: SeenKeys,
  now: number,
  on: boolean,
): FleetNotification | null {
  let n: FleetNotification | null = null;
  switch (e.kind) {
    case "restart-soon":
      n = {
        key: `upd-soon:${e.scheduleId}:${e.window}`,
        title: `${e.machine} restarts in 10 minutes`,
        body: "Its restart window opened. Open Fleet to cancel.",
      };
      break;
    case "busy-streak":
      n = {
        key: `upd-busy:${e.scheduleId}:${e.window}`,
        title: `${e.machine}: ${e.count} restart windows skipped`,
        body: "It was still busy at the drain cap each time.",
      };
      break;
    case "outcome":
      n = {
        key: `upd-run:${e.runId}`,
        title: `${e.action === "restart" ? "Restart" : "Update"} of ${e.machine}: ${
          e.outcome === "succeeded" ? "done" : e.outcome
        }`,
        body: OUTCOME_TEXT[e.outcome] ?? e.outcome,
      };
      break;
    default:
      return null;
  }
  if (seen.has(n.key)) return null;
  seen.set(n.key, now);
  return on ? n : null;
}
