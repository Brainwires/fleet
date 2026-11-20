// Fleet is signalled, not polling: the runner scheduler's file changes reach the pool cards at once
// with no GitHub request (the reported bug: the Windows cards stayed "unhealthy" for minutes after
// the scheduler said healthy, until the 300 s reconcile poll). Fakes only: no GUI, no network, no
// timers of the real clock.

import { assert, assertEquals } from "@std/assert";
import type { AgentSnapshot } from "../lib/agent-snapshot.ts";
import { mergeLocalHealth } from "../lib/local-health.ts";
import { createFleetService } from "../lib/service.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const TOKEN = "gho_" + "e".repeat(36);

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
