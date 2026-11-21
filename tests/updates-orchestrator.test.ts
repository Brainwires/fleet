// Machine updates: the orchestrator's state machine over fake pools, remote, clock and store — the
// happy path's order, deferred-busy at the drain cap, busy at the final check, a failed install,
// a host that never returns, a pool paused before the run, a restart mid-install, cancel through
// step 3 only, and a no-pool server (happy and failed verify). Plus the hold pool command, which
// only the orchestrator builds. Nothing here runs a program or reaches a host.

import { TEST_POOL_PATHS } from "./fixture-settings.ts";
import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { holdPoolCommand, type PoolCommand, poolCommand } from "../lib/controls.ts";
import { parsePoolControl } from "../lib/control-runner.ts";
import { validateUpdatesConfig } from "../lib/updates/config.ts";
import {
  type AuditEntry,
  type Clock,
  type CommandResult,
  emptyStatus,
  type MachineStatus,
  type PoolPause,
  type PoolState,
  type RemoteResult,
  type RemoteVerb,
  type RunEvent,
  type RunRecord,
  type UpdatesConfig,
  type UpdatesMachine,
  withCheck,
} from "../lib/updates/model.ts";
import { type RunRequest, UpdateOrchestrator } from "../lib/updates/orchestrator.ts";

const T0 = Date.parse("2026-11-22T08:40:00Z");
const MIN = 60_000;
const RUN_ID = "host-a-test-0001";

const CONFIG: UpdatesConfig = (() => {
  const r = validateUpdatesConfig({
    ssh: { program: "/usr/bin/ssh", configFile: "~/fleet-test/ssh_config" },
    machines: [
      {
        id: "host-a",
        os: "ubuntu",
        via: { ssh: "host-a" },
        pools: ["lx-a", "lx-b"],
        busy: ["pools", "remote"],
        verify: { mounts: ["/srv/data"] },
        drainCapMinutes: 30,
      },
      { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" } },
      { id: "here", os: "macos", via: "local", self: true },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value!;
})();

class FakeClock implements Clock {
  t = T0;
  onSleep: (() => void) | null = null;
  now() {
    return this.t;
  }
  async sleep(ms: number, signal?: AbortSignal) {
    await Promise.resolve();
    if (signal?.aborted) return;
    this.t += ms;
    this.onSleep?.();
  }
}

class FakePools {
  jobs: Record<string, number> = { "lx-a": 0, "lx-b": 0 };
  pause: Record<string, PoolPause | null> = { "lx-a": null, "lx-b": null };
  commands: string[][] = [];
  readyOk = true;
  constructor(private clock: FakeClock) {}
  state(pool: string): Promise<PoolState> {
    const jobs = this.jobs[pool] ?? 0;
    return Promise.resolve({
      idle: jobs === 0,
      jobs,
      pause: this.pause[pool] ?? null,
      healthy: true,
    });
  }
  run(c: PoolCommand): Promise<CommandResult> {
    assertEquals(c.program, TEST_POOL_PATHS.pausePool, "only the pause-pool program runs");
    this.commands.push([...c.args]);
    if (c.args[0] === "--resume") this.pause[c.args[1]] = null;
    else if (c.args[1] === "--for") {
      this.pause[c.args[0]] = {
        reason: c.args[5],
        until: this.clock.now() + Number(c.args[4].replace(/s$/, "")) * 1000,
      };
    }
    return Promise.resolve({ code: 0, output: "" });
  }
  ready() {
    return Promise.resolve({ ok: this.readyOk, reason: this.readyOk ? "" : "slot 2 not ready" });
  }
}

const VERIFY_OK = {
  system: "running",
  failedUnits: [] as string[],
  docker: "active",
  mounts: ["/", "/srv/data"],
  checks: [] as { name: string; ok: boolean }[],
  xcodePlatforms: null,
  freeDiskMb: 50_000,
};

/** A host: answers the gate's verbs; installs take `installPolls` result polls. */
class FakeHost {
  bootId = "boot-1";
  calls: [string, RemoteVerb][] = [];
  installPolls = 1;
  installState: "succeeded" | "failed" = "succeeded";
  installedAt: number | null = null;
  rebootRequired = true;
  comesBack = true;
  verifyAfter = VERIFY_OK;
  #polls = 0;
  #rebooted = false;
  constructor(private clock: FakeClock) {}
  run(m: UpdatesMachine, verb: RemoteVerb): Promise<RemoteResult> {
    this.calls.push([m.id, verb]);
    const out = (stdout: string, code = 0): Promise<RemoteResult> =>
      Promise.resolve({ code, stdout, unreachable: false, timedOut: false });
    switch (verb) {
      case "boot-id":
        if (this.#rebooted && !this.comesBack) {
          return Promise.resolve({ code: 255, stdout: "", unreachable: true, timedOut: false });
        }
        return out(this.bootId);
      case "verify":
        return out(
          JSON.stringify(this.#rebooted || this.installedAt ? this.verifyAfter : VERIFY_OK),
        );
      case "busy":
        return out("");
      case "install-security":
      case "install-all":
        this.installedAt = this.clock.now();
        return out("started");
      case "result": {
        if (this.installedAt === null) return out(JSON.stringify({ state: "none" }));
        const done = ++this.#polls >= this.installPolls;
        return out(JSON.stringify({
          state: done ? this.installState : "running",
          startedAt: Math.floor(this.installedAt / 1000),
          exitCode: done ? (this.installState === "succeeded" ? 0 : 100) : null,
          rebootRequired: done && this.rebootRequired,
          tail: "Setting up openssl ...\nGITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789",
        }));
      }
      case "reboot":
        this.#rebooted = true;
        if (this.comesBack) this.bootId = "boot-2";
        return out("");
      case "status":
        return out("{}");
    }
  }
}

/** Remote calls `busy` with an exit code the test scripts. */
function scriptedBusy(host: FakeHost, codes: number[]) {
  const orig = host.run.bind(host);
  host.run = (m, verb) => {
    if (verb !== "busy") return orig(m, verb);
    host.calls.push([m.id, verb]);
    const code = codes.length ? codes.shift()! : 0;
    return Promise.resolve({
      code,
      stdout: code === 10 ? "backup running" : "",
      unreachable: false,
      timedOut: false,
    });
  };
}

class FakeStore {
  run: RunRecord | null = null;
  audit: AuditEntry[] = [];
  readRun() {
    return Promise.resolve(this.run);
  }
  claimRun(r: RunRecord) {
    if (this.run) return Promise.resolve(false);
    this.run = r;
    return Promise.resolve(true);
  }
  saveRun(r: RunRecord) {
    this.run = r;
    return Promise.resolve();
  }
  clearRun(id: string) {
    if (this.run?.id === id) this.run = null;
    return Promise.resolve();
  }
  appendAudit(e: AuditEntry) {
    this.audit.push(e);
    return Promise.resolve();
  }
}

function harness(over: { pending?: { total: number; security: number }; reboot?: boolean } = {}) {
  const clock = new FakeClock();
  const pools = new FakePools(clock);
  const host = new FakeHost(clock);
  const store = new FakeStore();
  const events: RunEvent[] = [];
  const refreshes: string[] = [];
  const status = {
    refresh(m: UpdatesMachine): Promise<MachineStatus> {
      refreshes.push(m.id);
      const p = over.pending ?? { total: 3, security: 2 };
      return Promise.resolve(withCheck(emptyStatus(m.id), {
        pending: { ...p, names: [], securityNames: [] },
        reboot: { required: over.reboot ?? false, since: null, packages: [] },
        indexAt: clock.now(),
      }, clock.now()));
    },
    current: () => null,
  };
  const orch = new UpdateOrchestrator({
    config: CONFIG,
    paths: TEST_POOL_PATHS,
    pools,
    remote: host,
    clock,
    store,
    status,
    peers: {
      facts: () =>
        Promise.resolve({
          pools: {
            "lx-a": { label: "lx", healthy: true, held: false },
            "lx-b": { label: "lx", healthy: true, held: false },
            "other": { label: "lx", healthy: true, held: false },
          },
          unreachable: [],
        }),
    },
    telemetry: null,
    events: (e) => events.push(e),
    newRunId: () => RUN_ID,
  });
  return { clock, pools, host, store, events, refreshes, orch };
}

async function runToEnd(h: ReturnType<typeof harness>, req: Partial<RunRequest> = {}) {
  const s = await h.orch.start({ machine: "host-a", origin: { kind: "user" }, ...req });
  if (!s.ok) throw new Error(s.reason);
  return await s.done;
}

const steps = (r: RunRecord) => r.steps.map((s) => s.step);
const verbs = (h: ReturnType<typeof harness>) => h.host.calls.map(([, v]) => v);
const HOLD = (pool: string, s = 30 * 60 + 7200) => [
  pool,
  "--for",
  "hold",
  "--duration",
  `${s}s`,
  `fleet-update:${RUN_ID}`,
];

Deno.test("orchestrator: the happy path, in order", async () => {
  const h = harness();
  h.pools.jobs["lx-a"] = 1;
  let sleeps = 0;
  h.clock.onSleep = () => {
    if (++sleeps === 2) h.pools.jobs["lx-a"] = 0; // the job finishes during the drain
  };
  const r = await runToEnd(h);
  assertEquals(r.outcome, "succeeded");
  assertEquals(steps(r), [
    "preflight",
    "hold",
    "drain",
    "final-check",
    "install",
    "reboot",
    "wait-boot",
    "verify",
    "resume",
  ]);
  assert(r.steps.every((s) => s.ok));
  assertEquals(h.pools.commands, [
    HOLD("lx-a"),
    HOLD("lx-b"),
    ["--resume", "lx-a"],
    ["--resume", "lx-b"],
  ]);
  assertEquals(verbs(h), [
    "boot-id",
    "verify",
    // drain: one busy check per poll (every plugin runs; the job ends after two polls)
    "busy",
    "busy",
    "busy",
    "busy", // final check
    "install-security",
    "result",
    "busy", // step 3 again before the reboot
    "reboot",
    "boot-id",
    "verify",
  ]);
  // The audit line, the lock released, a fresh status, a done event, the token redacted.
  assertEquals(h.store.run, null);
  assertEquals(h.store.audit.length, 1);
  assertEquals(h.store.audit[0].outcome, "succeeded");
  const tail = h.store.audit[0].steps.find((s) => s.step === "install")!.tail!;
  assertStringIncludes(tail, "Setting up openssl");
  assertFalse(tail.includes("ghp_"), "the output tail is redacted");
  assertEquals(h.refreshes, ["host-a", "host-a"]);
  assertEquals(h.events.at(-1)?.kind, "done");
});

Deno.test("orchestrator: a job still running at the drain cap ends deferred-busy, nothing installed", async () => {
  const h = harness();
  h.pools.jobs["lx-b"] = 2;
  const r = await runToEnd(h);
  assertEquals(r.outcome, "deferred-busy");
  assertEquals(steps(r), ["preflight", "hold", "drain"]);
  assertFalse(verbs(h).some((v) => v.startsWith("install") || v === "reboot"));
  assertEquals(h.pools.commands.slice(2), [["--resume", "lx-a"], ["--resume", "lx-b"]]);
  assertEquals(h.clock.t - T0, 30 * MIN, "it waited exactly the drain cap");
  assertStringIncludes(r.steps.at(-1)!.detail, "lx-b: 2 jobs running");
  // The window's end comes first when it is sooner than the cap.
  const w = harness();
  w.pools.jobs["lx-a"] = 1;
  const rw = await runToEnd(w, { windowEnd: T0 + 10 * MIN });
  assertEquals(rw.outcome, "deferred-busy");
  assertEquals(w.clock.t - T0, 10 * MIN);
});

Deno.test("orchestrator: busy at the final check installs nothing", async () => {
  const h = harness();
  scriptedBusy(h.host, [0, 10]); // free while draining, busy at step 3
  const r = await runToEnd(h);
  assertEquals(r.outcome, "aborted");
  assertEquals(steps(r), ["preflight", "hold", "drain", "final-check"]);
  assertStringIncludes(r.steps.at(-1)!.detail, "backup running");
  assertFalse(verbs(h).some((v) => v.startsWith("install")));
  assertEquals(h.pools.commands.slice(2), [["--resume", "lx-a"], ["--resume", "lx-b"]]);
});

Deno.test("orchestrator: a failed install never reboots, still verifies, and resumes on a pass", async () => {
  const h = harness();
  h.host.installState = "failed";
  h.host.installPolls = 3;
  const r = await runToEnd(h);
  assertEquals(r.outcome, "install-failed");
  assertFalse(verbs(h).includes("reboot"));
  assertEquals(steps(r), [
    "preflight",
    "hold",
    "drain",
    "final-check",
    "install",
    "verify",
    "resume",
  ]);
  assertEquals(r.steps.find((s) => s.step === "install")!.code, 100);
  assertEquals(h.pools.commands.slice(2), [["--resume", "lx-a"], ["--resume", "lx-b"]]);
  // A failed install whose verify fails keeps the holds.
  const k = harness();
  k.host.installState = "failed";
  k.host.verifyAfter = { ...VERIFY_OK, failedUnits: ["docker.service"] };
  const rk = await runToEnd(k);
  assertEquals(rk.outcome, "verify-failed");
  assertFalse(k.pools.commands.some((c) => c[0] === "--resume"));
});

Deno.test("orchestrator: a host that never returns keeps its hold (renewed), no second reboot", async () => {
  const h = harness();
  h.host.comesBack = false;
  const r = await runToEnd(h);
  assertEquals(r.outcome, "host-down");
  assertEquals(steps(r).slice(-2), ["reboot", "wait-boot"]);
  assertEquals(verbs(h).filter((v) => v === "reboot").length, 1);
  assertFalse(h.pools.commands.some((c) => c[0] === "--resume"));
  assertEquals(h.pools.commands.slice(2), [HOLD("lx-a", 86400), HOLD("lx-b", 86400)]);
  assertEquals(r.keptHolds, ["lx-a", "lx-b"]);
  assertEquals(h.store.audit[0].keptHolds, ["lx-a", "lx-b"]);
  assert(h.events.some((e) => e.kind === "alert" && e.text.includes("didn't come back")));
  assert(h.clock.t - T0 >= 15 * MIN);
});

Deno.test("orchestrator: a pool paused before the run stays paused", async () => {
  const h = harness();
  h.pools.pause["lx-b"] = { reason: "manual base swap", until: null };
  const r = await runToEnd(h);
  assertEquals(r.outcome, "succeeded");
  assertEquals(r.holds.map((x) => [x.pool, x.pausedBefore]), [["lx-a", false], ["lx-b", true]]);
  assertEquals(h.pools.commands, [HOLD("lx-a"), ["--resume", "lx-a"]]);
  assertEquals(h.pools.pause["lx-b"], { reason: "manual base swap", until: null });
  assertStringIncludes(r.steps.find((s) => s.step === "hold")!.detail, "already paused: lx-b");
});

Deno.test("orchestrator: a Fleet restart mid-install re-attaches and never installs twice", async () => {
  const h = harness();
  h.host.installedAt = T0 - 5 * MIN; // the install was started by the Fleet that died
  h.host.installPolls = 3;
  h.pools.pause = {
    "lx-a": { reason: `fleet-update:${RUN_ID}`, until: T0 + 120 * MIN },
    "lx-b": { reason: `fleet-update:${RUN_ID}`, until: T0 + 120 * MIN },
  };
  const verify = JSON.parse(JSON.stringify(VERIFY_OK));
  h.store.run = {
    v: 1,
    id: RUN_ID,
    machine: "host-a",
    origin: { kind: "schedule", scheduleId: "s1" },
    mode: "security",
    reboot: "if-needed",
    drainCapMinutes: 30,
    windowEnd: null,
    startedAt: T0 - 20 * MIN,
    step: "install",
    stepAt: T0 - 5 * MIN,
    holds: [
      { pool: "lx-a", until: T0 + 120 * MIN, pausedBefore: false },
      { pool: "lx-b", until: T0 + 120 * MIN, pausedBefore: false },
    ],
    bootId: "boot-1",
    baseline: verify,
    installAt: T0 - 5 * MIN,
    installOk: null,
    rebootNeeded: false,
    rebooted: false,
    steps: [],
    outcome: null,
    keptHolds: [],
  };
  const done = await h.orch.reattach();
  assert(done);
  const r = await done;
  assertEquals(r.outcome, "succeeded");
  assertFalse(verbs(h).some((v) => v.startsWith("install")), "the install is polled, not re-run");
  assertEquals(verbs(h).filter((v) => v === "result").length, 3);
  assertEquals(steps(r), ["install", "reboot", "wait-boot", "verify", "resume"]);
  assertEquals(h.pools.commands, [["--resume", "lx-a"], ["--resume", "lx-b"]]);
  assertEquals(h.store.audit[0].origin, { kind: "schedule", scheduleId: "s1" });

  // A restart before the install: nothing was installed, this run's holds are resumed.
  const e = harness();
  e.store.run = {
    v: 1,
    id: RUN_ID,
    machine: "host-a",
    origin: { kind: "user" },
    mode: "security",
    reboot: "if-needed",
    drainCapMinutes: 30,
    windowEnd: null,
    startedAt: T0,
    step: "drain",
    stepAt: T0,
    holds: [{ pool: "lx-a", until: T0 + 150 * MIN, pausedBefore: false }],
    bootId: "boot-1",
    baseline: verify,
    installAt: null,
    installOk: null,
    rebootNeeded: false,
    rebooted: false,
    steps: [],
    outcome: null,
    keptHolds: [],
  };
  const re = await (await e.orch.reattach())!;
  assertEquals(re.outcome, "aborted");
  assertEquals(e.pools.commands, [["--resume", "lx-a"]]);
  assertFalse(verbs(e).some((v) => v.startsWith("install")));
  // Nothing in flight: nothing to re-attach.
  assertEquals(await harness().orch.reattach(), null);
});

Deno.test("orchestrator: cancel through step 3 resumes the pools; after it, refused", async () => {
  // During the drain: accepted.
  const h = harness();
  h.pools.jobs["lx-a"] = 1;
  h.clock.onSleep = () => {
    const cur = h.orch.current()!;
    if (cur.step === "drain") assertEquals(h.orch.cancel(cur.id), { ok: true });
  };
  const r = await runToEnd(h);
  assertEquals(r.outcome, "cancelled");
  assertFalse(verbs(h).some((v) => v.startsWith("install")));
  assertEquals(h.pools.commands.slice(2), [["--resume", "lx-a"], ["--resume", "lx-b"]]);

  // During the install: refused, and the run goes on.
  const k = harness();
  k.host.installPolls = 3;
  const refusals: string[] = [];
  k.clock.onSleep = () => {
    const cur = k.orch.current()!;
    if (cur.step === "install") {
      const c = k.orch.cancel(cur.id);
      if (!c.ok) refusals.push(c.reason);
    }
  };
  const rk = await runToEnd(k);
  assertEquals(rk.outcome, "succeeded");
  assert(refusals.length > 0);
  assertStringIncludes(refusals[0], "can't be cancelled after the final check");
  assertFalse(k.orch.cancel("nope").ok);
});

Deno.test("orchestrator: refusals before anything runs (self, unknown, lock, nothing due)", async () => {
  const h = harness();
  const self = await h.orch.start({ machine: "here", origin: { kind: "user" } });
  assertFalse(self.ok);
  if (!self.ok) assertStringIncludes(self.reason, "notify only");
  assertFalse((await h.orch.start({ machine: "ghost", origin: { kind: "user" } })).ok);
  h.store.run = { id: "other", machine: "mail-1" } as RunRecord;
  const locked = await h.orch.start({ machine: "host-a", origin: { kind: "user" } });
  assertFalse(locked.ok);
  assertEquals(h.host.calls, []);
  assertEquals(h.pools.commands, []);
  // Nothing pending, no reboot due: nothing held, nothing installed.
  const n = harness({ pending: { total: 0, security: 0 } });
  const r = await runToEnd(n);
  assertEquals(r.outcome, "nothing-to-do");
  assertEquals(n.pools.commands, []);
  assertEquals(verbs(n), []);
  // Only non-security pending in security mode: nothing to do either; in all mode it runs.
  const all = harness({ pending: { total: 2, security: 0 } });
  assertEquals((await runToEnd(all)).outcome, "nothing-to-do");
  const all2 = harness({ pending: { total: 2, security: 0 } });
  const ra = await runToEnd(all2, { mode: "all" });
  assertEquals(ra.outcome, "succeeded");
  assert(verbs(all2).includes("install-all"));
});

Deno.test("orchestrator: reboot policy never leaves the reboot pending", async () => {
  const h = harness();
  const r = await runToEnd(h, { reboot: "never" });
  assertEquals(r.outcome, "reboot-pending");
  assertFalse(verbs(h).includes("reboot"));
  assertEquals(h.pools.commands.slice(2), [["--resume", "lx-a"], ["--resume", "lx-b"]]);
});

Deno.test("orchestrator: a no-pool server skips hold, drain and resume (happy path)", async () => {
  const h = harness();
  const r = await runToEnd(h, { machine: "mail-1" });
  assertEquals(r.outcome, "succeeded");
  assertEquals(steps(r), ["preflight", "install", "reboot", "wait-boot", "verify"]);
  assertEquals(h.pools.commands, [], "no pool is held or resumed");
  assertEquals(verbs(h), [
    "boot-id",
    "verify",
    "install-security",
    "result",
    "reboot",
    "boot-id",
    "verify",
  ]);
  assert(h.host.calls.every(([m]) => m === "mail-1"));
});

Deno.test("orchestrator: a no-pool server's failed verify.d check is reported", async () => {
  const h = harness();
  h.host.verifyAfter = {
    ...VERIFY_OK,
    checks: [{ name: "mailcow", ok: false }, { name: "samba", ok: true }],
  };
  const r = await runToEnd(h, { machine: "mail-1" });
  assertEquals(r.outcome, "verify-failed");
  assertEquals(h.pools.commands, []);
  assertStringIncludes(r.steps.at(-1)!.detail, "verify.d/mailcow failed");
  assert(h.events.some((e) => e.kind === "alert" && e.text.includes("verify.d/mailcow")));
  assertEquals(h.store.run, null, "the lock is released");
});

Deno.test("hold: only the orchestrator builds it; a page request can't", () => {
  const p = TEST_POOL_PATHS;
  const ok = holdPoolCommand("lx-a", 5400, RUN_ID, p);
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.command.program, p.pausePool);
    assertEquals(ok.command.args, [
      "lx-a",
      "--for",
      "hold",
      "--duration",
      "5400s",
      `fleet-update:${RUN_ID}`,
    ]);
  }
  assertFalse(holdPoolCommand("-x", 5400, RUN_ID, p).ok);
  assertFalse(holdPoolCommand("lx-a; reboot", 5400, RUN_ID, p).ok);
  assertFalse(holdPoolCommand("lx-a", 30, RUN_ID, p).ok);
  assertFalse(holdPoolCommand("lx-a", 8 * 24 * 3600, RUN_ID, p).ok);
  assertFalse(holdPoolCommand("lx-a", 5400, "x y", p).ok);
  // The page's pool controls have no hold.
  assertEquals(parsePoolControl({ kind: "hold", pool: "win-x64", seconds: 5400 }), null);
  assertFalse(
    poolCommand({ kind: "pause", pool: "win-x64", seconds: 5400 }, p, 501).ok,
    "a page pause stays capped",
  );
});
