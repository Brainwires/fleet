// The `ci` MCP server (mcp/ci-mcp.ts, ci-tools.ts, ci-guards.ts) with GitHub stubbed: the guards
// (stale head, [skip ci] release gate, runner allowlist, de-duplication, protected runs, ownership),
// the re-run plan (picker re-run for routing, never a protected run's passing jobs), the reads
// (status with annotations, log excerpts, capacity), the non-blocking watch and the bounded wait,
// the per-call deadline, the audit ledger and how Fleet turns it into events and run owners.

import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import type { AgentJob, AgentRun, AgentSnapshot } from "../lib/agent-snapshot.ts";
import {
  CI_AUDIT_FILE,
  CI_NOTICES_FILE,
  ciEvent,
  ciLedgerDir,
  ciLedgerTail,
  type CiRecord,
  ownershipOf,
  parseCiLine,
} from "../lib/ci-ledger.ts";
import type { GhJob, GhRun } from "../lib/github-types.ts";
import { createFleetService } from "../lib/service.ts";
import { DEFAULT_SETTINGS, type FleetSettings } from "../lib/settings.ts";
import {
  isPickerJob,
  isProtectedRun,
  parseAllowlist,
  planRerun,
  skipCiMarker,
  vetDispatchRef,
} from "../mcp/ci-guards.ts";
import { type CiGitHub, ciGitHub, GitHubError } from "../mcp/ci-github.ts";
import {
  ciPathsFromArgs,
  createCiMcp,
  parseSharedBudget,
  serverCommand,
  TOOLS,
  verdict,
} from "../mcp/ci-mcp.ts";
import { type CiDeps, CiTools } from "../mcp/ci-tools.ts";
import { ciRunId, fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const ISO = (ms: number) => new Date(ms).toISOString();
const REPO = "Brainwires/denext";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const DATA = "/data";
const RUNNERS = "/runners";

// ---- stubs ----

type Answer = unknown | (() => unknown);

interface Stub extends CiGitHub {
  routes: Map<string, Answer>;
  posts: { path: string; body: unknown }[];
  gets: string[];
}

/** GitHub stubbed by path: a value, a thrower, or 404 for anything not routed. */
function stubGitHub(routes: Record<string, Answer> = {}): Stub {
  const map = new Map(Object.entries(routes));
  const posts: { path: string; body: unknown }[] = [];
  const gets: string[] = [];
  const answer = (path: string) => {
    if (!map.has(path)) throw new GitHubError("not found (404)", 404, "not-found");
    const a = map.get(path);
    return typeof a === "function" ? (a as () => unknown)() : structuredClone(a);
  };
  return {
    routes: map,
    posts,
    gets,
    get<T>(path: string) {
      gets.push(path);
      try {
        return Promise.resolve(answer(path) as T);
      } catch (err) {
        return Promise.reject(err);
      }
    },
    post(path, body) {
      posts.push({ path, body });
      const key = `POST ${path}`;
      if (map.has(key)) {
        try {
          return Promise.resolve(answer(key) as { status: number; body: unknown });
        } catch (err) {
          return Promise.reject(err);
        }
      }
      return Promise.resolve({ status: 204, body: null });
    },
    log(path) {
      gets.push(path);
      try {
        return Promise.resolve(answer(path) as { text: string; truncated: boolean; bytes: number });
      } catch (err) {
        return Promise.reject(err);
      }
    },
    rate: () => null,
  };
}

interface Env {
  tools: CiTools;
  gh: Stub;
  files: Map<string, string>;
  clock: { t: number };
  audit: () => CiRecord[];
  notices: () => CiRecord[];
}

const ALLOWLIST = {
  owner: "Brainwires",
  events: ["push", "workflow_dispatch", "schedule", "pull_request"],
  any_ref_events: ["push", "workflow_dispatch", "pull_request"],
  refs: ["development", "train/*", "fix/*", "feat/*", "pretest/*"],
  tags: true,
  widened_labels: ["denext-linux-x64", "denext-macos-arm64"],
};

const HEALTH = {
  checked_at_epoch: Math.floor((NOW - 30_000) / 1000),
  scheduler: { healthy: true, reason: "ok" },
  pools: {
    "mac-arm": {
      healthy: true,
      reason: "ok",
      label: "denext-macos-arm64",
      slots: 2,
      runner_prefix: "denext-mac-arm-",
      labels: ["denext-macos-arm64"],
    },
    "linux-x64": {
      healthy: true,
      reason: "ok",
      label: "denext-linux-x64",
      slots: 3,
      runner_prefix: "denext-linux-x64-",
      labels: ["denext-linux-x64"],
    },
    "win-arm64": {
      healthy: true,
      reason: "ok",
      label: "denext-windows-arm64",
      slots: 2,
      runner_prefix: "denext-win-arm64-",
      labels: ["denext-windows-arm64"],
    },
  },
};

function env(routes: Record<string, Answer> = {}, snap: AgentSnapshot | null = null): Env {
  const files = new Map<string, string>();
  files.set("/ops/allowlist.json", JSON.stringify(ALLOWLIST));
  files.set("/ops/tunables.conf", "RAM_BUDGET_GB=16\nMINI_VM_MAX=2\n");
  files.set(`${RUNNERS}/health.json`, JSON.stringify(HEALTH));
  if (snap) files.set(`${DATA}/snapshot.json`, JSON.stringify(snap));
  const clock = { t: NOW };
  const gh = stubGitHub({ [`/repos/${REPO}`]: { default_branch: "main" }, ...routes });
  const deps: CiDeps = {
    paths: {
      dataDir: DATA,
      runnersDir: RUNNERS,
      allowlist: "/ops/allowlist.json",
      tunables: "/ops/tunables.conf",
      shared: { name: "mini", pools: ["mac-arm", "win-arm64"], max: "MINI_VM_MAX" },
    },
    github: gh,
    now: () => clock.t,
    readText: (p) => Promise.resolve(files.get(p) ?? null),
    append: (p, line) => {
      files.set(p, (files.get(p) ?? "") + line);
      return Promise.resolve();
    },
    sleep: (ms) => {
      clock.t += ms;
      return Promise.resolve();
    },
  };
  const lines = (name: string) => () =>
    (files.get(`${RUNNERS}/${name}`) ?? "").split("\n").filter(Boolean).map((l) => parseCiLine(l)!);
  return {
    tools: new CiTools(deps),
    gh,
    files,
    clock,
    audit: lines(CI_AUDIT_FILE),
    notices: lines(CI_NOTICES_FILE),
  };
}

const ghRun = (id: number, over: Partial<GhRun> = {}): GhRun => ({
  id,
  name: "CI",
  display_title: "a commit",
  head_branch: "fix/thing",
  head_sha: SHA,
  event: "workflow_dispatch",
  status: "in_progress",
  conclusion: null,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  created_at: ISO(NOW - 10 * 60_000),
  repository: { full_name: REPO },
  head_repository: { full_name: REPO },
  ...over,
});

const ghJob = (id: number, runId: number, over: Partial<GhJob> = {}): GhJob => ({
  id,
  run_id: runId,
  name: `job-${id}`,
  status: "completed",
  conclusion: "success",
  labels: ["self-hosted", "denext-linux-x64"],
  runner_name: "denext-linux-x64-2-17",
  created_at: ISO(NOW - 9 * 60_000),
  started_at: ISO(NOW - 8 * 60_000),
  completed_at: ISO(NOW - 2 * 60_000),
  steps: [],
  ...over,
});

// The tools' answers are unions per outcome: the tests read them loosely.
// deno-lint-ignore no-explicit-any
type Loose = Record<string, any>;
type LooseTools = Record<
  "dispatch" | "rerun" | "cancel" | "logs" | "status" | "capacity",
  (a?: Record<string, unknown>) => Promise<Loose>
>;
const T = (e: { tools: CiTools }) => e.tools as unknown as LooseTools;

const jobsRoute = (runId: number) =>
  `/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100&page=1`;
const text = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

function dispatchRoutes(over: Record<string, Answer> = {}): Record<string, Answer> {
  return {
    [`/repos/${REPO}/git/ref/heads/fix/thing`]: { object: { sha: SHA, type: "commit" } },
    [`/repos/${REPO}/git/commits/${SHA}`]: { message: "fix: a thing" },
    [`POST /repos/${REPO}/actions/workflows/ci.yml/dispatches`]: {
      status: 200,
      body: { workflow_run_id: 777, html_url: `https://github.com/${REPO}/actions/runs/777` },
    },
    ...over,
  };
}

const dispatchArgs = (over: Record<string, unknown> = {}) => ({
  repo: REPO,
  workflow: "ci.yml",
  ref: "fix/thing",
  expect_sha: SHA,
  purpose: "pre-test",
  owner: "agent-7",
  ...over,
});

// ---- guards ----

Deno.test("guards: [skip ci] markers, picker jobs", () => {
  assertEquals(skipCiMarker("release: 4.20.0 [skip ci]"), "[skip ci]");
  assertEquals(skipCiMarker("x [CI SKIP]"), "[ci skip]");
  assertEquals(skipCiMarker("x\n\nskip-checks: true"), "skip-checks: true");
  assertEquals(skipCiMarker("fix: skip the ci step"), null);
  assert(isPickerJob({ name: "pick runners" }));
  assert(isPickerJob({ name: "Pick-runner" }));
  assertFalse(isPickerJob({ name: "check" }));
});

Deno.test("guards: the allowlist pre-check names what every pool accepts", () => {
  const allow = parseAllowlist(ALLOWLIST)!;
  const labels = ["denext-macos-arm64", "denext-linux-x64", "denext-windows-arm64"];
  assertEquals(vetDispatchRef(allow, REPO, "fix/x", "main", false, labels).served, "all");
  assertEquals(vetDispatchRef(allow, REPO, "main", "main", false, labels).served, "all");
  assertEquals(vetDispatchRef(allow, REPO, "v1.2.3", "main", true, labels).served, "all");
  const odd = vetDispatchRef(allow, REPO, "exp/try", "main", false, labels);
  assertEquals(odd.served, "widened");
  assertEquals(odd.refusing_labels, ["denext-windows-arm64"]);
  assertEquals(vetDispatchRef(allow, "Other/repo", "fix/x", null, false, labels).served, "none");
  assertEquals(
    vetDispatchRef({ ...allow, any_ref_events: [] }, REPO, "exp/try", "main", false, labels).served,
    "none",
  );
});

Deno.test("guards: protected runs follow the default branch and Fleet's rules, never a fork", () => {
  const s: FleetSettings = {
    ...DEFAULT_SETTINGS,
    branches: {
      rules: [{ branch: "development", cancel: "refuse", duplicateDispatch: "refuse" }],
      otherDuplicateDispatch: "warn",
    },
  };
  assert(isProtectedRun(REPO, ghRun(1, { head_branch: "main" }), "main", s));
  assert(isProtectedRun(REPO, ghRun(1, { head_branch: "development" }), "main", s));
  assertFalse(isProtectedRun(REPO, ghRun(1, { head_branch: "fix/x" }), "main", s));
  assertFalse(
    isProtectedRun(
      REPO,
      ghRun(1, { head_branch: "main", head_repository: { full_name: "someone/denext" } }),
      "main",
      s,
    ),
  );
  assertFalse(
    isProtectedRun(REPO, ghRun(1, { head_branch: "main", event: "pull_request" }), "main", s),
  );
});

Deno.test("guards: the re-run plan re-runs the picker, but never a protected run's passing jobs", () => {
  const jobs = [
    ghJob(1, 9, { name: "pick runners" }),
    ghJob(2, 9, { name: "check" }),
    ghJob(3, 9, { name: "macos-tests", conclusion: "failure" }),
  ];
  const open = planRerun(jobs, "failed", true, false);
  assertEquals(open.kind, "job");
  assert(open.kind !== "refuse" && open.jobId === 1 && open.passingRerun === 1);
  const prot = planRerun(jobs, "failed", true, true);
  assertEquals(prot.kind, "failed");
  assert(prot.kind !== "refuse" && prot.reroute.startsWith("skipped: protected run"));
  assertEquals(planRerun(jobs, [2], false, true).kind, "refuse");
  assertEquals(planRerun(jobs, "failed", false, false).kind, "failed");
  const one = planRerun([...jobs, ghJob(4, 9, { conclusion: "failure" })], [3], false, false);
  assert(one.kind === "job" && one.jobId === 3);
  assertEquals(planRerun(jobs, [2, 3], false, false).kind, "refuse");
  assertEquals(planRerun(jobs, [99], true, false).kind, "refuse");
  assertEquals(planRerun([ghJob(2, 9)], "failed", true, false).kind, "refuse");
  const noPicker = planRerun(jobs.slice(1), "failed", true, false);
  assert(noPicker.kind === "failed" && noPicker.reroute.includes("no picker"));
});

// ---- ci_dispatch ----

Deno.test("ci_dispatch: dispatches on the expected head, records owner and purpose", async () => {
  const e = env(dispatchRoutes());
  const r = await T(e).dispatch(dispatchArgs());
  assertEquals(r.ok, true);
  assertEquals(r.run_id, 777);
  assertEquals(e.gh.posts.length, 1);
  assertEquals(e.gh.posts[0].body, { ref: "fix/thing", inputs: {}, return_run_details: true });
  const [a] = e.audit();
  assert(a.kind === "audit" && a.op === "dispatch" && a.ok);
  assertEquals([a.owner, a.purpose, a.run_id, a.sha], ["agent-7", "pre-test", 777, SHA]);
  assertEquals(ownershipOf(e.audit()).get(777), { owner: "agent-7", purpose: "pre-test" });
});

Deno.test("ci_dispatch: refuses a stale head (the push didn't land), and audits the refusal", async () => {
  const other = "f".repeat(40);
  const e = env(dispatchRoutes({
    [`/repos/${REPO}/git/ref/heads/fix/thing`]: { object: { sha: other, type: "commit" } },
  }));
  const r = await T(e).dispatch(dispatchArgs());
  assertEquals(r.ok, false);
  assertStringIncludes(String(r.refused), "your push didn't land");
  assertEquals(e.gh.posts.length, 0);
  const [a] = e.audit();
  assert(a.kind === "audit" && !a.ok && a.refused?.includes("not 0123456789ab"));
});

Deno.test("ci_dispatch: a ref missing on GitHub is refused; a tag resolves through its object", async () => {
  const e = env(dispatchRoutes());
  const r = await T(e).dispatch(dispatchArgs({ ref: "fix/nothing" }));
  assertEquals(r.ok, false);
  assertStringIncludes(String(r.refused), "not a branch or tag");
  const t = env(dispatchRoutes({
    [`/repos/${REPO}/git/ref/tags/v1.0.0`]: { object: { sha: "a".repeat(40), type: "tag" } },
    [`/repos/${REPO}/git/tags/${"a".repeat(40)}`]: { object: { sha: SHA, type: "commit" } },
  }));
  assertEquals((await T(t).dispatch(dispatchArgs({ ref: "v1.0.0" }))).ok, true);
});

Deno.test("ci_dispatch: a release gate on a [skip ci] head is refused; a diagnostic is not", async () => {
  const routes = dispatchRoutes({
    [`/repos/${REPO}/git/commits/${SHA}`]: { message: "test: a thing [skip ci]" },
  });
  const e = env(routes);
  const r = await T(e).dispatch(dispatchArgs({ purpose: "release-gate" }));
  assertEquals(r.ok, false);
  assertStringIncludes(String(r.refused), "[skip ci]");
  assertEquals(e.gh.posts.length, 0);
  const d = await T(env(routes)).dispatch(dispatchArgs({ purpose: "diagnostic" }));
  assertEquals(d.ok, true);
  assertStringIncludes(String(d.note), "[skip ci]");
});

Deno.test("ci_dispatch: an unlisted ref is refused with the accepted prefixes", async () => {
  const routes = dispatchRoutes({
    [`/repos/${REPO}/git/ref/heads/exp/try`]: { object: { sha: SHA, type: "commit" } },
  });
  const e = env(routes);
  const r = await T(e).dispatch(dispatchArgs({ ref: "exp/try" }));
  assertEquals(r.ok, false);
  assertStringIncludes(String(r.refused), "denext-windows-arm64");
  assertStringIncludes(String(r.refused), "pretest/try");
  const ok = await env(routes).tools.dispatch(
    dispatchArgs({ ref: "exp/try", unlisted_ref_ok: true }),
  );
  assertEquals(ok.ok, true);
});

Deno.test("ci_dispatch: an identical dispatch in flight answers its run; a finished one doesn't", async () => {
  let status = "in_progress";
  const e = env(dispatchRoutes({
    [`/repos/${REPO}/actions/runs/777`]: () => ghRun(777, { status }),
    [jobsRoute(777)]: { jobs: [] },
  }));
  assertEquals((await T(e).dispatch(dispatchArgs())).run_id, 777);
  const twin = await T(e).dispatch(dispatchArgs({ owner: "agent-9" }));
  assertEquals(twin.deduped, true);
  assertEquals(twin.run_id, 777);
  assertEquals(twin.dispatched_by, "agent-7");
  assertEquals(e.gh.posts.length, 1);
  // The de-duplicated call doesn't take the run over.
  assertEquals(ownershipOf(e.audit()).get(777)?.owner, "agent-7");
  // Other inputs are another dispatch.
  await T(e).dispatch(dispatchArgs({ inputs: { job: "x" } }));
  assertEquals(e.gh.posts.length, 2);
  // Once finished, the same dispatch goes out again.
  status = "completed";
  const again = await T(e).dispatch(dispatchArgs());
  assertEquals(again.deduped, false);
  assertEquals(e.gh.posts.length, 3);
});

Deno.test("ci_dispatch: a 204 answer finds the new run by its SHA", async () => {
  const e = env(dispatchRoutes({
    [`POST /repos/${REPO}/actions/workflows/ci.yml/dispatches`]: { status: 204, body: null },
    [`/repos/${REPO}/actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${SHA}&per_page=20`]:
      { workflow_runs: [ghRun(888, { created_at: ISO(NOW + 1000) })] },
  }));
  const r = await T(e).dispatch(dispatchArgs());
  assertEquals(r.run_id, 888);
});

Deno.test("ci_dispatch: arguments are checked before anything is asked of GitHub", async () => {
  const e = env(dispatchRoutes());
  for (
    const bad of [
      { owner: "" },
      { owner: "has space" },
      { purpose: "whatever" },
      { expect_sha: "xyz" },
      { ref: "../etc" },
      { workflow: "rm -rf" },
      { repo: "denext" },
    ]
  ) {
    let msg = "";
    try {
      await T(e).dispatch(dispatchArgs(bad));
    } catch (err) {
      msg = (err as Error).message;
    }
    assert(msg, `expected a refusal for ${JSON.stringify(bad)}`);
  }
  assertEquals(e.gh.gets.length, 0);
});

// ---- ci_rerun ----

function rerunEnv(branch: string, runStatus = "completed") {
  return env({
    [`/repos/${REPO}/actions/runs/500`]: ghRun(500, {
      head_branch: branch,
      status: runStatus,
      conclusion: runStatus === "completed" ? "failure" : null,
    }),
    [jobsRoute(500)]: {
      jobs: [
        ghJob(1, 500, { name: "pick runners" }),
        ghJob(2, 500, { name: "check" }),
        ghJob(3, 500, { name: "macos-tests", conclusion: "failure" }),
      ],
    },
  });
}

Deno.test("ci_rerun: reroute re-runs the picker job so routing is recomputed", async () => {
  const e = rerunEnv("fix/thing");
  const r = await T(e).rerun({ run_id: 500, repo: REPO, owner: "agent-7" });
  assertEquals(r.ok, true);
  assertEquals(e.gh.posts.map((p) => p.path), [`/repos/${REPO}/actions/jobs/1/rerun`]);
  assertStringIncludes(String(r.reroute), "picker");
  assertEquals(r.passing_jobs_rerun, 1);
  const [a] = e.audit();
  assert(a.kind === "audit" && a.op === "rerun" && a.ok && a.purpose === "rerun");
});

Deno.test("ci_rerun: a protected run re-runs only its failed jobs", async () => {
  const e = rerunEnv("main");
  const r = await T(e).rerun({ run_id: 500, repo: REPO, owner: "agent-7" });
  assertEquals(e.gh.posts.map((p) => p.path), [
    `/repos/${REPO}/actions/runs/500/rerun-failed-jobs`,
  ]);
  assertEquals(r.protected, true);
  assertStringIncludes(String(r.reroute), "skipped");
  const refused = await T(e).rerun({ run_id: 500, repo: REPO, owner: "agent-7", jobs: [2] });
  assertEquals(refused.ok, false);
  assertEquals(e.gh.posts.length, 1);
});

Deno.test("ci_rerun: a run still going is refused", async () => {
  const e = rerunEnv("fix/thing", "in_progress");
  const r = await T(e).rerun({ run_id: 500, repo: REPO, owner: "agent-7", reroute: false });
  assertEquals(r.ok, false);
  assertEquals(e.gh.posts.length, 0);
});

// ---- ci_cancel ----

function cancelEnv(branch: string) {
  return env({
    [`/repos/${REPO}/actions/runs/600`]: ghRun(600, { head_branch: branch }),
    [`/repos/${REPO}/actions/runs/601`]: ghRun(601, { head_branch: branch }),
  });
}

Deno.test("ci_cancel: never a protected run", async () => {
  const e = cancelEnv("main");
  const r = await T(e).cancel({ run_id: 600, repo: REPO, owner: "agent-7", reason: "stale" });
  assertEquals(r.ok, false);
  assertStringIncludes(String(r.refused), "protected");
  assertEquals(e.gh.posts.length, 0);
});

Deno.test("ci_cancel: another agent's run only with superseded_by; the reason is logged", async () => {
  const e = cancelEnv("fix/thing");
  await e.tools.audit({
    op: "dispatch",
    ok: true,
    owner: "agent-1",
    purpose: "pre-test",
    repo: REPO,
    run_id: 600,
  });
  const no = await T(e).cancel({ run_id: 600, repo: REPO, owner: "agent-7", reason: "dup" });
  assertEquals(no.ok, false);
  assertStringIncludes(String(no.refused), "agent-1");
  const bad = await T(e).cancel({
    run_id: 600,
    repo: REPO,
    owner: "agent-7",
    reason: "dup",
    superseded_by: 9999,
  });
  assertEquals(bad.ok, false);
  const yes = await T(e).cancel({
    run_id: 600,
    repo: REPO,
    owner: "agent-7",
    reason: "pushed again",
    superseded_by: 601,
  });
  assertEquals(yes.ok, true);
  assertEquals(yes.owner_was, "agent-1");
  assertEquals(e.gh.posts.map((p) => p.path), [`/repos/${REPO}/actions/runs/600/cancel`]);
  const last = e.audit().at(-1)!;
  assert(last.kind === "audit" && last.op === "cancel" && last.ok);
  assertEquals([last.reason, last.superseded_by], ["pushed again", 601]);
  // The owner may cancel its own.
  const own = cancelEnv("fix/thing");
  await own.tools.audit({
    op: "dispatch",
    ok: true,
    owner: "agent-7",
    purpose: "pre-test",
    repo: REPO,
    run_id: 600,
  });
  assertEquals(
    (await T(own).cancel({ run_id: 600, repo: REPO, owner: "agent-7", reason: "x" })).ok,
    true,
  );
});

Deno.test("mutations need the runner folder for their audit line", async () => {
  const e = env(dispatchRoutes());
  const tools = new CiTools({
    ...e.tools.deps,
    paths: { ...e.tools.deps.paths, runnersDir: null },
  });
  let msg = "";
  try {
    await (tools as unknown as LooseTools).dispatch(dispatchArgs());
  } catch (err) {
    msg = (err as Error).message;
  }
  assertStringIncludes(msg, "--runners-dir");
  assertEquals(e.gh.posts.length, 0);
});

// ---- reads ----

Deno.test("ci_status: jobs with runner, pool, queue wait, failed step and annotations", async () => {
  const e = env({
    [`/repos/${REPO}/actions/runs/700`]: ghRun(700, { status: "completed", conclusion: "failure" }),
    [jobsRoute(700)]: {
      jobs: [
        ghJob(1, 700, { name: "pick runners" }),
        ghJob(2, 700, {
          name: "macos-tests",
          conclusion: "failure",
          runner_name: "denext-mac-arm-1-99",
          labels: ["self-hosted", "denext-macos-arm64"],
          steps: [
            { name: "Checkout", status: "completed", conclusion: "success" },
            { name: "Run tests", status: "completed", conclusion: "failure" },
          ],
        }),
        ghJob(3, 700, {
          status: "queued",
          conclusion: null,
          runner_name: null,
          labels: ["macos-15"],
          started_at: null,
        }),
      ],
    },
    [`/repos/${REPO}/check-runs/2/annotations?per_page=50`]: [
      { annotation_level: "notice", message: "fyi" },
      { annotation_level: "warning", message: "slow" },
      {
        annotation_level: "failure",
        title: "test x",
        message: "expected 1",
        path: "a.ts",
        start_line: 3,
      },
    ],
  });
  await e.tools.audit({
    op: "dispatch",
    ok: true,
    owner: "agent-7",
    purpose: "diagnostic",
    repo: REPO,
    run_id: 700,
  });
  const s = await T(e).status({ run_id: 700, repo: REPO });
  assertEquals([s.owner, s.purpose, s.protected], ["agent-7", "diagnostic", false]);
  const [picker, mac, queued] = s.jobs;
  assertEquals(picker.picker, true);
  assertEquals([mac.pool, mac.runner, mac.failed_step], [
    "mac-arm",
    "denext-mac-arm-1-99",
    "Run tests",
  ]);
  assertEquals(mac.queue_wait_s, 60);
  assertEquals(mac.annotations, [
    { level: "failure", message: "test x: expected 1", path: "a.ts", line: 3 },
    { level: "warning", message: "slow" },
  ]);
  assertEquals([queued.pool, queued.queue_wait_s], ["github", 540]);
  assertEquals(s.counts, { success: 1, failure: 1, queued: 1 });
});

Deno.test("ci_logs: not served before the job completes; grep with context, redacted", async () => {
  const log = [
    "2026-11-11T17:00:00.0000000Z setup",
    "2026-11-11T17:00:01.0000000Z token: ghp_" + "a".repeat(36),
    "2026-11-11T17:00:02.0000000Z running",
    "2026-11-11T17:00:03.0000000Z error: boom",
    "2026-11-11T17:00:04.0000000Z after",
    "2026-11-11T17:00:05.0000000Z done",
  ].join("\n");
  const e = env({
    [`/repos/${REPO}/actions/jobs/5`]: ghJob(5, 1, { status: "in_progress", conclusion: null }),
    [`/repos/${REPO}/actions/jobs/6`]: ghJob(6, 1, { conclusion: "failure" }),
    [`/repos/${REPO}/actions/jobs/6/logs`]: { text: log, truncated: false, bytes: log.length },
    [`/repos/${REPO}/actions/jobs/7`]: ghJob(7, 1),
  });
  const pending = await T(e).logs({ job_id: 5, repo: REPO });
  assertEquals(pending.available, false);
  assertStringIncludes(String(pending.message), "available when");
  assertFalse(e.gh.gets.includes(`/repos/${REPO}/actions/jobs/5/logs`));
  const g = await T(e).logs({ job_id: 6, repo: REPO, grep: "ERROR", context: 1 });
  const bare = await T(e).logs({ job_id: 6, repo: REPO, grep: "error", context: 0 });
  assertEquals(bare.text, "4: error: boom");
  assertEquals(g.matches, 1);
  assertEquals(g.text, "3: running\n4: error: boom\n5: after");
  const t = await T(e).logs({ job_id: 6, repo: REPO, tail: 5 });
  assertFalse(String(t.text).includes("ghp_"));
  assertStringIncludes(String(t.text), "[redacted]");
  const gone = await T(e).logs({ job_id: 7, repo: REPO });
  assertEquals(gone.available, false);
  assertStringIncludes(String(gone.message), "available when the run completes");
});

function agentSnap(over: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    v: 1,
    updated_at: ISO(NOW - 5_000),
    written_at: ISO(NOW - 5_000),
    source: "hook",
    owners: ["Brainwires"],
    auth: "gh",
    poll: {
      ok: true,
      message: "",
      last_success_at: ISO(NOW - 5_000),
      interval_ms: 60_000,
      slow: null,
    },
    rate: null,
    hooks: { state: "live", last_delivery_at: ISO(NOW - 5_000) },
    health: { state: "ok", checked_at: null, message: "" },
    summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
    pools: [],
    hosts: [],
    alerts: [],
    event_seq: 1,
    clock_offset_ms: 0,
    runs: [],
    jobs: [],
    ...over,
  };
}

const agentRun = (id: number, over: Partial<AgentRun> = {}): AgentRun => ({
  repo: REPO,
  run_id: id,
  workflow: "CI",
  title: "t",
  branch: "fix/thing",
  sha: SHA,
  event: "workflow_dispatch",
  status: "in_progress",
  conclusion: null,
  attempt: 1,
  created_at: ISO(NOW - 60_000),
  started_at: null,
  completed_at: null,
  html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  ...over,
});

const agentJob = (id: number, runId: number, over: Partial<AgentJob> = {}): AgentJob => ({
  repo: REPO,
  run_id: runId,
  job_id: id,
  name: `job-${id}`,
  workflow: "CI",
  branch: "fix/thing",
  sha: SHA,
  status: "queued",
  conclusion: null,
  created_at: ISO(NOW - 5 * 60_000),
  started_at: null,
  completed_at: null,
  html_url: null,
  labels: ["macos-15"],
  runner_name: null,
  pool: "github",
  steps: [],
  failed_step: null,
  failure_annotation: null,
  ...over,
});

const pool = (id: string, slots: number, busy: number, queued = 0) => ({
  id,
  label: `denext-${id}`,
  state: "ok",
  reason: "",
  slots,
  busy,
  running: busy,
  queued,
  state_since: null,
  oldest_queued_since: queued ? ISO(NOW - 120_000) : null,
});

Deno.test("ci_capacity: free slots, GitHub family saturation, the mini's shared budget", async () => {
  const e = env(
    {},
    agentSnap({
      pools: [pool("mac-arm", 2, 1, 1), pool("win-arm64", 2, 0), pool("linux-x64", 3, 1), {
        ...pool("github", 0, 0),
        slots: null,
      }],
      jobs: [
        agentJob(1, 1),
        agentJob(2, 1, { created_at: ISO(NOW - 60_000) }),
        agentJob(3, 1, { labels: ["ubuntu-latest"], created_at: ISO(NOW - 30_000) }),
        agentJob(4, 1, { labels: ["windows-2022"], status: "in_progress" }),
      ],
    }),
  );
  const c = await T(e).capacity();
  assertEquals(c.stale, false);
  assertEquals(c.free_slots, 1 + 2 + 2);
  assertEquals(c.pools.find((p: Loose) => p.pool === "mac-arm")?.oldest_queued_s, 120);
  assertEquals(c.github.saturated, ["macos"]);
  const mac = c.github.families.find((f: Loose) => f.family === "macos")!;
  assertEquals([mac.queued, mac.oldest_queued_s], [2, 300]);
  assertEquals(c.shared_budget.max_vms, 2);
  assertEquals([c.shared_budget.ci_busy, c.shared_budget.free, c.shared_budget.queued], [1, 1, 1]);
  assertEquals(c.scheduler?.healthy, true);
});

// ---- the server: watch, wait, deadline ----

async function call(
  server: ReturnType<typeof createCiMcp>,
  name: string,
  args: unknown,
  sent: unknown[] = [],
) {
  return await server.handle(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    (m) => void sent.push(m),
  );
}

Deno.test("tools/list: the phase 1 and 2 tools, each with a schema", async () => {
  const server = createCiMcp(env().tools);
  const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" }, () => {});
  const names = (r as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
  assertEquals(names, [
    "ci_status",
    "ci_logs",
    "ci_capacity",
    "ci_watch",
    "ci_wait",
    "ci_dispatch",
    "ci_rerun",
    "ci_cancel",
  ]);
  for (const t of TOOLS) assertEquals(t.inputSchema.type, "object");
});

Deno.test("ci_watch: returns at once; the first failure arrives as a notification and a Fleet event", async () => {
  const snap = agentSnap({
    runs: [agentRun(900)],
    jobs: [agentJob(1, 900, { status: "in_progress" })],
  });
  const e = env({}, snap);
  const server = createCiMcp(e.tools, { tickMs: 60_000, newId: () => "abc" });
  const sent: { method?: string; params?: { level: string; data: { outcome: string } } }[] = [];
  const r = text(
    ((await call(server, "ci_watch", { run_ids: [900], owner: "agent-7" }, sent)) as {
      result: unknown;
    }).result,
  );
  assertEquals(r.watch_id, "w-abc");
  await server.tick();
  assertEquals(sent.length, 0);
  // A job fails: the next pass fires.
  e.files.set(
    `${DATA}/snapshot.json`,
    JSON.stringify({
      ...snap,
      jobs: [agentJob(1, 900, { name: "macos-tests", status: "completed", conclusion: "failure" })],
    }),
  );
  await server.tick();
  const note = sent.find((m) => m.method === "notifications/message")!;
  assertEquals([note.params!.level, note.params!.data.outcome], ["error", "failure"]);
  const [n] = e.notices();
  assert(n.kind === "notice" && n.outcome === "failure" && n.owner === "agent-7");
  assertEquals(n.failed_jobs, ["macos-tests"]);
  assertEquals(server.watches().length, 0);
  assertStringIncludes(ciEvent(n).text, "ci[agent-7] watch w-abc: run 900 failed: macos-tests");
  server.close();
});

Deno.test("ci_watch: a run Fleet doesn't hold is read from GitHub, at most once a minute", async () => {
  const e = env(
    { [`/repos/${REPO}/actions/runs/901`]: ghRun(901), [jobsRoute(901)]: { jobs: [] } },
    agentSnap(),
  );
  const server = createCiMcp(e.tools, { tickMs: 60_000, ghEveryMs: 60_000 });
  await call(server, "ci_watch", {
    run_ids: [901],
    repo: REPO,
    owner: "agent-7",
    until: "completed",
  });
  await server.tick();
  await server.tick();
  assertEquals(e.gh.gets.filter((g) => g === `/repos/${REPO}/actions/runs/901`).length, 1);
  e.gh.routes.set(
    `/repos/${REPO}/actions/runs/901`,
    ghRun(901, { status: "completed", conclusion: "success" }),
  );
  e.clock.t += 61_000;
  await server.tick();
  const [n] = e.notices();
  assert(n.kind === "notice" && n.outcome === "completed" && n.conclusion === "success");
  server.close();
});

Deno.test("ci_watch: expires", async () => {
  const e = env({}, agentSnap({ runs: [agentRun(902)] }));
  const server = createCiMcp(e.tools, { tickMs: 60_000 });
  await call(server, "ci_watch", { run_ids: [902], owner: "agent-7", expires_in_s: 60 });
  e.clock.t += 61_000;
  e.files.set(
    `${DATA}/snapshot.json`,
    JSON.stringify(
      agentSnap({ updated_at: ISO(e.clock.t), written_at: ISO(e.clock.t), runs: [agentRun(902)] }),
    ),
  );
  await server.tick();
  assertEquals(
    e.notices()[0].kind === "notice" && (e.notices()[0] as { outcome: string }).outcome,
    "expired",
  );
  server.close();
});

Deno.test("ci_wait: bounded, answers still_running", async () => {
  const e = env({}, agentSnap({ runs: [agentRun(903)] }));
  const server = createCiMcp(e.tools, { tickMs: 3000 });
  const start = e.clock.t;
  const r = text(
    ((await call(server, "ci_wait", { run_ids: [903], timeout_s: 9999 })) as { result: unknown })
      .result,
  );
  // Past the cap: waits 300 s at most.
  assertEquals(r.triggered, "still_running");
  assert(e.clock.t - start <= 300_000 + 3000);
  assert(r.waited_s >= 300);
  server.close();
});

Deno.test("verdict: any_failure fires on the first failure, completed on all completed", () => {
  const st = (status: string, conclusion: string | null, failed: string[] = []) => ({
    repo: REPO,
    run_id: 1,
    status,
    conclusion,
    failed_jobs: failed,
    html_url: null,
    source: "fleet" as const,
  });
  assertEquals(
    verdict([st("in_progress", null, ["x"]), st("queued", null)], "any_failure"),
    "failure",
  );
  assertEquals(verdict([st("in_progress", null, ["x"])], "completed"), null);
  assertEquals(
    verdict([st("completed", "success"), st("completed", "failure")], "completed"),
    "completed",
  );
  assertEquals(verdict([st("completed", "failure")], "any_failure"), "failure");
  assertEquals(verdict([null], "completed"), null);
});

Deno.test("every call but ci_wait is cut off within the deadline", async () => {
  const e = env();
  const hang: CiGitHub = {
    ...e.gh,
    get: (_p, signal) =>
      new Promise((_, reject) =>
        signal?.addEventListener("abort", () => reject(new Error("aborted")))
      ),
  };
  const server = createCiMcp(new CiTools({ ...e.tools.deps, github: hang }), {
    toolDeadlineMs: 50,
  });
  const t0 = Date.now();
  const r = (await call(server, "ci_status", { run_id: 1, repo: REPO })) as {
    result: { isError: boolean; content: { text: string }[] };
  };
  assert(Date.now() - t0 < 5000);
  assertEquals(r.result.isError, true);
  assertMatch(r.result.content[0].text, /took too long/);
});

Deno.test("ci-github: the dispatch POST carries the token and returns the run details", async () => {
  const seen: { url: string; method: string; auth: string | null; body: string }[] = [];
  const f: typeof fetch = (input, init) => {
    seen.push({
      url: String(input),
      method: init?.method ?? "GET",
      auth: new Headers(init?.headers).get("authorization"),
      body: String(init?.body ?? ""),
    });
    return Promise.resolve(new Response(JSON.stringify({ workflow_run_id: 5 }), { status: 200 }));
  };
  const gh = ciGitHub({ token: () => Promise.resolve("ghs_" + "x".repeat(36)), fetch: f });
  const r = await gh.post(`/repos/${REPO}/actions/workflows/ci.yml/dispatches`, { ref: "x" });
  assertEquals(r.body, { workflow_run_id: 5 });
  assertEquals(seen[0].auth, "Bearer ghs_" + "x".repeat(36));
  let refused = false;
  await gh.post("/orgs/x", {}).catch(() => (refused = true));
  assert(refused);
  const err = ciGitHub({
    token: () => Promise.resolve(null),
    fetch: () =>
      Promise.resolve(new Response(JSON.stringify({ message: "nope" }), { status: 422 })),
  });
  let msg = "";
  await err.post(`/repos/${REPO}/actions/runs/1/cancel`).catch((e) => (msg = e.message));
  assertEquals(msg, "HTTP 422: nope");
});

// ---- the ledger and Fleet ----

Deno.test("ledger: lines parse, garbage doesn't, events read well", () => {
  const rec = parseCiLine(JSON.stringify({
    v: 1,
    kind: "audit",
    at: NOW,
    op: "dispatch",
    ok: true,
    owner: "agent-7",
    purpose: "release-gate",
    repo: REPO,
    run_id: 42,
    workflow: "ci.yml",
    ref: "train/4.20",
    sha: SHA,
  }))!;
  assertEquals(
    ciEvent(rec).text,
    "ci[agent-7] dispatched ci.yml on train/4.20 @0123456 (release-gate) → run 42",
  );
  assertEquals(ciEvent(rec).run_id, 42);
  assertEquals(parseCiLine("{"), null);
  assertEquals(
    parseCiLine(JSON.stringify({ v: 2, kind: "audit", at: 1, owner: "a", repo: "r" })),
    null,
  );
  const refused = parseCiLine(
    JSON.stringify({
      v: 1,
      kind: "audit",
      at: NOW,
      op: "cancel",
      ok: false,
      owner: "a\nb",
      repo: REPO,
      run_id: 1,
      refused: "protected‮",
    }),
  )!;
  assertEquals(ciEvent(refused).sev, "warn");
  assertFalse(ciEvent(refused).text.includes("\n"));
  assertFalse(ciEvent(refused).text.includes("‮"));
  assertEquals(
    ciLedgerDir("~/.denext-runners/health.json", "/Users/x"),
    "/Users/x/.denext-runners",
  );
  assertEquals(ciLedgerDir(null, "/Users/x"), null);
});

Deno.test("ledger: the tail returns what's new, survives a rotation", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const line = (run: number) =>
      JSON.stringify({
        v: 1,
        kind: "audit",
        at: NOW + run,
        op: "dispatch",
        ok: true,
        owner: "a",
        purpose: "pre-test",
        repo: REPO,
        run_id: run,
      }) + "\n";
    const read = ciLedgerTail(dir);
    assertEquals(await read(), []);
    await Deno.writeTextFile(`${dir}/${CI_AUDIT_FILE}`, line(1) + line(2));
    assertEquals((await read()).map((r) => r.run_id), [1, 2]);
    await Deno.writeTextFile(`${dir}/${CI_AUDIT_FILE}`, line(3) + '{"v":1,"kind"', {
      append: true,
    });
    assertEquals((await read()).map((r) => r.run_id), [3]);
    await Deno.rename(`${dir}/${CI_AUDIT_FILE}`, `${dir}/${CI_AUDIT_FILE}.1`);
    await Deno.writeTextFile(`${dir}/${CI_AUDIT_FILE}`, line(4));
    assertEquals((await read()).map((r) => r.run_id), [4]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("Fleet: ledger records become events, and the run card names its owner", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const runId = ciRunId();
  const rec: CiRecord = {
    v: 1,
    kind: "audit",
    at: NOW - 1000,
    op: "dispatch",
    ok: true,
    owner: "agent-7",
    purpose: "release-gate",
    repo: REPO,
    run_id: runId,
    workflow: "ci.yml",
    ref: "development",
    sha: SHA,
  };
  let batches: CiRecord[][] = [[rec]];
  const journal: { text: string }[] = [];
  const svc = createFleetService({
    ghToken: () => Promise.resolve("gho_" + "b".repeat(36)),
    secrets: {
      get: () => Promise.resolve(null),
      set: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    },
    fetch,
    now: () => NOW,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    appendJournal: (e) => Promise.resolve(void journal.push(...e)),
    setTimeout: () => 0,
    clearTimeout: () => {},
    readCiLedger: () => {
      const b = batches[0] ?? [];
      batches = batches.slice(1);
      return Promise.resolve(b);
    },
  });
  await svc.start();
  const runs = [...svc.snapshot().running, ...svc.snapshot().queued].flatMap((g) => g.runs);
  assertEquals(runs.find((r) => r.id === runId)?.ci, { owner: "agent-7", purpose: "release-gate" });
  assert(journal.some((e) => e.text.startsWith("ci[agent-7] dispatched ci.yml on development")));
  svc.stop();
});

Deno.test("arguments: paths, the shared budget, and the least-privilege command", () => {
  assertEquals(parseSharedBudget("m:a,b:MAX_VMS"), {
    name: "m",
    pools: ["a", "b"],
    max: "MAX_VMS",
  });
  assertEquals(parseSharedBudget("m:a:3"), { name: "m", pools: ["a"], max: 3 });
  assertEquals(typeof parseSharedBudget("m;a"), "string");
  const p = ciPathsFromArgs([
    "--data-dir",
    "/d",
    "--runners-dir",
    "/r",
    "--shared-budget",
    "m:a:2",
  ]);
  assert(typeof p !== "string");
  assertEquals(p.runnersDir, "/r");
  const cmd = serverCommand(p, "/x/ci-mcp.ts");
  const write = cmd.find((a) => a.startsWith("--allow-write="))!;
  assertEquals(write.slice(14).split(","), [
    "/r/ci-audit.log",
    "/r/ci-audit.log.1",
    "/r/ci-notices.jsonl",
    "/r/ci-notices.jsonl.1",
  ]);
  assert(cmd.includes("--no-config") && cmd.includes("--allow-env=GH_TOKEN,GITHUB_TOKEN"));
  assert(cmd.find((a) => a.startsWith("--allow-net="))!.startsWith("--allow-net=api.github.com,"));
  assertFalse(cmd.some((a) => a === "-A" || a === "--allow-all"));
  // Without a runner folder: no write grant (and every mutation is refused).
  const ro = ciPathsFromArgs(["--data-dir", "/d"]);
  assert(typeof ro !== "string" && ro.runnersDir === null);
  assertFalse(serverCommand(ro, "/x").some((a) => a.startsWith("--allow-write")));
});
