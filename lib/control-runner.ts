// Running a control: validate the page's request, gather the facts, apply the guardrails
// (lib/controls.ts), ask for confirmation in the OS's own dialog, then act and log it to the event
// log as the user's action. Machine access is injected (the GitHub client, the dialog, the pool
// scripts), so the tests run it with fakes; nothing here runs before the user confirmed.

import {
  checkDispatch,
  checkInputs,
  checkRunControl,
  type ControlCheck,
  controlRequest,
  type DispatchInput,
  type GitHubControl,
  parseDispatchInputs,
  poolCommand,
  type PoolControl,
  type PoolPaths,
  validRef,
  validRepo,
} from "./controls.ts";
import type { NewEvent } from "./events.ts";
import type { GitHubClient } from "./github.ts";
import type { GhJobList, GhRun } from "./github-types.ts";
import type { Poller } from "./poller.ts";

/** The OS confirm dialog (denext's `host.confirm`). */
export type ConfirmFn = (o: {
  message: string;
  detail?: string;
  title?: string;
  buttons: string[];
  defaultId: number;
  cancelId: number;
  kind: "info" | "warning" | "error";
}) => Promise<number | null>;

/** What the runner needs. */
export interface ControlDeps {
  github(): { client: GitHubClient; poller: Poller; canWrite: boolean } | null;
  confirm: ConfirmFn;
  log(e: Omit<NewEvent, "at" | "user">): Promise<void>;
  /** The pool scripts on this machine, or `null` (not the Mac mini). */
  poolPaths?: PoolPaths | null;
  uid?: number;
  /** Run an exact program with argv (no shell); its exit code and first output lines. */
  runProgram?: (program: string, args: readonly string[]) => Promise<{ code: number; out: string }>;
}

/** A control's outcome, for the page. */
export type ControlResult =
  | { readonly ok: true; readonly message: string }
  | {
    readonly ok: false;
    readonly message: string;
    readonly refused?: boolean;
    readonly cancelled?: boolean;
  };

const obj = (
  v: unknown,
) => (typeof v === "object" && v !== null ? v as Record<string, unknown> : {});
const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null);

/** Ask, with the safe choice as the default and as Escape. */
async function ask(deps: ControlDeps, check: ControlCheck, extra: string[]): Promise<boolean> {
  const detail = [...check.warnings, ...extra].join("\n\n");
  const answer = await deps.confirm({
    title: "Fleet",
    message: check.message,
    ...(detail ? { detail } : {}),
    buttons: [check.confirmLabel, "Don't"],
    defaultId: 1,
    cancelId: 1,
    kind: check.warnings.length ? "warning" : "info",
  });
  return answer === 0;
}

const NO_TOKEN = "Fleet has no GitHub token (public data only): GitHub would refuse this.";

/** Parse the page's GitHub control. */
export function parseControl(raw: unknown): GitHubControl | null {
  const r = obj(raw);
  const repo = r.repo;
  if (!validRepo(repo)) return null;
  const runId = int(r.runId);
  switch (r.kind) {
    case "cancel-run":
    case "rerun-failed":
    case "rerun-all":
      return runId ? { kind: r.kind, repo, runId } : null;
    case "rerun-job": {
      const jobId = int(r.jobId);
      return runId && jobId ? { kind: "rerun-job", repo, runId, jobId } : null;
    }
    case "dispatch": {
      const workflowId = int(r.workflowId);
      if (!workflowId || !validRef(r.ref)) return null;
      const inputs: Record<string, string> = {};
      for (const [k, v] of Object.entries(obj(r.inputs))) {
        if (!/^[\w-]{1,100}$/.test(k)) return null;
        if (typeof v === "string" || typeof v === "boolean" || typeof v === "number") {
          inputs[k] = String(v);
        }
      }
      return { kind: "dispatch", repo, workflowId, ref: r.ref, inputs };
    }
  }
  return null;
}

/** Run a GitHub control end to end. */
export async function runControl(deps: ControlDeps, raw: unknown): Promise<ControlResult> {
  const c = parseControl(raw);
  if (!c) return { ok: false, message: "That control isn't valid." };
  const gh = deps.github();
  if (!gh) return { ok: false, message: "Fleet isn't connected to GitHub yet." };
  return c.kind === "dispatch" ? await dispatch(deps, gh, c) : await runAction(deps, gh, c);
}

async function runAction(
  deps: ControlDeps,
  gh: NonNullable<ReturnType<ControlDeps["github"]>>,
  c: Exclude<GitHubControl, { kind: "dispatch" }>,
): Promise<ControlResult> {
  // The run's facts: what Fleet tracks, else GitHub's.
  let tracked = gh.poller.run(c.runId);
  if (!tracked || tracked.repo !== c.repo) {
    try {
      const run = (await gh.client.get<GhRun>(`/repos/${c.repo}/actions/runs/${c.runId}`)).body;
      const jobs = (await gh.client.get<GhJobList>(
        `/repos/${c.repo}/actions/runs/${c.runId}/jobs?per_page=100`,
      )).body.jobs;
      tracked = { repo: c.repo, run, jobs };
    } catch {
      return { ok: false, message: `Couldn't read run ${c.runId}.` };
    }
  }
  const { run, jobs } = tracked;
  const job = c.kind === "rerun-job" ? jobs.find((j) => j.id === c.jobId) : undefined;
  if (c.kind === "rerun-job" && !job) return { ok: false, message: "That job isn't in the run." };
  const check = checkRunControl(c, {
    id: run.id,
    workflow: run.name ?? "workflow",
    branch: run.head_branch ?? "",
    sha: run.head_sha,
    jobs: jobs.length,
    repoDefaultBranch: gh.poller.defaultBranch(c.repo),
    ...(job ? { jobName: job.name } : {}),
  });
  const base = {
    repo: c.repo,
    workflow: run.name ?? "workflow",
    job: job?.name ?? null,
    url: job?.html_url ?? run.html_url,
    branch: run.head_branch ?? "",
  };
  if (!check.allowed) {
    await deps.log({ ...base, sev: "warn", kind: "action", text: `refused: ${check.refusal}` });
    return { ok: false, refused: true, message: check.refusal! };
  }
  if (!(await ask(deps, check, gh.canWrite ? [] : [NO_TOKEN]))) {
    return { ok: false, cancelled: true, message: "Not done." };
  }
  if (!gh.canWrite) return { ok: false, message: NO_TOKEN };
  const req = controlRequest(c);
  try {
    await gh.client.post(req.path, req.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    await deps.log({
      ...base,
      sev: "bad",
      kind: "action",
      text: `${check.confirmLabel} failed: ${msg}`,
    });
    return { ok: false, message: `GitHub refused it: ${msg}` };
  }
  const done = {
    "cancel-run": `cancel requested for run ${run.id}`,
    "rerun-failed": `re-run of the failed jobs requested for run ${run.id}`,
    "rerun-all": `re-run of all jobs requested for run ${run.id}`,
    "rerun-job": `re-run requested for job "${job?.name}"`,
  }[c.kind];
  await deps.log({ ...base, sev: "info", kind: "action", text: done });
  return { ok: true, message: done.charAt(0).toUpperCase() + done.slice(1) + "." };
}

/** A dispatchable workflow. */
export interface DispatchWorkflow {
  readonly id: number;
  readonly name: string;
  readonly path: string;
  readonly inputs: readonly DispatchInput[];
}

const workflowCache = new Map<string, { at: number; list: DispatchWorkflow[] }>();
const WORKFLOW_CACHE_MS = 10 * 60_000;

function b64(text: string): string {
  const bin = atob(text.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

/** The repo's workflows that declare `workflow_dispatch`, with their inputs (cached 10 min). */
export async function listWorkflows(
  deps: ControlDeps,
  repo: unknown,
  now = Date.now(),
): Promise<DispatchWorkflow[]> {
  if (!validRepo(repo)) return [];
  const hit = workflowCache.get(repo);
  if (hit && now - hit.at < WORKFLOW_CACHE_MS) return hit.list;
  const gh = deps.github();
  if (!gh) return [];
  const all = (await gh.client.get<
    { workflows: { id: number; name: string; path: string; state: string }[] }
  >(
    `/repos/${repo}/actions/workflows?per_page=100`,
  )).body.workflows.filter((w) =>
    w.state === "active" && /^\.github\/workflows\/[\w.-]+\.ya?ml$/.test(w.path)
  );
  const list: DispatchWorkflow[] = [];
  for (const w of all) {
    try {
      const f = (await gh.client.get<{ content?: string; encoding?: string }>(
        `/repos/${repo}/contents/${w.path}`,
      )).body;
      if (f.encoding !== "base64" || !f.content) continue;
      const inputs = parseDispatchInputs(b64(f.content));
      if (inputs) list.push({ id: w.id, name: w.name, path: w.path, inputs });
    } catch {
      // Unreadable: not offered.
    }
  }
  workflowCache.set(repo, { at: now, list });
  return list;
}

async function dispatch(
  deps: ControlDeps,
  gh: NonNullable<ReturnType<ControlDeps["github"]>>,
  c: Extract<GitHubControl, { kind: "dispatch" }>,
): Promise<ControlResult> {
  const wf = (await listWorkflows(deps, c.repo)).find((w) => w.id === c.workflowId);
  if (!wf) return { ok: false, message: "That workflow can't be dispatched." };
  const inputs = checkInputs(wf.inputs, c.inputs);
  if (!inputs.ok) return { ok: false, message: inputs.message };
  let sha: string;
  let sameShaRuns: { id: number; status: string; conclusion: string | null }[];
  try {
    sha = (await gh.client.get<{ sha: string }>(
      `/repos/${c.repo}/commits/${encodeURIComponent(c.ref)}`,
    ))
      .body.sha;
    sameShaRuns = (await gh.client.get<{ workflow_runs: GhRun[] }>(
      `/repos/${c.repo}/actions/workflows/${c.workflowId}/runs?head_sha=${sha}&per_page=20`,
    )).body.workflow_runs.map((r) => ({
      id: r.id,
      status: r.status ?? "",
      conclusion: r.conclusion ?? null,
    }));
  } catch {
    return { ok: false, message: `Couldn't resolve ${c.ref}.` };
  }
  const control = { ...c, inputs: inputs.inputs };
  const check = checkDispatch(control, { workflow: wf.name, ref: c.ref, sha, sameShaRuns });
  const base = { repo: c.repo, workflow: wf.name, job: null, url: null, branch: c.ref };
  if (!check.allowed) {
    await deps.log({ ...base, sev: "warn", kind: "action", text: `refused: ${check.refusal}` });
    return { ok: false, refused: true, message: check.refusal! };
  }
  if (!(await ask(deps, check, gh.canWrite ? [] : [NO_TOKEN]))) {
    return { ok: false, cancelled: true, message: "Not done." };
  }
  if (!gh.canWrite) return { ok: false, message: NO_TOKEN };
  const req = controlRequest(control);
  try {
    await gh.client.post(req.path, req.body);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "failed";
    await deps.log({ ...base, sev: "bad", kind: "action", text: `dispatch failed: ${msg}` });
    return { ok: false, message: `GitHub refused it: ${msg}` };
  }
  const text = `dispatched on ${c.ref} (${sha.slice(0, 7)})`;
  await deps.log({ ...base, sev: "info", kind: "action", text });
  return { ok: true, message: `Dispatched ${wf.name} on ${c.ref}.` };
}

/** Parse the page's pool control. */
export function parsePoolControl(raw: unknown): PoolControl | null {
  const r = obj(raw);
  const pool = typeof r.pool === "string" ? r.pool : "";
  switch (r.kind) {
    case "pause":
      return {
        kind: "pause",
        pool,
        seconds: typeof r.seconds === "number" ? r.seconds : 0,
        ...(typeof r.reason === "string" ? { reason: r.reason } : {}),
      };
    case "resume":
      return { kind: "resume", pool };
    case "restart-scheduler":
      return { kind: "restart-scheduler" };
    case "watchdog-pass":
      return { kind: "watchdog-pass" };
  }
  return null;
}

/** Run a pool control (the Mac mini only). */
export async function runPoolControl(deps: ControlDeps, raw: unknown): Promise<ControlResult> {
  if (!deps.poolPaths || !deps.runProgram) {
    return {
      ok: false,
      message: "Pool controls run only on the machine with the runner scheduler.",
    };
  }
  const c = parsePoolControl(raw);
  if (!c) return { ok: false, message: "That pool control isn't valid." };
  const built = poolCommand(c, deps.poolPaths, deps.uid ?? -1);
  if (!built.ok) return { ok: false, refused: true, message: built.message };
  const cmd = built.command;
  const yes = await deps.confirm({
    title: "Fleet",
    message: cmd.message,
    buttons: [cmd.confirmLabel, "Don't"],
    defaultId: 1,
    cancelId: 1,
    kind: "warning",
  });
  if (yes !== 0) return { ok: false, cancelled: true, message: "Not done." };
  const r = await deps.runProgram(cmd.program, cmd.args);
  const first = r.out.split("\n").map((l) => l.trim()).filter(Boolean)[0]?.slice(0, 200) ?? "";
  const where = "pool" in c ? `pool ${c.pool}` : "fleet";
  await deps.log({
    repo: "",
    workflow: where,
    job: null,
    url: null,
    sev: r.code === 0 ? "info" : "bad",
    kind: "action",
    text: `${cmd.confirmLabel.toLowerCase()}: exit ${r.code}${first ? ` (${first})` : ""}`,
  });
  return r.code === 0
    ? { ok: true, message: `${cmd.confirmLabel}: done.${first ? ` ${first}` : ""}` }
    : {
      ok: false,
      message: `${cmd.confirmLabel} failed (exit ${r.code}).${first ? ` ${first}` : ""}`,
    };
}
