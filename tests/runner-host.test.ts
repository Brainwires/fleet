// Runner-host jobs (the GitHub-hosted "intel helper" that registers an ephemeral self-hosted
// runner): never STALLED / over usual, "hosting …" text idle vs running, and jobs on a
// gh-intel-helper- runner counted as mac-x64.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { classifyJob, groupLanes, jobWarning } from "../lib/classify.ts";
import { diffObservation, newTracker, STALL_MS } from "../lib/events.ts";
import type { GhJob, GhRun, GhRunList } from "../lib/github-types.ts";
import { parsePoolHealth } from "../lib/health.ts";
import { poolFromRunnerName } from "../lib/pools.ts";
import { fixture, NOW } from "./helpers.ts";

const RUN: GhRun = fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs[0];
const iso = (ms: number) => new Date(ms).toISOString();

const hostJob = (id: number, slot: number, startedMs: number): GhJob => ({
  id,
  run_id: RUN.id,
  name: `helper (${slot})`,
  status: "in_progress",
  labels: ["macos-15-intel"],
  runner_name: "GitHub Actions 1000000001",
  created_at: iso(startedMs),
  started_at: iso(startedMs),
  html_url: null,
});

const workJob = (id: number, runner: string): GhJob => ({
  id,
  run_id: 999,
  name: "tests",
  status: "in_progress",
  labels: ["self-hosted", "denext-macos-x64"],
  runner_name: runner,
  created_at: iso(NOW - 60_000),
  started_at: iso(NOW - 60_000),
  html_url: null,
});

const helperRun = { ...RUN, id: 500, name: "intel helper" };
const workRun = { ...RUN, id: 999, name: "CI" };

Deno.test("runner host: no STALLED, no over-usual", () => {
  const started = NOW - STALL_MS - 4 * 60_000;
  const host = hostJob(1, 1, started);
  const t = newTracker();
  const obs = (now: number) => ({
    now,
    runs: [{ repo: "Brainwires/deno", run: helperRun, jobs: [host] }],
    health: parsePoolHealth(null, NOW),
    annotations: new Map(),
  });
  diffObservation(t, obs(NOW));
  assertEquals(diffObservation(t, obs(NOW + 2 * STALL_MS)), []);
  // The same job in another workflow still stalls.
  const t2 = newTracker();
  const other = { repo: "Brainwires/deno", run: { ...helperRun, name: "other" }, jobs: [host] };
  diffObservation(t2, { ...obs(NOW), runs: [other] });
  const ev = diffObservation(t2, { ...obs(NOW + 2 * STALL_MS), runs: [other] });
  assertEquals(ev.map((e) => e.kind), ["stalled"]);

  const lanes = groupLanes(
    [{ repo: "Brainwires/deno", run: helperRun }],
    new Map([[500, [host]]]),
    () => 60_000,
    NOW,
  );
  const row = lanes.running[0].runs[0].jobs[0];
  assert(row.hosting !== undefined);
  assertEquals(jobWarning(row, NOW), null);
});

Deno.test("runner host: hosting text idle vs running, matched by slot", () => {
  const hosts = [hostJob(1, 1, NOW - 600_000), hostJob(2, 2, NOW - 600_000)];
  const runs = [
    { repo: "Brainwires/deno", run: helperRun },
    { repo: "Brainwires/denext", run: workRun },
  ];
  const idle = groupLanes(runs, new Map([[500, hosts]]), () => null, NOW);
  const idleRows = idle.running[0].runs[0].jobs;
  assertEquals(idleRows.map((j) => j.hosting), [
    "hosting gh-intel-helper-1 · idle",
    "hosting gh-intel-helper-2 · idle",
  ]);
  const busy = groupLanes(
    runs,
    new Map([[500, hosts], [999, [workJob(7, "gh-intel-helper-2-1700000000")]]]),
    () => null,
    NOW,
  );
  const rows = busy.running.find((g) => g.repo === "Brainwires/deno")!.runs[0].jobs;
  assertEquals(rows[0].hosting, "hosting gh-intel-helper-1 · idle");
  assertEquals(rows[1].hosting, "hosting gh-intel-helper-2 · running denext · CI · tests");
});

Deno.test("runner host: a job on a gh-intel-helper runner is mac-x64", () => {
  assertEquals(poolFromRunnerName("gh-intel-helper-1-1700000000"), "mac-x64");
  assertEquals(classifyJob(workJob(7, "gh-intel-helper-1-1700000000"))?.pool, "mac-x64");
  assertEquals(classifyJob(workJob(7, "gh-intel-helper-1-1700000000"))?.target, "pool");
  const lanes = groupLanes(
    [{ repo: "Brainwires/denext", run: workRun }],
    new Map([[999, [workJob(7, "gh-intel-helper-1-1700000000")]]]),
    () => null,
    NOW,
  );
  const row = lanes.running[0].runs[0].jobs[0];
  assertEquals(row.pool, "mac-x64");
  assertEquals(row.helper, true);
  assertStringIncludes(row.runner ?? "", "gh-intel-helper-");
});
