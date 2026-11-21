// Machine updates, wired: the pause pause-pool.sh prints, whether a kept hold is still in force, the
// peer facts from pool cards, the pools port over a fake program runner, the engine's status
// collector (the gate's status verb through the parsers into updates.json), its 6 h schedule, the
// orchestrator rebuilt on a config change only between runs, the panel dropping a kept hold the
// user resumed, and a server's description in the outage text. Nothing here runs a program or
// reaches a host.

import { TEST_POOL_PATHS } from "./fixture-settings.ts";
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { holdPoolCommand, resumeHoldCommand } from "../lib/controls.ts";
import { createPoolsPort } from "../lib/deno-updates.ts";
import type { PoolCard } from "../lib/model.ts";
import { createUpdatesBackend, type UpdatesFilesPort } from "../lib/updates/backend.ts";
import { validateUpdatesConfig } from "../lib/updates/config.ts";
import { outageText } from "../lib/updates/dialog.ts";
import {
  COLLECT_EVERY_MS,
  collectDue,
  createUpdatesEngine,
  type EngineDeps,
} from "../lib/updates/engine.ts";
import type {
  AuditEntry,
  MachineStatus,
  PoolPause,
  RemoteResult,
  RemoteVerb,
  RunRecord,
  UpdatesConfig,
  UpdatesMachine,
} from "../lib/updates/model.ts";
import { cardFacts, heldByRun, parsePauseStatus, peerFacts } from "../lib/updates/pools.ts";
import { CONFIG, H, NOW, statuses } from "./updates-fixtures.ts";

const S = Math.floor(NOW / 1000);

// ---- the pause pause-pool.sh prints ----

Deno.test("pools: the pause in pause-pool.sh --status output", () => {
  const held = `2026-11-22 09:00:01 pause-pool: pool lx-a is PAUSED (6900 s left): ` +
    `2026-11-22 08:55:00 paused by me with pause-pool.sh --for hold: fleet-update:runner-1-abc-0001 ` +
    `for 7200 s (expires=${S + 6900}; resume: pause-pool.sh --resume lx-a)\n` +
    "2026-11-22 09:00:01 pause-pool: pool lx-a slot 1: idle\n" +
    "2026-11-22 09:00:01 pause-pool: pool lx-a is idle\n";
  assertEquals(parsePauseStatus(held), {
    reason: "fleet-update:runner-1-abc-0001",
    until: (S + 6900) * 1000,
  });
  const byHand =
    `x pause-pool: pool lx-a is PAUSED: x paused by me with pause-pool.sh --for swap ` +
    `for 120 s (expires=${S + 60}; resume: pause-pool.sh --resume lx-a)`;
  const p = parsePauseStatus(byHand)!;
  assertEquals(p.until, (S + 60) * 1000);
  assertStringIncludes(p.reason, "--for swap");
  // A scheduler-written pause has no expiry.
  assertEquals(parsePauseStatus("pool lx-a is PAUSED: paused by the scheduler")?.until, null);
  assertEquals(parsePauseStatus("x pause-pool: pool lx-a is not paused\npool lx-a is idle"), null);
  assertEquals(
    parsePauseStatus("pool lx-a is not paused: its pause EXPIRED 30 s ago and is void: …"),
    null,
    "an expired pause is void",
  );
  assertEquals(parsePauseStatus(undefined), null);
});

Deno.test("pools: a kept hold counts only while that run's pause is in force", () => {
  const pause: PoolPause = { reason: "fleet-update:run-1", until: NOW + H };
  assert(heldByRun(pause, "run-1", NOW));
  assert(!heldByRun(pause, "run-2", NOW), "another run's hold");
  assert(!heldByRun(pause, "run-1", NOW + 2 * H), "expired");
  assert(!heldByRun(null, "run-1", NOW), "resumed");
  assert(!heldByRun({ reason: "paused by hand", until: null }, "run-1", NOW));
});

const card = (id: string, label: string | null, state: PoolCard["state"], busy = 0): PoolCard => ({
  id,
  title: id,
  label,
  slots: 2,
  busy,
  running: busy,
  queued: 0,
  state,
  reason: "",
  since: null,
  oldestQueuedSince: null,
});

Deno.test("pools: peer facts from the pool cards and the failed checks", () => {
  const st: Record<string, MachineStatus> = {
    ...statuses(),
    "runner-2": { ...statuses()["runner-2"], error: "unreachable over ssh" },
    "here": { ...statuses()["here"], error: "x" },
  };
  const f = peerFacts(
    [card("lx-a", "lx", "ok"), card("arm-a", "arm", "paused"), card("github", null, "ok")],
    CONFIG,
    st,
  );
  assertEquals(f.pools, {
    "lx-a": { label: "lx", healthy: true, held: false },
    "arm-a": { label: "arm", healthy: true, held: true },
  });
  assertEquals(f.unreachable, ["runner-2"], "the self machine never counts");
  assertEquals(cardFacts(card("lx-a", "lx", "unhealthy", 2)), { jobs: 2, healthy: false });
});

// ---- the pools port ----

Deno.test("pools port: status, holds and resumes through pause-pool.sh only", async () => {
  const calls: string[][] = [];
  let statusOut = "pool lx-a is not paused\npool lx-a is idle";
  let statusCode = 0;
  const port = createPoolsPort({
    paths: () => TEST_POOL_PATHS,
    run: (program, args) => {
      calls.push([program, ...args]);
      if (args[0] === "--status") return Promise.resolve({ code: statusCode, out: statusOut });
      return Promise.resolve({ code: 0, out: "" });
    },
    card: (p) => (p === "lx-a" ? { jobs: 0, healthy: true } : null),
    refresh: () => Promise.resolve(),
  });
  assertEquals(await port.state("lx-a"), { idle: true, jobs: 0, pause: null, healthy: true });
  assertEquals(calls.at(-1), [TEST_POOL_PATHS.pausePool, "--status", "lx-a"]);
  statusCode = 1;
  statusOut = `pool lx-a is PAUSED: x --for hold: fleet-update:r-1 for 60 s (expires=${S + 60};`;
  const busy = await port.state("lx-a");
  assertEquals([busy.idle, busy.pause?.reason], [false, "fleet-update:r-1"]);

  const hold = holdPoolCommand("lx-a", 3600, "r-1", TEST_POOL_PATHS);
  assert(hold.ok);
  assertEquals((await port.run(hold.command)).code, 0);
  assertEquals(calls.at(-1), [TEST_POOL_PATHS.pausePool, ...hold.command.args]);
  const resume = resumeHoldCommand("lx-a", TEST_POOL_PATHS);
  assert(resume.ok);
  await port.run(resume.command);
  assertEquals(calls.at(-1), [TEST_POOL_PATHS.pausePool, "--resume", "lx-a"]);
  const n = calls.length;
  const other = await port.run({ ...hold.command, program: "/bin/sh" });
  assertEquals([other.code, calls.length], [-1, n], "nothing but the pause script runs");

  assertEquals(await port.ready(["lx-a"]), { ok: true, reason: "" });
  if (TEST_POOL_PATHS.watchdog) assertEquals(calls.at(-1), [TEST_POOL_PATHS.watchdog]);
});

Deno.test("pools port: no runner scheduler here: not idle, nothing runs", async () => {
  let ran = 0;
  const port = createPoolsPort({
    paths: () => null,
    run: () => (ran++, Promise.resolve({ code: 0, out: "" })),
    card: () => ({ jobs: 1, healthy: true }),
    refresh: () => Promise.resolve(),
  });
  assertEquals((await port.state("lx-a")).idle, false);
  assertEquals((await port.ready(["lx-a"])).ok, false);
  assertEquals(ran, 0);
});

// ---- the engine ----

const ok = (stdout: string): RemoteResult => ({
  code: 0,
  stdout,
  unreachable: false,
  timedOut: false,
});

const APT_DOC = JSON.stringify({
  os: "ubuntu",
  apt: "WARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n" +
    "Listing...\n" +
    "openssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\n" +
    "ubuntu-drivers-common/noble-updates 1:0.9.7.6ubuntu3.2 amd64 [upgradable from: 1:0.9.7.6ubuntu3.1]\n",
  rebootRequired: null,
  indexStamp: S - 3600,
});

function engineSetup(cfg: () => UpdatesConfig | null = () => CONFIG) {
  let now = NOW;
  const saved: Record<string, MachineStatus>[] = [];
  let file: Record<string, MachineStatus> = {};
  const calls: [string, RemoteVerb][] = [];
  let answer: (m: UpdatesMachine) => RemoteResult = () => ok(APT_DOC);
  let run: RunRecord | null = null;
  const deps: EngineDeps = {
    config: cfg,
    paths: () => TEST_POOL_PATHS,
    remote: {
      run: (m, verb) => {
        calls.push([m.id, verb]);
        return Promise.resolve(answer(m));
      },
    },
    pools: {
      state: () => Promise.resolve({ idle: true, jobs: 0, pause: null, healthy: true }),
      run: () => Promise.resolve({ code: 0, output: "" }),
      ready: () => Promise.resolve({ ok: true, reason: "" }),
    },
    store: {
      readRun: () => Promise.resolve(run),
      claimRun: () => Promise.resolve(false),
      saveRun: () => Promise.resolve(),
      clearRun: () => Promise.resolve(),
      appendAudit: () => Promise.resolve(),
    },
    files: {
      statuses: () => Promise.resolve(file),
      saveStatuses: (st) => {
        file = { ...st };
        saved.push(file);
        return Promise.resolve();
      },
    },
    clock: { now: () => now, sleep: () => Promise.resolve() },
    telemetry: null,
    peers: (c, st) => peerFacts([], c, st),
    events: () => {},
  };
  return {
    engine: createUpdatesEngine(deps),
    calls,
    saved,
    file: () => file,
    setNow: (t: number) => (now = t),
    answer: (fn: (m: UpdatesMachine) => RemoteResult) => (answer = fn),
    setRun: (r: RunRecord | null) => (run = r),
  };
}

const machine = (id: string) => CONFIG.machines.find((m) => m.id === id)!;

Deno.test("engine: Check now runs the status verb, parses it and writes updates.json", async () => {
  const t = engineSetup();
  const s = await t.engine.status.refresh(machine("runner-1"));
  assertEquals(t.calls, [["runner-1", "status"]]);
  assertEquals(s.error, null);
  assertEquals([s.host?.pending.total, s.host?.pending.security], [2, 1], "phased counts");
  assertEquals(s.checkedAt, NOW);
  assertEquals(Object.keys(t.file()), ["runner-1"]);
  assertEquals(t.engine.status.current("runner-1")?.checkedAt, NOW);

  // A failed check keeps the last findings and records why.
  t.answer(() => ({ code: 255, stdout: "", unreachable: true, timedOut: false }));
  t.setNow(NOW + H);
  const bad = await t.engine.status.refresh(machine("runner-1"));
  assertStringIncludes(bad.error ?? "", "unreachable");
  assertEquals([bad.checkedAt, bad.attemptAt, bad.host?.pending.total], [NOW, NOW + H, 2]);
  // Garbage from a host is an error, never a throw.
  t.answer(() => ok("<html>"));
  assertStringIncludes((await t.engine.status.refresh(machine("runner-1"))).error ?? "", "Ubuntu");
  // The machine Fleet runs on is never asked anything.
  const n = t.calls.length;
  await t.engine.status.refresh(machine("here"));
  assertEquals(t.calls.length, n);
});

Deno.test("engine: one check at a time; unknown machines drop out of updates.json", async () => {
  let cfg: UpdatesConfig = CONFIG;
  const t = engineSetup(() => cfg);
  await Promise.all([
    t.engine.status.refresh(machine("runner-1")),
    t.engine.status.refresh(machine("mail-1")),
  ]);
  assertEquals(Object.keys(t.file()).sort(), ["mail-1", "runner-1"], "no write lost");
  cfg = { ...CONFIG, machines: CONFIG.machines.filter((m) => m.id !== "mail-1") };
  await t.engine.status.refresh(machine("runner-1"));
  assertEquals(Object.keys(t.file()), ["runner-1"]);
});

Deno.test("engine: the collector checks each machine every 6 h, one per tick", async () => {
  const t = engineSetup();
  const due = collectDue(CONFIG, {}, NOW, null).map((m) => m.id);
  assertEquals(due, ["runner-1", "runner-2", "mail-1", "files-1"], "never the local machine");
  assertEquals(
    collectDue(CONFIG, statuses(), NOW, "runner-1").map((m) => m.id),
    [],
    "checked an hour ago",
  );
  assertEquals(
    collectDue(CONFIG, statuses(), NOW + COLLECT_EVERY_MS, "runner-1").map((m) => m.id),
    ["runner-2", "mail-1", "files-1"],
    "never the machine mid-run",
  );
  assertEquals((await t.engine.collectTick())?.machine, "runner-1");
  assertEquals((await t.engine.collectTick())?.machine, "runner-2");
  assertEquals(t.calls.map((c) => c[1]), ["status", "status"]);
});

Deno.test("engine: a changed config builds a new orchestrator for the next run", async () => {
  let cfg: UpdatesConfig = CONFIG;
  const t = engineSetup(() => cfg);
  const first = await t.engine.orchestrator.start({ machine: "new-1", origin: { kind: "user" } });
  assert(!first.ok && first.reason.includes("isn't configured"));
  const r = validateUpdatesConfig({
    ssh: { configFile: "~/fleet-test/ssh_config" },
    machines: [{ id: "new-1", os: "ubuntu", kind: "server", via: { ssh: "new-1" } }],
  });
  assert(r.ok);
  cfg = r.value!;
  const second = await t.engine.orchestrator.start({ machine: "new-1", origin: { kind: "user" } });
  // The fake store's lock is taken: the new config got that far.
  assert(!second.ok && second.reason.includes("in flight"), !second.ok ? second.reason : "");
  assertEquals(t.engine.orchestrator.current(), null);
  assertEquals(t.engine.orchestrator.cancel("x").ok, false);
});

Deno.test("engine: reattach with no run file picks nothing up", async () => {
  const t = engineSetup();
  assertEquals(await t.engine.reattach(), false);
  assertEquals(await engineSetup(() => null).engine.collectTick(), null);
});

// ---- the panel: a kept hold the user resumed stops counting ----

Deno.test("backend: a kept hold counts only while its pause is in force", async () => {
  const kept: AuditEntry = {
    v: 1,
    id: "runner-1-abc-0001",
    machine: "runner-1",
    origin: { kind: "auto" },
    action: "install",
    mode: "security",
    reboot: "never",
    startedAt: NOW - 2 * H,
    endedAt: NOW - H,
    outcome: "verify-failed",
    steps: [],
    keptHolds: ["lx-a"],
  };
  const files: UpdatesFilesPort = {
    statuses: () => Promise.resolve(statuses()),
    run: () => Promise.resolve(null),
    audit: () => Promise.resolve([kept]),
    schedules: () => Promise.resolve([]),
    saveSchedules: () => Promise.resolve(),
    requests: () => Promise.resolve([]),
    removeRequest: () => Promise.resolve(),
  };
  let pause: PoolPause | null = { reason: `fleet-update:${kept.id}`, until: NOW + H };
  const asked: string[][] = [];
  const b = createUpdatesBackend({
    config: () => CONFIG,
    files,
    engine: () => null,
    confirm: () => Promise.resolve(0),
    openSoftwareUpdate: () => Promise.resolve({ ok: true, message: "" }),
    now: () => NOW,
    tz: () => "UTC",
    log: () => Promise.resolve(),
    holds: (pools) => {
      asked.push([...pools]);
      return Promise.resolve(new Map([["lx-a", pause]]));
    },
  });
  const view = async () => (await b.view()).machines.find((m) => m.id === "runner-1")!;
  assertEquals((await view()).status.heldPools, ["lx-a"]);
  assertEquals((await view()).level, "bad");
  assertEquals(asked[0], ["lx-a"]);
  pause = null; // The user resumed it.
  assertEquals((await view()).status.heldPools, []);
  pause = { reason: "paused by hand", until: null };
  assertEquals((await view()).status.heldPools, [], "someone else's pause isn't the run's hold");
});

// ---- a server's description ----

Deno.test("config: a description names what a server runs in the outage text", () => {
  const r = validateUpdatesConfig({
    ssh: { configFile: "~/fleet-test/ssh_config" },
    machines: [{
      id: "mail-1",
      os: "ubuntu",
      kind: "server",
      via: { ssh: "mail-1" },
      description: " mail server ",
    }],
  });
  assert(r.ok);
  const m = r.value!.machines[0];
  assertEquals(m.description, "mail server");
  assertStringIncludes(outageText(m), "mail-1 is a server: its services (mail server) will be");
  assertStringIncludes(outageText(machine("mail-1")), "mail, file shares or whatever it runs");
  for (const bad of ["", "   ", "x".repeat(81), "mail\nserver", 5]) {
    const v = validateUpdatesConfig({
      ssh: { configFile: "~/fleet-test/ssh_config" },
      machines: [{ id: "m", os: "ubuntu", kind: "server", via: { ssh: "m" }, description: bad }],
    });
    assert(!v.ok, `refused: ${JSON.stringify(bad)}`);
  }
});
