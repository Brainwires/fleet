// The scheduler's tick over a fake clock and a fake orchestrator: automatic installs start as soon
// as a machine with `autoInstall` is out of date (never the self machine, never one with it off),
// always with restart policy `never` (a needed restart waits); one run at a time; the retry
// spacing after a busy or a finished run; restart windows: the ten-minute notice, then a restart
// run (nothing installs) only when a restart is pending, a skip when none is, no catch-up, and the
// notice after three busy windows. The orchestrator's side of these (no reboot when none is
// required; reboot-pending with the pools resumed; the restart-only run) is in
// updates-orchestrator.test.ts.

import { assert, assertEquals } from "@std/assert";
import {
  AUTO_AFTER_FAILURE_MS,
  AUTO_AFTER_SUCCESS_MS,
  createUpdatesScheduler,
  EMPTY_SCHEDULER_STATE,
  parseSchedulerState,
  type SchedulerEvent,
  type SchedulerState,
} from "../lib/updates/scheduler.ts";
import type { RunRequest } from "../lib/updates/orchestrator.ts";
import type { OrchestratorHandle } from "../lib/updates/backend.ts";
import {
  emptyStatus,
  type MachineStatus,
  type RunOutcome,
  type RunRecord,
  type UpdateSchedule,
  withCheck,
} from "../lib/updates/model.ts";
import { CONFIG, host } from "./updates-fixtures.ts";

const TZ = "America/Chicago";
// Sunday 2026-11-29 03:00 CST = 09:00Z.
const WINDOW = Date.parse("2026-11-29T09:00:00Z");
const MIN = 60_000;
const H = 60 * MIN;

/** Statuses: what is pending where (others up to date). */
function sts(over: Record<string, ReturnType<typeof host>>): Record<string, MachineStatus> {
  const out: Record<string, MachineStatus> = {};
  for (const m of CONFIG.machines) {
    out[m.id] = withCheck(emptyStatus(m.id), over[m.id] ?? host(0, 0), WINDOW - 2 * H);
  }
  return out;
}

class FakeOrch implements OrchestratorHandle {
  starts: RunRequest[] = [];
  running: RunRecord | null = null;
  #finish: ((o: RunOutcome) => void) | null = null;
  refuse: string | null = null;
  start(req: RunRequest) {
    if (this.refuse) return Promise.resolve({ ok: false as const, reason: this.refuse });
    this.starts.push(req);
    const rec = { id: `run-${this.starts.length}`, machine: req.machine } as RunRecord;
    this.running = rec;
    const done = new Promise<RunRecord>((resolve) => {
      this.#finish = (outcome) => {
        this.running = null;
        resolve({ ...rec, outcome });
      };
    });
    return Promise.resolve({ ok: true as const, runId: rec.id, done });
  }
  /** End the run in flight. */
  async finish(outcome: RunOutcome) {
    this.#finish?.(outcome);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
  }
  cancel() {
    return { ok: true as const };
  }
  current() {
    return this.running;
  }
}

function setup(
  statuses: Record<string, MachineStatus>,
  schedules: UpdateSchedule[] = [],
  start = WINDOW - 6 * H,
) {
  const clock = { t: start };
  const orch = new FakeOrch();
  const events: SchedulerEvent[] = [];
  let saved: SchedulerState = EMPTY_SCHEDULER_STATE;
  const sched = createUpdatesScheduler({
    config: () => CONFIG,
    schedules: () => Promise.resolve(schedules),
    statuses: () => Promise.resolve(statuses),
    orchestrator: orch,
    now: () => clock.t,
    tz: () => TZ,
    loadState: () => Promise.resolve(saved),
    saveState: (s) => {
      saved = s;
      return Promise.resolve();
    },
    events: (e) => events.push(e),
  });
  return { clock, orch, events, sched, saved: () => saved };
}

Deno.test("scheduler: an out-of-date machine with autoInstall gets an install run at once, never restarting", async () => {
  // runner-1: security pending (install: security) → due. runner-2: only non-security → not due
  // for a security-only machine. files-1: autoInstall off. here: the self machine.
  const t = setup(sts({
    "runner-1": host(3, 2),
    "runner-2": host(5, 0),
    "files-1": host(9, 9),
    "here": host(4, 4),
  }));
  await t.sched.tick();
  assertEquals(t.orch.starts, [{
    machine: "runner-1",
    origin: { kind: "auto" },
    mode: "security",
    reboot: "never",
  }]);
  assertEquals(t.events.at(-1), {
    kind: "started",
    machine: "runner-1",
    runId: "run-1",
    action: "install",
    origin: "auto",
  });
  // One at a time: the next tick starts nothing while it runs.
  t.clock.t += MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 1);
});

Deno.test("scheduler: nothing pending (or only a pending restart) starts no install", async () => {
  const t = setup(sts({ "mail-1": host(0, 0, { since: WINDOW - 3 * H }) }));
  await t.sched.tick();
  assertEquals(t.orch.starts, []);
});

Deno.test("scheduler: after a run the same machine waits (6 h when it installed, 1 h when busy)", async () => {
  const t = setup(sts({ "runner-1": host(3, 2) }));
  await t.sched.tick();
  await t.orch.finish("deferred-busy");
  t.clock.t += AUTO_AFTER_FAILURE_MS - MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 1, "busy: not again within the hour");
  t.clock.t += 2 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 2);
  await t.orch.finish("reboot-pending");
  t.clock.t += AUTO_AFTER_SUCCESS_MS - MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 2, "installed: not again for six hours");
  t.clock.t += 2 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 3);
  // The state survives a restart of Fleet (a fresh parse of what was saved).
  const back = parseSchedulerState(JSON.parse(JSON.stringify(t.saved())));
  assertEquals(back.auto["runner-1"].outcome, null);
});

Deno.test("scheduler: a refused start (a peer holds the label) is retried an hour later", async () => {
  const t = setup(sts({ "runner-1": host(3, 2) }));
  t.orch.refuse = "lx is held by another machine";
  await t.sched.tick();
  assertEquals(t.events.at(-1), {
    kind: "refused",
    machine: "runner-1",
    reason: "lx is held by another machine",
  });
  t.orch.refuse = null;
  t.clock.t += 30 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 0);
  t.clock.t += 31 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 1);
});

const RESTART_WINDOW: UpdateSchedule = {
  id: "s-mail",
  machine: "mail-1",
  days: [0],
  start: "03:00",
  windowMinutes: 120,
  mode: "security",
  reboot: "if-needed",
  drainCapMinutes: 90,
  enabled: true,
};

Deno.test("scheduler: a pending restart waits for its window: the notice, then a restart run", async () => {
  const t = setup(
    sts({ "mail-1": host(0, 0, { since: WINDOW - 26 * H }) }),
    [RESTART_WINDOW],
    WINDOW - 10 * H,
  );
  // Before the window: the restart stays pending, nothing starts.
  await t.sched.tick();
  assertEquals(t.orch.starts, []);
  t.clock.t = WINDOW;
  await t.sched.tick();
  assertEquals(t.events.map((e) => e.kind), ["restart-soon"]);
  assertEquals(t.orch.starts, []);
  t.clock.t = WINDOW + 10 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts, [{
    machine: "mail-1",
    origin: { kind: "schedule", scheduleId: "s-mail" },
    action: "restart",
    drainCapMinutes: 90,
    windowEnd: WINDOW + 120 * MIN,
  }]);
  await t.orch.finish("succeeded");
  // Once per window.
  t.clock.t = WINDOW + 20 * MIN;
  await t.sched.tick();
  assertEquals(t.orch.starts.length, 1);
  assertEquals(t.saved().windows["s-mail"].outcomes, ["succeeded"]);
});

Deno.test("scheduler: a window with no restart pending is skipped; a missed one is never caught up", async () => {
  const t = setup(sts({}), [RESTART_WINDOW], WINDOW);
  await t.sched.tick();
  assertEquals(t.events, [{
    kind: "skip",
    scheduleId: "s-mail",
    machine: "mail-1",
    window: WINDOW,
    reason: "nothing-due",
  }]);
  // A restart that became pending after the window ended waits for the next one.
  const late = setup(
    sts({ "mail-1": host(0, 0, { since: WINDOW }) }),
    [RESTART_WINDOW],
    WINDOW + 3 * H,
  );
  await late.sched.tick();
  assertEquals(late.orch.starts, []);
  assertEquals(late.events, []);
});

Deno.test("scheduler: three busy restart windows in a row raise a notice", async () => {
  const runnerWindow: UpdateSchedule = {
    ...RESTART_WINDOW,
    id: "s-r1",
    machine: "runner-1",
    windowMinutes: 240,
    drainCapMinutes: 45,
  };
  const t = setup(
    sts({ "runner-1": host(0, 0, { since: WINDOW - 30 * H }) }),
    [runnerWindow],
    WINDOW,
  );
  for (let week = 0; week < 3; week++) {
    t.clock.t = WINDOW + week * 7 * 24 * H;
    await t.sched.tick(); // notice
    t.clock.t += 10 * MIN;
    await t.sched.tick(); // start
    assertEquals(t.orch.starts.at(-1)?.action, "restart");
    await t.orch.finish("deferred-busy");
  }
  const streak = t.events.filter((e) => e.kind === "busy-streak");
  assertEquals(streak.length, 1);
  assert(streak[0].kind === "busy-streak" && streak[0].count === 3);
});
