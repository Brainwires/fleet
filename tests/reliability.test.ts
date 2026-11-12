// Reliability: a hung request times out (never a poll stuck forever, and a stuck poll is dropped by
// the watchdog); the ETag cache is bounded and forgets runs that left the poller's view; ages of
// GitHub timestamps use GitHub's clock (from the API's Date headers), not this machine's.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { createGitHubClient, ETAG_CACHE_MAX, GitHubError } from "../lib/github.ts";
import type { GhJob, GhRun, GhRunList } from "../lib/github-types.ts";
import { Poller } from "../lib/poller.ts";
import { AGENT_FINISHED_KEEP_MS } from "../lib/agent-snapshot.ts";
import { buildSnapshot } from "../lib/snapshot.ts";
import { diffObservation, newTracker, STALL_MS } from "../lib/events.ts";
import { pendingNotifications } from "../lib/notify.ts";
import { parsePoolHealth } from "../lib/health.ts";
import { createFleetService, POLL_STUCK_MS } from "../lib/service.ts";
import { ciRunId, fakeFetch, fixture, NOW, standardRoutes } from "./helpers.ts";

/** Reject if `p` hasn't settled within `ms` (so a hang fails the test instead of blocking it). */
function within<T>(p: Promise<T>, ms: number): Promise<T> {
  let id: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.finally(() => clearTimeout(id)),
    new Promise<never>((_, reject) => {
      id = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]);
}

/** A fetch that never resolves and ignores its abort signal. */
const neverFetch = (() => new Promise<Response>(() => {})) as typeof fetch;

Deno.test("timeout: a request that never answers rejects as a retryable timeout (GET and POST)", async () => {
  const c = createGitHubClient({ token: "x".repeat(40), fetch: neverFetch, timeoutMs: 30 });
  const get = await within(c.get("/rate_limit").then(() => null, (e) => e), 2000);
  assert(get instanceof GitHubError);
  assertEquals(get.kind, "timeout");
  assertStringIncludes(get.message, "timed out");
  const post = await within(c.post("/repos/a/b/x").then(() => null, (e) => e), 2000);
  assert(post instanceof GitHubError);
  assertEquals(post.kind, "timeout");
  // Not a back-off: the next request goes out.
  assertEquals(c.backoffUntil(), null);
});

Deno.test("timeout: a caller's signal is combined with the deadline", async () => {
  const c = createGitHubClient({ token: null, fetch: neverFetch, timeoutMs: 60_000 });
  const ac = new AbortController();
  const p = c.get("/rate_limit", { signal: ac.signal }).then(() => null, (e) => e);
  ac.abort();
  const err = await within(p, 2000);
  assert(err instanceof GitHubError);
  assertEquals(err.kind, "network");
});

Deno.test("timeout: a poll over a hung connection fails (keeps its data) instead of hanging", async () => {
  const client = createGitHubClient({ token: "x".repeat(40), fetch: neverFetch, timeoutMs: 30 });
  const p = new Poller({ client, auth: "gh", now: () => NOW });
  const r = await within(p.poll(), 5000);
  assertFalse(r.ok);
  assertFalse(r.authFailed);
  assertStringIncludes(p.snapshot().poll.message, "timed out");
});

Deno.test("watchdog: a poll stuck past 2 min is dropped and the next one goes ahead", async () => {
  let t = NOW;
  let calls = 0;
  const gates: (() => void)[] = [];
  const { fetch: inner } = fakeFetch(standardRoutes());
  // Every request hangs until released, then answers from the fixtures.
  const fetch = ((url: string, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((resolve) => gates.push(() => resolve(inner(url, init))));
  }) as typeof globalThis.fetch;
  const warned: string[] = [];
  const timers: number[] = [];
  const svc = createFleetService({
    ghToken: () => Promise.resolve("gho_" + "c".repeat(36)),
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
    setTimeout: (_f, ms) => timers.push(ms),
    clearTimeout: () => {},
    requestTimeoutMs: 10_000,
    warn: (m) => warned.push(m),
  });
  const started = svc.start();
  while (calls === 0) await new Promise((r) => setTimeout(r, 0));
  const first = calls;
  // A watchdog timer is armed past the stuck limit.
  assert(timers.some((ms) => ms > POLL_STUCK_MS));
  // Under the limit, a refresh joins the poll in flight.
  t += POLL_STUCK_MS - 1000;
  void svc.refresh();
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(calls, first);
  assertEquals(warned, []);
  // Past it, the stuck poll is dropped (and said so) and a new one starts.
  t += 2000;
  const second = svc.refresh();
  await new Promise((r) => setTimeout(r, 0));
  assert(calls > first, "a new poll went out");
  assertEquals(warned.length, 1);
  assertStringIncludes(warned[0], "dropped it");
  // Release everything; both settle.
  while (gates.length) {
    gates.splice(0).forEach((g) => g());
    await new Promise((r) => setTimeout(r, 0));
  }
  await within(Promise.all([started, second]), 5000);
  svc.stop();
});

Deno.test("etag cache: bounded LRU (2,000 by default); the least recently used goes first", async () => {
  assertEquals(ETAG_CACHE_MAX, 2000);
  const routes: Record<string, { body: unknown }> = {};
  for (let i = 0; i < ETAG_CACHE_MAX + 50; i++) routes[`/r/${i}`] = { body: { i } };
  const { fetch, seen } = fakeFetch(routes);
  const big = createGitHubClient({ token: null, fetch, now: () => NOW });
  for (let i = 0; i < ETAG_CACHE_MAX + 50; i++) await big.get(`/r/${i}`);
  assertEquals(big.cacheSize(), ETAG_CACHE_MAX);

  const small = createGitHubClient({ token: null, fetch, now: () => NOW, cacheMax: 3 });
  for (const i of [0, 1, 2]) await small.get(`/r/${i}`);
  await small.get("/r/0"); // touched: now the most recent
  await small.get("/r/3"); // evicts /r/1, the least recent
  assertEquals(small.cacheSize(), 3);
  seen.length = 0;
  await small.get("/r/1");
  assertEquals(seen[0].headers.get("if-none-match"), null, "/r/1 was evicted");
  seen.length = 0;
  await small.get("/r/0");
  assert(seen[0].headers.get("if-none-match"), "/r/0 was kept");
});

Deno.test("etag cache: a run's URLs are evicted once it leaves the poller's recent set", async () => {
  let t = NOW;
  const routes = standardRoutes();
  const { fetch, seen } = fakeFetch(routes);
  const client = createGitHubClient({ token: "x".repeat(40), fetch, now: () => t });
  const p = new Poller({ client, auth: "gh", now: () => t });
  await p.poll();
  // The run finishes: one last read of it and its jobs, then it is "recent" for 2 h.
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: { total_count: 0, workflow_runs: [] },
  };
  const run = fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs[0];
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}`] = {
    body: { ...run, status: "completed", conclusion: "success" },
  };
  t += 20_000;
  await p.poll();
  const jobsUrl = `/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`;
  seen.length = 0;
  await client.get(jobsUrl);
  assert(seen[0].headers.get("if-none-match"), "still cached while recent");
  t += AGENT_FINISHED_KEEP_MS + 60_000;
  await p.poll();
  seen.length = 0;
  await client.get(jobsUrl);
  assertEquals(seen[0].headers.get("if-none-match"), null, "evicted once it left the recent set");
});

/** A fetch whose every answer carries GitHub's clock `skewMs` ahead of ours. */
function skewedFetch(skewMs: number, now: () => number): typeof fetch {
  const { fetch: inner } = fakeFetch(standardRoutes());
  return (async (url: string, init?: RequestInit) => {
    const res = await inner(url, init);
    const headers = new Headers(res.headers);
    headers.set("date", new Date(now() + skewMs).toUTCString());
    return new Response(res.body, { status: res.status, headers });
  }) as typeof fetch;
}

Deno.test("clock: GitHub's offset comes from the Date headers (0 without, or within a second)", async () => {
  const t = () => NOW;
  const ahead = createGitHubClient({ token: null, fetch: skewedFetch(20 * 60_000, t), now: t });
  await ahead.get("/orgs/Brainwires/repos?per_page=100&type=all");
  assert(Math.abs(ahead.clockOffset() - 20 * 60_000) <= 1000, String(ahead.clockOffset()));
  const close = createGitHubClient({ token: null, fetch: skewedFetch(400, t), now: t });
  await close.get("/orgs/Brainwires/repos?per_page=100&type=all");
  assertEquals(close.clockOffset(), 0);
  const { fetch } = fakeFetch(standardRoutes());
  const none = createGitHubClient({ token: null, fetch, now: t });
  await none.get("/orgs/Brainwires/repos?per_page=100&type=all");
  assertEquals(none.clockOffset(), 0);
  // The poller's snapshot carries it for the page.
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch: skewedFetch(-90_000, t), now: t }),
    auth: "gh",
    now: t,
  });
  await p.poll();
  assert(Math.abs((p.snapshot().clockOffsetMs ?? 0) + 90_000) <= 1000);
});

const RUN: GhRun = fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs[0];
/** This machine's clock runs 20 min behind GitHub's. */
const SKEW = 20 * 60_000;
const GH_NOW = NOW + SKEW;
const queuedJob = (over: Partial<GhJob> = {}): GhJob => ({
  id: 501,
  run_id: RUN.id,
  name: "check",
  status: "queued",
  labels: ["self-hosted", "denext-linux-x64"],
  runner_name: null,
  // 16 min ago on GitHub's clock: 4 min in this machine's future.
  created_at: new Date(GH_NOW - 16 * 60_000).toISOString(),
  ...over,
});

Deno.test("clock: queued over 15 min is judged on GitHub's clock (snapshot + notification)", () => {
  const input = {
    now: NOW,
    auth: "gh" as const,
    poll: {
      ok: true,
      message: "",
      lastSuccessAt: NOW,
      intervalMs: 15_000,
      backoffUntil: null,
      slow: null,
    },
    rate: null,
    health: parsePoolHealth(null, NOW),
    runs: [{ repo: "Brainwires/denext", run: RUN }],
    jobsByRun: new Map([[RUN.id, [queuedJob()]]]),
    runners: null,
    finished: [],
    usual: () => null,
    repos: [],
  };
  const naive = buildSnapshot(input);
  assertFalse(naive.summary.reasons.some((r) => r.includes("queued over 15 min")));
  const snap = buildSnapshot({ ...input, clockOffsetMs: SKEW });
  assertEquals(snap.clockOffsetMs, SKEW);
  assert(snap.summary.reasons.includes("1 job queued over 15 min"), snap.summary.reasons.join());
  assertEquals(snap.summary.severity, "alert");
  const notes = pendingNotifications(snap, new Map(), NOW - 3600_000);
  assertEquals(notes.map((n) => n.title), ["Job queued over 15 min"]);
});

Deno.test("clock: STALLED is judged on GitHub's clock", () => {
  const running = queuedJob({
    status: "in_progress",
    runner_name: "denext-linux-x64-1-5",
    // Running 80 min on GitHub's clock; 60 min by this machine's.
    started_at: new Date(GH_NOW - 80 * 60_000).toISOString(),
  });
  const base = { health: parsePoolHealth(null, NOW), annotations: new Map<number, string>() };
  const runs = [{ repo: "Brainwires/denext", run: RUN, jobs: [running] }];
  const seedOnly = newTracker();
  diffObservation(seedOnly, { now: NOW - 1000, runs: [], ...base });
  const naive = diffObservation(seedOnly, { now: NOW, runs, ...base });
  assertFalse(naive.some((e) => e.kind === "stalled"), "60 min by our clock is not stalled");
  const tracker = newTracker();
  diffObservation(tracker, { now: NOW - 1000, runs: [], ...base });
  const ev = diffObservation(tracker, { now: NOW, runs, clockOffsetMs: SKEW, ...base });
  const stalled = ev.find((e) => e.kind === "stalled");
  assert(stalled, "stalled on GitHub's clock");
  assertStringIncludes(stalled.text, "running 80 min");
  assert(80 * 60_000 > STALL_MS);
});
