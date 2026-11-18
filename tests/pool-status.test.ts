// A pool's badge (lib/pool-status.ts): Paused (amber) for a paused pool even when the watchdog
// reports it "not healthy", busy for every slot busy, blocked (amber) for a gate, red unhealthy only
// for a real failure; the same on the cards, the summary, the events and the MCP answers.

import "./fixture-settings.ts";

import { assert, assertEquals } from "@std/assert";
import type { AgentSnapshot } from "../lib/agent-snapshot.ts";
import type { HealthState, HostHealth } from "../lib/health.ts";
import type { PoolStart } from "../lib/pool-state.ts";
import { healthIsPaused, POOL_STATE_TEXT, poolStatus } from "../lib/pool-status.ts";
import { poolCards, summarize } from "../lib/snapshot.ts";
import { poolHealthResult } from "../mcp/queries.ts";

const NOW = Date.parse("2026-11-18T20:30:00Z");
const OK = { ok: true, paused: false, reason: "" };
/** What the watchdog publishes for a pool pause-pool.sh paused. */
const PAUSED_WD = { ok: false, paused: false, reason: "paused by pause-pool.sh (288 s left)" };
const start = (state: string, reason = `${state} reason`) => ({ state, reason });

Deno.test("poolStatus: each health / start pair maps to one badge", () => {
  const cases: [
    string,
    Parameters<typeof poolStatus>[0],
    Parameters<typeof poolStatus>[1],
    string,
  ][] = [
    ["no health", null, start("blocked"), "unknown"],
    ["healthy", OK, start("healthy"), "ok"],
    ["no scheduler word", OK, null, "ok"],
    ["the watchdog's pause flag", { ...OK, paused: true }, null, "paused"],
    ["the watchdog's 'paused by' report, not a failure", PAUSED_WD, null, "paused"],
    ["the scheduler's paused", PAUSED_WD, start("paused"), "paused"],
    [
      "paused wins over a watchdog failure",
      { ...PAUSED_WD, reason: "x" },
      start("paused"),
      "paused",
    ],
    ["every slot busy, jobs queued", OK, start("degraded"), "busy"],
    ["a gate holds the launch", OK, start("blocked"), "blocked"],
    ["host unreachable", OK, start("down"), "unhealthy"],
    [
      "registration failing",
      { ok: false, paused: false, reason: "registration failing" },
      start("healthy"),
      "unhealthy",
    ],
    [
      "a failure is not hidden behind busy",
      { ok: false, paused: false, reason: "not clean" },
      start("degraded"),
      "unhealthy",
    ],
  ];
  for (const [what, h, s, want] of cases) assertEquals(poolStatus(h, s).state, want, what);
});

Deno.test("poolStatus: the reason beside the badge", () => {
  assertEquals(
    poolStatus(PAUSED_WD, start("paused", "paused by nightness for a fix, 4 min left")).reason,
    "paused by nightness for a fix, 4 min left",
    "the scheduler's words (who and why) over the watchdog's",
  );
  assertEquals(poolStatus(PAUSED_WD, null).reason, "paused by pause-pool.sh (288 s left)");
  assertEquals(poolStatus(OK, start("blocked", "waiting for RAM")).reason, "waiting for RAM");
  assertEquals(poolStatus(OK, start("healthy", "idle, nothing queued")).reason, "");
  assertEquals(
    poolStatus({ ok: false, paused: false, reason: "ssh failed" }, null).reason,
    "ssh failed",
  );
});

Deno.test("badge text: Paused is capitalised; a pause is told apart from a failure", () => {
  assertEquals(POOL_STATE_TEXT.paused, "Paused");
  assertEquals(POOL_STATE_TEXT.busy, "busy");
  assertEquals(POOL_STATE_TEXT.unhealthy, "unhealthy");
  assert(healthIsPaused(PAUSED_WD));
  assert(healthIsPaused({ ...OK, paused: true }));
  assert(!healthIsPaused({ ok: false, paused: false, reason: "unpaused, then failed" }));
  assert(
    !healthIsPaused({ ok: true, paused: false, reason: "paused earlier" }),
    "ok is not paused",
  );
  assert(!healthIsPaused(null));
});

/** A local-health state with one host per entry. */
function healthOf(hosts: Record<string, Partial<HostHealth>>): HealthState {
  const out: Record<string, HostHealth> = {};
  for (const [id, h] of Object.entries(hosts)) {
    out[id] = {
      ok: true,
      reason: "",
      since: NOW - 60_000,
      slots: 1,
      busy: 0,
      paused: false,
      label: `denext-${id}`,
      runnerPrefix: `denext-${id}-`,
      ...h,
    };
  }
  return { state: "ok", doc: { checkedAt: NOW - 5_000, pools: {}, hosts: out, alerts: [] } };
}

const startOf = (state: PoolStart["state"], reason: string): PoolStart => ({
  state,
  code: state,
  reason,
  detail: null,
  stateSince: NOW - 120_000,
  reasonSince: NOW - 120_000,
  slots: 1,
  busy: state === "degraded" ? 1 : 0,
  free: state === "degraded" ? 0 : 1,
  queued: 2,
  blockedJobs: [],
  slotStates: [],
});

Deno.test("cards and summary: a paused pool is amber Paused, never red unhealthy", () => {
  const health = healthOf({
    "win-x64-pc": {
      ...PAUSED_WD,
      paused: true,
      start: startOf("paused", "paused by nightness for a fix, 4 min left"),
    },
    "mac-x64": { start: startOf("degraded", "all 1 slot(s) busy; 4 job(s) queued") },
  });
  const cards = poolCards([], [], health, null);
  const brain = cards.find((c) => c.id === "win-x64-pc")!;
  assertEquals([brain.state, brain.reason], [
    "paused",
    "paused by nightness for a fix, 4 min left",
  ]);
  assertEquals(cards.find((c) => c.id === "mac-x64")!.state, "busy");
  const sum = summarize([], [], cards, NOW, { pollOk: true, healthStale: false });
  assertEquals(sum.severity, "warn", "a pause is amber, a busy pool no severity");
  assert(sum.reasons.includes("win-x64-pc paused"), sum.reasons.join(" | "));
  assert(!sum.reasons.some((r) => r.includes("unhealthy")), sum.reasons.join(" | "));
  // without the pause file and the scheduler's word, the watchdog's report alone is still a pause
  const bare = poolCards([], [], healthOf({ "win-x64-pc": PAUSED_WD }), null);
  assertEquals(bare.find((c) => c.id === "win-x64-pc")!.state, "paused");
});

Deno.test("fleet_pool_health: `status` is the badge; a watchdog-reported pause is paused, not down", () => {
  const snap = {
    v: 1,
    updated_at: new Date(NOW - 5_000).toISOString(),
    written_at: new Date(NOW - 5_000).toISOString(),
    clock_offset_ms: 0,
    poll: { ok: true, message: "" },
    hooks: { state: "live", last_delivery_at: null },
    health: { state: "ok", checked_at: null, message: "" },
    pools: [],
    hosts: [
      { id: "brain", label: "l", ...PAUSED_WD, slots: 1, busy: 0, since: null },
      { id: "dead", label: "l", ok: false, paused: false, reason: "ssh failed", since: null },
      {
        id: "full",
        label: "l",
        ...OK,
        since: null,
        start: { state: "degraded", code: "capacity", reason: "all busy", state_since: null },
      },
    ],
  } as unknown as AgentSnapshot;
  const r = poolHealthResult(snap, NOW, {});
  const by = (id: string) => r.pools.find((p) => p.pool === id)!;
  assertEquals([by("brain").state, by("brain").status, by("brain").code], [
    "paused",
    "paused",
    "paused",
  ]);
  assertEquals([by("dead").state, by("dead").status], ["down", "unhealthy"]);
  assertEquals([by("full").state, by("full").status], ["degraded", "busy"]);
  assertEquals(r.unhealthy.find((u) => u.pool === "brain")?.status, "paused");
});
