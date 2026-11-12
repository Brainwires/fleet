// On the Mac mini the watchdog's own ~/.denext-runners/health.json is local and fresher than the org
// variable it publishes: when it is newer, its pools' health wins (paused from the scheduler's
// paused-<pool> files); slots and busy stay the variable's. Its `pools` keys are the scheduler's pool
// names (each with its label, slots and runner prefix from a current watchdog): they become the doc's
// per-pool `hosts`, which the pool list and the per-host cards read. The label-keyed `pools` entry
// merges every local pool on that label the way the watchdog publishes it (ok while any is).
// Pure: the files come in as values.

import type { HealthState, HostHealth, PoolHealth, PoolHealthDoc } from "./health.ts";
import { POOLS } from "./pools.ts";

type LocalPool = {
  healthy?: unknown;
  reason?: unknown;
  since_epoch?: unknown;
  label?: unknown;
  slots?: unknown;
  runner_prefix?: unknown;
} | null;

const text = (v: unknown): string | null => (typeof v === "string" && v ? v : null);

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
  const known = new Map(POOLS.map((p) => [p.id, p]));
  const hosts: Record<string, HostHealth> = {};
  for (const [id, raw] of Object.entries(l.pools)) {
    const p = raw as LocalPool;
    if (!p || typeof p.healthy !== "boolean") continue;
    const label = text(p.label) ?? known.get(id)?.label ?? null;
    if (!label) continue;
    const prev = base?.hosts?.[id];
    hosts[id] = {
      ok: p.healthy,
      reason: p.healthy ? "" : text(p.reason) ?? "",
      since: typeof p.since_epoch === "number" ? p.since_epoch * 1000 : prev?.since ?? null,
      slots: typeof p.slots === "number" ? p.slots : prev?.slots ?? known.get(id)?.slots ?? null,
      busy: prev?.busy ?? null,
      paused: paused.has(id),
      label,
      runnerPrefix: text(p.runner_prefix) ?? known.get(id)?.runnerPrefix ?? `denext-${id}-`,
    };
  }
  const byLabel = new Map<string, HostHealth[]>();
  for (const h of Object.values(hosts)) {
    const label = h.label ?? "";
    byLabel.set(label, [...(byLabel.get(label) ?? []), h]);
  }
  const pools: Record<string, PoolHealth> = { ...(base?.pools ?? {}) };
  for (const [label, hs] of byLabel) {
    const prev = pools[label];
    const ok = hs.some((h) => h.ok);
    const since = hs.filter((h) => h.ok === ok).flatMap((h) => (h.since === null ? [] : [h.since]));
    pools[label] = {
      ok,
      reason: ok ? "" : hs.map((h) => h.reason).filter(Boolean).join("; "),
      since: since.length ? Math.min(...since) : prev?.since ?? null,
      slots: prev?.slots ?? hs.reduce((n, h) => n + (h.slots ?? 0), 0),
      busy: prev?.busy ?? null,
      paused: hs.every((h) => h.paused),
    };
  }
  const doc: PoolHealthDoc = {
    checkedAt,
    pools,
    hosts: Object.keys(hosts).length ? hosts : base?.hosts ?? {},
    alerts: base?.alerts ?? [],
  };
  return { state: now - checkedAt > 30 * 60_000 ? "stale" : "ok", doc };
}
