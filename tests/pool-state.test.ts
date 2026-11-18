// Why a pool cannot start jobs: the scheduler's pool-state file parsed (lib/pool-state.ts), carried
// onto each host by the local health merge, shown as one line on the pool card, raised in the
// summary once it lasts, and answered by the MCP's fleet_pool_health. No network, no files.

import "./fixture-settings.ts";

import { assert, assertEquals } from "@std/assert";
import { type AgentSnapshot, agentStart } from "../lib/agent-snapshot.ts";
import { parsePoolHealth } from "../lib/health.ts";
import { mergeLocalHealth, withStarts } from "../lib/local-health.ts";
import {
  currentPoolStarts,
  longBlocked,
  parsePoolState,
  POOL_STATE_STALE_MS,
  startLine,
} from "../lib/pool-state.ts";
import { poolCards, summarize } from "../lib/snapshot.ts";
import { TOOLS } from "../mcp/fleet-mcp.ts";
import { poolHealthResult } from "../mcp/queries.ts";

const NOW = Date.parse("2026-11-18T17:30:00Z");
const S = NOW / 1000;

/** The scheduler's file: one pool per state. */
const FILE = {
  checked_at: S - 5,
  queue_known: true,
  queue_unknown_since: null,
  pools: {
    "mac-arm": {
      label: "denext-macos-arm64",
      state: "blocked",
      code: "ram",
      reason: "waiting for RAM: 12 of 16 GB in use by win-arm64 x1 (8 GB), needs 8",
      detail: "12 GB of VM RAM in use (Tart + QEMU, booting slots counted), need 8 (budget 16)",
      state_since: S - 20 * 60,
      reason_since: S - 3 * 60,
      slots: 2,
      busy: 1,
      free: 1,
      queued: 2,
      unvetted: 0,
      blocked_jobs: [
        {
          repo: "o/r",
          run_id: 7,
          job_id: 71,
          name: "macos-15 / test unit",
          queued_at: "2026-11-18T17:05:00Z",
          waiting_s: 1500,
        },
        {
          repo: "o/r",
          run_id: 7,
          job_id: 72,
          name: "macos-15 / test libs",
          queued_at: "2026-11-18T17:06:00Z",
          waiting_s: 1440,
        },
        { repo: "o/r", job_id: 73, name: "no run id: dropped" },
      ],
      slot_states: [{ slot: 1, phase: "running", since: S - 600, job: "repo=o/r run=7 job=70" }],
    },
    "linux-x64": {
      label: "denext-linux-x64",
      state: "degraded",
      code: "capacity",
      reason:
        "all 3 job containers on the Linux host are busy (3 of 3; linux-x64:1 linux-x64-2204:2)",
      detail: null,
      state_since: S - 30,
      reason_since: S - 30,
      slots: 3,
      busy: 1,
      free: 2,
      queued: 1,
      unvetted: 0,
      blocked_jobs: [{ repo: "o/r", run_id: 7, job_id: 80, name: "pick runners", queued_at: null }],
      slot_states: [],
    },
    "win-x64": {
      label: "denext-windows-x64",
      state: "paused",
      code: "paused",
      reason: "paused by someone for a base commit, 4 min left",
      state_since: S - 60,
      reason_since: S - 60,
      slots: 1,
      busy: 0,
      free: 1,
      queued: 0,
      blocked_jobs: [],
      slot_states: [],
    },
    "mac-x64": {
      label: "denext-macos-x64",
      state: "down",
      code: "host-unreachable",
      reason: "host unreachable: the MacBook",
      state_since: S - 40 * 60,
      reason_since: S - 40 * 60,
      slots: 1,
      busy: 0,
      free: 1,
      queued: 1,
      blocked_jobs: [{
        repo: "o/r",
        run_id: 7,
        job_id: 90,
        name: "macos-15-intel / build debug",
        queued_at: "2026-11-18T16:50:00Z",
      }],
      slot_states: [],
    },
    "win-arm64": {
      label: "denext-windows-arm64",
      state: "healthy",
      code: "running",
      reason: "1 of 2 slot(s) busy, nothing queued",
      slots: 2,
      busy: 1,
      free: 1,
      queued: 0,
      blocked_jobs: [],
      slot_states: [],
    },
    "bogus": { state: "on fire" },
  },
};

Deno.test("parsePoolState: every state, numbers to ms, junk dropped", () => {
  const doc = parsePoolState(FILE)!;
  assertEquals(doc.checkedAt, (S - 5) * 1000);
  assertEquals(doc.queueKnown, true);
  assertEquals(Object.keys(doc.pools).sort(), [
    "linux-x64",
    "mac-arm",
    "mac-x64",
    "win-arm64",
    "win-x64",
  ]);
  const m = doc.pools["mac-arm"];
  assertEquals(m.state, "blocked");
  assertEquals(m.code, "ram");
  assertEquals(m.stateSince, (S - 20 * 60) * 1000);
  assertEquals(m.free, 1);
  assertEquals(m.blockedJobs.map((j) => j.jobId), [71, 72]);
  assertEquals(m.blockedJobs[0].queuedAt, Date.parse("2026-11-18T17:05:00Z"));
  assertEquals(m.slotStates, [{ slot: 1, phase: "running", since: (S - 600) * 1000 }]);
  assertEquals(doc.pools["win-x64"].detail, null);
  for (const junk of [null, "x", [], {}, { checked_at: "1", pools: {} }, { checked_at: 1 }]) {
    assertEquals(parsePoolState(junk), null);
  }
});

Deno.test("currentPoolStarts: a file the scheduler stopped writing says nothing; an unknown queue blocks every pool", () => {
  const doc = parsePoolState(FILE)!;
  assertEquals(Object.keys(currentPoolStarts(doc, NOW)).length, 5);
  assertEquals(currentPoolStarts(doc, doc.checkedAt + POOL_STATE_STALE_MS + 1), {});
  assertEquals(currentPoolStarts(null, NOW), {});
  const unknown = parsePoolState({ ...FILE, queue_known: false, queue_unknown_since: S - 120 })!;
  const cur = currentPoolStarts(unknown, NOW);
  assertEquals(cur["win-arm64"].state, "blocked");
  assertEquals(cur["win-arm64"].code, "queue-unknown");
  assertEquals(cur["win-arm64"].stateSince, (S - 120) * 1000);
  assertEquals(cur["win-x64"].state, "paused", "a paused pool stays paused");
});

Deno.test("startLine: the state, how long, the reason with its numbers, the jobs waiting; nothing for a healthy pool", () => {
  const p = parsePoolState(FILE)!.pools;
  assertEquals(
    startLine(p["mac-arm"], NOW),
    "blocked 20 min: waiting for RAM: 12 of 16 GB in use by win-arm64 x1 (8 GB), needs 8 (2 jobs wait)",
  );
  assertEquals(
    startLine(p["linux-x64"], NOW),
    "degraded: all 3 job containers on the Linux host are busy (3 of 3; linux-x64:1 linux-x64-2204:2) (1 job waits)",
  );
  assertEquals(
    startLine(p["win-x64"], NOW),
    "paused 60 s: paused by someone for a base commit, 4 min left",
  );
  assertEquals(
    startLine(p["mac-x64"], NOW),
    "down 40 min: host unreachable: the MacBook (1 job waits)",
  );
  assertEquals(startLine(p["win-arm64"], NOW), "");
  assertEquals(startLine(null, NOW), "");
});

Deno.test("longBlocked: blocked or down, a free slot, jobs waiting, long enough", () => {
  const p = parsePoolState(FILE)!.pools;
  assertEquals(longBlocked(p, NOW, 15 * 60_000).map((b) => b.pool).sort(), ["mac-arm", "mac-x64"]);
  assertEquals(longBlocked(p, NOW, 30 * 60_000).map((b) => b.pool), ["mac-x64"]);
  // degraded (every slot busy) and paused never count
  assertEquals(longBlocked(p, NOW, 0).map((b) => b.pool).sort(), ["mac-arm", "mac-x64"]);
});

/** A local health file whose pools are all healthy: the watchdog sees nothing wrong. */
const LOCAL = {
  checked_at_epoch: S - 10,
  pools: Object.fromEntries(
    ["mac-arm", "linux-x64", "win-x64", "mac-x64", "win-arm64"].map((id) => [id, {
      healthy: true,
      reason: "",
      label: (FILE.pools as Record<string, { label?: string }>)[id].label,
      slots: 2,
      runner_prefix: `denext-${id}-`,
    }]),
  ),
};

Deno.test("the merge carries each pool's start state onto its host; the card and the summary show it", () => {
  const starts = currentPoolStarts(parsePoolState(FILE), NOW);
  const variable = parsePoolHealth(null, NOW);
  const health = mergeLocalHealth(variable, LOCAL, new Set(), NOW, starts);
  assert(health.state === "ok");
  assertEquals(health.doc.hosts["mac-arm"].ok, true, "the watchdog calls it healthy");
  assertEquals(
    health.doc.hosts["mac-arm"].start?.state,
    "blocked",
    "the scheduler says it cannot start jobs",
  );
  assertEquals(health.doc.hosts["win-arm64"].start?.state, "healthy");
  // without a state file nothing is attached
  const bare = mergeLocalHealth(variable, LOCAL, new Set(), NOW);
  assert(bare.state === "ok");
  assertEquals(bare.doc.hosts["mac-arm"].start, null);
  assertEquals(withStarts(bare, {}), bare);
  const again = withStarts(bare, starts);
  assert(again.state === "ok");
  assertEquals(again.doc.hosts["mac-x64"].start?.code, "host-unreachable");

  const cards = poolCards([], [], health, null);
  const card = cards.find((c) => c.id === "mac-arm")!;
  assertEquals(card.state, "blocked", "the badge follows the scheduler (lib/pool-status.ts)");
  assertEquals(card.start?.code, "ram");
  assertEquals(cards.find((c) => c.id === "linux-x64")!.state, "busy");
  assertEquals(cards.find((c) => c.id === "win-x64")!.state, "paused");
  assertEquals(
    cards.find((c) => c.id === "mac-x64")!.state,
    "unhealthy",
    "a down host is a failure",
  );
  const sum = summarize([], [], cards, NOW, { pollOk: true, healthStale: false });
  assertEquals(sum.severity, "alert", "the unreachable host");
  assert(
    sum.reasons.includes(
      "mac-arm blocked 20 min: waiting for RAM: 12 of 16 GB in use by win-arm64 x1 (8 GB), needs 8 (2 jobs wait)",
    ),
    sum.reasons.join(" | "),
  );
  assert(
    sum.reasons.includes("mac-x64 unhealthy: host unreachable: the MacBook"),
    sum.reasons.join(" | "),
  );
  assert(sum.reasons.includes("win-x64 paused"));
  assert(!sum.reasons.some((r) => r.startsWith("linux-x64")), "every slot busy is not an alert");
});

Deno.test("fleet_pool_health: state, reason, since, blocked jobs; the watchdog's word without the scheduler's", () => {
  assert(TOOLS.some((t) => t.name === "fleet_pool_health"));
  const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
  const p = parsePoolState(FILE)!.pools;
  const host = (id: string, over: Record<string, unknown> = {}) => {
    const s = p[id];
    return {
      id,
      label: `l-${id}`,
      ok: true,
      paused: false,
      reason: "",
      slots: 2,
      busy: 1,
      since: iso(NOW - 3_600_000),
      ...(s
        ? {
          start: {
            state: s.state,
            code: s.code,
            reason: s.reason,
            detail: s.detail,
            state_since: iso(s.stateSince),
            reason_since: iso(s.reasonSince),
            slots: s.slots,
            busy: s.busy,
            free: s.free,
            queued: s.queued,
            blocked_jobs: s.blockedJobs.map((j) => ({
              repo: j.repo,
              run_id: j.runId,
              job_id: j.jobId,
              name: j.name,
              queued_at: iso(j.queuedAt),
            })),
            slot_states: s.slotStates.map((x) => ({
              slot: x.slot,
              phase: x.phase,
              since: iso(x.since),
            })),
          },
        }
        : {}),
      ...over,
    };
  };
  const snap = {
    v: 1,
    updated_at: iso(NOW - 5_000),
    written_at: iso(NOW - 5_000),
    clock_offset_ms: 0,
    poll: { ok: true, message: "" },
    hooks: { state: "live", last_delivery_at: null },
    health: { state: "ok", checked_at: null, message: "" },
    pools: [],
    hosts: [
      host("mac-arm"),
      host("win-arm64"),
      host("mac-x64"),
      host("old-pool", { ok: false, reason: "ssh failed" }),
    ],
  } as unknown as AgentSnapshot;
  const r = poolHealthResult(snap, NOW, {});
  assertEquals(r.unhealthy.map((u) => `${u.pool}:${u.state}`), [
    "mac-x64:down",
    "old-pool:down",
    "mac-arm:blocked",
  ]);
  const m = r.pools.find((x) => x.pool === "mac-arm")!;
  assertEquals(m.state, "blocked");
  assertEquals(m.source, "scheduler");
  assertEquals(m.for_s, 20 * 60);
  assertEquals(m.free, 1);
  assertEquals(m.blocked_jobs.map((j) => [j.job_id, j.waiting_s]), [[71, 25 * 60], [72, 24 * 60]]);
  assertEquals(m.slot_states[0].for_s, 600);
  const o = r.pools.find((x) => x.pool === "old-pool")!;
  assertEquals([o.state, o.reason, o.source], ["down", "ssh failed", "watchdog"]);
  assertEquals(poolHealthResult(snap, NOW, { pool: "win-arm64" }).pools.map((x) => x.state), [
    "healthy",
  ]);
  assertEquals(poolHealthResult(null, NOW, {}).stale, true);
  // the scheduler's file read directly wins over the snapshot, and answers without one
  const direct = { "mac-arm": agentStart(p["linux-x64"]), "new-pool": agentStart(p["mac-x64"]) };
  const d = poolHealthResult(snap, NOW, {}, direct);
  assertEquals(d.pools.find((x) => x.pool === "mac-arm")!.state, "degraded");
  assertEquals(d.pools.find((x) => x.pool === "new-pool")!.reason, "host unreachable: the MacBook");
  const alone = poolHealthResult(null, NOW, {}, direct);
  assertEquals(alone.pools.map((x) => x.pool).sort(), ["mac-arm", "new-pool"]);
  assertEquals(alone.unhealthy[0].pool, "new-pool");
});
