// The data layer against recorded fixtures: classification, queue ages and warnings, grouping, the
// pool-health parser (missing / garbage / stale), the GitHub client's ETag cache and back-off, the
// poller end to end, the notifications (once each), the tray, and the service's token handling.
// No network, no gh, no keychain.

import { assert, assertEquals, assertFalse, assertRejects } from "@std/assert";
import {
  classifyJob,
  GHOST_RUN_MS,
  groupLanes,
  isGhostRun,
  jobAge,
  jobSince,
  jobWarning,
  median,
  poolIsFull,
  QUEUED_WARN_MS,
} from "../lib/classify.ts";
import { createGitHubClient, GitHubError, nextLink } from "../lib/github.ts";
import type { GhJob, GhJobList, GhRunList } from "../lib/github-types.ts";
import { HEALTH_STALE_MS, parsePoolHealth } from "../lib/health.ts";
import { formatAgo, formatDuration } from "../lib/format.ts";
import { pendingNotifications } from "../lib/notify.ts";
import { Poller } from "../lib/poller.ts";
import { currentPools, poolFromLabels, poolFromRunnerName, setPools } from "../lib/pools.ts";
import { cleanToken, createFleetService, TOKEN_KEY } from "../lib/service.ts";
import { encodePng } from "../lib/png.ts";
import type { PoolCard, Snapshot } from "../lib/model.ts";
import { markCapacityWaits, poolCards, summarize } from "../lib/snapshot.ts";
import { ciRunId, fakeFetch, fixture, NOW, standardRoutes } from "./helpers.ts";

const job = (over: Partial<GhJob>): GhJob => ({
  id: 1,
  run_id: 10,
  name: "job",
  status: "queued",
  labels: [],
  runner_name: null,
  created_at: "2026-11-11T17:00:00Z",
  started_at: null,
  ...over,
});

// ---- pools and classification ----

Deno.test("pools: labels and runner names map to the short pool names", () => {
  assertEquals(poolFromLabels(["self-hosted", "denext-macos-arm64"]), "mac-arm");
  assertEquals(poolFromLabels(["self-hosted", "denext-windows-x64"]), "win-x64");
  assertEquals(poolFromLabels(["ubuntu-latest"]), null);
  assertEquals(poolFromLabels(["self-hosted", "denext-new-pool"]), "denext-new-pool");
  assertEquals(poolFromRunnerName("denext-linux-x64-2204-1-17944"), "linux-x64-2204");
  assertEquals(poolFromRunnerName("denext-linux-x64-docker-1-17944"), "linux-x64-docker");
  assertEquals(poolFromRunnerName("denext-linux-x64-3-17944"), "linux-x64");
  assertEquals(poolFromRunnerName("GitHub Actions 1000057773"), null);
});

Deno.test("classify: the four kinds, and completed jobs drop out", () => {
  assertEquals(
    classifyJob(job({
      status: "in_progress",
      labels: ["self-hosted", "denext-linux-x64-docker"],
      runner_name: "denext-linux-x64-docker-1-1",
    })),
    { lane: "running", target: "pool", pool: "linux-x64-docker" },
  );
  assertEquals(
    classifyJob(
      job({ status: "in_progress", labels: ["macos-latest"], runner_name: "GitHub Actions 1" }),
    ),
    { lane: "running", target: "github", pool: "github" },
  );
  assertEquals(
    classifyJob(job({ status: "queued", labels: ["self-hosted", "denext-macos-x64"] })),
    { lane: "queued", target: "pool", pool: "mac-x64" },
  );
  assertEquals(
    classifyJob(job({ status: "waiting", labels: ["self-hosted"] })),
    { lane: "queued", target: "pool", pool: "self-hosted" },
  );
  assertEquals(
    classifyJob(job({ status: "queued", labels: ["windows-latest"] })),
    { lane: "queued", target: "github", pool: "github" },
  );
  assertEquals(classifyJob(job({ status: "completed", conclusion: "success" })), null);
  // A runner name of ours wins over a missing label (a job picked by runner group).
  assertEquals(
    classifyJob(job({ status: "in_progress", labels: [], runner_name: "denext-mac-arm-2-17" })),
    { lane: "running", target: "pool", pool: "mac-arm" },
  );
});

Deno.test("classify: the recorded CI run's jobs", () => {
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs;
  const by = Object.fromEntries(jobs.map((j) => [j.name, classifyJob(j)]));
  assertEquals(by["coverage"], { lane: "running", target: "pool", pool: "linux-x64-docker" });
  assertEquals(by["windows-tests"], { lane: "running", target: "pool", pool: "win-x64" });
  assertEquals(by["next-compat"], { lane: "queued", target: "pool", pool: "linux-x64" });
  assertEquals(by["macos-tests"], null);
});

Deno.test("queue age: created_at while queued, started_at while running", () => {
  const q = job({ created_at: "2026-11-11T17:10:00Z" });
  const r = job({
    status: "in_progress",
    created_at: "2026-11-11T17:00:00Z",
    started_at: "2026-11-11T17:20:00Z",
  });
  assertEquals(jobAge(jobSince(q, "queued"), NOW), 20 * 60_000);
  assertEquals(jobAge(jobSince(r, "running"), NOW), 10 * 60_000);
  // A clock behind GitHub's never gives a negative age.
  assertEquals(jobAge(NOW + 5000, NOW), 0);
});

Deno.test("warnings: queued over 15 min, running past its usual length", () => {
  assertEquals(
    jobWarning({ lane: "queued", since: NOW - QUEUED_WARN_MS + 1000, usualMs: null }, NOW),
    null,
  );
  assertEquals(
    jobWarning({ lane: "queued", since: NOW - QUEUED_WARN_MS - 1000, usualMs: null }, NOW),
    "queued-long",
  );
  // Usual 10 min: late past max(15 min, 13 min) = 15 min.
  assertEquals(
    jobWarning({ lane: "running", since: NOW - 14 * 60_000, usualMs: 600_000 }, NOW),
    null,
  );
  assertEquals(
    jobWarning({ lane: "running", since: NOW - 16 * 60_000, usualMs: 600_000 }, NOW),
    "over-usual",
  );
  // Short jobs get the 3-minute slack: usual 1 min, late past 4 min.
  assertEquals(
    jobWarning({ lane: "running", since: NOW - 3 * 60_000, usualMs: 60_000 }, NOW),
    null,
  );
  assertEquals(
    jobWarning({ lane: "running", since: NOW - 5 * 60_000, usualMs: 60_000 }, NOW),
    "over-usual",
  );
  assertEquals(jobWarning({ lane: "running", since: NOW - 99 * 60_000, usualMs: null }, NOW), null);
  assertEquals(median([5, 1, 3]), 3);
  assertEquals(median([4, 1, 3, 2]), 2.5);
  assertEquals(median([]), null);
});

Deno.test("grouping: repo → run → job, per lane; a queued run with no jobs yet", () => {
  const runs = [
    ...fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs.map((run) => ({
      repo: "Brainwires/denext",
      run,
    })),
    ...fixture<GhRunList>("deno-runs-queued.json").workflow_runs.map((run) => ({
      repo: "Brainwires/deno",
      run,
    })),
  ];
  const jobs = new Map([[ciRunId(), fixture<GhJobList>("denext-ci-jobs.json").jobs]]);
  const { running, queued } = groupLanes(runs, jobs, () => null, NOW);
  assertEquals(running.map((g) => g.repo), ["Brainwires/denext"]);
  assertEquals(running[0].runs[0].jobs.map((j) => j.name), ["coverage", "windows-tests"]);
  assertEquals(running[0].runs[0].branch, "train/4.17");
  assertFalse(running[0].runs[0].defaultBranch);
  // deno (core order first) then denext.
  assertEquals(queued.map((g) => g.repo), ["Brainwires/deno", "Brainwires/denext"]);
  assert(queued[0].runs.every((r) => r.pendingJobs && r.jobs.length === 0));
  assertEquals(queued[1].runs[0].jobs.map((j) => j.name).sort(), [
    "backend-integration",
    "cargo-audit",
    "next-compat",
  ]);
  assertEquals(queued[1].runs[0].sha.length, 7);
});

Deno.test("grouping: a queued run with no jobs shows while fresh, is hidden once a ghost", () => {
  const base = fixture<GhRunList>("deno-runs-queued.json").workflow_runs[0];
  const at = (iso: string) => ({ ...base, status: "queued", created_at: iso, run_started_at: iso });
  const created = Date.parse(base.created_at);
  const runs = [{ repo: "Brainwires/deno", run: at(base.created_at) }];
  // Fresh (just dispatched, jobs not expanded yet): "queued, no jobs yet".
  const fresh = groupLanes(runs, new Map(), () => null, created + 5_000).queued;
  assertEquals(fresh.length, 1);
  assert(fresh[0].runs[0].pendingJobs);
  // Still under 10 min: shown.
  assertEquals(
    groupLanes(runs, new Map(), () => null, created + GHOST_RUN_MS - 1).queued.length,
    1,
  );
  // Past 10 min with no jobs: GitHub's stale status, left out of both lanes.
  const ghost = groupLanes(runs, new Map(), () => null, created + GHOST_RUN_MS + 1);
  assertEquals(ghost.queued, []);
  assertEquals(ghost.running, []);
  // An old run re-run just now (run_started_at fresh) still shows while its jobs appear.
  const rerun = [{
    repo: "Brainwires/deno",
    run: { ...at(base.created_at), run_started_at: new Date(created + 60 * 60_000).toISOString() },
  }];
  assertEquals(groupLanes(rerun, new Map(), () => null, created + 61 * 60_000).queued.length, 1);
  // An old queued run WITH jobs is never hidden.
  const job = { ...fixture<GhJobList>("denext-ci-jobs.json").jobs[0], status: "queued" };
  const withJobs = groupLanes(runs, new Map([[base.id, [job]]]), () => null, created + 99 * 60_000);
  assertEquals(withJobs.queued[0].runs[0].jobs.length, 1);
  assertFalse(isGhostRun(at(base.created_at), created + GHOST_RUN_MS));
});

// ---- health variable ----

Deno.test("health: a good variable parses; pools by label, alerts newest first, ms times", () => {
  const raw = fixture<{ value: string }>("health-variable.json").value;
  const h = parsePoolHealth(raw, NOW);
  assertEquals(h.state, "ok");
  if (h.state !== "ok") return;
  assertEquals(h.doc.pools["denext-windows-x64"].ok, false);
  assertEquals(
    h.doc.pools["denext-windows-x64"].reason,
    "the Windows guest on macbook unreachable",
  );
  assertEquals(h.doc.pools["denext-macos-x64"].paused, true);
  assertEquals(h.doc.alerts[0].pool, "win-x64");
  assertEquals(h.doc.checkedAt, 1794418000 * 1000);
});

Deno.test("health: missing, garbage, wrong schema, stale", () => {
  assertEquals(parsePoolHealth(null, NOW).state, "unavailable");
  assertEquals(parsePoolHealth("not json {", NOW).state, "invalid");
  assertEquals(parsePoolHealth("[1,2]", NOW).state, "invalid");
  assertEquals(parsePoolHealth('{"v":2,"checked_at":1}', NOW).state, "invalid");
  assertEquals(parsePoolHealth('{"v":1}', NOW).state, "invalid");
  assertEquals(parsePoolHealth("", NOW).state, "invalid");
  const old = Math.floor((NOW - HEALTH_STALE_MS - 60_000) / 1000);
  assertEquals(parsePoolHealth(`{"v":1,"checked_at":${old},"pools":{}}`, NOW).state, "stale");
  // Junk entries are skipped, not fatal.
  const h = parsePoolHealth(
    `{"v":1,"checked_at":${
      NOW / 1000
    },"pools":{"a":{"ok":"yes"},"b":null,"c":{"ok":true}},"alerts":[null,{"at":"x"},{"at":1,"msg":"m"}]}`,
    NOW,
  );
  assertEquals(h.state, "ok");
  if (h.state === "ok") {
    assertEquals(Object.keys(h.doc.pools), ["c"]);
    assertEquals(h.doc.alerts.length, 1);
    assertEquals(h.doc.alerts[0].pool, "fleet");
  }
});

// ---- GitHub client ----

Deno.test("client: ETag caching answers 304 from the cache, and reads the rate limit", async () => {
  const { fetch, seen } = fakeFetch({ "/x": { body: { a: 1 } } });
  const c = createGitHubClient({ token: "test-token-not-real-0000", fetch, now: () => NOW });
  const first = await c.get<{ a: number }>("/x");
  const second = await c.get<{ a: number }>("/x");
  assertEquals(first.cached, false);
  assertEquals(second.cached, true);
  assertEquals(second.body.a, 1);
  assertEquals(seen[1].status, 304);
  assert(seen[1].headers.get("if-none-match"));
  assertEquals(seen[0].headers.get("authorization"), "Bearer test-token-not-real-0000");
  assertEquals(c.rate()?.remaining, 4999);
  assertEquals(c.stats(), { requests: 2, notModified: 1 });
});

Deno.test("client: unauthenticated sends no authorization header", async () => {
  const { fetch, seen } = fakeFetch({ "/x": { body: {} } });
  await createGitHubClient({ token: null, fetch }).get("/x");
  assertFalse(seen[0].headers.has("authorization"));
});

Deno.test("client: 429 and rate-limited 403 back off, without sending requests meanwhile", async () => {
  let t = NOW;
  const routes = {
    "/limited": { status: 429, headers: { "retry-after": "120" } },
    "/primary": {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(NOW / 1000 + 900) },
    },
    "/ok": { body: { fine: true } },
  };
  const { fetch, seen } = fakeFetch(routes);
  const c = createGitHubClient({ token: "x".repeat(40), fetch, now: () => t });
  await assertRejects(() => c.get("/limited"), GitHubError, "429");
  assertEquals(c.backoffUntil(), NOW + 120_000);
  const before = seen.length;
  await assertRejects(() => c.get("/ok"), GitHubError, "backing off");
  assertEquals(seen.length, before, "no request while backing off");
  t = NOW + 121_000;
  assertEquals((await c.get<{ fine: boolean }>("/ok")).body.fine, true);
  assertEquals(c.backoffUntil(), null);
  // The primary limit: until the reset time.
  await assertRejects(() => c.get("/primary"), GitHubError, "403");
  assertEquals(c.backoffUntil(), NOW + 900_000);
});

Deno.test("client: exponential back-off without a hint; 401, 404 and permission 403 are not back-off", async () => {
  let t = NOW;
  const { fetch } = fakeFetch({
    "/secondary": { status: 429 },
    "/auth": { status: 401 },
    "/perm": { status: 403 },
  });
  const c = createGitHubClient({ token: "x".repeat(40), fetch, now: () => t });
  await assertRejects(() => c.get("/secondary"));
  assertEquals(c.backoffUntil(), NOW + 60_000);
  t += 61_000;
  await assertRejects(() => c.get("/secondary"));
  assertEquals(c.backoffUntil(), t + 120_000);
  t += 121_000;
  const e401 = await assertRejects(() => c.get("/auth"), GitHubError);
  assertEquals(e401.kind, "auth");
  const e404 = await assertRejects(() => c.get("/missing"), GitHubError);
  assertEquals(e404.kind, "not-found");
  const e403 = await assertRejects(() => c.get("/perm"), GitHubError);
  assertEquals(e403.kind, "http");
  assertEquals(c.backoffUntil(), null);
});

Deno.test("client: refuses non-API URLs and never puts the token in an error", async () => {
  const token = "ghp_" + "a".repeat(36);
  const c = createGitHubClient({
    token,
    fetch: () => Promise.reject(new TypeError(`connect failed ${token}`)),
  });
  const e = await assertRejects(() => c.get("/x"), GitHubError);
  assertFalse(e.message.includes(token));
  await assertRejects(() => c.get("https://example.com/x"), GitHubError, "non-API");
  assertEquals(
    nextLink(
      '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
    ),
    "https://api.github.com/x?page=2",
  );
  assertEquals(nextLink(null), null);
});

// ---- poller ----

Deno.test("poller: one round builds the snapshot from the fixtures", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const client = createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW });
  const p = new Poller({ client, auth: "gh", now: () => NOW });
  const r = await p.poll();
  assertEquals(r, { ok: true, authFailed: false });
  const s = p.snapshot();
  assertEquals(s.summary.running, 2);
  assertEquals(s.summary.queued, 3);
  // win-x64 is unhealthy in the health fixture: the tray goes red.
  assertEquals(s.summary.severity, "alert");
  assert(s.summary.reasons.some((x) => x.startsWith("win-x64 unhealthy")));
  const win = s.pools.find((x) => x.id === "win-x64")!;
  assertEquals([win.state, win.busy, win.slots], ["unhealthy", 1, 1]);
  assertEquals(s.pools.find((x) => x.id === "mac-x64")!.state, "paused");
  const linux = s.pools.find((x) => x.id === "linux-x64")!;
  assertEquals([linux.queued, linux.slots], [3, 3]);
  assertEquals(linux.oldestQueuedSince, Date.parse("2026-11-11T16:42:54Z"));
  assertEquals(s.pools.at(-1)!.id, "github");
  assertEquals(s.alerts.length, 2);
  // Finished in the last 30 min: completed at or after 17:00.
  assertEquals(
    s.finished.map((f) => f.name).sort(),
    ["bundle-budget", "check", "integration", "windows-resolve", "windows-runner"],
  );
  assertEquals(s.health.state, "ok");
  assertEquals(s.rate?.limit, 5000);
});

Deno.test("poller: the second round is all 304s, and a finished run gets one last jobs read", async () => {
  const routes = standardRoutes();
  const { fetch, seen } = fakeFetch(routes);
  let t = NOW;
  const client = createGitHubClient({ token: "x".repeat(40), fetch, now: () => t });
  const p = new Poller({ client, auth: "gh", now: () => t });
  await p.poll();
  const n = seen.length;
  t += 15_000;
  await p.poll();
  const second = seen.slice(n);
  assert(second.length > 0);
  assert(
    second.every((s) => s.status === 304 || s.status === 404),
    "unchanged lists come from the cache",
  );
  // The org repo list is not re-read within 10 minutes.
  assertFalse(second.some((s) => s.url.startsWith("/orgs/Brainwires/repos")));
  // The CI run finishes: it leaves the in_progress list, its jobs are read once more.
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs.map((j) =>
    j.status === "completed" ? j : {
      ...j,
      status: "completed",
      conclusion: "success",
      started_at: j.started_at ?? "2026-11-11T17:31:00Z",
      completed_at: "2026-11-11T17:40:00Z",
      runner_name: j.runner_name ?? "denext-linux-x64-1-9",
    }
  );
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: { total_count: 0, workflow_runs: [] },
  };
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`] = {
    body: { total_count: jobs.length, jobs },
  };
  t = Date.parse("2026-11-11T17:41:00Z");
  await p.poll();
  const s = p.snapshot();
  assertEquals(s.summary.running, 0);
  assert(s.finished.some((f) => f.name === "coverage" && f.conclusion === "success"));
  // check (≈37 min) was recorded once even though it was seen in three rounds.
  assertEquals(p.durations()[["Brainwires/denext", "CI", "check"].join("\u0000")]?.length, 1);
});

Deno.test("poller: a missing health variable and refused runners endpoint degrade gracefully", async () => {
  const routes = standardRoutes();
  delete routes["/orgs/Brainwires/actions/variables/DENEXT_POOL_HEALTH"];
  routes["/orgs/Brainwires/actions/runners?per_page=100"] = { status: 403 };
  const { fetch, seen } = fakeFetch(routes);
  let t = NOW;
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => t }),
    auth: "stored",
    now: () => t,
  });
  assertEquals((await p.poll()).ok, true);
  const s = p.snapshot();
  assertEquals(s.health.state, "unavailable");
  assertEquals(s.health.message, "pool health unavailable");
  assert(s.pools.filter((x) => x.id !== "github").every((x) => x.state === "unknown"));
  // Busy falls back to our running jobs.
  assertEquals(s.pools.find((x) => x.id === "win-x64")!.busy, 1);
  // The refused runners endpoint isn't asked again next round.
  t += 15_000;
  const n = seen.filter((x) => x.url.includes("/runners")).length;
  await p.poll();
  assertEquals(seen.filter((x) => x.url.includes("/runners")).length, n);
});

Deno.test("poller: a 401 is an auth failure; network errors keep the last data", async () => {
  const routes = standardRoutes();
  let fail: "none" | "401" | "net" = "none";
  const { fetch: inner } = fakeFetch(routes);
  const fetch = ((url: string, init?: RequestInit) => {
    if (fail === "401") return Promise.resolve(new Response("{}", { status: 401 }));
    if (fail === "net") return Promise.reject(new TypeError("offline"));
    return inner(url, init);
  }) as typeof globalThis.fetch;
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  fail = "net";
  assertEquals(await p.poll(), { ok: false, authFailed: false });
  const s = p.snapshot();
  assertEquals(s.summary.running, 2, "last good data kept");
  assertFalse(s.poll.ok);
  assertEquals(s.poll.message, "network: TypeError");
  fail = "401";
  assertEquals(await p.poll(), { ok: false, authFailed: true });
});

// ---- notifications ----

Deno.test("notifications: pool unhealthy, queued over 15 min, default-branch failure — once each", async () => {
  const routes = standardRoutes();
  // The run is on a default branch, and one job fails after Fleet started.
  const runs = fixture<GhRunList>("denext-runs-in_progress.json");
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: { ...runs, workflow_runs: [{ ...runs.workflow_runs[0], head_branch: "development" }] },
  };
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs.map((j) =>
    j.name === "check" ? { ...j, conclusion: "failure" } : j
  );
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`] = {
    body: { total_count: jobs.length, jobs },
  };
  const { fetch } = fakeFetch(routes);
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  const seen = new Map<string, number>();
  const startedAt = NOW - 5 * 60_000;
  const first = pendingNotifications(p.snapshot(), seen, startedAt);
  const titles = first.map((n) => n.title);
  assert(titles.includes("Pool win-x64 is unhealthy"));
  // linux-x64 has every slot busy in the fixture: its long waits are capacity waits, no notice.
  assertEquals(titles.filter((t) => t === "Job queued over 15 min").length, 0);
  assert(titles.includes("denext development: job failed"));
  // macos-tests failed at 16:49, before Fleet started: no notice.
  assertFalse(first.some((n) => n.body.includes("macos-tests")));
  // Nothing new on the next poll.
  assertEquals(pendingNotifications(p.snapshot(), seen, startedAt), []);
  // Keys survive a relaunch (the caller persists them).
  const again = new Map(Object.entries(Object.fromEntries(seen)));
  assertEquals(pendingNotifications(p.snapshot(), again, startedAt), []);
});

Deno.test("notifications: many late jobs at once become one notice; stale health posts nothing", () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({
    id: i + 1,
    name: `j${i}`,
    url: null,
    lane: "queued" as const,
    target: "pool" as const,
    pool: "mac-arm",
    runner: null,
    since: NOW - 20 * 60_000,
    usualMs: null,
  }));
  const snap: Snapshot = {
    ...emptySnap(),
    health: { state: "stale", checkedAt: NOW - 3600_000, message: "" },
    pools: [{
      id: "win-x64",
      title: "win-x64",
      label: "denext-windows-x64",
      slots: 1,
      busy: 0,
      running: 0,
      queued: 0,
      state: "unhealthy",
      reason: "x",
      since: 1,
      oldestQueuedSince: null,
    }],
    queued: [{ repo: "Brainwires/denext", runs: [{ ...runGroup(), jobs: rows }] }],
  };
  const seen = new Map<string, number>();
  const out = pendingNotifications(snap, seen, NOW);
  assertEquals(out.map((n) => n.title), ["6 jobs queued over 15 min"]);
  assertEquals(pendingNotifications(snap, seen, NOW), []);
});

function emptySnap(): Snapshot {
  return {
    at: NOW,
    auth: "gh",
    poll: {
      ok: true,
      message: "",
      lastSuccessAt: NOW,
      intervalMs: 15_000,
      backoffUntil: null,
      slow: null,
    },
    rate: null,
    health: { state: "ok", checkedAt: NOW, message: "" },
    pools: [],
    running: [],
    queued: [],
    finished: [],
    alerts: [],
    summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
    repos: [],
    eventSeq: 0,
    notificationsPaused: false,
    hooks: { state: "off", lastDeliveryAt: null },
  };
}

function runGroup() {
  return {
    id: 1,
    repo: "Brainwires/denext",
    workflow: "CI",
    title: "",
    branch: "x",
    sha: "abcdef0",
    event: "push",
    url: "https://github.com/Brainwires/denext/actions/runs/1",
    defaultBranch: false,
    pendingJobs: false,
  };
}

Deno.test("png: a valid PNG signature and IHDR", async () => {
  const png = await encodePng(2, 2, new Uint8Array(16).fill(255));
  assertEquals([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assertEquals(new DataView(png.buffer).getUint32(16), 2);
});

Deno.test("format: durations and ages", () => {
  assertEquals(formatDuration(42_000), "42s");
  assertEquals(formatDuration(7 * 60_000 + 5000), "7m 05s");
  assertEquals(formatDuration(64 * 60_000), "1h 04m");
  assertEquals(formatDuration(-5), "0s");
  assertEquals(formatAgo(NOW - 3000, NOW), "just now");
  assertEquals(formatAgo(NOW - 3 * 60_000, NOW), "3m ago");
});

// ---- service: token handling, scheduling ----

interface FakeTimers {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  pending: () => { fn: () => void; ms: number }[];
}

function fakeTimers(): FakeTimers {
  let id = 0;
  const timers = new Map<number, { fn: () => void; ms: number }>();
  return {
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (k) => void timers.delete(k),
    pending: () => [...timers.values()],
  };
}

function memoryStore() {
  const m = new Map<string, string>();
  return {
    map: m,
    get: (k: string) => Promise.resolve(m.get(k) ?? null),
    set: (k: string, v: string) => Promise.resolve(void m.set(k, v)),
    delete: (k: string) => Promise.resolve(void m.delete(k)),
  };
}

Deno.test("service: gh's token first; polls at 15 s visible and 60 s hidden; notifies once", async () => {
  const { fetch, seen } = fakeFetch(standardRoutes());
  const timers = fakeTimers();
  const posted: string[] = [];
  const saved: unknown[] = [];
  let t = NOW;
  const svc = createFleetService({
    ghToken: () => Promise.resolve("gho_" + "b".repeat(36)),
    secrets: memoryStore(),
    fetch,
    now: () => t,
    notify: (n) => void posted.push(n.key),
    load: () => Promise.resolve(null),
    save: (s) => Promise.resolve(void saved.push(s)),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  const snaps: Snapshot[] = [];
  svc.onChange((s) => snaps.push(s));
  await svc.start();
  assertEquals(svc.snapshot().auth, "gh");
  assert(seen.length > 0);
  assert(seen.every((s) => s.headers.get("authorization")?.startsWith("Bearer gho_")));
  assert(posted.includes("pool:denext-windows-x64:1794417000000"));
  // Hidden: the next poll is 60 s out.
  assertEquals(timers.pending().at(-1)?.ms, 60_000);
  t += 20_000;
  svc.visibility(true); // 20 s since the last poll: poll now
  await svc.refresh();
  assertEquals(timers.pending().at(-1)?.ms, 15_000);
  // The persisted state and the snapshots never hold the token.
  const all = JSON.stringify([saved, snaps, svc.snapshot()]);
  assertFalse(all.includes("gho_"));
  const before = posted.length;
  await svc.refresh();
  assertEquals(posted.length, before, "no duplicate notifications");
  svc.stop();
});

Deno.test("service: no gh → first-run; a pasted token is checked, stored and used; a bad one is refused", async () => {
  const routes = { ...standardRoutes(), "/rate_limit": { body: { resources: {} } } };
  const good = "github_pat_" + "c".repeat(40);
  const { fetch: inner, seen } = fakeFetch(routes);
  const fetch = ((url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization");
    if (auth && auth !== `Bearer ${good}`) {
      return Promise.resolve(new Response("{}", { status: 401 }));
    }
    return inner(url, init);
  }) as typeof globalThis.fetch;
  const store = memoryStore();
  const timers = fakeTimers();
  const svc = createFleetService({
    ghToken: () => Promise.resolve(null),
    secrets: store,
    fetch,
    now: () => NOW,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await svc.start();
  assertEquals(svc.snapshot().auth, "needs-token");
  assertEquals(seen.length, 0, "nothing polled without a token");
  assertEquals(await svc.setToken("not a token"), {
    ok: false,
    message: "That doesn't look like a GitHub token.",
  });
  assertEquals(await svc.setToken("github_pat_" + "d".repeat(40)), {
    ok: false,
    message: "GitHub refused that token.",
  });
  assertEquals(store.map.size, 0);
  assertEquals(await svc.setToken(`  ${good}\n`), { ok: true });
  assertEquals(store.map.get(TOKEN_KEY), good);
  assertEquals(svc.snapshot().auth, "stored");
  await svc.refresh();
  assertEquals(svc.snapshot().summary.running, 2);
  await svc.clearToken();
  assertEquals(svc.snapshot().auth, "needs-token");
  assertEquals(store.map.size, 0);
  svc.stop();
});

Deno.test("service: a stored token GitHub refuses turns into the 'invalid' screen", async () => {
  const store = memoryStore();
  await store.set(TOKEN_KEY, "github_pat_" + "e".repeat(40));
  const timers = fakeTimers();
  const svc = createFleetService({
    ghToken: () => Promise.resolve(null),
    secrets: store,
    fetch: (() => Promise.resolve(new Response("{}", { status: 401 }))) as typeof fetch,
    now: () => NOW,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await svc.start();
  assertEquals(svc.snapshot().auth, "invalid");
  svc.stop();
});

Deno.test("service: public mode polls only the core repos, unauthenticated", async () => {
  const { fetch, seen } = fakeFetch(standardRoutes());
  const timers = fakeTimers();
  const svc = createFleetService({
    ghToken: () => Promise.resolve(null),
    secrets: memoryStore(),
    fetch,
    now: () => NOW,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
  });
  await svc.start();
  await svc.usePublic();
  assertEquals(svc.snapshot().auth, "public");
  assert(seen.length > 0);
  assert(seen.every((s) => !s.headers.has("authorization")));
  assertFalse(seen.some((s) => s.url.startsWith("/orgs/")));
  assertEquals(svc.snapshot().summary.running, 2);
  svc.stop();
});

Deno.test("cleanToken: trims and rejects junk", () => {
  assertEquals(cleanToken("  ghp_" + "a".repeat(36) + "\n"), "ghp_" + "a".repeat(36));
  assertEquals(cleanToken("short"), null);
  assertEquals(cleanToken("ghp_ with spaces " + "a".repeat(30)), null);
  assertEquals(cleanToken(42), null);
});

// ---- capacity waits: a long queue on a full pool is not a fault ----

const card = (over: Partial<PoolCard>): PoolCard => ({
  id: "mac-x64",
  title: "mac-x64",
  label: "denext-macos-x64",
  slots: 1,
  busy: 1,
  running: 1,
  queued: 1,
  state: "ok",
  reason: "",
  since: null,
  oldestQueuedSince: NOW - 48 * 60_000,
  ...over,
});

function capacityCase(pool: PoolCard) {
  const row = {
    id: 9,
    name: "cli / x86_64-apple-darwin",
    url: null,
    lane: "queued" as const,
    target: "pool" as const,
    pool: "mac-x64",
    runner: null,
    since: NOW - 48 * 60_000,
    usualMs: null,
  };
  const groups = markCapacityWaits(
    [{ repo: "Brainwires/denext", runs: [{ ...runGroup(), jobs: [row] }] }],
    [pool],
  );
  const rows = groups.flatMap((g) => g.runs.flatMap((r) => r.jobs));
  const summary = summarize([], rows, [pool], NOW, { pollOk: true, healthStale: false });
  return { rows, summary, snap: { ...emptySnap(), pools: [pool], queued: groups } };
}

Deno.test("capacity wait: a long queue on a full pool is a capacity wait, not a fault", () => {
  const { rows, summary, snap } = capacityCase(card({}));
  assert(poolIsFull(card({})));
  assertEquals(jobWarning(rows[0], NOW), "queued-capacity");
  assertEquals(summary.severity, "ok");
  assertEquals(summary.reasons, ["1 waiting for capacity"]);
  // No "queued over 15 min" notification for it.
  assertEquals(pendingNotifications(snap, new Map(), NOW), []);
});

Deno.test("capacity wait: a free slot is still a fault", () => {
  const { rows, summary, snap } = capacityCase(card({ busy: 0 }));
  assertFalse(poolIsFull(card({ busy: 0 })));
  assertEquals(jobWarning(rows[0], NOW), "queued-long");
  assertEquals(summary.severity, "alert");
  assertEquals(summary.reasons, ["1 job queued over 15 min"]);
  assertEquals(pendingNotifications(snap, new Map(), NOW).map((n) => n.title), [
    "Job queued over 15 min",
  ]);
});

Deno.test("capacity wait: a paused, unhealthy or unknown pool is still a fault", () => {
  for (const state of ["paused", "unhealthy", "unknown"] as const) {
    const { rows, summary } = capacityCase(card({ state }));
    assertEquals(jobWarning(rows[0], NOW), "queued-long", state);
    assertEquals(summary.severity, "alert", state);
  }
});

// ---- capacity waits on pools that share one machine ----

function sharedHostCase(busyA: number, busyB: number) {
  const prev = currentPools();
  const mk = (id: string, host?: string) => ({
    id,
    label: `l-${id}`,
    runnerPrefix: `${id}-`,
    slots: 3,
    ...(host ? { host } : {}),
  });
  setPools([mk("linux-x64", "biscuits"), mk("linux-arm", "biscuits"), mk("mac")]);
  try {
    const cards = poolCards([], [], { state: "unavailable", message: "" } as never, null);
    const a = cards.find((c) => c.id === "linux-x64")!;
    const b = cards.find((c) => c.id === "linux-arm")!;
    return {
      a: { ...a, state: "ok" as const, busy: busyA, queued: 1 },
      b: { ...b, state: "ok" as const, busy: busyB },
      mac: { ...cards.find((c) => c.id === "mac")!, state: "ok" as const, busy: 1 },
    };
  } finally {
    setPools(prev);
  }
}

Deno.test("shared host: pools on one machine report host load", () => {
  const { a, mac } = sharedHostCase(0, 0);
  assertEquals([a.host, a.hostSlots], ["biscuits", 3]);
  assertEquals(mac.host, undefined);
});

Deno.test("shared host: host full is a capacity wait even when the pool reads 2/3", () => {
  const { a, b } = sharedHostCase(2, 1);
  const full = { ...a, hostBusy: 3, hostSlots: 3 };
  assert(poolIsFull(full));
  assertFalse(poolIsFull({ ...b, busy: 0, hostBusy: 2, hostSlots: 3 }));
});

Deno.test("shared host: a free slot on the host is still a fault; no host unchanged", () => {
  const { a } = sharedHostCase(2, 0);
  assertFalse(poolIsFull({ ...a, hostBusy: 2, hostSlots: 3 }));
  assertFalse(poolIsFull(card({ slots: 3, busy: 2 })));
  assert(poolIsFull(card({ slots: 3, busy: 3 })));
});
