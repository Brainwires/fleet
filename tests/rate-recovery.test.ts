// Rate-limit recovery: a poll that drained the shared REST budget (a 403 with no requests left)
// must resume once the reset time passes. The stuck state this reproduces: the client kept the
// 403's `remaining: 0` after its reset, the budget planner read it as "under the floor" and pushed
// the next poll 5 min past now on every tick, so no request went out to replace it, for good.
// Also: secondary limits back off on their hints, a permission 403 names its endpoint while the
// rest keeps polling, and the polled data is marked stale while polls fail.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { HIDDEN_MS, pollPlan, RATE_FLOOR, SLOW_MS } from "../lib/budget.ts";
import { createGitHubClient, GitHubError, retryAfterMs } from "../lib/github.ts";
import { POLL_STALE_MS, Poller } from "../lib/poller.ts";
import { createFleetService } from "../lib/service.ts";
import type { AgentSnapshot } from "../lib/agent-snapshot.ts";
import { freshness } from "../mcp/queries.ts";
import { fakeFetch, NOW, type Route, standardRoutes } from "./helpers.ts";

const TOKEN = "gho_" + "r".repeat(36);
const RESET_AFTER_MS = 9 * 60_000;

Deno.test("budget: a floor rate whose reset has passed no longer pauses polling", () => {
  const base = { visible: false, publicOnly: false, spentLastHour: 0, hooks: "live" as const };
  const drained = { remaining: 0, limit: 5000, resetAt: NOW + RESET_AFTER_MS };
  // Before the reset: paused until it.
  assertEquals(pollPlan({ ...base, rate: drained, now: NOW }), {
    intervalMs: SLOW_MS,
    notBefore: NOW + RESET_AFTER_MS,
    slow: "floor",
  });
  // After it (16 h later, the reported stuck state): the old figure says nothing; no pause.
  const later = NOW + 16 * 3600_000;
  const p = pollPlan({ ...base, rate: drained, now: later });
  assertEquals(p.notBefore, null);
  assertEquals(p.slow, null);
  // A rate without a reset time can't hold polling either.
  const noReset = { remaining: RATE_FLOOR - 1, limit: 5000, resetAt: 0 };
  assertEquals(pollPlan({ ...base, rate: noReset, now: NOW }).notBefore, null);
});

Deno.test("client: the rate is forgotten once its reset passes", async () => {
  let t = NOW;
  const reset = Math.floor((NOW + RESET_AFTER_MS) / 1000);
  const { fetch } = fakeFetch({ "/x": { body: {} } }, { remaining: 10, limit: 5000, reset });
  const c = createGitHubClient({ token: TOKEN, fetch, now: () => t });
  await c.get("/x");
  assertEquals(c.rate()?.remaining, 10);
  t = reset * 1000 + 1;
  assertEquals(c.rate(), null, "a refilled budget isn't reported as the old figure");
});

Deno.test("client: a secondary limit (403 naming it, no headers) backs off, then resumes", async () => {
  let t = NOW;
  let limited = true;
  const { fetch, seen } = fakeFetch({
    "/runs": () =>
      limited
        ? {
          status: 403,
          body: { message: "You have exceeded a secondary rate limit. Please wait a few minutes." },
        }
        : { body: { ok: true } },
  });
  const c = createGitHubClient({ token: TOKEN, fetch, now: () => t });
  const e = await assertRejectsGh(() => c.get("/runs"));
  assertEquals(e.kind, "backoff");
  assertStringIncludes(e.message, "GET /runs");
  assertEquals(c.backoffUntil(), NOW + 60_000);
  const sent = seen.length;
  assertEquals((await assertRejectsGh(() => c.get("/runs"))).message, "backing off");
  assertEquals(seen.length, sent, "nothing sent while backing off");
  limited = false;
  t = NOW + 61_000;
  assertEquals((await c.get<{ ok: boolean }>("/runs")).body.ok, true);
  assertEquals(c.backoffUntil(), null);
});

Deno.test("client: Retry-After as seconds or an HTTP date; a garbled hint can't park polling", async () => {
  assertEquals(retryAfterMs("30", NOW), 30_000);
  assertEquals(retryAfterMs(new Date(NOW + 90_000).toUTCString(), NOW), 90_000);
  assertEquals(retryAfterMs("soon", NOW), null);
  assertEquals(retryAfterMs("0", NOW), null);
  const t = NOW;
  const { fetch } = fakeFetch({
    "/date": { status: 429, headers: { "retry-after": new Date(NOW + 120_000).toUTCString() } },
  });
  const c = createGitHubClient({ token: TOKEN, fetch, now: () => t });
  await assertRejectsGh(() => c.get("/date"));
  assertEquals(c.backoffUntil(), NOW + 120_000);
  // A reset days away (a bad header) is capped at an hour.
  const far = fakeFetch({
    "/far": {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 86400) },
    },
  });
  const c2 = createGitHubClient({ token: TOKEN, fetch: far.fetch, now: () => t });
  await assertRejectsGh(() => c2.get("/far"));
  assertEquals(c2.backoffUntil(), NOW + 3600_000);
});

Deno.test("client: a permission 403 names the endpoint and GitHub's reason; no back-off", async () => {
  const { fetch } = fakeFetch({
    "/orgs/Brainwires/actions/runners?per_page=100": {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    },
  });
  const c = createGitHubClient({ token: TOKEN, fetch, now: () => NOW });
  const e = await assertRejectsGh(() => c.get("/orgs/Brainwires/actions/runners?per_page=100"));
  assertEquals(e.kind, "http");
  assertEquals(
    e.message,
    "forbidden (403) on GET /orgs/Brainwires/actions/runners: Resource not accessible by personal access token",
  );
  assertEquals(c.backoffUntil(), null);
  assertFalse(e.message.includes(TOKEN));
});

Deno.test("poller: a permission 403 is reported with its endpoint while the rest keeps polling", async () => {
  const routes = standardRoutes();
  routes["/orgs/Brainwires/actions/runners?per_page=100"] = {
    status: 403,
    body: { message: "Must have admin rights to Repository." },
  };
  const { fetch, seen } = fakeFetch(routes);
  const p = new Poller({
    client: createGitHubClient({ token: TOKEN, fetch, now: () => NOW }),
    auth: "stored",
    now: () => NOW,
  });
  assertEquals((await p.poll()).ok, true);
  const s = p.snapshot();
  assertEquals(s.poll.ok, true);
  assertFalse(s.poll.stale);
  assertEquals(s.poll.forbidden, [
    "forbidden (403) on GET /orgs/Brainwires/actions/runners: Must have admin rights to Repository.",
  ]);
  assert(s.summary.reasons.includes("no access (403) to 1 GitHub endpoint"));
  // The other endpoints were polled: runs, jobs and the health variable.
  assert(seen.some((r) => r.url.includes("/actions/runs?status=")));
  assert(seen.some((r) => r.url.includes("/actions/variables/DENEXT_POOL_HEALTH")));
  assert(s.running.length > 0, "the active runs are still shown");
});

/** A fake clock whose timers fire in order as it advances (the service's injected timers). */
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

Deno.test("service: a poll that drained the budget resumes after the reset (the stuck state)", async () => {
  const clock = fakeClock(NOW);
  const resetAt = NOW + 30_000 + RESET_AFTER_MS;
  let drained = false;
  let requests = 0;
  // The real GitHub after the reset: thousands left, its reset an hour on.
  const healthy = fakeFetch(standardRoutes(), {
    remaining: 4800,
    limit: 5000,
    reset: Math.floor(NOW / 1000) + 24 * 3600,
  });
  const drainedRes = (): Route => ({
    status: 403,
    body: { message: "API rate limit exceeded for user ID 1." },
    headers: {
      "x-ratelimit-remaining": "0",
      "x-ratelimit-limit": "5000",
      "x-ratelimit-reset": String(Math.floor(resetAt / 1000)),
    },
  });
  const fetch = ((input: string, init?: RequestInit) => {
    requests++;
    if (!drained) return healthy.fetch(input, init);
    const r = drainedRes();
    return Promise.resolve(
      new Response(JSON.stringify(r.body), { status: r.status, headers: r.headers }),
    );
  }) as typeof globalThis.fetch;
  const agents: AgentSnapshot[] = [];
  const svc = createFleetService({
    ghToken: () => Promise.resolve(TOKEN),
    secrets: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    fetch,
    now: clock.now,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    saveAgentSnapshot: (s) => {
      agents.push(s);
      return Promise.resolve();
    },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    warn: () => {},
  });
  await svc.start();
  await clock.settle();
  assertEquals(svc.snapshot().poll.ok, true);
  const firstOk = svc.snapshot().poll.lastSuccessAt;

  // Another tool drains the shared budget: the next poll is refused with no requests left.
  drained = true;
  await clock.advanceTo(NOW + 30_000);
  await svc.refresh();
  let s = svc.snapshot();
  assertEquals(s.poll.ok, false);
  assertStringIncludes(s.poll.message, "rate limited (403)");
  assertEquals(s.rate?.remaining, 0);
  assertEquals(s.poll.slow, "floor");
  assertFalse(s.poll.stale, "a fresh failure isn't stale yet");

  // Past the stale threshold but before the reset: no requests, and the data is marked stale.
  const before = requests;
  await clock.advanceTo(firstOk! + POLL_STALE_MS + 1000);
  assertEquals(requests, before, "nothing polls before the reset");
  s = svc.snapshot();
  assertEquals(s.poll.stale, true);
  assert(s.summary.reasons.includes("GitHub poll failing: pools and queue are stale"));
  // The agents' copy says so too: each pool is marked, and the MCP answers are stale even
  // though webhooks are live.
  // (The heartbeat rewrites it each minute: let one pass.)
  await clock.advanceTo(clock.now() + 61_000);
  assertEquals(requests, before);
  const stuck = agents.at(-1)!;
  assertEquals(stuck.poll.stale, true);
  assert(stuck.pools.length > 0 && stuck.pools.every((p) => p.stale === true));
  const f = freshness(
    { ...stuck, hooks: { state: "live", last_delivery_at: stuck.written_at } },
    clock.now(),
  );
  assertEquals(f.stale, true);
  assertStringIncludes(f.warning ?? "", "polls are failing");

  // The budget refills at the reset. Polling must resume on its own, right after it (the bug
  // left it paused for good: 16 h on, still `remaining: 0` and "floor"), at the normal interval,
  // and the stale marks go.
  drained = false;
  await clock.advanceTo(resetAt + HIDDEN_MS + 5000);
  s = svc.snapshot();
  assertEquals(s.poll.ok, true, `still failing: ${s.poll.message}`);
  assertEquals(s.poll.slow, null);
  assertEquals(s.poll.intervalMs, HIDDEN_MS);
  assertEquals(s.rate?.remaining, 4800);
  assertFalse(s.poll.stale);
  assert(s.poll.lastSuccessAt! > resetAt, "a poll succeeded after the reset");
  assert(s.poll.lastSuccessAt! < resetAt + HIDDEN_MS + 2000, "promptly after the reset");
  assertFalse(agents.at(-1)!.poll.stale);
  svc.stop();
});

async function assertRejectsGh(fn: () => Promise<unknown>): Promise<GitHubError> {
  try {
    await fn();
  } catch (err) {
    assert(err instanceof GitHubError, `not a GitHubError: ${err}`);
    return err;
  }
  throw new Error("did not reject");
}
