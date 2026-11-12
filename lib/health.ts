// DENEXT_POOL_HEALTH: the org variable the runner watchdog publishes (ops/runners/README.md).
// Schema v1: {"v":1,"checked_at":epoch,"pools":{"<label>":{ok,reason,since,slots,busy,paused}},
// "alerts":[{at,pool,msg}]}. The variable may be missing (404), garbage, or stale (the watchdog
// down); every case parses to a result the UI can show, never a throw.

/** One pool's health as published. */
export interface PoolHealth {
  readonly ok: boolean;
  readonly reason: string;
  /** When `ok` last flipped, epoch ms. */
  readonly since: number | null;
  readonly slots: number | null;
  readonly busy: number | null;
  readonly paused: boolean;
}

/** One alert line. */
export interface HealthAlert {
  /** Epoch ms. */
  readonly at: number;
  /** A pool's short name, or `fleet`. */
  readonly pool: string;
  readonly msg: string;
}

/** The parsed variable. */
export interface PoolHealthDoc {
  /** Epoch ms of the watchdog's check. */
  readonly checkedAt: number;
  /** By runs-on label. */
  readonly pools: Readonly<Record<string, PoolHealth>>;
  readonly alerts: readonly HealthAlert[];
}

/** What Fleet knows about pool health. */
export type HealthState =
  | { readonly state: "ok"; readonly doc: PoolHealthDoc }
  | { readonly state: "stale"; readonly doc: PoolHealthDoc }
  | { readonly state: "unavailable"; readonly message: string }
  | { readonly state: "invalid"; readonly message: string };

/** Older than this, the variable is stale (the watchdog's own rule: 30 min). */
export const HEALTH_STALE_MS = 30 * 60_000;

const num = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** Epoch seconds to ms (null stays null). */
const ms = (secs: number | null): number | null => (secs === null ? null : secs * 1000);

/**
 * Parse the variable's value.
 *
 * @param raw The variable's `value` string; `null` when the variable doesn't exist.
 * @param now Epoch ms, for staleness.
 */
export function parsePoolHealth(raw: string | null, now: number): HealthState {
  if (raw === null) return { state: "unavailable", message: "pool health unavailable" };
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return { state: "invalid", message: "pool health is not JSON" };
  }
  if (!isObj(data)) return { state: "invalid", message: "pool health is not an object" };
  if (data.v !== 1) return { state: "invalid", message: `pool health schema v${String(data.v)}` };
  const checked = num(data.checked_at);
  if (checked === null) return { state: "invalid", message: "pool health has no checked_at" };
  const pools: Record<string, PoolHealth> = {};
  if (isObj(data.pools)) {
    for (const [label, p] of Object.entries(data.pools)) {
      if (!isObj(p) || typeof p.ok !== "boolean") continue;
      pools[label] = {
        ok: p.ok,
        reason: str(p.reason),
        since: ms(num(p.since)),
        slots: num(p.slots),
        busy: num(p.busy),
        paused: p.paused === true,
      };
    }
  }
  const alerts: HealthAlert[] = [];
  if (Array.isArray(data.alerts)) {
    for (const a of data.alerts) {
      if (!isObj(a)) continue;
      const at = num(a.at);
      const msg = str(a.msg);
      if (at === null || !msg) continue;
      alerts.push({ at: at * 1000, pool: str(a.pool) || "fleet", msg });
    }
  }
  alerts.sort((a, b) => b.at - a.at);
  const doc: PoolHealthDoc = { checkedAt: checked * 1000, pools, alerts };
  return { state: now - doc.checkedAt > HEALTH_STALE_MS ? "stale" : "ok", doc };
}
