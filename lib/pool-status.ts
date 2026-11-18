// A pool's badge: one state from the watchdog's health and the runner scheduler's start state
// (lib/pool-state.ts), so every surface (summary bar, pool cards, the detail page, the MCP answers)
// says the same thing. Red is kept for real failures:
//   paused    — paused by hand (pause-pool.sh), whatever else is said: amber "Paused";
//   unhealthy — the watchdog reports a failure (registration failing, not clean) or the scheduler
//               says the host is down (unreachable): red;
//   blocked   — a free slot, but a gate holds the launch (RAM, disk, a VM limit): amber, with why;
//   busy      — every slot busy with jobs queued (the scheduler's "degraded"): informational blue;
//   ok        — healthy.
// The watchdog reports a paused pool as not healthy ("paused by pause-pool.sh (288 s left)"): that
// is a pause, never a failure. Pure.

import type { PoolState } from "./model.ts";

/** The watchdog's word on a pool (lib/health.ts `PoolHealth`, or the agents' shape). */
export interface HealthWord {
  readonly ok: boolean;
  readonly paused: boolean;
  readonly reason: string;
}

/** The scheduler's word on a pool (lib/pool-state.ts `PoolStart`, or the agents' shape). */
export interface StartWord {
  readonly state: string;
  readonly reason: string;
}

/** The badge's text per state ("Paused" capitalised: it stands out without being red). */
export const POOL_STATE_TEXT: Readonly<Record<PoolState, string>> = {
  ok: "ok",
  paused: "Paused",
  busy: "busy",
  blocked: "blocked",
  unhealthy: "unhealthy",
  unknown: "no health",
};

/** Whether the watchdog's word is a pause (its own flag, or a "paused …" reason with `ok` false). */
export function healthIsPaused(h: HealthWord | null | undefined): boolean {
  return !!h && (h.paused || (!h.ok && /^paused\b/i.test(h.reason.trim())));
}

/**
 * The pool's badge state and the reason shown beside it, from the watchdog's health (`null`: none
 * fresh) and the scheduler's start state (`null`: none current). Without health: `unknown`.
 */
export function poolStatus(
  h: HealthWord | null | undefined,
  start: StartWord | null | undefined,
): { readonly state: PoolState; readonly reason: string } {
  if (!h) return { state: "unknown", reason: "" };
  const st = start ?? null;
  if (st?.state === "paused") return { state: "paused", reason: st.reason || h.reason };
  if (healthIsPaused(h)) return { state: "paused", reason: h.reason };
  if (!h.ok) return { state: "unhealthy", reason: h.reason };
  switch (st?.state) {
    case "down":
      return { state: "unhealthy", reason: st.reason };
    case "blocked":
      return { state: "blocked", reason: st.reason };
    case "degraded":
      return { state: "busy", reason: st.reason };
    default:
      return { state: "ok", reason: "" };
  }
}
