// Controls, with their guardrails as hard rules (pure, unit-tested). Every control is checked here
// first; the backend then asks for confirmation in a native dialog naming exactly what will happen,
// and only then calls GitHub (or, on the Mac mini, the runner scripts) and logs the action to the
// event log as the user's.
//
// - Cancel is refused outright on a default branch (development-denext, development, main, or the
//   repo's own default_branch): those must stay green.
// - Re-run on a release branch (rel/*) warns that a failed attempt on a release commit blocks its
//   tag, so the fix is a new commit.
// - Dispatch is refused when the workflow already has a run on the same commit SHA, unless every
//   such run was cancelled (then it warns).
// - Pool commands run only exact absolute paths with argv built here (no shell, no free text but a
//   sanitized reason), for known pools only; nothing restarts a VM or deletes anything.

import { currentPools, DEFAULT_BRANCHES } from "./pools.ts";

/** A GitHub control. */
export type GitHubControl =
  | { kind: "cancel-run"; repo: string; runId: number }
  | { kind: "rerun-failed"; repo: string; runId: number }
  | { kind: "rerun-all"; repo: string; runId: number }
  | { kind: "rerun-job"; repo: string; runId: number; jobId: number }
  | {
    kind: "dispatch";
    repo: string;
    workflowId: number;
    ref: string;
    inputs: Record<string, string>;
  };

/** What a run looks like to the guardrails. */
export interface RunFacts {
  readonly id: number;
  readonly workflow: string;
  readonly branch: string;
  readonly sha: string;
  readonly jobs: number;
  /** The repo's own default branch, when known. */
  readonly repoDefaultBranch?: string | null;
  readonly jobName?: string;
}

/** What a dispatch looks like to the guardrails. */
export interface DispatchFacts {
  readonly workflow: string;
  readonly ref: string;
  /** The SHA the ref points at. */
  readonly sha: string;
  /** Runs of this workflow on that SHA (any status). */
  readonly sameShaRuns: readonly { id: number; status: string; conclusion: string | null }[];
  readonly repoDefaultBranch?: string | null;
}

/** The verdict. */
export interface ControlCheck {
  /** `false`: refused, no dialog, `refusal` says why. */
  readonly allowed: boolean;
  readonly refusal?: string;
  /** The dialog's main line: exactly what will happen. */
  readonly message: string;
  /** Warnings shown under it. */
  readonly warnings: readonly string[];
  /** The confirm button's label. */
  readonly confirmLabel: string;
}

const RELEASE = /^rel\//;

/** Whether a branch must stay green. */
export function isProtectedBranch(branch: string, repoDefault?: string | null): boolean {
  return DEFAULT_BRANCHES.has(branch) || (!!repoDefault && branch === repoDefault);
}

const short = (repo: string) => repo.split("/")[1] ?? repo;
const jobsText = (n: number) => `${n} job${n === 1 ? "" : "s"}`;

/** Check a run control (cancel / re-run). */
export function checkRunControl(
  c: Exclude<GitHubControl, { kind: "dispatch" }>,
  run: RunFacts,
): ControlCheck {
  const on = `${run.workflow} on ${run.branch}`;
  const warnings: string[] = [];
  if (c.kind !== "cancel-run" && RELEASE.test(run.branch)) {
    warnings.push(
      "This is a release branch: a failed attempt on a release commit blocks its tag, so the fix is a new commit, not a re-run.",
    );
  }
  switch (c.kind) {
    case "cancel-run": {
      const message = `Cancel run ${run.id}, ${on}, ${jobsText(run.jobs)}?`;
      if (isProtectedBranch(run.branch, run.repoDefaultBranch)) {
        return {
          allowed: false,
          refusal: `Cancel is refused on ${run.branch}: ${
            short(c.repo)
          }'s default branch must stay green.`,
          message,
          warnings,
          confirmLabel: "Cancel run",
        };
      }
      return { allowed: true, message, warnings, confirmLabel: "Cancel run" };
    }
    case "rerun-failed":
      return {
        allowed: true,
        message: `Re-run the failed jobs of run ${run.id}, ${on}?`,
        warnings,
        confirmLabel: "Re-run failed jobs",
      };
    case "rerun-all":
      return {
        allowed: true,
        message: `Re-run all ${jobsText(run.jobs)} of run ${run.id}, ${on}?`,
        warnings,
        confirmLabel: "Re-run all",
      };
    case "rerun-job":
      return {
        allowed: true,
        message: `Re-run job "${run.jobName ?? c.jobId}" of run ${run.id}, ${on}?`,
        warnings,
        confirmLabel: "Re-run job",
      };
  }
}

/** Check a workflow dispatch. */
export function checkDispatch(
  c: Extract<GitHubControl, { kind: "dispatch" }>,
  d: DispatchFacts,
): ControlCheck {
  const inputs = Object.entries(c.inputs);
  const message = `Dispatch ${d.workflow} on ${d.ref} (${d.sha.slice(0, 7)})${
    inputs.length ? ` with ${inputs.map(([k, v]) => `${k}=${v}`).join(", ")}` : ""
  }?`;
  const live = d.sameShaRuns.filter((r) => r.conclusion !== "cancelled");
  if (live.length > 0) {
    return {
      allowed: false,
      refusal: `This commit already has run ${live[0].id}; a second run on one SHA isn't allowed.`,
      message,
      warnings: [],
      confirmLabel: "Dispatch",
    };
  }
  const warnings = d.sameShaRuns.length
    ? [`This commit had run ${d.sameShaRuns[0].id}, cancelled; a new run takes its place.`]
    : [];
  return { allowed: true, message, warnings, confirmLabel: "Dispatch" };
}

/** The GitHub request a control makes. */
export function controlRequest(c: GitHubControl): { path: string; body?: unknown } {
  const r = `/repos/${c.repo}/actions`;
  switch (c.kind) {
    case "cancel-run":
      return { path: `${r}/runs/${c.runId}/cancel` };
    case "rerun-failed":
      return { path: `${r}/runs/${c.runId}/rerun-failed-jobs` };
    case "rerun-all":
      return { path: `${r}/runs/${c.runId}/rerun` };
    case "rerun-job":
      return { path: `${r}/jobs/${c.jobId}/rerun` };
    case "dispatch":
      return {
        path: `${r}/workflows/${c.workflowId}/dispatches`,
        body: { ref: c.ref, inputs: c.inputs },
      };
  }
}

/** A repo name GitHub would accept (and nothing that could reach a path or shell). */
export function validRepo(repo: unknown): repo is string {
  return typeof repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(repo) && !repo.includes("..");
}

/** A git ref for a dispatch: a branch or tag name, no spaces, no `..`, no leading `-`. */
export function validRef(ref: unknown): ref is string {
  return typeof ref === "string" && /^[\w./-]{1,200}$/.test(ref) && !ref.includes("..") &&
    !ref.startsWith("-") && !ref.endsWith("/") && !ref.endsWith(".lock");
}

// ---- workflow_dispatch inputs (only that block of the YAML is read) ----

/** One declared input. */
export interface DispatchInput {
  readonly name: string;
  readonly description: string;
  readonly required: boolean;
  readonly default: string;
  readonly type: "string" | "boolean" | "choice" | "number" | "environment";
  readonly options: readonly string[];
}

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t.replace(/\s+#.*$/, "");
};
const indentOf = (l: string) => l.length - l.trimStart().length;

/**
 * Whether a workflow declares `workflow_dispatch`, and its inputs, read from `on.workflow_dispatch`
 * only (a small indentation reader for that block; the rest of the file is ignored). `null` when
 * the workflow has no `workflow_dispatch` trigger.
 */
export function parseDispatchInputs(yaml: string): DispatchInput[] | null {
  const lines = yaml.replace(/\r/g, "").split("\n");
  // The `on:` key at the top level (or `"on":` / `true:` as some YAML writers emit it).
  const onIdx = lines.findIndex((l) => /^(on|"on"|'on'|true):/.test(l));
  if (onIdx === -1) return null;
  const onLine = lines[onIdx];
  const inline = onLine.slice(onLine.indexOf(":") + 1).trim();
  if (inline) {
    // `on: workflow_dispatch` or `on: [push, workflow_dispatch]`: no inputs.
    return /\bworkflow_dispatch\b/.test(inline) ? [] : null;
  }
  let wdIdx = -1;
  let wdIndent = 0;
  for (let i = onIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    if (indentOf(l) === 0) break;
    if (/^\s+workflow_dispatch:/.test(l)) {
      wdIdx = i;
      wdIndent = indentOf(l);
      break;
    }
  }
  if (wdIdx === -1) return null;
  // The block under workflow_dispatch.
  const block: string[] = [];
  for (let i = wdIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || l.trimStart().startsWith("#")) continue;
    if (indentOf(l) <= wdIndent) break;
    block.push(l);
  }
  const inputsAt = block.findIndex((l) => /^\s+inputs:\s*$/.test(l));
  if (inputsAt === -1) return [];
  const inputsIndent = indentOf(block[inputsAt]);
  const out: DispatchInput[] = [];
  let cur: { name: string; fields: Record<string, string>; options: string[] } | null = null;
  let nameIndent = -1;
  let inOptions = false;
  const flush = () => {
    if (!cur) return;
    const f = cur.fields;
    const type =
      (["string", "boolean", "choice", "number", "environment"] as const).find((t) =>
        t === unquote(f.type ?? "string")
      ) ?? "string";
    out.push({
      name: cur.name,
      description: unquote(f.description ?? ""),
      required: unquote(f.required ?? "false") === "true",
      default: unquote(f.default ?? ""),
      type,
      options: cur.options,
    });
  };
  for (let i = inputsAt + 1; i < block.length; i++) {
    const l = block[i];
    const ind = indentOf(l);
    if (ind <= inputsIndent) break;
    const t = l.trim();
    if (nameIndent === -1) nameIndent = ind;
    if (ind === nameIndent) {
      flush();
      const m = t.match(/^([\w-]+):\s*$/);
      cur = m ? { name: m[1], fields: {}, options: [] } : null;
      inOptions = false;
      continue;
    }
    if (!cur) continue;
    if (inOptions && t.startsWith("- ")) {
      cur.options.push(unquote(t.slice(2)));
      continue;
    }
    const kv = t.match(/^([\w-]+):\s*(.*)$/);
    if (!kv) continue;
    inOptions = kv[1] === "options" && kv[2] === "";
    if (kv[1] === "options" && kv[2].startsWith("[")) {
      cur.options.push(...kv[2].replace(/^\[|\]$/g, "").split(",").map(unquote).filter((x) => x));
    } else if (!inOptions) cur.fields[kv[1]] = kv[2];
  }
  flush();
  return out;
}

/** Check dispatch inputs against the declared ones: required present, choices valid, no extras. */
export function checkInputs(
  declared: readonly DispatchInput[],
  given: Record<string, unknown>,
): { ok: true; inputs: Record<string, string> } | { ok: false; message: string } {
  const inputs: Record<string, string> = {};
  for (const k of Object.keys(given)) {
    if (!declared.some((d) => d.name === k)) return { ok: false, message: `unknown input "${k}"` };
  }
  for (const d of declared) {
    const raw = given[d.name];
    const v = raw === undefined || raw === null || raw === "" ? d.default : String(raw);
    if (d.required && v === "") return { ok: false, message: `input "${d.name}" is required` };
    if (d.type === "choice" && v !== "" && !d.options.includes(v)) {
      return { ok: false, message: `input "${d.name}" must be one of ${d.options.join(", ")}` };
    }
    if (d.type === "boolean" && v !== "" && v !== "true" && v !== "false") {
      return { ok: false, message: `input "${d.name}" must be true or false` };
    }
    if (v.length > 1000) return { ok: false, message: `input "${d.name}" is too long` };
    if (v !== "") inputs[d.name] = v;
  }
  return { ok: true, inputs };
}

// ---- pool controls (the Mac mini only) ----

/** The runner scripts' paths on this machine (absolute; baked as --allow-run). */
export interface PoolPaths {
  readonly pausePool: string;
  readonly watchdog: string;
  readonly launchctl: string;
}

/** The paths, from $HOME (the ops checkout's fixed place). */
export function poolPaths(home: string): PoolPaths {
  const ops = `${home}/Source/Brainwires/denext-internal/ops/runners`;
  return {
    pausePool: `${ops}/pause-pool.sh`,
    watchdog: `${ops}/watchdog.sh`,
    launchctl: "/bin/launchctl",
  };
}

/** A pool command. */
export type PoolControl =
  | { kind: "pause"; pool: string; seconds: number; reason?: string }
  | { kind: "resume"; pool: string }
  | { kind: "restart-scheduler" }
  | { kind: "watchdog-pass" };

/** Pause durations offered (pause-pool.sh caps a pause at 180 s; its own expiry voids it). */
export const PAUSE_SECONDS = [60, 120, 180] as const;
export const SCHEDULER_LABEL = "com.brainwires.denext-runners";

/** A command to run: an exact program and argv (no shell). */
export interface PoolCommand {
  readonly program: string;
  readonly args: readonly string[];
  readonly message: string;
  readonly confirmLabel: string;
}

/** Build a pool command, or refuse it. */
export function poolCommand(
  c: PoolControl,
  paths: PoolPaths,
  uid: number,
): { ok: true; command: PoolCommand } | { ok: false; message: string } {
  const known = (p: string) => currentPools().some((x) => x.id === p);
  switch (c.kind) {
    case "pause": {
      if (!known(c.pool)) return { ok: false, message: `unknown pool "${c.pool}"` };
      if (!PAUSE_SECONDS.includes(c.seconds as typeof PAUSE_SECONDS[number])) {
        return { ok: false, message: `a pause is ${PAUSE_SECONDS.join(", ")} seconds` };
      }
      const reason = (c.reason ?? "").replace(/[^\w .,:-]/g, "").replace(/\s+/g, " ").trim().slice(
        0,
        120,
      );
      return {
        ok: true,
        command: {
          program: paths.pausePool,
          args: [
            c.pool,
            "--seconds",
            String(c.seconds),
            ...(reason ? [`fleet: ${reason}`] : ["fleet"]),
          ],
          message:
            `Pause pool ${c.pool} for ${c.seconds} s? No new jobs launch there until it resumes or the pause expires; running jobs go on.`,
          confirmLabel: "Pause pool",
        },
      };
    }
    case "resume":
      if (!known(c.pool)) return { ok: false, message: `unknown pool "${c.pool}"` };
      return {
        ok: true,
        command: {
          program: paths.pausePool,
          args: ["--resume", c.pool],
          message: `Resume pool ${c.pool}? Launches start again on the scheduler's next tick.`,
          confirmLabel: "Resume pool",
        },
      };
    case "restart-scheduler":
      if (!Number.isInteger(uid) || uid < 0) return { ok: false, message: "no user id" };
      return {
        ok: true,
        command: {
          program: paths.launchctl,
          args: ["kickstart", "-k", `gui/${uid}/${SCHEDULER_LABEL}`],
          message:
            "Restart the runner scheduler (launchctl kickstart -k)? Running jobs are not ended; launchers are adopted.",
          confirmLabel: "Restart scheduler",
        },
      };
    case "watchdog-pass":
      return {
        ok: true,
        command: {
          program: paths.watchdog,
          args: [],
          message: "Run one watchdog pass now (deadman, hosts, registrations, health)?",
          confirmLabel: "Run watchdog pass",
        },
      };
  }
}

/** The programs pool controls may run, for the baked --allow-run. */
export function poolPrograms(paths: PoolPaths): string[] {
  return [paths.pausePool, paths.watchdog, paths.launchctl];
}
