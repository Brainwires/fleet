// The agents' side: the snapshot and journal the backend writes, and the read-only MCP server's
// tools over them (filters, cursor paging, fleet_wait's triggers and timeout, the stale flag), plus
// the server's least privilege: it runs with only --allow-read of its three paths, and its source
// reaches for no network, environment or subprocess API.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import type { AgentJob, AgentRun, AgentSnapshot } from "../lib/agent-snapshot.ts";
import { AGENT_SNAPSHOT_FILE, JOURNAL_FILE, JOURNAL_OLD_FILE } from "../lib/agent-files.ts";
import { appendJournal, journalLastSeq } from "../lib/deno-host.ts";
import type { FleetEvent } from "../lib/events.ts";
import type { GhJobList, GhRunList } from "../lib/github-types.ts";
import { createFleetService } from "../lib/service.ts";
import { createFleetMcp, FleetFiles, TOOLS } from "../mcp/fleet-mcp.ts";
import {
  eventsResult,
  freshness,
  jobsResult,
  runsResult,
  statusResult,
  waitArgs,
  waitTrigger,
} from "../mcp/queries.ts";
import { ciRunId, fakeFetch, fixture, NOW, standardRoutes } from "./helpers.ts";

const ISO = (ms: number) => new Date(ms).toISOString();

// ---- fixtures ----

const run = (id: number, over: Partial<AgentRun> = {}): AgentRun => ({
  repo: "Brainwires/denext",
  run_id: id,
  workflow: "CI",
  title: "a commit",
  branch: "development",
  sha: "abcdef1234567890",
  event: "push",
  status: "in_progress",
  conclusion: null,
  attempt: 1,
  created_at: ISO(NOW - 10 * 60_000),
  started_at: ISO(NOW - 9 * 60_000),
  completed_at: null,
  html_url: `https://github.com/Brainwires/denext/actions/runs/${id}`,
  ...over,
});

const job = (id: number, runId: number, over: Partial<AgentJob> = {}): AgentJob => ({
  repo: "Brainwires/denext",
  run_id: runId,
  job_id: id,
  name: `job-${id}`,
  workflow: "CI",
  branch: "development",
  sha: "abcdef1234567890",
  status: "in_progress",
  conclusion: null,
  created_at: ISO(NOW - 9 * 60_000),
  started_at: ISO(NOW - 8 * 60_000),
  completed_at: null,
  html_url: `https://github.com/Brainwires/denext/actions/runs/${runId}/job/${id}`,
  labels: ["self-hosted", "denext-linux-x64"],
  runner_name: "denext-linux-x64-1-1",
  pool: "linux-x64",
  steps: [{ name: "Set up job", status: "completed", conclusion: "success" }],
  failed_step: null,
  failure_annotation: null,
  ...over,
});

function snap(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    v: 1,
    updated_at: ISO(NOW - 10_000),
    written_at: ISO(NOW - 10_000),
    source: "poll",
    auth: "gh",
    poll: {
      ok: true,
      message: "",
      last_success_at: ISO(NOW - 10_000),
      interval_ms: 60_000,
      slow: null,
    },
    rate: { remaining: 4321, limit: 5000, reset: ISO(NOW + 30 * 60_000) },
    hooks: { state: "off", last_delivery_at: null },
    health: { state: "ok", checked_at: ISO(NOW - 60_000), message: "" },
    summary: { running: 2, queued: 1, severity: "ok", reasons: [] },
    pools: [
      {
        id: "linux-x64",
        label: "denext-linux-x64",
        state: "ok",
        reason: "",
        slots: 3,
        busy: 2,
        running: 2,
        queued: 1,
        state_since: null,
        oldest_queued_since: ISO(NOW - 4 * 60_000),
      },
      {
        id: "github",
        label: null,
        state: "ok",
        reason: "",
        slots: null,
        busy: 0,
        running: 0,
        queued: 0,
        state_since: null,
        oldest_queued_since: null,
      },
    ],
    hosts: [{
      id: "linux-x64",
      label: "denext-linux-x64",
      ok: true,
      paused: false,
      reason: "",
      slots: 3,
      busy: 2,
      since: null,
    }],
    alerts: [],
    event_seq: 3,
    runs: [
      run(100),
      run(200, {
        repo: "Brainwires/deno",
        branch: "rel/x",
        sha: "fedcba9876543210",
        status: "completed",
        conclusion: "failure",
        completed_at: ISO(NOW - 60_000),
      }),
    ],
    jobs: [
      job(1, 100),
      job(2, 100, { status: "completed", conclusion: "success", completed_at: ISO(NOW - 60_000) }),
      job(3, 100, { status: "queued", runner_name: null, started_at: null }),
      job(4, 200, {
        repo: "Brainwires/deno",
        status: "completed",
        conclusion: "failure",
        failed_step: "Run tests",
        failure_annotation: "Process completed with exit code 1.",
        pool: "github",
        steps: [{ name: "Run tests", status: "completed", conclusion: "failure" }],
      }),
    ],
    ...over,
  };
}

const ev = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  at: NOW - (100 - seq) * 1000,
  sev: "info",
  kind: "started",
  repo: "Brainwires/denext",
  workflow: "CI",
  job: `job-${seq}`,
  text: "started on linux-x64",
  url: null,
  ...over,
});

// ---- the backend's side ----

Deno.test("agent snapshot: written after each poll, no token, runs + jobs with failed_step; journal follows the log", async () => {
  const routes = standardRoutes();
  const { fetch } = fakeFetch(routes);
  let t = NOW;
  const written: AgentSnapshot[] = [];
  const journal: FleetEvent[] = [];
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
    saveAgentSnapshot: (s) => Promise.resolve(void written.push(JSON.parse(JSON.stringify(s)))),
    appendJournal: (e) => Promise.resolve(void journal.push(...e)),
    journalLastSeq: () => Promise.resolve(40),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await svc.start();
  const first = written.at(-1)!;
  assertEquals(first.v, 1);
  assertEquals(first.source, "poll");
  assertEquals(first.updated_at, ISO(NOW));
  assert(first.runs.some((r) => r.run_id === ciRunId() && r.status === "in_progress"));
  assertEquals(first.jobs.filter((j) => j.run_id === ciRunId()).length, 12);
  assert(first.pools.length > 0);
  assertEquals(first.rate?.remaining, 4999);

  // The run finishes with a failure (with steps): it stays, its job has a failed step.
  const RUN = fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs[0];
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs.map((j, i) =>
    i === 0
      ? {
        ...j,
        status: "completed",
        conclusion: "failure",
        completed_at: "2026-11-11T17:40:00Z",
        steps: [
          { name: "Set up job", status: "completed", conclusion: "success" },
          { name: "Run coverage", status: "completed", conclusion: "failure" },
        ],
      }
      : { ...j, status: "completed", conclusion: j.conclusion ?? "success" }
  );
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: { total_count: 0, workflow_runs: [] },
  };
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`] = {
    body: { total_count: jobs.length, jobs },
  };
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}`] = {
    body: {
      ...RUN,
      status: "completed",
      conclusion: "failure",
      updated_at: "2026-11-11T17:41:00Z",
    },
  };
  t += 60_000;
  await svc.refresh();
  const second = written.at(-1)!;
  const r = second.runs.find((x) => x.run_id === ciRunId())!;
  assertEquals([r.status, r.conclusion, r.completed_at], [
    "completed",
    "failure",
    "2026-11-11T17:41:00Z",
  ]);
  const failed = second.jobs.find((j) => j.job_id === jobs[0].id)!;
  assertEquals(failed.failed_step, "Run coverage");
  assertEquals(failed.steps.length, 2);
  assertEquals(failed.pool, "linux-x64-docker");
  // The journal got the new events, numbered after the journal's last seq (40), in order.
  assert(journal.length > 0);
  assertEquals(journal[0].seq, 41);
  assert(journal.every((e, i) => i === 0 || e.seq === journal[i - 1].seq + 1));
  assert(journal.some((e) => e.run_id === ciRunId() && e.kind === "run-completed"));
  assert(journal.some((e) => e.job_id === jobs[0].id && e.kind === "finished"));
  assertEquals(second.event_seq, journal.at(-1)!.seq);

  // Two hours later the finished run is gone from the snapshot.
  t += 2 * 60 * 60_000 + 60_000;
  await svc.refresh();
  assertFalse(written.at(-1)!.runs.some((x) => x.run_id === ciRunId()));
  assertFalse(JSON.stringify(written).includes("gho_"), "never the token");
  svc.stop();
});

Deno.test("journal: append-only JSONL, rotation keeps one old file, last seq survives", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await journalLastSeq(dir), 0);
    await appendJournal(dir, [ev(1), ev(2)]);
    await appendJournal(dir, [ev(3)]);
    const lines = (await Deno.readTextFile(`${dir}/${JOURNAL_FILE}`)).trim().split("\n");
    assertEquals(lines.map((l) => JSON.parse(l).seq), [1, 2, 3]);
    assertEquals(await journalLastSeq(dir), 3);
    // Past the size limit the next append rotates first.
    await appendJournal(dir, [ev(4)], 10);
    assertEquals(
      (await Deno.readTextFile(`${dir}/${JOURNAL_OLD_FILE}`)).trim().split("\n").length,
      3,
    );
    assertEquals(await journalLastSeq(dir), 4);
    // A torn last line is skipped.
    await Deno.writeTextFile(`${dir}/${JOURNAL_FILE}`, '{"seq":', { append: true });
    assertEquals(await journalLastSeq(dir), 4);
    // The reader sees both files in order, once each.
    const files = new FleetFiles({ dataDir: dir, hooksDir: dir, healthFile: `${dir}/none` });
    assertEquals((await files.events()).map((e) => e.seq), [1, 2, 3, 4]);
    await Deno.writeTextFile(`${dir}/${JOURNAL_FILE}`, "}\n" + JSON.stringify(ev(5)) + "\n", {
      append: true,
    });
    assertEquals((await files.events()).map((e) => e.seq), [1, 2, 3, 4, 5]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- the tools ----

Deno.test("freshness: as_of, running, and the stale flag", () => {
  const fresh = freshness(snap(), NOW);
  assertEquals([fresh.as_of, fresh.age_s, fresh.fleet_running, fresh.stale], [
    ISO(NOW - 10_000),
    10,
    true,
    false,
  ]);
  assertEquals(fresh.warning, undefined);
  // Not written for 6 min: Fleet isn't running.
  const old = freshness(
    snap({ updated_at: ISO(NOW - 6 * 60_000), written_at: ISO(NOW - 6 * 60_000) }),
    NOW,
  );
  assert(old.stale);
  assertFalse(old.fleet_running);
  assertStringIncludes(old.warning!, "STALE");
  assertStringIncludes(old.warning!, "not be running");
  // Data 6 min old but written now: stale with polling only, fine with live webhooks.
  const quiet = { updated_at: ISO(NOW - 6 * 60_000), written_at: ISO(NOW - 5_000) };
  assert(freshness(snap(quiet), NOW).stale);
  assertFalse(
    freshness(snap({ ...quiet, hooks: { state: "live", last_delivery_at: null } }), NOW).stale,
  );
  // No snapshot at all.
  const none = freshness(null, NOW);
  assert(none.stale);
  assertEquals(none.as_of, null);
  // A failing poll is said.
  assertStringIncludes(
    freshness(snap({ poll: { ...snap().poll, ok: false, message: "rate limited" } }), NOW).warning!,
    "rate limited",
  );
});

Deno.test("fleet_status: pools, hosts, queue and oldest wait, rate, watchdog", () => {
  const s = statusResult(snap(), NOW, {
    watchdog: {
      checked_at_epoch: (NOW - 30_000) / 1000,
      pools: { "linux-x64": { healthy: false, reason: "disk" } },
    },
    hooksSpoolAt: NOW - 5_000,
  }) as Any;
  assertEquals(s.queue, {
    running: 2,
    queued: 1,
    oldest_wait_s: 240,
    oldest_wait_pool: "linux-x64",
  });
  assertEquals(s.rate.remaining, 4321);
  assertEquals(s.pools[0].oldest_wait_s, 240);
  assertEquals(s.hosts[0].id, "linux-x64");
  assertEquals(s.watchdog.pools["linux-x64"], { healthy: false, reason: "disk" });
  assertEquals(s.watchdog.age_s, 30);
  assertEquals(s.hooks_spool.age_s, 5);
  assertEquals(s.fleet_running, true);
});

Deno.test("fleet_runs: filters by repo, branch, sha prefix, status; counts and failed jobs", () => {
  const all = runsResult(snap(), NOW, {});
  assertEquals(all.total, 2);
  const deno = runsResult(snap(), NOW, { repo: "deno" });
  assertEquals(deno.runs.map((r) => r.run_id), [200]);
  assertEquals(deno.runs[0].jobs.failed, [{ job_id: 4, name: "job-4", failed_step: "Run tests" }]);
  assertEquals(runsResult(snap(), NOW, { repo: "Brainwires/denext" }).runs.map((r) => r.run_id), [
    100,
  ]);
  assertEquals(runsResult(snap(), NOW, { branch: "rel/x" }).total, 1);
  assertEquals(runsResult(snap(), NOW, { sha: "ABCDEF1" }).runs.map((r) => r.run_id), [100]);
  assertEquals(runsResult(snap(), NOW, { status: "active" }).runs.map((r) => r.run_id), [100]);
  assertEquals(runsResult(snap(), NOW, { status: "completed" }).runs.map((r) => r.run_id), [200]);
  const counts = runsResult(snap(), NOW, { repo: "denext" }).runs[0].jobs;
  assertEquals([counts.total, counts.queued, counts.in_progress, counts.completed], [3, 1, 1, 1]);
  const lim = runsResult(snap(), NOW, { limit: 1 });
  assertEquals([lim.runs.length, lim.truncated], [1, true]);
  let threw = false;
  try {
    runsResult(snap(), NOW, { limit: 0 });
  } catch {
    threw = true;
  }
  assert(threw, "a bad limit is an argument error");
});

Deno.test("fleet_jobs: filters; steps only for failures or one run", () => {
  const all = jobsResult(snap(), NOW, {});
  assertEquals(all.total, 4);
  assertFalse("steps" in all.jobs[0], "no steps for a passing job across runs");
  assert("steps" in all.jobs.find((j) => j.job_id === 4)!, "a failure keeps its steps");
  const one = jobsResult(snap(), NOW, { run_id: 100 });
  assertEquals(one.jobs.map((j) => j.job_id), [1, 2, 3]);
  assert(one.jobs.every((j) => "steps" in j));
  assertEquals(jobsResult(snap(), NOW, { conclusion: "failed" }).jobs.map((j) => j.job_id), [4]);
  assertEquals(jobsResult(snap(), NOW, { pool: "github" }).jobs.map((j) => j.job_id), [4]);
  assertEquals(jobsResult(snap(), NOW, { status: "queued" }).jobs.map((j) => j.job_id), [3]);
  assertEquals(jobsResult(snap(), NOW, { repo: "deno", status: "active" }).total, 0);
});

Deno.test("fleet_events: cursor paging, filters, the newest page without a cursor, gaps", () => {
  const events = [
    ev(5),
    ev(6, { kind: "finished", sev: "bad" }),
    ev(7, { repo: "Brainwires/deno" }),
    ev(8),
    ev(9, { kind: "finished" }),
  ];
  const tail = eventsResult(snap({ event_seq: 9 }), events, NOW, { limit: 2 });
  assertEquals(tail.events.map((e) => e.seq), [8, 9]);
  assertEquals(tail.next_seq, 9);
  assertEquals(tail.events[0].at, ISO(events[3].at));
  // Page forward two at a time.
  const p1 = eventsResult(snap(), events, NOW, { since_seq: 5, limit: 2 });
  assertEquals([p1.events.map((e) => e.seq), p1.next_seq, p1.has_more], [[6, 7], 7, true]);
  const p2 = eventsResult(snap(), events, NOW, { since_seq: p1.next_seq, limit: 2 });
  assertEquals([p2.events.map((e) => e.seq), p2.next_seq, p2.has_more], [[8, 9], 9, false]);
  const p3 = eventsResult(snap(), events, NOW, { since_seq: p2.next_seq });
  assertEquals([p3.events.length, p3.next_seq], [0, 9]);
  // Filters; the cursor still moves past what didn't match.
  const fin = eventsResult(snap(), events, NOW, { since_seq: 5, kinds: ["finished"] });
  assertEquals([fin.events.map((e) => e.seq), fin.next_seq], [[6, 9], 9]);
  assertEquals(
    eventsResult(snap(), events, NOW, { since_seq: 0, repo: "deno" }).events.map((e) => e.seq),
    [7],
  );
  // Asking from before what's kept says so.
  assertStringIncludes(eventsResult(snap(), events, NOW, { since_seq: 1 }).gap!, "2..4");
});

Deno.test("fleet_wait: triggers for any_failure, completed and first_event; argument checks", () => {
  const w = (a: Record<string, unknown>) => waitArgs(a);
  // Run 200 already failed: any_failure is satisfied at once.
  assertEquals(waitTrigger(snap(), [], w({ run_ids: [200], until: "any_failure" })), "failure");
  // Run 100 is still going.
  assertEquals(waitTrigger(snap(), [], w({ run_ids: [100], until: "any_failure" })), null);
  assertEquals(waitTrigger(snap(), [], w({ run_ids: [100], until: "completed" })), null);
  // One of its jobs fails.
  const failing = snap({
    jobs: snap().jobs.map((j) =>
      j.job_id === 1 ? { ...j, status: "completed", conclusion: "timed_out" } : j
    ),
  });
  assertEquals(waitTrigger(failing, [], w({ run_ids: [100], until: "any_failure" })), "failure");
  assertEquals(waitTrigger(failing, [], w({ job_ids: [1], until: "completed" })), "completed");
  // Everything passes: any_failure ends as completed.
  const passed = snap({
    runs: snap().runs.map((r) =>
      r.run_id === 100 ? { ...r, status: "completed", conclusion: "success" } : r
    ),
    jobs: snap().jobs.map((j) =>
      j.run_id === 100 ? { ...j, status: "completed", conclusion: "success" } : j
    ),
  });
  assertEquals(waitTrigger(passed, [], w({ run_ids: [100], until: "any_failure" })), "completed");
  // A run not in the snapshot never completes.
  assertEquals(waitTrigger(passed, [], w({ run_ids: [999], until: "completed" })), null);
  // first_event: about a target (by id, or parsed from the link), or any without targets.
  const e = ev(10, { run_id: 100, job_id: 3 });
  assertEquals(waitTrigger(snap(), [e], w({ run_ids: [100], until: "first_event" })), "event");
  assertEquals(waitTrigger(snap(), [e], w({ run_ids: [200], until: "first_event" })), null);
  const linked = ev(11, { url: "https://github.com/Brainwires/denext/actions/runs/200/job/4" });
  assertEquals(waitTrigger(snap(), [linked], w({ job_ids: [4], until: "first_event" })), "event");
  assertEquals(waitTrigger(snap(), [linked], w({ until: "first_event" })), "event");
  assertEquals(waitTrigger(snap(), [], w({ until: "first_event" })), null);
  // Argument errors.
  for (
    const bad of [{ until: "soon" }, { until: "completed" }, {
      until: "first_event",
      timeout_s: 1801,
    }, { until: "first_event", run_ids: ["x"] }]
  ) {
    let threw = false;
    try {
      waitArgs(bad);
    } catch {
      threw = true;
    }
    assert(threw, JSON.stringify(bad));
  }
  assertEquals(w({ until: "first_event" }).timeoutS, 600);
});

// ---- the server over real files ----

async function tempFleet() {
  const root = await Deno.makeTempDir();
  const paths = {
    dataDir: `${root}/data`,
    hooksDir: `${root}/hooks`,
    healthFile: `${root}/health.json`,
  };
  await Deno.mkdir(paths.dataDir);
  await Deno.mkdir(paths.hooksDir);
  return { root, paths };
}

async function writeSnap(dir: string, s: AgentSnapshot) {
  await Deno.writeTextFile(`${dir}/${AGENT_SNAPSHOT_FILE}.tmp`, JSON.stringify(s));
  await Deno.rename(`${dir}/${AGENT_SNAPSHOT_FILE}.tmp`, `${dir}/${AGENT_SNAPSHOT_FILE}`);
}

// deno-lint-ignore no-explicit-any
type Any = any;

function call(server: ReturnType<typeof createFleetMcp>, id: number, name: string, args: unknown) {
  return server.handle(
    { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
    () => {},
  ) as Promise<Any>;
}

const body = (r: Any) => JSON.parse(r.result.content[0].text);

Deno.test("server: initialize, tools/list, a tool error, unknown methods", async () => {
  const { root, paths } = await tempFleet();
  try {
    const server = createFleetMcp(new FleetFiles(paths), { now: () => NOW, watch: false });
    const init = await server.handle(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      () => {},
    ) as Any;
    assertEquals(init.result.protocolVersion, "2025-03-26");
    assertEquals(init.result.serverInfo.name, "fleet");
    assertEquals(
      await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, () => {}),
      null,
    );
    const list = await server.handle(
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      () => {},
    ) as Any;
    assertEquals(list.result.tools.map((t: Any) => t.name), TOOLS.map((t) => t.name));
    const bad = await call(server, 3, "fleet_runs", { limit: "lots" });
    assertEquals(bad.result.isError, true);
    const nope = await server.handle(
      { jsonrpc: "2.0", id: 4, method: "prompts/list" },
      () => {},
    ) as Any;
    assertEquals(nope.error.code, -32601);
    // No snapshot yet: the answer says stale.
    assertEquals(body(await call(server, 5, "fleet_status", {})).stale, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server: fleet_wait returns at once when satisfied, on a file change, at the timeout, and when stale", async () => {
  const { root, paths } = await tempFleet();
  let t = NOW;
  try {
    await writeSnap(paths.dataDir, snap());
    await appendJournal(paths.dataDir, [ev(1), ev(2), ev(3)]);
    const server = createFleetMcp(new FleetFiles(paths), { now: () => t, pollMs: 20 });
    // Already failed: at once.
    const now1 = body(
      await call(server, 1, "fleet_wait", { run_ids: [200], until: "any_failure" }),
    );
    assertEquals([now1.triggered, now1.waited_s], ["failure", 0]);
    assertEquals(now1.failed_jobs[0].failed_step, "Run tests");
    // Waiting on run 100; a job fails 100 ms later (the watcher or the re-read sees it).
    const pending = call(server, 2, "fleet_wait", {
      run_ids: [100],
      until: "any_failure",
      timeout_s: 30,
    });
    await new Promise((r) => setTimeout(r, 100));
    await writeSnap(
      paths.dataDir,
      snap({
        jobs: snap().jobs.map((j) =>
          j.job_id === 1
            ? { ...j, status: "completed", conclusion: "failure", failed_step: "Build" }
            : j
        ),
      }),
    );
    const got = body(await pending);
    assertEquals(got.triggered, "failure");
    assertEquals(got.failed_jobs.map((j: Any) => [j.job_id, j.failed_step]), [[1, "Build"]]);
    assertEquals(got.next_seq, 3);
    // first_event: a new journal line about the run.
    const first = call(server, 3, "fleet_wait", {
      run_ids: [100],
      until: "first_event",
      timeout_s: 30,
    });
    await new Promise((r) => setTimeout(r, 100));
    await appendJournal(paths.dataDir, [
      ev(4, { run_id: 999 }),
      ev(5, { run_id: 100, kind: "finished" }),
    ]);
    const fe = body(await first);
    assertEquals([fe.triggered, fe.events.map((e: Any) => e.seq), fe.next_seq], ["event", [5], 5]);
    // Timeout: the clock passes the deadline.
    const timing = call(server, 4, "fleet_wait", {
      job_ids: [3],
      until: "completed",
      timeout_s: 5,
    });
    await new Promise((r) => setTimeout(r, 60));
    t += 6_000;
    // Keep the snapshot fresh for the moved clock.
    await writeSnap(paths.dataDir, snap({ updated_at: ISO(t), written_at: ISO(t) }));
    const to = body(await timing);
    assertEquals(to.triggered, "timeout");
    assertEquals(to.jobs.map((j: Any) => j.job_id), [3]);
    // Stale: Fleet stopped writing 10 min ago.
    t += 10 * 60_000;
    const st = body(await call(server, 5, "fleet_wait", { run_ids: [100], until: "completed" }));
    assertEquals(st.triggered, "stale");
    assert(st.stale);
    assertStringIncludes(st.warning, "STALE");
    // A run Fleet doesn't know is named.
    t = NOW;
    await writeSnap(paths.dataDir, snap());
    const miss = body(
      await call(server, 6, "fleet_wait", { run_ids: [200, 12345], until: "any_failure" }),
    );
    assertEquals([miss.triggered, miss.missing.run_ids], ["failure", [12345]]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

// ---- least privilege ----

Deno.test("server: runs with only --allow-read of its three paths (no net, env, run, write)", async () => {
  const { root, paths } = await tempFleet();
  try {
    await writeSnap(
      paths.dataDir,
      snap({ updated_at: ISO(Date.now()), written_at: ISO(Date.now()) }),
    );
    await appendJournal(paths.dataDir, [ev(1), ev(2)]);
    await Deno.writeTextFile(
      paths.healthFile,
      JSON.stringify({ checked_at_epoch: Date.now() / 1000, pools: {} }),
    );
    await Deno.writeTextFile(`${paths.hooksDir}/events.jsonl`, "{}\n");
    const script = new URL("../mcp/fleet-mcp.ts", import.meta.url).pathname;
    const child = new Deno.Command(Deno.execPath(), {
      args: [
        "run",
        "--no-config",
        "--no-prompt",
        `--allow-read=${paths.dataDir},${paths.hooksDir},${paths.healthFile}`,
        script,
        "--data-dir",
        paths.dataDir,
        "--hooks-dir",
        paths.hooksDir,
        "--health-file",
        paths.healthFile,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env: { NO_COLOR: "1" },
      clearEnv: false,
    }).spawn();
    const reqs = [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "fleet_status", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "fleet_runs", arguments: {} },
      },
      {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "fleet_jobs", arguments: { run_id: 100 } },
      },
      {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "fleet_events", arguments: { since_seq: 0 } },
      },
      {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "fleet_wait", arguments: { run_ids: [200], until: "any_failure" } },
      },
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: {
          name: "fleet_wait",
          arguments: { run_ids: [100], until: "first_event", timeout_s: 1 },
        },
      },
    ];
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(reqs.map((r) => JSON.stringify(r)).join("\n") + "\n"));
    // Let the 1 s wait run out (it watches both folders meanwhile), then close stdin.
    await new Promise((r) => setTimeout(r, 1500));
    await w.close();
    const out = await child.output();
    const err = new TextDecoder().decode(out.stderr);
    assertEquals(out.code, 0, err);
    assertFalse(/NotCapable|PermissionDenied|Requires .* access/.test(err), err);
    const replies = new TextDecoder().decode(out.stdout).trim().split("\n").map((l) =>
      JSON.parse(l)
    );
    const byId = new Map(replies.map((r) => [r.id, r]));
    for (const id of [2, 3, 4, 5, 6, 7]) {
      const r = byId.get(id);
      assert(r?.result && !r.result.isError, `tool call ${id}: ${JSON.stringify(r)}`);
    }
    assertEquals(body(byId.get(6)).triggered, "failure");
    assertEquals(body(byId.get(7)).triggered, "timeout");
    assertEquals(body(byId.get(5)).events.length, 2);
    assertEquals(body(byId.get(2)).watchdog.pools, {});
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("server: its source uses no network, environment, subprocess or write API", async () => {
  for (const f of ["../mcp/fleet-mcp.ts", "../mcp/queries.ts", "../lib/agent-files.ts"]) {
    const src = await Deno.readTextFile(new URL(f, import.meta.url));
    for (
      const api of [
        /\bfetch\(/,
        /Deno\.(connect|connectTls|listen|listenTls|serve|resolveDns|startTls)\b/,
        /new WebSocket\b/,
        /Deno\.Command\b/,
        /Deno\.(run|writeFile|writeTextFile|mkdir|remove|rename|create|chmod|symlink)\b/,
        /Deno\.open\([^)]*write/,
        /Deno\.env\.(set|delete|toObject)\b/,
      ]
    ) {
      assertFalse(api.test(src), `${f} uses ${api}`);
    }
  }
});
