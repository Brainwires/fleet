// Fleet is signalled, not polling: the runner scheduler's file changes reach the pool cards at once
// with no GitHub request (the reported bug: the Windows cards stayed "unhealthy" for minutes after
// the scheduler said healthy, until the 300 s reconcile poll), webhook deliveries drive the jobs,
// and the REST poll is only a safety net: every 15 min, once 5 min after deliveries go quiet, and on
// Refresh. Fakes only: no GUI, no network, no timers of the real clock.

import { assert, assertEquals } from "@std/assert";
import { HIDDEN_MS, HOOK_GAP_MS, pollPlan, RECONCILE_MS, VISIBLE_MS } from "../lib/budget.ts";
import type { AgentSnapshot } from "../lib/agent-snapshot.ts";
import type { HookDelivery } from "../lib/hooks.ts";
import { mergeLocalHealth } from "../lib/local-health.ts";
import { createFleetService } from "../lib/service.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const TOKEN = "gho_" + "e".repeat(36);
const MIN = 60_000;

/** setTimeout on a hand-moved clock (as in rate-recovery.test.ts). */
function fakeClock(start: number) {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const settle = async () => {
    for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    now: () => t,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    settle,
    /** Move to `target`, firing every timer due on the way (each at its own time). */
    async advanceTo(target: number) {
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= target && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        timers.delete(due[0]);
        t = Math.max(t, due[1].at);
        due[1].fn();
        await settle();
      }
      t = target;
    },
  };
}

const secrets = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

/** A delivery for a watched repo (its job payload is not needed for the timer). */
const delivery = (id: string, at: number): HookDelivery => ({
  id,
  event: "workflow_job",
  receivedAt: at,
  payload: { repository: { full_name: "Brainwires/denext" } },
});

Deno.test("plan: with webhooks on, polling is the 15-minute safety net, quiet or not", () => {
  const base = { rate: null, visible: true, publicOnly: false, spentLastHour: 0, now: NOW };
  assertEquals(RECONCILE_MS, 15 * MIN);
  assertEquals(HOOK_GAP_MS, 5 * MIN);
  assertEquals(pollPlan({ ...base, hooks: "live", activeRuns: 3 }).intervalMs, RECONCILE_MS);
  // Quiet webhooks with jobs queued (a queue that isn't moving sends nothing): still the safety
  // net, not a fall back to 15 s polling.
  assertEquals(pollPlan({ ...base, hooks: "stale", activeRuns: 3 }).intervalMs, RECONCILE_MS);
  assertEquals(pollPlan({ ...base, hooks: "stale", activeRuns: 0 }).intervalMs, RECONCILE_MS);
  // No webhooks: the budget's normal rate.
  assertEquals(pollPlan({ ...base, hooks: "off" }).intervalMs, VISIBLE_MS);
  assertEquals(pollPlan({ ...base, visible: false, hooks: "off" }).intervalMs, HIDDEN_MS);
});

Deno.test("scheduler files: a change reaches the pool cards at once, with no GitHub request", async () => {
  const clock = fakeClock(NOW);
  const { fetch, seen } = fakeFetch(standardRoutes());
  // The scheduler's health file as it is on disk; the test rewrites it between polls.
  let local: unknown = {
    checked_at_epoch: (NOW - 100_000) / 1000,
    pools: {
      "win-x64": { healthy: false, reason: "the Windows guest unreachable", since_epoch: 1 },
      "linux-x64": { healthy: true },
    },
  };
  const agents: AgentSnapshot[] = [];
  let changes = 0;
  const svc = createFleetService({
    ghToken: () => Promise.resolve(TOKEN),
    secrets,
    fetch,
    now: clock.now,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    saveAgentSnapshot: (s) => {
      agents.push(s);
      return Promise.resolve();
    },
    localHealth: (v) => Promise.resolve(mergeLocalHealth(v, local, new Set(), clock.now())),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: () => {},
  });
  await svc.start();
  await clock.settle();
  const card = () => svc.snapshot().pools.find((p) => p.id === "win-x64");
  assertEquals(card()?.state, "unhealthy");
  svc.onChange(() => changes++);

  // The scheduler recovers the guest and rewrites its file, 5 s later (long before any poll).
  await clock.advanceTo(NOW + 5_000);
  local = {
    checked_at_epoch: (NOW + 5_000) / 1000,
    pools: { "win-x64": { healthy: true }, "linux-x64": { healthy: true } },
  };
  const requests = seen.length;
  await svc.localStateChanged();
  assertEquals(card()?.state, "ok", "the card follows the file, not the next poll");
  assertEquals(seen.length, requests, "no GitHub request for a local change");
  assert(changes >= 1, "the pages were told");
  // The agents' copy says where it came from.
  assertEquals(agents.at(-1)?.source, "watch");
  assertEquals(Date.parse(agents.at(-1)!.updated_at), NOW + 5_000);

  // A tick that changes nothing pushes nothing.
  const before = changes;
  await svc.localStateChanged();
  assertEquals(changes, before);
  svc.stop();
});

Deno.test("scheduler files: the watch shows in the snapshot only once set up", async () => {
  const clock = fakeClock(NOW);
  const { fetch } = fakeFetch(standardRoutes());
  const svc = createFleetService({
    ghToken: () => Promise.resolve(TOKEN),
    secrets,
    fetch,
    now: clock.now,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: () => {},
  });
  await svc.start();
  await clock.settle();
  assertEquals(svc.snapshot().watch, undefined);
  svc.setWatching(true);
  assertEquals(svc.snapshot().watch, { on: true, lastChangeAt: null });
  svc.setWatching(false);
  assertEquals(svc.snapshot().watch?.on, false);
  svc.stop();
});

Deno.test("safety poll: once 5 min after deliveries go quiet, then every 15 min; Refresh at once", async () => {
  const clock = fakeClock(NOW);
  const { fetch, seen } = fakeFetch(standardRoutes());
  const svc = createFleetService({
    ghToken: () => Promise.resolve(TOKEN),
    secrets,
    fetch,
    now: clock.now,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: () => {},
  });
  await svc.start(); // the first poll, at NOW
  await clock.settle();
  svc.setHooksEnabled(true);
  const polledAt: number[] = [];
  let count = seen.length;
  /** Move to `target` and note whether a poll (any request) went out on the way. */
  const step = async (target: number) => {
    await clock.advanceTo(target);
    if (seen.length > count) polledAt.push(target);
    count = seen.length;
  };

  // Deliveries every minute for 4 min: no poll meanwhile (they are the source).
  for (let i = 1; i <= 4; i++) {
    await clock.advanceTo(NOW + i * MIN);
    await svc.applyHook(delivery(`d${i}`, NOW + i * MIN));
  }
  count = seen.length;
  const last = NOW + 4 * MIN;
  await step(last + HOOK_GAP_MS - 1_000);
  assertEquals(polledAt, [], "nothing polls while deliveries keep coming, or before the gap");
  // The gap: deliveries quiet for 5 min → one reconciling poll.
  await step(last + HOOK_GAP_MS + 1_000);
  assertEquals(polledAt, [last + HOOK_GAP_MS + 1_000], "the gap poll");
  // …and then only the 15-minute safety net, not a poll every 5 min of the quiet.
  await step(last + HOOK_GAP_MS + RECONCILE_MS - 1_000);
  assertEquals(polledAt.length, 1, "no poll inside the safety interval");
  await step(last + HOOK_GAP_MS + RECONCILE_MS + 1_000);
  assertEquals(polledAt.length, 2, "the safety poll");
  // Refresh polls at once, whatever the timer says.
  const before = seen.length;
  await svc.refresh();
  assert(seen.length > before, "Refresh polls");
  svc.stop();
});

Deno.test("safety poll: a new delivery moves the gap poll on", async () => {
  const clock = fakeClock(NOW);
  const { fetch, seen } = fakeFetch(standardRoutes());
  const svc = createFleetService({
    ghToken: () => Promise.resolve(TOKEN),
    secrets,
    fetch,
    now: clock.now,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: () => {},
  });
  await svc.start();
  await clock.settle();
  svc.setHooksEnabled(true);
  await clock.advanceTo(NOW + MIN);
  await svc.applyHook(delivery("a", NOW + MIN));
  // Another delivery 4 min later, just before the first gap would end.
  await clock.advanceTo(NOW + 5 * MIN);
  await svc.applyHook(delivery("b", NOW + 5 * MIN));
  const count = seen.length;
  await clock.advanceTo(NOW + 9 * MIN);
  assertEquals(seen.length, count, "the first gap was cut short by the second delivery");
  await clock.advanceTo(NOW + 10 * MIN + 1_000);
  assert(seen.length > count, "the gap after the second delivery polls");
  svc.stop();
});
