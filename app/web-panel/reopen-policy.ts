// Whether the GitHub panel reloads its page when it reopens on the same link (github-browser.ts).
// A hidden web view's timers are throttled and GitHub's live-update socket can be suspended or
// dropped, so a page that was still changing may have missed updates (a running job's log lines).
// Fleet's snapshot knows each run's and job's status (lib/link-status.ts):
//
// - in progress (queued, in progress, waiting): reload, so a live console is in sync again;
// - completed: the page can't change any more, so it reopens as is, unless it completed while the
//   panel was hidden (it was in progress then): reloaded once, to show the final state;
// - not a run or job page, or a status Fleet doesn't know: reload after UNKNOWN_STALE_MS hidden.

/** A link's run / job status from Fleet's snapshot (`null`: not a run or job, or not known). */
export type LinkStatus = "live" | "done" | null;

/** An unknown page hidden longer than this reloads when the panel reopens on it. */
export const UNKNOWN_STALE_MS = 30_000;

/**
 * Whether to reload the page in place on reopening.
 *
 * @param atHide The link's status when the panel went back to Fleet.
 * @param now The link's status now.
 * @param hiddenMs How long the panel was hidden.
 */
export function reloadOnReopen(atHide: LinkStatus, now: LinkStatus, hiddenMs: number): boolean {
  if (now === "live") return true;
  if (now === "done") return atHide === "live";
  return hiddenMs > UNKNOWN_STALE_MS;
}
