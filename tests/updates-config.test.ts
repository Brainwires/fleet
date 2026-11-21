// Machine updates: the config's validation and the self-machine rules, no-pool servers, schedule
// window maths (DST days, no catch-up, "not enough window left"), and the exclusivity rules
// (shared labels never overlap, the last healthy host is refused). Pure; machine names are made up.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { canInstall, validateSchedules, validateUpdatesConfig } from "../lib/updates/config.ts";
import { checkExclusive } from "../lib/updates/exclusive.ts";
import {
  busyStreak,
  currentWindow,
  nextWindow,
  NOTICE_MS,
  scheduleTick,
  type TickInput,
  zonedTime,
} from "../lib/updates/schedule.ts";
import type { PeerFacts, RunRecord, UpdateSchedule, UpdatesConfig } from "../lib/updates/model.ts";

const SSH = { program: "/usr/bin/ssh", configFile: "~/fleet-test/ssh_config" };

function config(machines: unknown[]): UpdatesConfig {
  const r = validateUpdatesConfig({ ssh: SSH, machines });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value!;
}

const errorsOf = (raw: unknown) => {
  const r = validateUpdatesConfig(raw);
  return r.ok ? [] : r.errors;
};

Deno.test("config: defaults, kinds, and absent means off", () => {
  assertEquals(validateUpdatesConfig(undefined), { ok: true, value: null });
  const c = config([
    { id: "linux-1", os: "ubuntu", via: { ssh: "linux-1" }, pools: ["pool-a"] },
    { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" } },
    { id: "here", os: "macos", via: "local", self: true },
  ]);
  const [runner, server, self] = c.machines;
  assertEquals(runner.kind, "runner");
  assertEquals(runner.busy, ["pools"], "a machine with pools checks them by default");
  assertEquals([runner.install, runner.reboot, runner.drainCapMinutes], [
    "security",
    "if-needed",
    90,
  ]);
  assertEquals(server.kind, "server");
  assertEquals(server.pools, []);
  assertEquals(server.busy, [], "a server has no busy plugin unless asked");
  assertEquals(self.install, "none");
  assertFalse(canInstall(self));
  assert(canInstall(server));
  assertEquals(c.thresholds, { securityDays: 7, rebootDays: 7, staleHours: 24, noCheckHours: 72 });
  // A server may opt in to the host's busy.d hook.
  assertEquals(
    config([{ id: "m", os: "ubuntu", kind: "server", via: { ssh: "m" }, busy: ["remote"] }])
      .machines[0].busy,
    ["remote"],
  );
});

Deno.test("config: self: true with an install, or a schedule for it, is an error", () => {
  const e = errorsOf({
    ssh: SSH,
    machines: [{ id: "here", os: "macos", via: "local", self: true, install: "security" }],
  });
  assert(e.some((x) => x.includes("notify-only")), e.join("\n"));
  // `local` is only for the self machine.
  assert(
    errorsOf({ ssh: SSH, machines: [{ id: "here", os: "macos", via: "local" }] })
      .some((x) => x.includes("only for the machine Fleet runs on")),
  );
  const c = config([
    { id: "here", os: "macos", via: "local", self: true },
    { id: "linux-1", os: "ubuntu", via: { ssh: "linux-1" } },
  ]);
  const sched = {
    id: "s1",
    machine: "here",
    days: [6],
    start: "02:00",
    windowMinutes: 240,
  };
  const r = validateSchedules([sched], c);
  assertFalse(r.ok);
  if (!r.ok) assertStringIncludes(r.errors.join("\n"), "no schedule");
  assert(validateSchedules([{ ...sched, machine: "linux-1" }], c).ok);
});

Deno.test("config: a server has no pools; bad fields are refused with their path", () => {
  const e = errorsOf({
    ssh: SSH,
    machines: [
      { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" }, pools: ["p"] },
      { id: "-x", os: "ubuntu", via: { ssh: "-oProxyCommand=sh" } },
      { id: "dup", os: "ubuntu", via: { ssh: "dup" }, busy: ["pools"] },
      {
        id: "dup",
        os: "ubuntu",
        via: { ssh: "dup2" },
        verify: { mounts: ["../etc"], reach: ["ghost"] },
      },
      { id: "solo", os: "beos", via: { ssh: "solo" }, reboot: "sometimes", drainCapMinutes: 0 },
    ],
  });
  const all = e.join("\n");
  for (
    const s of [
      "a server (no CI) has no pools",
      "machines[1].id",
      "machines[1].via.ssh",
      '"pools" needs at least one pool',
      "listed twice",
      "an absolute mount point",
      `"ghost" isn't a configured machine`,
      "machines[4].os",
      "machines[4].reboot",
      "machines[4].drainCapMinutes",
    ]
  ) assertStringIncludes(all, s);
  // ssh needs its config file.
  assert(
    errorsOf({ machines: [{ id: "m", os: "ubuntu", via: { ssh: "m" } }] })
      .some((x) => x.includes("ssh.configFile")),
  );
});

Deno.test("schedules: days, times, and a window too short for the drain cap", () => {
  const c = config([
    { id: "linux-1", os: "ubuntu", via: { ssh: "linux-1" }, pools: ["p"] },
    { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" } },
  ]);
  const bad = validateSchedules([
    { id: "s1", machine: "linux-1", days: [7], start: "25:00", windowMinutes: 120 },
  ], c);
  assertFalse(bad.ok);
  if (!bad.ok) {
    const all = bad.errors.join("\n");
    assertStringIncludes(all, "days[0]");
    assertStringIncludes(all, "start");
    assertStringIncludes(all, "at least 180");
  }
  // A server needs no drain time: 90 min is enough.
  const srv = validateSchedules([
    { id: "s2", machine: "mail-1", days: [0, 3], start: "03:30", windowMinutes: 90 },
  ], c);
  assert(srv.ok);
  if (srv.ok) assertEquals(srv.value[0].enabled, true);
});

// ---- schedule maths ----

const TZ = "America/Chicago";
const SCHED: UpdateSchedule = {
  id: "s1",
  machine: "linux-1",
  days: [0], // Sundays
  start: "02:30",
  windowMinutes: 240,
  mode: "security",
  reboot: "if-needed",
  drainCapMinutes: 90,
  enabled: true,
};
const MIN = 60_000;

Deno.test("schedule: DST days — a start in the spring gap moves forward, fall back takes the first", () => {
  // 2026-03-08: 02:00 CST jumps to 03:00 CDT; 02:30 doesn't exist → 03:30 CDT (08:30Z).
  assertEquals(
    new Date(zonedTime(2026, 3, 8, 2, 30, TZ)).toISOString(),
    "2026-03-08T08:30:00.000Z",
  );
  // 2026-11-01: 01:30 happens twice; the first is CDT (06:30Z).
  assertEquals(
    new Date(zonedTime(2026, 11, 1, 1, 30, TZ)).toISOString(),
    "2026-11-01T06:30:00.000Z",
  );
  // An ordinary day either side.
  assertEquals(
    new Date(zonedTime(2026, 3, 1, 2, 30, TZ)).toISOString(),
    "2026-03-01T08:30:00.000Z",
  );
  assertEquals(
    new Date(zonedTime(2026, 3, 15, 2, 30, TZ)).toISOString(),
    "2026-03-15T07:30:00.000Z",
  );
  // The window on the spring day lasts 240 real minutes from 03:30 CDT.
  const w = nextWindow(SCHED, TZ, Date.parse("2026-03-07T12:00:00Z"))!;
  assertEquals(new Date(w.start).toISOString(), "2026-03-08T08:30:00.000Z");
  assertEquals(w.end - w.start, 240 * MIN);
  // Fall-back day: one window, not two.
  const fb = { ...SCHED, start: "01:30" };
  const first = nextWindow(fb, TZ, Date.parse("2026-10-31T12:00:00Z"))!;
  assertEquals(new Date(first.start).toISOString(), "2026-11-01T06:30:00.000Z");
  const after = nextWindow(fb, TZ, first.end + 1)!;
  assertEquals(new Date(after.start).toISOString(), "2026-11-08T07:30:00.000Z");
});

const tick = (over: Partial<TickInput>) =>
  scheduleTick({
    schedule: SCHED,
    tz: TZ,
    now: Date.parse("2026-11-22T08:30:00Z"), // Sunday 02:30 CST, the window opens
    hasPools: true,
    due: true,
    handledWindow: null,
    notice: null,
    ...over,
  });

Deno.test("schedule: the notice, then the run ten minutes later, once per window", () => {
  const open = Date.parse("2026-11-22T08:30:00Z");
  const n = tick({});
  assertEquals(n.kind, "notice");
  if (n.kind !== "notice") return;
  assertEquals(n.window.start, open);
  assertEquals(n.runAt, open + NOTICE_MS);
  const notice = { window: open, at: open };
  assertEquals(tick({ now: open + 5 * MIN, notice }).kind, "idle");
  assertEquals(tick({ now: open + NOTICE_MS, notice }).kind, "start");
  assertEquals(tick({ now: open + NOTICE_MS, notice, handledWindow: open }).kind, "idle");
  assertEquals(tick({ schedule: { ...SCHED, enabled: false } }).kind, "idle");
  // Nothing pending and no reboot due: skipped and recorded.
  assertEquals(tick({ due: false }), {
    kind: "skip",
    window: currentWindow(SCHED, TZ, open)!,
    reason: "nothing-due",
  });
});

Deno.test("schedule: no catch-up, and a window without enough left is skipped", () => {
  const open = Date.parse("2026-11-22T08:30:00Z");
  // Fleet was off for the whole window: nothing to do afterwards (not even the next minute).
  assertEquals(tick({ now: open + 240 * MIN }).kind, "idle");
  assertEquals(tick({ now: open + 241 * MIN }).kind, "idle");
  // Waking 2 h 30 in: 90 min left, the run needs 90 + 90 → skip.
  assertEquals(tick({ now: open + 150 * MIN }), {
    kind: "skip",
    window: currentWindow(SCHED, TZ, open)!,
    reason: "not-enough-window",
  });
  // A server needs only the margin: the same moment is fine… unless the notice eats it.
  assertEquals(tick({ now: open + 130 * MIN, hasPools: false }).kind, "notice");
  assertEquals(tick({ now: open + 145 * MIN, hasPools: false }).kind, "skip");
  // Three deferred-busy windows in a row raise a notice.
  assertEquals(busyStreak(["succeeded", "deferred-busy", "deferred-busy", "deferred-busy"]), 3);
  assertEquals(busyStreak(["deferred-busy", "succeeded"]), 0);
});

// ---- exclusivity ----

const FLEET = config([
  { id: "host-a", os: "ubuntu", via: { ssh: "host-a" }, pools: ["lx-a"] },
  { id: "host-b", os: "ubuntu", via: { ssh: "host-b" }, pools: ["lx-b"] },
  { id: "host-c", os: "fedora", via: { ssh: "host-c" }, pools: ["arm-c"] },
  { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" } },
]);
const facts = (over: Partial<PeerFacts["pools"]> = {}, unreachable: string[] = []): PeerFacts => ({
  pools: {
    "lx-a": { label: "linux-x64", healthy: true, held: false },
    "lx-b": { label: "linux-x64", healthy: true, held: false },
    "arm-c": { label: "linux-arm64", healthy: true, held: false },
    ...over,
  } as PeerFacts["pools"],
  unreachable,
});
const m = (id: string) => FLEET.machines.find((x) => x.id === id)!;
const ACTIVE = { id: "r1", machine: "host-c" } as RunRecord;

Deno.test("exclusive: one run fleet-wide; sharing a label never overlaps", () => {
  assertEquals(checkExclusive(m("host-a"), FLEET, facts(), null), {
    ok: true,
    labels: ["linux-x64"],
    soleLabels: [],
  });
  const locked = checkExclusive(m("host-a"), FLEET, facts(), ACTIVE);
  assertFalse(locked.ok);
  // host-b is held by another update (or a failed one): host-a, sharing its label, waits.
  const held = checkExclusive(
    m("host-a"),
    FLEET,
    facts({ "lx-b": { label: "linux-x64", healthy: true, held: true } }),
    null,
  );
  assertFalse(held.ok);
  if (!held.ok) assertStringIncludes(held.reason, "host-b");
  assertFalse(checkExclusive(m("host-a"), FLEET, facts({}, ["host-b"]), null).ok);
  // An unrelated label's trouble doesn't matter.
  assert(
    checkExclusive(
      m("host-a"),
      FLEET,
      facts({ "arm-c": { label: "linux-arm64", healthy: false, held: true } }),
      null,
    ).ok,
  );
});

Deno.test("exclusive: the last healthy host is refused; a sole label is named", () => {
  const sick = facts({ "lx-b": { label: "linux-x64", healthy: false, held: false } });
  const r = checkExclusive(m("host-a"), FLEET, sick, null);
  assertFalse(r.ok);
  // An unconfigured pool on the label that is unhealthy: host-a is still its last healthy host.
  const only = config([{ id: "host-a", os: "ubuntu", via: { ssh: "host-a" }, pools: ["lx-a"] }]);
  const last = checkExclusive(only.machines[0], only, sick, null);
  assertFalse(last.ok);
  if (!last.ok) assertStringIncludes(last.reason, "last healthy host for linux-x64");
  // host-c alone serves linux-arm64: allowed, and the label is named.
  assertEquals(checkExclusive(m("host-c"), FLEET, facts(), null), {
    ok: true,
    labels: ["linux-arm64"],
    soleLabels: ["linux-arm64"],
  });
});

Deno.test("exclusive: a server with no pools is bound only by the one-run lock", () => {
  const allSick = facts(
    {
      "lx-a": { label: "linux-x64", healthy: false, held: true },
      "lx-b": { label: "linux-x64", healthy: false, held: true },
    },
    ["host-a", "host-b", "host-c"],
  );
  assertEquals(checkExclusive(m("mail-1"), FLEET, allSick, null), {
    ok: true,
    labels: [],
    soleLabels: [],
  });
  assertFalse(checkExclusive(m("mail-1"), FLEET, facts(), ACTIVE).ok);
});
