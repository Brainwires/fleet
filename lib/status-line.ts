// How current the window's data is, for the status line and the empty lanes. With webhooks on, an
// idle org changes nothing and Fleet's REST poll is only a safety net (every 15 min, and once after
// deliveries go quiet for 5 min), so the last poll's age alone ("updated 4m ago") reads as stale
// when it isn't. The data is current as of the later of the last successful poll and the last
// webhook delivery; it is behind only when a poll is overdue (or failing), or when webhooks went
// quiet while jobs are running or queued and the gap poll hasn't reconciled since. Webhooks quiet
// with nothing running is the idle state, not a fault. `sourceLine` says where the data comes from
// ("live · watch + webhooks", the safety poll's interval secondary).

import { HOOK_GAP_MS } from "./budget.ts";
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
  // Quiet webhooks with jobs active are behind until the gap poll has reconciled after the last
  // delivery (a queue that isn't moving sends nothing; the poll confirms it).
  const hooksBehind = hooks.state === "stale" && active &&
    (hooks.lastDeliveryAt === null || poll.lastSuccessAt < hooks.lastDeliveryAt + HOOK_GAP_MS);
  const state = pollBehind || hooksBehind ? "behind" : hooks.state === "live" ? "live" : "current";
  return { state, updatedAt, hooksQuiet };
}

/** Where the data comes from, for the status line. */
export interface SourceLine {
  /** Pushed by events (webhooks and / or the scheduler's files), not only polled. */
  readonly live: boolean;
  /** "live · watch + webhooks", or "every 15 s" when only polling. */
  readonly text: string;
  /** The event sources alone ("watch + webhooks"); `""` when only polling. */
  readonly sources: string;
  /** The poll's interval, secondary ("safety poll 15 min"); `""` when `text` already says it. */
  readonly poll: string;
  /** The tooltip: what each source covers. */
  readonly title: string;
}

/** An interval in words: "15 s", "15 min". */
export function intervalText(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 90 ? `${s} s` : `${Math.round(s / 60)} min`;
}

/**
 * The status line's source: what pushes changes (the runner scheduler's state files, watched;
 * GitHub's webhooks) and the REST poll's interval, which with webhooks on is only a safety net.
 */
export function sourceLine(s: Pick<Snapshot, "poll" | "hooks" | "watch">): SourceLine {
  const hooks = s.hooks.state !== "off";
  const watch = s.watch?.on === true;
  const every = intervalText(s.poll.intervalMs);
  if (!hooks && !watch) {
    return {
      live: false,
      text: `every ${every}`,
      sources: "",
      poll: "",
      title: `Polling GitHub every ${every}.`,
    };
  }
  const sources = [watch ? "watch" : null, hooks ? "webhooks" : null].filter((x) => x !== null)
    .join(" + ");
  const covers = [
    watch ? "pool health follows the runner scheduler's state files as they change" : null,
    hooks ? "jobs and runs arrive as GitHub webhooks" : null,
  ].filter((x) => x !== null).join("; ");
  const poll = hooks ? `safety poll ${every}` : `GitHub poll ${every}`;
  const why = hooks
    ? `GitHub's REST API is polled every ${every} as a safety net, once after webhooks go quiet ` +
      `for ${intervalText(HOOK_GAP_MS)}, and on Refresh.`
    : `GitHub's REST API is polled every ${every}.`;
  return {
    live: true,
    text: `live · ${sources}`,
    sources,
    poll,
    title: `${covers[0].toUpperCase()}${covers.slice(1)}. ${why}`,
  };
}
