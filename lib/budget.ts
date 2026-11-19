// The REST budget. Fleet shares the user's gh token, and so its 5,000-an-hour primary limit, with
// the runner scheduler, the watchdog and the CI watchers: if Fleet starved it, queued jobs would go
// unseen and runners would stop launching. So the poll interval follows the remaining budget:
//
// - below 1,500 remaining: 60 s, even with the window visible;
// - below 800: every 5 min, with a "rate limit low" banner;
// - below 300: no polling until the reset (a user-confirmed control may still go through); once
//   the reset time passes, the old figure is ignored and polling resumes;
// - Fleet's own spend over 1,200 counted (non-304) requests in the last hour: every 5 min.
//
// Conditional requests answered 304 don't count against the limit, so they don't count here.

import type { RateInfo } from "./model.ts";

/** Below this, poll at 60 s whatever the window does. */
export const RATE_SLOW = 1500;
/** Below this, every 5 min and the banner. */
export const RATE_LOW = 800;
/** Below this, nothing but user-confirmed controls until the reset. */
export const RATE_FLOOR = 300;
/** Fleet's own counted requests an hour. */
export const OWN_BUDGET_PER_HOUR = 1200;

export const VISIBLE_MS = 15_000;
export const HIDDEN_MS = 60_000;
export const SLOW_MS = 300_000;
/** Unauthenticated (60 an hour): visible / hidden. */
export const PUBLIC_MS = [60_000, 300_000] as const;

/** Why polling is slowed, for the banner. */
export type SlowReason = "low" | "floor" | "budget" | null;

/** The plan for the next poll. */
export interface PollPlan {
  /** Wait at least this long after the last poll. */
  readonly intervalMs: number;
  /** Don't poll before this time (the rate limit's reset), or `null`. */
  readonly notBefore: number | null;
  readonly slow: SlowReason;
}

/** What the plan depends on. */
export interface PlanInput {
  readonly rate: RateInfo | null;
  readonly visible: boolean;
  readonly publicOnly: boolean;
  /** Fleet's counted (non-304) requests in the last hour. */
  readonly spentLastHour: number;
  readonly now: number;
  /** Webhooks: live → polling only reconciles every 5 min; stale with runs active → normal. */
  readonly hooks?: "live" | "stale" | "off";
  readonly activeRuns?: number;
}

/** With webhooks live, polling only reconciles this often. */
export const RECONCILE_MS = 5 * 60_000;

/**
 * The poll plan. With webhooks on, polling becomes a reconciliation: every 5 min while deliveries
 * arrive, and at the normal rate when they've gone quiet with runs active (a missed delivery).
 */
export function pollPlan(i: PlanInput): PollPlan {
  const p = basePlan(i);
  const reconcile = i.hooks === "live" || (i.hooks === "stale" && (i.activeRuns ?? 0) === 0);
  return reconcile && p.intervalMs < RECONCILE_MS ? { ...p, intervalMs: RECONCILE_MS } : p;
}

function basePlan(i: PlanInput): PollPlan {
  if (i.publicOnly) {
    return { intervalMs: PUBLIC_MS[i.visible ? 0 : 1], notBefore: null, slow: null };
  }
  // A rate seen before its reset time says nothing after it: the budget has refilled. Holding on to
  // its `remaining` would keep polling paused for good (no poll, so no newer headers to replace it).
  const rate = i.rate !== null && i.rate.resetAt > i.now ? i.rate : null;
  const remaining = rate?.remaining ?? null;
  if (rate !== null && rate.remaining < RATE_FLOOR) {
    return { intervalMs: SLOW_MS, notBefore: rate.resetAt, slow: "floor" };
  }
  if (remaining !== null && remaining < RATE_LOW) {
    return { intervalMs: SLOW_MS, notBefore: null, slow: "low" };
  }
  if (i.spentLastHour >= OWN_BUDGET_PER_HOUR) {
    return { intervalMs: SLOW_MS, notBefore: null, slow: "budget" };
  }
  if (remaining !== null && remaining < RATE_SLOW) {
    return { intervalMs: HIDDEN_MS, notBefore: null, slow: null };
  }
  return { intervalMs: i.visible ? VISIBLE_MS : HIDDEN_MS, notBefore: null, slow: null };
}

/** The banner text for a slow reason. */
export function slowText(slow: SlowReason): string {
  switch (slow) {
    case "low":
      return "Rate limit low: slowed down to protect the runner scheduler.";
    case "floor":
      return "Rate limit nearly used up: polling paused until it resets, to protect the runner scheduler.";
    case "budget":
      return "Fleet used its share of the rate limit this hour: polling every 5 minutes.";
    default:
      return "";
  }
}
