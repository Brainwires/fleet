// The controls' guardrails: a default-branch cancel refused, a duplicate-SHA dispatch refused, a
// rel/* re-run warned, dispatch inputs read from the workflow YAML and checked, and pool commands
// built only from allowlisted paths, pools and durations. Nothing here calls GitHub or runs a
// script.

import { TEST_POOL_PATHS } from "./fixture-settings.ts";

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  checkDispatch,
  checkInputs,
  checkRunControl,
  controlRequest,
  isProtectedBranch,
  parseDispatchInputs,
  poolCommand,
  poolPrograms,
  validRef,
  validRepo,
} from "../lib/controls.ts";

const RUN = {
  id: 43194560988,
  workflow: "denext tests",
  branch: "rel/3.0.0-denext.21",
  sha: "0123456789abcdef",
  jobs: 41,
};

Deno.test("cancel: the dialog names exactly what will happen", () => {
  const c = checkRunControl({ kind: "cancel-run", repo: "Brainwires/deno", runId: RUN.id }, RUN);
  assert(c.allowed);
  assertEquals(
    c.message,
    'Cancel run 43194560988 in Brainwires/deno: "denext tests" on "rel/3.0.0-denext.21", 41 jobs?',
  );
});

Deno.test("cancel: refused outright on a default branch, or the repo's own default_branch", () => {
  for (const branch of ["development-denext", "development", "main"]) {
    const c = checkRunControl({ kind: "cancel-run", repo: "Brainwires/denext", runId: 1 }, {
      ...RUN,
      branch,
    });
    assertFalse(c.allowed);
    assertStringIncludes(c.refusal!, `Cancel is refused on ${branch}`);
    assertStringIncludes(c.refusal!, "must stay green");
  }
  const own = checkRunControl(
    { kind: "cancel-run", repo: "Brainwires/qutty", runId: 1 },
    { ...RUN, branch: "trunk", repoDefaultBranch: "trunk" },
  );
  assertFalse(own.allowed);
  assert(isProtectedBranch("Brainwires/denext", "main"));
  assertFalse(isProtectedBranch("Brainwires/denext", "train/4.17"));
  // Re-runs on a default branch are fine.
  assert(
    checkRunControl({ kind: "rerun-failed", repo: "Brainwires/denext", runId: 1 }, {
      ...RUN,
      branch: "main",
    }).allowed,
  );
});

Deno.test("re-run on rel/* warns that a failed attempt blocks the tag", () => {
  for (const kind of ["rerun-failed", "rerun-all"] as const) {
    const c = checkRunControl({ kind, repo: "Brainwires/deno", runId: RUN.id }, RUN);
    assert(c.allowed);
    assertEquals(c.warnings.length, 1);
    assertStringIncludes(c.warnings[0], "blocks its tag");
  }
  const job = checkRunControl(
    { kind: "rerun-job", repo: "Brainwires/deno", runId: RUN.id, jobId: 7 },
    { ...RUN, jobName: "unit (macos)" },
  );
  assertEquals(
    job.message,
    'Re-run job "unit (macos)" of run 43194560988 in Brainwires/deno: "denext tests" on "rel/3.0.0-denext.21"?',
  );
  assertStringIncludes(job.warnings[0], "blocks its tag");
  assertEquals(
    checkRunControl({ kind: "rerun-all", repo: "x/y", runId: 1 }, { ...RUN, branch: "train/4.17" })
      .warnings,
    [],
  );
});

Deno.test("dispatch: refused on a SHA that already has a run, unless it was cancelled", () => {
  const c = {
    kind: "dispatch" as const,
    repo: "Brainwires/denext",
    workflowId: 5,
    ref: "development",
    inputs: { job: "e2e" },
  };
  const base = { workflow: "e2e", ref: "development", sha: "abcdef0123456789" };
  const dup = checkDispatch(c, {
    ...base,
    sameShaRuns: [{ id: 99, status: "completed", conclusion: "failure" }],
  });
  assertFalse(dup.allowed);
  assertEquals(
    dup.refusal,
    "This commit already has run 99; a second run on one SHA isn't allowed.",
  );
  const running = checkDispatch(c, {
    ...base,
    sameShaRuns: [{ id: 98, status: "in_progress", conclusion: null }],
  });
  assertFalse(running.allowed);
  const cancelled = checkDispatch(c, {
    ...base,
    sameShaRuns: [{ id: 97, status: "completed", conclusion: "cancelled" }],
  });
  assert(cancelled.allowed);
  assertStringIncludes(cancelled.warnings[0], "run 97, cancelled");
  const fresh = checkDispatch(c, { ...base, sameShaRuns: [] });
  assertEquals(
    fresh.message,
    'Dispatch "e2e" in Brainwires/denext on "development" (abcdef0) with job="e2e"?',
  );
  assertEquals(controlRequest(c), {
    path: "/repos/Brainwires/denext/actions/workflows/5/dispatches",
    body: { ref: "development", inputs: { job: "e2e" } },
  });
});

Deno.test("requests: the exact endpoints", () => {
  assertEquals(
    controlRequest({ kind: "cancel-run", repo: "a/b", runId: 1 }).path,
    "/repos/a/b/actions/runs/1/cancel",
  );
  assertEquals(
    controlRequest({ kind: "rerun-failed", repo: "a/b", runId: 1 }).path,
    "/repos/a/b/actions/runs/1/rerun-failed-jobs",
  );
  assertEquals(
    controlRequest({ kind: "rerun-all", repo: "a/b", runId: 1 }).path,
    "/repos/a/b/actions/runs/1/rerun",
  );
  assertEquals(
    controlRequest({ kind: "rerun-job", repo: "a/b", runId: 1, jobId: 2 }).path,
    "/repos/a/b/actions/jobs/2/rerun",
  );
  assert(validRepo("Brainwires/denext"));
  assertFalse(validRepo("Brainwires/../x"));
  assertFalse(validRepo("a/b; rm -rf /"));
  assert(validRef("rel/3.0.0-denext.21"));
  assertFalse(validRef("-x"));
  assertFalse(validRef("a..b"));
  assertFalse(validRef("a b"));
});

const YAML = `name: e2e
on:
  push:
    branches: [development]
  workflow_dispatch:
    inputs:
      job:
        description: "Run one job only"
        required: false
        type: choice
        options:
          - e2e
          - migration-beds
          - 'no-deno'
      verbose:
        type: boolean
        default: false
      note:
        description: Free text # a comment
        required: true
jobs:
  e2e:
    runs-on: ubuntu-latest
    steps:
      - run: echo "inputs: not this"
`;

Deno.test("dispatch inputs: only on.workflow_dispatch.inputs is read", () => {
  const inputs = parseDispatchInputs(YAML)!;
  assertEquals(inputs.map((i) => [i.name, i.type, i.required, i.default]), [
    ["job", "choice", false, ""],
    ["verbose", "boolean", false, "false"],
    ["note", "string", true, ""],
  ]);
  assertEquals(inputs[0].options, ["e2e", "migration-beds", "no-deno"]);
  assertEquals(inputs[0].description, "Run one job only");
  assertEquals(inputs[2].description, "Free text");
  assertEquals(parseDispatchInputs("on:\n  push:\n    branches: [main]\njobs: {}\n"), null);
  assertEquals(parseDispatchInputs("on: [push, workflow_dispatch]\n"), []);
  assertEquals(parseDispatchInputs("on:\n  workflow_dispatch:\njobs: {}\n"), []);
  assertEquals(
    parseDispatchInputs(
      "on:\n  workflow_dispatch:\n    inputs:\n      x:\n        options: [a, b]\n        type: choice\n",
    )![0].options,
    ["a", "b"],
  );
});

Deno.test("dispatch inputs: required, choices, booleans, no extras", () => {
  const d = parseDispatchInputs(YAML)!;
  assertEquals(checkInputs(d, { note: "hi" }), {
    ok: true,
    inputs: { verbose: "false", note: "hi" },
  });
  assertEquals(checkInputs(d, {}), { ok: false, message: 'input "note" is required' });
  assertEquals(checkInputs(d, { note: "x", job: "other" }).ok, false);
  assertEquals(checkInputs(d, { note: "x", verbose: "yes" }).ok, false);
  assertEquals(checkInputs(d, { note: "x", extra: "1" }), {
    ok: false,
    message: 'unknown input "extra"',
  });
});

Deno.test("pool controls: allowlisted paths and pools, bounded pauses, no shell", () => {
  const p = TEST_POOL_PATHS;
  assertEquals(poolPrograms(p), [
    "/opt/test-ops/pause-pool.sh",
    "/opt/test-ops/watchdog.sh",
    "/bin/launchctl",
  ]);
  const pause = poolCommand(
    { kind: "pause", pool: "win-x64", seconds: 120, reason: "base swap; $(rm -rf ~)" },
    p,
    501,
  );
  assert(pause.ok);
  if (pause.ok) {
    assertEquals(pause.command.program, p.pausePool);
    assertEquals(pause.command.args, ["win-x64", "--seconds", "120", "fleet: base swap rm -rf"]);
  }
  assertFalse(poolCommand({ kind: "pause", pool: "win-x64; reboot", seconds: 60 }, p, 501).ok);
  assertFalse(poolCommand({ kind: "pause", pool: "win-x64", seconds: 3600 }, p, 501).ok);
  const resume = poolCommand({ kind: "resume", pool: "mac-arm" }, p, 501);
  assert(resume.ok && resume.command.args.join(" ") === "--resume mac-arm");
  const kick = poolCommand({ kind: "restart-scheduler" }, p, 501);
  assert(kick.ok && kick.command.program === "/bin/launchctl");
  if (kick.ok) {
    assertEquals(kick.command.args, ["kickstart", "-k", "gui/501/org.example.runners"]);
  }
  const wd = poolCommand({ kind: "watchdog-pass" }, p, 501);
  assert(wd.ok && wd.command.args.length === 0 && wd.command.program === p.watchdog);
  // Every program is one of the allowlisted three.
  for (const r of [pause, resume, kick, wd]) {
    if (r.ok) assert(poolPrograms(p).includes(r.command.program));
  }
});

Deno.test("local health: the mini's health.json wins when fresher; paused from pause files", async () => {
  const { mergeLocalHealth } = await import("../lib/local-health.ts");
  const { parsePoolHealth } = await import("../lib/health.ts");
  const NOW = Date.parse("2026-11-12T10:10:00Z");
  const variable = parsePoolHealth(
    JSON.stringify({
      v: 1,
      checked_at: NOW / 1000 - 600,
      pools: {
        "denext-windows-x64": { ok: true, reason: "", since: 1, slots: 1, busy: 1, paused: false },
      },
    }),
    NOW,
  );
  const local = {
    checked_at_epoch: NOW / 1000 - 60,
    pools: {
      "win-x64": { healthy: false, reason: "guest unreachable", since_epoch: NOW / 1000 - 120 },
    },
  };
  const m = mergeLocalHealth(variable, local, new Set(["mac-arm"]), NOW);
  assertEquals(m.state, "ok");
  if (m.state !== "ok") return;
  assertEquals(m.doc.pools["denext-windows-x64"].ok, false);
  assertEquals(m.doc.pools["denext-windows-x64"].reason, "guest unreachable");
  assertEquals(m.doc.pools["denext-windows-x64"].busy, 1, "busy stays the variable's");
  // Older local file: the variable wins; garbage: unchanged.
  assertEquals(
    mergeLocalHealth(variable, { ...local, checked_at_epoch: 1 }, new Set(), NOW),
    variable,
  );
  assertEquals(mergeLocalHealth(variable, "junk", new Set(), NOW), variable);
});
