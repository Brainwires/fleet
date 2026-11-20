// Idle runners over MCP: the idle condition (mcp/idle.ts) on snapshots — triggering only after
// idle_for_s, a busy pool resetting the clock, paused pools and `github` left out, mode `any`, and an
// immediate answer when the pools have already been idle long enough by Fleet's records — then
// fleet_wait `until: "idle"`, fleet_watch_idle's one notification per idle episode, and the built-in
// `idle` event, driven over the server's handle() on a temp data folder (short re-read, no watcher).

import { assert, assertEquals, assertFalse, assertThrows } from "@std/assert";
import type { AgentJob, AgentPool, AgentSnapshot } from "../lib/agent-snapshot.ts";
import { AGENT_SNAPSHOT_FILE } from "../lib/agent-files.ts";
import { appendJournal } from "../lib/deno-host.ts";
import type { FleetEvent } from "../lib/events.ts";
import { createFleetMcp, FleetFiles, TOOLS } from "../mcp/fleet-mcp.ts";
import { idleArgs, IdleTracker, lastActivity, watchedPools } from "../mcp/idle.ts";
import { ArgError, waitArgs } from "../mcp/queries.ts";
import { NOW } from "./helpers.ts";

// deno-lint-ignore no-explicit-any
type Any = any;

const ISO = (ms: number) => new Date(ms).toISOString();
const S = 1000;

const pool = (id: string, over: Partial<AgentPool> = {}): AgentPool => ({
  id,
  label: `denext-${id}`,
  state: "ok",
  reason: "",
  slots: 2,
  busy: 0,
  running: 0,
  queued: 0,
  state_since: null,
  oldest_queued_since: null,
  ...over,
});

const doneJob = (pool: string, completedAt: number): AgentJob => ({
  repo: "Brainwires/denext",
  run_id: 1,
  job_id: 11,
  name: "test",
  workflow: "CI",
  branch: "development",
  sha: "abcdef1234567890",
  status: "completed",
  conclusion: "success",
  created_at: ISO(completedAt - 600 * S),
  started_at: ISO(completedAt - 500 * S),
  completed_at: ISO(completedAt),
  html_url: "https://github.com/Brainwires/denext/actions/runs/1/job/11",
  labels: ["self-hosted"],
  runner_name: `denext-${pool}-1`,
  pool,
  steps: [],
  failed_step: null,
  failure_annotation: null,
});

/** A fresh snapshot at `at` (webhooks live, so a quiet fleet stays fresh). */
function snap(at: number, pools: AgentPool[], over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    v: 1,
    updated_at: ISO(at - 5 * S),
    written_at: ISO(at - 5 * S),
    source: "hook",
    auth: "gh",
    poll: { ok: true, message: "", last_success_at: ISO(at), interval_ms: 60_000, slow: null },
    rate: null,
    hooks: { state: "live", last_delivery_at: ISO(at) },
    health: { state: "ok", checked_at: ISO(at), message: "" },
    summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
    pools,
    hosts: pools.map((p) => ({
      id: p.id,
      label: p.label,
      ok: true,
      paused: p.state === "paused",
      reason: "",
      slots: p.slots,
      busy: p.busy,
      since: null,
    })),
    alerts: [],
    event_seq: 0,
    runs: [],
    jobs: [],
    ...over,
  };
}

const busyLinux = (at: number) =>
  snap(at, [pool("linux-x64", { busy: 1, running: 1 }), pool("mac-arm")]);
const allIdle = (at: number) => snap(at, [pool("linux-x64"), pool("mac-arm")]);

// ---- the condition ----

Deno.test("idle: triggers only after idle_for_s; a busy pool resets the clock", () => {
  const tr = new IdleTracker(idleArgs({ idle_for_s: 120 }));
  // Seen busy first: the clock starts when the pool is next seen idle.
  const busy = tr.step(busyLinux(NOW), [], NOW);
  assertFalse(busy.holding);
  assertEquals(busy.dueAt, null);
  const t1 = NOW + 10 * S;
  const first = tr.step(allIdle(t1), [], t1);
  assert(first.holding && !first.triggered);
  assertEquals(first.dueAt, t1 + 120 * S);
  assertFalse(tr.step(allIdle(t1 + 119 * S), [], t1 + 119 * S).triggered);
  const fired = tr.step(allIdle(t1 + 120 * S), [], t1 + 120 * S);
  assert(fired.triggered);
  assertEquals(fired.idlePools, ["linux-x64", "mac-arm"]);
  assertEquals(fired.idleSince, t1);
  assertEquals(fired.pools.map((p) => [p.id, p.slots, p.busy, p.queued, p.state]), [
    ["linux-x64", 2, 0, 0, "ok"],
    ["mac-arm", 2, 0, 0, "ok"],
  ]);
  // Busy again (a queued job counts too), then idle: the clock starts over.
  const t2 = t1 + 200 * S;
  const queued = snap(t2, [pool("linux-x64"), pool("mac-arm", { queued: 1 })]);
  assertFalse(tr.step(queued, [], t2).holding);
  const t3 = t2 + 30 * S;
  assertFalse(tr.step(allIdle(t3), [], t3).triggered);
  assertFalse(tr.step(allIdle(t3 + 100 * S), [], t3 + 100 * S).triggered);
  const again = tr.step(allIdle(t3 + 120 * S), [], t3 + 120 * S);
  assert(again.triggered);
  assertEquals(again.idleSince, t3);
});

Deno.test("idle: paused pools, pools without slots and `github` are not watched", () => {
  const s = snap(NOW, [
    pool("linux-x64"),
    pool("mac-x64", { state: "paused", busy: 1 }),
    pool("win-x64", { slots: 0, busy: 1 }),
    pool("win-arm", { slots: null }),
    pool("github", { slots: null, busy: 5, running: 5, queued: 3 }),
  ]);
  // A pool the watchdog reports paused (its badge not yet updated) is left out too.
  const hostPaused = {
    ...s,
    pools: [...s.pools, pool("linux-arm", { busy: 1 })],
    hosts: [...s.hosts, { ...s.hosts[0], id: "linux-arm", paused: true }],
  };
  const a = idleArgs({});
  assertEquals(watchedPools(hostPaused, a).map((p) => p.id), ["linux-x64"]);
  // Nothing on linux-x64 in Fleet's records: idle at once, whatever the others do.
  const v = new IdleTracker(idleArgs({ idle_for_s: 120 })).step(hostPaused, [], NOW);
  assert(v.triggered);
  assertEquals(v.idlePools, ["linux-x64"]);
  // A list narrows the set; a paused pool in it is still left out.
  assertEquals(
    watchedPools(hostPaused, idleArgs({ pools: ["linux-x64", "mac-x64"] })).map((p) => p.id),
    ["linux-x64"],
  );
  // Every pool paused: nothing holds.
  const allPaused = snap(NOW, [pool("mac-x64", { state: "paused" })]);
  assertFalse(new IdleTracker(a).step(allPaused, [], NOW).holding);
});

Deno.test("idle: mode any wants one pool with a free slot and nothing queued", () => {
  const s = (at: number) =>
    snap(at, [
      pool("linux-x64", { slots: 3, busy: 3, running: 3 }), // full
      pool("mac-arm", { slots: 2, busy: 1, running: 1 }), // a free slot
      pool("win-x64", { slots: 2, busy: 0, queued: 1 }), // free but queued
    ]);
  const any = new IdleTracker(idleArgs({ mode: "any", idle_for_s: 60 }));
  const all = new IdleTracker(idleArgs({ mode: "all", idle_for_s: 60 }));
  // Seen not idle first, so the clock starts now for mac-arm.
  any.step(snap(NOW, [pool("mac-arm", { busy: 2 })]), [], NOW);
  const v1 = any.step(s(NOW + S), [], NOW + S);
  assert(v1.holding && !v1.triggered);
  assertEquals(v1.idleNow, ["mac-arm"]);
  const v2 = any.step(s(NOW + 61 * S), [], NOW + 61 * S);
  assert(v2.triggered);
  assertEquals(v2.idlePools, ["mac-arm"]);
  assertEquals(v2.idleSince, NOW + S);
  // Mode all: two pools are busy, so it never holds.
  assertFalse(all.step(s(NOW + 61 * S), [], NOW + 61 * S).holding);
});

Deno.test("idle: already idle long enough by Fleet's records returns at once", () => {
  const a = idleArgs({ idle_for_s: 120 });
  // The last job on each pool finished 10 min ago: triggered on the first look.
  const old = allIdle(NOW);
  const longAgo = { ...old, jobs: [doneJob("linux-x64", NOW - 600 * S)] };
  const v = new IdleTracker(a).step(longAgo, [], NOW);
  assert(v.triggered);
  assertEquals(v.idleSince, NOW - 600 * S);
  // One finished 30 s ago: due 90 s from now.
  const recent = { ...old, jobs: [doneJob("mac-arm", NOW - 30 * S)] };
  const w = new IdleTracker(a).step(recent, [], NOW);
  assertFalse(w.triggered);
  assertEquals(w.dueAt, NOW + 90 * S);
  // An event about the pool counts as activity too, and GitHub's clock offset is applied.
  const ev = { seq: 1, at: NOW - 20 * S, pool: "linux-x64" } as FleetEvent;
  assertEquals(lastActivity(old, [ev], "linux-x64"), NOW - 20 * S);
  const skewed = { ...recent, clock_offset_ms: 5 * S };
  assertEquals(lastActivity(skewed, [], "mac-arm"), NOW - 35 * S);
});

Deno.test("idle: argument checks", () => {
  assertEquals(idleArgs({}), { pools: null, idleForS: 120, mode: "all" });
  assertEquals(idleArgs({ pools: ["a", "a"], idle_for_s: 0, mode: "any" }).pools, ["a"]);
  for (
    const bad of [
      { pools: ["github"] },
      { pools: [] },
      { pools: "linux-x64" },
      { idle_for_s: -1 },
      { idle_for_s: 1801 },
      { idle_for_s: 1.5 },
      { mode: "some" },
    ]
  ) {
    assertThrows(() => idleArgs(bad), ArgError, undefined, JSON.stringify(bad));
  }
  assertEquals(waitArgs({ until: "idle" }).until, "idle");
  assertThrows(() => waitArgs({ until: "idle", run_ids: [1] }), ArgError);
  const wait = TOOLS.find((t) => t.name === "fleet_wait")!;
  assert((wait.inputSchema.properties.until.enum as readonly string[]).includes("idle"));
  assert(TOOLS.some((t) => t.name === "fleet_watch_idle"));
});

// ---- over the server ----

async function writeSnap(dir: string, s: AgentSnapshot) {
  await Deno.writeTextFile(`${dir}/${AGENT_SNAPSHOT_FILE}.tmp`, JSON.stringify(s));
  await Deno.rename(`${dir}/${AGENT_SNAPSHOT_FILE}.tmp`, `${dir}/${AGENT_SNAPSHOT_FILE}`);
}

async function setup(first: AgentSnapshot) {
  const root = await Deno.makeTempDir();
  await writeSnap(root, first);
  const firstEvent: FleetEvent = {
    seq: 1,
    at: NOW - 3600 * S,
    sev: "info",
    kind: "action",
    repo: "",
    workflow: "",
    job: null,
    text: "",
    url: null,
  };
  await appendJournal(root, [firstEvent]);
  const clock = { t: NOW };
  let n = 0;
  const server = createFleetMcp(
    new FleetFiles({ dataDir: root, hooksDir: null, healthFile: null }),
    { now: () => clock.t, watch: false, pollMs: 15, newId: () => String(++n) },
  );
  const sent: Any[] = [];
  const send = (m: Record<string, unknown>) => sent.push(m);
  let id = 0;
  const rpc = (method: string, params: unknown = {}) =>
    server.handle({ jsonrpc: "2.0", id: ++id, method, params }, send) as Promise<Any>;
  const tool = async (name: string, args: unknown) => {
    const r = await rpc("tools/call", { name, arguments: args });
    return { error: r.result.isError === true, body: r.result.content[0].text };
  };
  const until = async (pred: () => boolean, what: string) => {
    const deadline = Date.now() + 3000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}: ${JSON.stringify(sent)}`);
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  /** Move the clock and write a snapshot for it. */
  const at = async (t: number, make: (t: number) => AgentSnapshot) => {
    clock.t = t;
    await writeSnap(root, make(t));
  };
  const close = async () => {
    server.abortAll();
    await Deno.remove(root, { recursive: true });
  };
  return { root, server, sent, rpc, tool, until, at, clock, close };
}

const settle = () => new Promise((r) => setTimeout(r, 80));

Deno.test("server: fleet_wait until idle — at once when already idle, else after idle_for_s", async () => {
  const t = await setup(allIdle(NOW));
  try {
    // No activity on either pool in Fleet's records: idle at once.
    const now1 = await t.tool("fleet_wait", { until: "idle", idle_for_s: 120 });
    assertFalse(now1.error, now1.body);
    const b1 = JSON.parse(now1.body);
    assertEquals([b1.triggered, b1.waited_s, b1.idle_pools], ["idle", 0, ["linux-x64", "mac-arm"]]);
    assertEquals(b1.idle_since, ISO(NOW - 2 * 3600 * S));
    assertEquals(b1.as_of, ISO(NOW - 5 * S));
    assertEquals(b1.pools[0], { id: "linux-x64", slots: 2, busy: 0, queued: 0, state: "ok" });
    // Busy now: the wait starts, sees linux-x64 go idle, and returns 120 s later.
    await t.at(NOW, busyLinux);
    const pending = t.tool("fleet_wait", { until: "idle", idle_for_s: 120, timeout_s: 600 });
    await settle();
    await t.at(NOW + 10 * S, allIdle);
    await settle();
    await t.at(NOW + 100 * S, allIdle);
    await settle();
    await t.at(NOW + 131 * S, allIdle);
    const b2 = JSON.parse((await pending).body);
    assertEquals(b2.triggered, "idle");
    assertEquals(b2.idle_since, ISO(NOW + 10 * S));
    // Mode any on one named pool; an unknown pool is an error.
    await t.at(NOW + 200 * S, busyLinux);
    const any = JSON.parse(
      (await t.tool("fleet_wait", { until: "idle", mode: "any", pools: ["linux-x64"] })).body,
    );
    assertEquals([any.triggered, any.idle_pools], ["idle", ["linux-x64"]]);
    const nope = await t.tool("fleet_wait", { until: "idle", pools: ["nope"] });
    assert(nope.error && nope.body.includes("no such pool"), nope.body);
    // Timeout, and stale data.
    const timing = t.tool("fleet_wait", { until: "idle", timeout_s: 5 });
    await settle();
    await t.at(NOW + 206 * S, busyLinux);
    assertEquals(JSON.parse((await timing).body).triggered, "timeout");
    t.clock.t = NOW + 3600 * S;
    const stale = JSON.parse((await t.tool("fleet_wait", { until: "idle" })).body);
    assertEquals(stale.triggered, "stale");
  } finally {
    await t.close();
  }
});

Deno.test("server: fleet_watch_idle notifies once per idle episode and re-arms when busy", async () => {
  const t = await setup(busyLinux(NOW));
  try {
    const r = await t.tool("fleet_watch_idle", { idle_for_s: 60 });
    assertFalse(r.error, r.body);
    const w = JSON.parse(r.body);
    assertEquals(w.watch_id, "idle-1");
    assertEquals(t.server.idleWatches(), ["idle-1"]);
    const notes = () => t.sent.filter((m) => m.params?.data?.watch_id === "idle-1");
    await settle();
    await t.at(NOW + 5 * S, allIdle);
    await settle();
    assertEquals(notes().length, 0, "not yet idle for 60 s");
    await t.at(NOW + 70 * S, allIdle);
    await t.until(() => notes().length === 1, "the first idle notice");
    const n = notes()[0];
    assertEquals([n.method, n.params.level, n.params.logger], [
      "notifications/message",
      "warning",
      "fleet",
    ]);
    assertEquals(n.params.data.outcome, "idle");
    assertEquals(n.params.data.idle_pools, ["linux-x64", "mac-arm"]);
    assertEquals(n.params.data.idle_since, ISO(NOW + 5 * S));
    // Still idle: no second notice.
    await t.at(NOW + 300 * S, allIdle);
    await settle();
    assertEquals(notes().length, 1);
    // Busy, then idle for 60 s again: a second episode.
    await t.at(NOW + 310 * S, busyLinux);
    await settle();
    await t.at(NOW + 320 * S, allIdle);
    await settle();
    await t.at(NOW + 381 * S, allIdle);
    await t.until(() => notes().length === 2, "the second idle notice");
    // Expiry ends the watch with a notice.
    await t.at(NOW + 7 * 3600 * S, allIdle);
    await t.until(() => notes().some((m) => m.params.data.outcome === "expired"), "expiry");
    assertEquals(t.server.idleWatches(), []);
    // Argument errors.
    assert((await t.tool("fleet_watch_idle", { expires_in_s: 90_000 })).error);
    assert((await t.tool("fleet_watch_idle", { pools: ["github"] })).error);
  } finally {
    await t.close();
  }
});

Deno.test("server: fleet_watch_idle mode any notifies per pool", async () => {
  const t = await setup(snap(NOW, [pool("linux-x64", { busy: 2 }), pool("mac-arm", { busy: 2 })]));
  try {
    await t.tool("fleet_watch_idle", { idle_for_s: 30, mode: "any" });
    const notes = () => t.sent.filter((m) => m.params?.data?.outcome === "idle");
    await settle();
    const oneFree = (at: number) =>
      snap(at, [pool("linux-x64", { busy: 1 }), pool("mac-arm", { busy: 2 })]);
    await t.at(NOW + S, oneFree);
    await settle();
    await t.at(NOW + 40 * S, oneFree);
    await t.until(() => notes().length === 1, "linux-x64 has had a free slot for 30 s");
    assertEquals(notes()[0].params.data.idle_pools, ["linux-x64"]);
    const bothFree = (at: number) =>
      snap(at, [pool("linux-x64", { busy: 1 }), pool("mac-arm", { busy: 0 })]);
    await t.at(NOW + 50 * S, bothFree);
    await settle();
    await t.at(NOW + 90 * S, bothFree);
    await t.until(() => notes().length === 2, "then mac-arm");
    assertEquals(notes()[1].params.data.idle_pools, ["mac-arm"]);
  } finally {
    await t.close();
  }
});

Deno.test("server: an `idle` event when every self-hosted pool is idle 2 min, and busy again", async () => {
  const t = await setup(busyLinux(NOW));
  try {
    assertEquals((await t.rpc("logging/setLevel", { level: "info" })).result, {});
    const idle = () => t.sent.filter((m) => m.params?.data?.kind === "idle");
    await settle();
    await t.at(NOW + 5 * S, allIdle);
    await settle();
    assertEquals(idle().length, 0);
    await t.at(NOW + 130 * S, allIdle);
    await t.until(() => idle().length === 1, "the idle event");
    const e = idle()[0].params;
    assertEquals([e.level, e.logger, e.data.sev], ["warning", "fleet", "warn"]);
    assert(e.data.text.startsWith("IDLE: every self-hosted pool"), e.data.text);
    await t.at(NOW + 200 * S, busyLinux);
    await t.until(() => idle().length === 2, "busy again");
    const b = idle()[1].params;
    assertEquals([b.level, b.data.sev, b.data.text], [
      "info",
      "info",
      "runners busy again (linux-x64)",
    ]);
  } finally {
    await t.close();
  }
});
