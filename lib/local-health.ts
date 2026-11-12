// On the Mac mini the watchdog's own ~/.denext-runners/health.json is local and fresher than the org
// variable it publishes: when it is newer, its pools' health wins (paused from the scheduler's
// paused-<pool> files); slots and busy stay the variable's. Pure: the files come in as values.

import type { HealthState, PoolHealth, PoolHealthDoc } from "./health.ts";
import { POOLS } from "./pools.ts";

/** Merge the local health file over the variable's state. */
export function mergeLocalHealth(
  variable: HealthState,
  localJson: unknown,
  paused: ReadonlySet<string>,
  now: number,
): HealthState {
  const l = localJson as { checked_at_epoch?: unknown; pools?: Record<string, unknown> } | null;
  if (!l || typeof l.checked_at_epoch !== "number" || typeof l.pools !== "object" || !l.pools) {
    return variable;
  }
  const checkedAt = l.checked_at_epoch * 1000;
  const base = variable.state === "ok" || variable.state === "stale" ? variable.doc : null;
  if (base && base.checkedAt >= checkedAt) return variable;
  const pools: Record<string, PoolHealth> = { ...(base?.pools ?? {}) };
  for (const def of POOLS) {
    const p = l.pools[def.id] as
      | { healthy?: unknown; reason?: unknown; since_epoch?: unknown }
      | undefined;
    if (!p || typeof p.healthy !== "boolean") continue;
    const prev = pools[def.label];
    pools[def.label] = {
      ok: p.healthy,
      reason: p.healthy ? "" : typeof p.reason === "string" ? p.reason : "",
      since: typeof p.since_epoch === "number" ? p.since_epoch * 1000 : prev?.since ?? null,
      slots: prev?.slots ?? def.slots,
      busy: prev?.busy ?? null,
      paused: paused.has(def.id),
    };
  }
  const doc: PoolHealthDoc = { checkedAt, pools, alerts: base?.alerts ?? [] };
  return { state: now - checkedAt > 30 * 60_000 ? "stale" : "ok", doc };
}
