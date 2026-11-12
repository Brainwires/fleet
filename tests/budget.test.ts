// The shared REST budget: the slow-down thresholds read from response headers, the floor that
// pauses polling until the reset, Fleet's own hourly cap, and the cheaper poll (job lists only for
// runs whose updated_at changed; idle repos every 5 minutes).

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  HIDDEN_MS,
  OWN_BUDGET_PER_HOUR,
  pollPlan,
  RATE_FLOOR,
  RATE_LOW,
  RATE_SLOW,
  SLOW_MS,
  slowText,
  VISIBLE_MS,
} from "../lib/budget.ts";
import { createGitHubClient } from "../lib/github.ts";
import { IDLE_POLL_MS, Poller } from "../lib/poller.ts";
import { createFleetService } from "../lib/service.ts";
import { ciRunId, fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const RESET = NOW + 40 * 60_000;
const rate = (remaining: number) => ({ remaining, limit: 5000, resetAt: RESET });
const plan = (remaining: number | null, visible = true, spent = 0) =>
  pollPlan({
    rate: remaining === null ? null : rate(remaining),
    visible,
    publicOnly: false,
    spentLastHour: spent,
    now: NOW,
  });

Deno.test("budget: the thresholds", () => {
  assertEquals(plan(4000), { intervalMs: VISIBLE_MS, notBefore: null, slow: null });
  assertEquals(plan(4000, false).intervalMs, HIDDEN_MS);
  assertEquals(plan(null).intervalMs, VISIBLE_MS);
  // Below 1,500: 60 s even when visible, no banner.
  assertEquals(plan(RATE_SLOW - 1), { intervalMs: HIDDEN_MS, notBefore: null, slow: null });
  // Below 800: 5 min and the banner.
  assertEquals(plan(RATE_LOW - 1), { intervalMs: SLOW_MS, notBefore: null, slow: "low" });
  // Below 300: nothing until the reset.
  assertEquals(plan(RATE_FLOOR - 1), { intervalMs: SLOW_MS, notBefore: RESET, slow: "floor" });
  // Fleet's own spend.
  assertEquals(plan(4000, true, OWN_BUDGET_PER_HOUR).slow, "budget");
  assertEquals(plan(4000, true, OWN_BUDGET_PER_HOUR - 1).slow, null);
  assert(slowText("low").includes("protect the runner scheduler"));
  assertEquals(slowText(null), "");
});

function service(remaining: number) {
  const { fetch, seen } = fakeFetch(standardRoutes(), {
    remaining,
    limit: 5000,
    reset: RESET / 1000,
  });
  const pending: { ms: number }[] = [];
  let t = NOW;
  const svc = createFleetService({
    ghToken: () => Promise.resolve("gho_" + "b".repeat(36)),
    secrets: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    fetch,
    now: () => t,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: (_fn, ms) => pending.push({ ms }),
    clearTimeout: () => {},
  });
  return { svc, seen, pending, advance: (ms: number) => (t += ms) };
}

Deno.test("budget: the service reads x-ratelimit-* and slows down, visible or not", async () => {
  for (
    const [remaining, ms, slow] of [
      [4000, VISIBLE_MS, null],
      [1400, HIDDEN_MS, null],
      [700, SLOW_MS, "low"],
    ] as const
  ) {
    const { svc, pending } = service(remaining);
    await svc.start();
    svc.visibility(true);
    await svc.refresh();
    assertEquals(pending.at(-1)?.ms, ms, `remaining ${remaining}`);
    assertEquals(svc.snapshot().poll.slow, slow);
    assertEquals(svc.snapshot().rate?.remaining, remaining);
    svc.stop();
  }
});

Deno.test("budget: below the floor nothing polls until the reset", async () => {
  const { svc, seen, pending, advance } = service(RATE_FLOOR - 10);
  await svc.start(); // the first poll learns the limit
  const n = seen.length;
  assertEquals(svc.snapshot().poll.slow, "floor");
  // Waits for the reset (40 min out), not the interval.
  assert(pending.at(-1)!.ms > 30 * 60_000);
  advance(60_000);
  await svc.refresh();
  svc.visibility(true);
  assertEquals(seen.length, n, "no request under the floor");
  svc.stop();
});

Deno.test("budget: the client counts only non-304 requests", async () => {
  const { fetch } = fakeFetch({ "/x": { body: { a: 1 } }, "/y": { body: { b: 2 } } });
  let t = NOW;
  const c = createGitHubClient({ token: "x".repeat(40), fetch, now: () => t });
  await c.get("/x");
  await c.get("/x"); // 304
  await c.get("/y");
  assertEquals(c.spentLastHour(), 2);
  t += 3600_001;
  assertEquals(c.spentLastHour(), 0);
});

Deno.test("cheaper poll: jobs only for runs whose updated_at changed", async () => {
  const routes = standardRoutes();
  const { fetch, seen } = fakeFetch(routes);
  let t = NOW;
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => t }),
    auth: "gh",
    now: () => t,
  });
  // The fixture run gets an updated_at.
  const key = "/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100";
  const body = routes[key].body as { workflow_runs: Record<string, unknown>[] };
  body.workflow_runs[0].updated_at = "2026-11-11T17:29:00Z";
  await p.poll();
  const jobsPath = `/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`;
  const jobReads = () => seen.filter((s) => s.url === jobsPath).length;
  assertEquals(jobReads(), 1);
  t += 15_000;
  await p.poll();
  assertEquals(jobReads(), 1, "unchanged run: no jobs request at all");
  body.workflow_runs[0].updated_at = "2026-11-11T17:30:10Z";
  t += 15_000;
  await p.poll();
  assertEquals(jobReads(), 2, "changed run: jobs read again");
});

Deno.test("cheaper poll: repos idle for 3 polls are polled every 5 minutes", async () => {
  const { fetch, seen } = fakeFetch(standardRoutes());
  let t = NOW;
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => t }),
    auth: "gh",
    now: () => t,
  });
  const laufey = () =>
    seen.filter((s) => s.url.startsWith("/repos/Brainwires/laufey/actions/runs?")).length;
  const denext = () =>
    seen.filter((s) => s.url.startsWith("/repos/Brainwires/denext/actions/runs?")).length;
  for (let i = 0; i < 3; i++) {
    await p.poll();
    t += 15_000;
  }
  const idleAfter3 = laufey();
  const busyAfter3 = denext();
  await p.poll(); // laufey idle 3 polls: skipped; denext (active) polled
  assertEquals(laufey(), idleAfter3);
  assert(denext() > busyAfter3);
  t += IDLE_POLL_MS;
  await p.poll();
  assert(laufey() > idleAfter3, "polled again after 5 minutes");
  assertFalse(seen.some((s) => s.url.startsWith("/repos/Brainwires/archived/")));
});
