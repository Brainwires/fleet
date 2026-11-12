// Running controls with fakes: nothing is sent unless the user confirmed in the dialog; refusals
// never open one; public mode sends nothing; confirmed actions post once and are logged as the
// user's; pool commands run only the allowlisted program after confirmation.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { listWorkflows, runControl, runPoolControl } from "../lib/control-runner.ts";
import { poolPaths } from "../lib/controls.ts";
import { createGitHubClient } from "../lib/github.ts";
import type { GhRunList } from "../lib/github-types.ts";
import { Poller } from "../lib/poller.ts";
import { ciRunId, fakeFetch, fixture, NOW, standardRoutes } from "./helpers.ts";

async function setup(opts: { branch?: string; canWrite?: boolean; answer?: number | null } = {}) {
  const routes = standardRoutes();
  if (opts.branch) {
    const runs = fixture<GhRunList>("denext-runs-in_progress.json");
    routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
      body: { ...runs, workflow_runs: [{ ...runs.workflow_runs[0], head_branch: opts.branch }] },
    };
  }
  const posted: { url: string; body: string | null }[] = [];
  const { fetch: inner } = fakeFetch(routes);
  const fetch = ((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posted.push({ url: new URL(url).pathname, body: (init.body as string) ?? null });
      return Promise.resolve(new Response(null, { status: 202 }));
    }
    return inner(url, init);
  }) as typeof globalThis.fetch;
  const client = createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW });
  const poller = new Poller({ client, auth: "gh", now: () => NOW });
  await poller.poll();
  const asked: string[] = [];
  const logged: string[] = [];
  const deps = {
    github: () => ({ client, poller, canWrite: opts.canWrite ?? true }),
    confirm: (o: { message: string; detail?: string }) => {
      asked.push(o.message + (o.detail ? ` | ${o.detail}` : ""));
      return Promise.resolve(opts.answer === undefined ? 0 : opts.answer);
    },
    log: (e: { text: string }) => Promise.resolve(void logged.push(e.text)),
  };
  return { deps, posted, asked, logged, routes };
}

Deno.test("control: cancel on a default branch is refused with no dialog and nothing sent", async () => {
  const s = await setup({ branch: "development" });
  const r = await runControl(s.deps, {
    kind: "cancel-run",
    repo: "Brainwires/denext",
    runId: ciRunId(),
  });
  assertEquals(r.ok, false);
  assert(!r.ok && r.refused);
  assertStringIncludes(r.message, "Cancel is refused on development");
  assertEquals(s.asked, []);
  assertEquals(s.posted, []);
  assertStringIncludes(s.logged[0], "refused:");
});

Deno.test("control: a dismissed dialog sends nothing", async () => {
  const s = await setup({ answer: 1 });
  const r = await runControl(s.deps, {
    kind: "cancel-run",
    repo: "Brainwires/denext",
    runId: ciRunId(),
  });
  assert(!r.ok && r.cancelled);
  assertEquals(s.asked, [
    `Cancel run ${ciRunId()} in Brainwires/denext: "CI" on "train/4.17", 12 jobs? | ` +
    "Started by (not reported) · from this repo · workflow_dispatch",
  ]);
  assertEquals(s.posted, []);
  // Escape / closed (null) is the same.
  const t = await setup({ answer: null });
  await runControl(t.deps, { kind: "rerun-all", repo: "Brainwires/denext", runId: ciRunId() });
  assertEquals(t.posted, []);
});

Deno.test("control: confirmed → one POST to the exact endpoint, logged as the user's action", async () => {
  const s = await setup();
  const r = await runControl(s.deps, {
    kind: "rerun-failed",
    repo: "Brainwires/denext",
    runId: ciRunId(),
  });
  assert(r.ok);
  assertEquals(s.posted.map((p) => p.url), [
    `/repos/Brainwires/denext/actions/runs/${ciRunId()}/rerun-failed-jobs`,
  ]);
  assertEquals(s.logged, [`re-run of the failed jobs requested for run ${ciRunId()}`]);
});

Deno.test("control: on rel/* the dialog carries the tag warning", async () => {
  const s = await setup({ branch: "rel/3.0.0-denext.21" });
  await runControl(s.deps, { kind: "rerun-all", repo: "Brainwires/denext", runId: ciRunId() });
  assertStringIncludes(s.asked[0], "blocks its tag");
});

Deno.test("control: in public mode the dialog says so and nothing is sent after confirming", async () => {
  const s = await setup({ canWrite: false });
  const r = await runControl(s.deps, {
    kind: "rerun-all",
    repo: "Brainwires/denext",
    runId: ciRunId(),
  });
  assertEquals(r.ok, false);
  assertStringIncludes(s.asked[0], "no GitHub token");
  assertEquals(s.posted, []);
});

Deno.test("control: invalid requests are refused before anything", async () => {
  const s = await setup();
  for (
    const bad of [
      { kind: "cancel-run", repo: "Brainwires/denext; rm -rf /", runId: 1 },
      { kind: "cancel-run", repo: "Brainwires/denext", runId: -1 },
      { kind: "delete-repo", repo: "Brainwires/denext" },
      { kind: "dispatch", repo: "Brainwires/denext", workflowId: 1, ref: "--upload-pack=x" },
    ]
  ) {
    const r = await runControl(s.deps, bad);
    assertEquals(r.ok, false);
  }
  assertEquals(s.asked, []);
  assertEquals(s.posted, []);
});

Deno.test("dispatch: only workflow_dispatch workflows; same-SHA refused; confirmed dispatch posts", async () => {
  const s = await setup();
  const yaml =
    "on:\n  workflow_dispatch:\n    inputs:\n      job:\n        type: choice\n        options: [e2e, beds]\n";
  const enc = (t: string) => btoa(t);
  s.routes["/repos/Brainwires/qutty/actions/workflows?per_page=100"] = {
    body: {
      workflows: [
        { id: 1, name: "e2e", path: ".github/workflows/e2e.yml", state: "active" },
        { id: 2, name: "ci", path: ".github/workflows/ci.yml", state: "active" },
        { id: 3, name: "old", path: ".github/workflows/old.yml", state: "disabled_manually" },
      ],
    },
  };
  s.routes["/repos/Brainwires/qutty/contents/.github/workflows/e2e.yml"] = {
    body: { encoding: "base64", content: enc(yaml) },
  };
  s.routes["/repos/Brainwires/qutty/contents/.github/workflows/ci.yml"] = {
    body: { encoding: "base64", content: enc("on:\n  push:\n") },
  };
  s.routes["/repos/Brainwires/qutty/commits/main"] = { body: { sha: "f".repeat(40) } };
  const runsKey = `/repos/Brainwires/qutty/actions/workflows/1/runs?head_sha=${
    "f".repeat(40)
  }&per_page=20`;
  s.routes[runsKey] = {
    body: { workflow_runs: [{ id: 55, status: "completed", conclusion: "success" }] },
  };
  const wfs = await listWorkflows(s.deps, "Brainwires/qutty", NOW);
  assertEquals(wfs.map((w) => w.name), ["e2e"]);
  assertEquals(wfs[0].inputs[0].options, ["e2e", "beds"]);
  const c = {
    kind: "dispatch",
    repo: "Brainwires/qutty",
    workflowId: 1,
    ref: "main",
    inputs: { job: "e2e" },
  };
  const dup = await runControl(s.deps, c);
  assert(!dup.ok && dup.refused);
  assertStringIncludes(dup.message, "already has run 55");
  assertEquals(s.asked, []);
  s.routes[runsKey] = { body: { workflow_runs: [] } };
  const bad = await runControl(s.deps, { ...c, inputs: { job: "nope" } });
  assertStringIncludes(bad.message, "must be one of");
  const ok = await runControl(s.deps, c);
  assert(ok.ok);
  assertEquals(s.asked, [`Dispatch "e2e" in Brainwires/qutty on "main" (fffffff) with job="e2e"?`]);
  assertEquals(s.posted, [{
    url: "/repos/Brainwires/qutty/actions/workflows/1/dispatches",
    body: JSON.stringify({ ref: "main", inputs: { job: "e2e" } }),
  }]);
});

Deno.test("pool control: only on the scheduler's machine; confirmed first; exact program", async () => {
  const s = await setup();
  const ran: string[] = [];
  const paths = poolPaths("/Users/me");
  const deps = {
    ...s.deps,
    poolPaths: paths,
    uid: 501,
    runProgram: (p: string, a: readonly string[]) => {
      ran.push([p, ...a].join(" "));
      return Promise.resolve({ code: 0, out: "paused win-x64 until 12:03\n" });
    },
  };
  assertEquals(
    (await runPoolControl(s.deps, { kind: "watchdog-pass" })).ok,
    false,
    "not this machine",
  );
  const r = await runPoolControl(deps, { kind: "pause", pool: "win-x64", seconds: 60 });
  assert(r.ok);
  assertEquals(ran, [`${paths.pausePool} win-x64 --seconds 60 fleet`]);
  assertStringIncludes(s.asked.at(-1)!, "Pause pool win-x64 for 60 s?");
  assertStringIncludes(s.logged.at(-1)!, "pause pool: exit 0 (paused win-x64 until 12:03)");
  // Refused before the dialog.
  const n = s.asked.length;
  assertEquals((await runPoolControl(deps, { kind: "pause", pool: "all", seconds: 60 })).ok, false);
  assertEquals((await runPoolControl(deps, { kind: "reboot-vm" })).ok, false);
  assertEquals(s.asked.length, n);
  // Dismissed: nothing runs.
  const d = { ...deps, confirm: () => Promise.resolve(1) };
  await runPoolControl(d, { kind: "restart-scheduler" });
  assertEquals(ran.length, 1);
});

Deno.test("dry run: the dialog shows and says so; nothing is sent even when confirmed", async () => {
  const s = await setup({ answer: 0 });
  const deps = { ...s.deps, dryRun: true };
  const r = await runControl(deps, {
    kind: "rerun-all",
    repo: "Brainwires/denext",
    runId: ciRunId(),
  });
  assertEquals(r, { ok: false, message: "Dry run: nothing was sent." });
  assertStringIncludes(s.asked[0], "Dry run (test build)");
  assertEquals(s.posted, []);
  const ran: string[] = [];
  const pool = await runPoolControl(
    {
      ...deps,
      poolPaths: poolPaths("/Users/me"),
      uid: 501,
      runProgram: (p) => (ran.push(p), Promise.resolve({ code: 0, out: "" })),
    },
    { kind: "watchdog-pass" },
  );
  assertEquals(pool.ok, false);
  assertEquals(ran, []);
});
