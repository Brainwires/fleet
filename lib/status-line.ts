// How current the window's data is, for the status line and the empty lanes. With webhooks live an
// idle org changes nothing and Fleet only reconciles every 5 min, so the last poll's age alone
// ("updated 4m ago") reads as stale when it isn't. The data is current as of the later of the last
// successful poll and the last webhook delivery; it is behind only when a poll is overdue (or
// failing), or when webhooks went quiet while jobs are running or queued (deliveries were due).
// Webhooks quiet with nothing running is the idle state, not a fault.

import type { Snapshot } from "./model.ts";

/** What the status line shows about the data's age. */
export type FreshState =
  /** No successful poll yet. */
  | "pending"
  /** Webhooks live: changes arrive as they happen. */
  | "live"
  /** Up to date by polling (or webhooks quiet with nothing to report). */
  | "current"
  /** A poll is overdue or failing, or webhooks went quiet while jobs are active. */
  | "behind";

export interface StatusFreshness {
  readonly state: FreshState;
  /** When the data was last known current: the later of the last poll and the last delivery. */
  readonly updatedAt: number | null;
  /** Webhooks stale with nothing running or queued: no delivery was expected. */
  readonly hooksQuiet: boolean;
}

/** Slack past two poll intervals before a poll counts as overdue (a reopened window's catch-up). */
export const POLL_GRACE_MS = 60_000;

/** The data's freshness at `now` (this machine's clock: poll and delivery times are local). */
export function statusFreshness(
  s: Pick<Snapshot, "poll" | "hooks" | "summary">,
  now: number,
): StatusFreshness {
  const { poll, hooks } = s;
  const delivered = hooks.state === "off" ? null : hooks.lastDeliveryAt;
  const updatedAt = poll.lastSuccessAt === null && delivered === null
    ? null
    : Math.max(poll.lastSuccessAt ?? -Infinity, delivered ?? -Infinity);
  const active = s.summary.running + s.summary.queued > 0;
  const hooksQuiet = hooks.state === "stale" && !active;
  if (poll.lastSuccessAt === null) return { state: "pending", updatedAt, hooksQuiet };
  const pollBehind = !poll.ok || poll.backoffUntil !== null ||
    now - poll.lastSuccessAt > 2 * poll.intervalMs + POLL_GRACE_MS;
  const hooksBehind = hooks.state === "stale" && active;
  const state = pollBehind || hooksBehind ? "behind" : hooks.state === "live" ? "live" : "current";
  return { state, updatedAt, hooksQuiet };
}
