// The `ci` server's guards and plans, pure: argument checks, the [skip ci] test, the runner
// allowlist pre-check (the scheduler's allowlist.json, read-only), protected-run detection, the dispatch
// de-duplication key, which jobs pick the runners, how a re-run is asked of GitHub, and GitHub-hosted
// families. mcp/ci-mcp.ts does the I/O around them.

import { capText } from "../lib/agent-snapshot.ts";
import { protectingRule } from "../lib/branches.ts";
import { CI_PURPOSES, type CiPurpose, OWNER_RE } from "../lib/ci-ledger.ts";
import type { GhJob, GhRun } from "../lib/github-types.ts";
import type { FleetSettings } from "../lib/settings.ts";
import { ArgError } from "./queries.ts";

export { ArgError };

// ---- arguments ----

type Json = Record<string, unknown>;

/** A whole positive number argument, or `undefined` when absent. */
export function optInt(args: Json, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v <= 0) {
    throw new ArgError(`${key} must be a positive whole number`);
  }
  return v;
}

/** A whole number ≥ 0 argument, or `undefined` when absent. */
export function optCount(args: Json, key: string): number | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new ArgError(`${key} must be a whole number (0 or more)`);
  }
  return v;
}

export function reqInt(args: Json, key: string): number {
  const v = optInt(args, key);
  if (v === undefined) throw new ArgError(`${key} is required`);
  return v;
}

export function optStr(args: Json, key: string, max = 200): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new ArgError(`${key} must be a string`);
  const t = v.trim();
  if (t.length > max) throw new ArgError(`${key} is longer than ${max} characters`);
  return t || undefined;
}

export function reqStr(args: Json, key: string, max = 200): string {
  const v = optStr(args, key, max);
  if (v === undefined) throw new ArgError(`${key} is required`);
  return v;
}

export function optBool(args: Json, key: string, dflt: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new ArgError(`${key} must be true or false`);
  return v;
}

/** The agent id (`owner`), required on every mutation and watch. */
export function ownerArg(args: Json): string {
  const o = reqStr(args, "owner", 64);
  if (!OWNER_RE.test(o)) {
    throw new ArgError("owner must be your agent id: letters, digits and ._:@/- (1–64)");
  }
  return o;
}

export function purposeArg(args: Json, dflt?: CiPurpose): CiPurpose {
  const p = args.purpose ?? dflt;
  if (!CI_PURPOSES.includes(p as CiPurpose)) {
    throw new ArgError(`purpose must be one of ${CI_PURPOSES.join(", ")}`);
  }
  return p as CiPurpose;
}

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** `owner/name`, checked (mutations take only the full name). */
export function fullRepoArg(v: unknown, key = "repo"): string {
  if (typeof v !== "string" || !REPO_RE.test(v.trim()) || v.includes("..")) {
    throw new ArgError(`${key} must be owner/name`);
  }
  return v.trim();
}

/** A git ref name a workflow can be dispatched on (a branch or a tag; never `refs/…` or a SHA). */
export function refArg(args: Json): string {
  let r = reqStr(args, "ref", 200);
  if (r.startsWith("refs/heads/")) r = r.slice(11);
  else if (r.startsWith("refs/tags/")) r = r.slice(10);
  if (
    !/^[A-Za-z0-9._/+-]+$/.test(r) || r.includes("..") || r.startsWith("/") || r.endsWith("/") ||
    r.endsWith(".lock") || r.includes("//") || r.startsWith("-")
  ) {
    throw new ArgError("ref must be a branch or tag name");
  }
  return r;
}

/** A commit SHA (7–40 hex), lower-cased. */
export function shaArg(args: Json, key = "expect_sha"): string {
  const s = reqStr(args, key, 40).toLowerCase();
  if (!/^[0-9a-f]{7,40}$/.test(s)) throw new ArgError(`${key} must be a commit SHA (7–40 hex)`);
  return s;
}

/** A workflow: its file name (`ci.yml`), path (`.github/workflows/ci.yml`) or numeric id. */
export function workflowArg(args: Json): string {
  const v = args.workflow;
  if (typeof v === "number" && Number.isSafeInteger(v) && v > 0) return String(v);
  let w = reqStr(args, "workflow", 200);
  if (w.startsWith(".github/workflows/")) w = w.slice(".github/workflows/".length);
  if (!/^\d+$/.test(w) && !/^[A-Za-z0-9._-]+\.ya?ml$/.test(w)) {
    throw new ArgError("workflow must be a workflow file name (ci.yml) or its numeric id");
  }
  return w;
}

/** workflow_dispatch inputs: at most 25 string / number / boolean values (GitHub's limit). */
export function inputsArg(args: Json): Record<string, string> {
  const v = args.inputs;
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v)) throw new ArgError("inputs must be an object");
  const out: Record<string, string> = {};
  const entries = Object.entries(v as Json);
  if (entries.length > 25) throw new ArgError("at most 25 inputs");
  for (const [k, x] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,99}$/.test(k)) throw new ArgError(`input name ${k} is invalid`);
    if (typeof x === "string") out[k] = x.slice(0, 1000);
    else if (typeof x === "number" || typeof x === "boolean") out[k] = String(x);
    else throw new ArgError(`input ${k} must be a string, number or boolean`);
  }
  return out;
}

/** The inputs' canonical JSON (sorted keys): part of the de-duplication key. */
export function canonicalInputs(inputs: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a < b ? -1 : 1)),
  );
}

// ---- [skip ci] ----

/** The commit message markers that make GitHub skip push / pull_request workflows. */
const SKIP_MARKERS = ["[skip ci]", "[ci skip]", "[no ci]", "[skip actions]", "[actions skip]"];

/** The [skip ci] marker in a commit message, or `null`. */
export function skipCiMarker(message: string): string | null {
  const lower = message.toLowerCase();
  for (const m of SKIP_MARKERS) if (lower.includes(m)) return m;
  if (/^skip-checks:\s*true\s*$/im.test(message)) return "skip-checks: true";
  return null;
}

// ---- the runner allowlist (read-only) ----

/** The runner scheduler's allowlist.json policy, as far as a dispatch needs it. */
export interface Allowlist {
  readonly owner: string;
  readonly events: readonly string[];
  readonly any_ref_events: readonly string[];
  readonly refs: readonly string[];
  readonly tags: boolean;
  readonly widened_labels: readonly string[];
}

/** The policy from the file's JSON, or `null` when it isn't one. */
export function parseAllowlist(raw: unknown): Allowlist | null {
  const r = raw as Json | null;
  if (!r || typeof r !== "object" || typeof r.owner !== "string") return null;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  return {
    owner: r.owner,
    events: list(r.events),
    any_ref_events: list(r.any_ref_events),
    refs: list(r.refs),
    tags: r.tags === true,
    widened_labels: list(r.widened_labels),
  };
}

/** What the scheduler's vetter would make of a workflow_dispatch on `ref`. */
export interface RefVerdict {
  /** `all`: every pool serves it; `widened`: only pools in widened_labels; `none`: no pool. */
  readonly served: "all" | "widened" | "none";
  readonly reason: string;
  /** The branch names / prefixes every pool accepts (besides the default branch and tags). */
  readonly accepted_refs: readonly string[];
  /** Pool labels that would refuse it (`served: "widened"`). */
  readonly refusing_labels: readonly string[];
}

/**
 * A workflow_dispatch on `ref` of `repo` against the allowlist: `poolLabels` are every pool label
 * the scheduler runs (from its health file), `isTag` whether `ref` is a tag.
 */
export function vetDispatchRef(
  allow: Allowlist,
  repo: string,
  ref: string,
  repoDefault: string | null,
  isTag: boolean,
  poolLabels: readonly string[],
): RefVerdict {
  const accepted = allow.refs;
  const base = { accepted_refs: accepted, refusing_labels: [] as string[] };
  if (!repo.toLowerCase().startsWith(allow.owner.toLowerCase() + "/")) {
    return { ...base, served: "none", reason: `${repo} is not owned by ${allow.owner}` };
  }
  if (!allow.events.includes("workflow_dispatch")) {
    return { ...base, served: "none", reason: "workflow_dispatch is not a served event" };
  }
  const listed = (repoDefault !== null && ref === repoDefault) ||
    accepted.some((p) => p.endsWith("*") ? ref.startsWith(p.slice(0, -1)) : p === ref) ||
    (isTag && allow.tags);
  if (listed) {
    return {
      ...base,
      served: "all",
      reason: isTag ? "a tag" : ref === repoDefault ? "the default branch" : "a listed ref",
    };
  }
  const widened = new Set(allow.widened_labels.map((l) => l.toLowerCase()));
  const refusing = [...new Set(poolLabels)].filter((l) => !widened.has(l.toLowerCase())).sort();
  if (!allow.any_ref_events.includes("workflow_dispatch")) {
    return {
      ...base,
      served: "none",
      reason: `${ref} matches none of the listed refs`,
      refusing_labels: refusing,
    };
  }
  return {
    ...base,
    served: refusing.length === 0 ? "all" : "widened",
    reason: refusing.length === 0
      ? "any ref (every pool is widened)"
      : `${ref} matches none of the listed refs: pools not in widened_labels refuse it`,
    refusing_labels: refusing,
  };
}

/** A branch name under a listed prefix (`fix/x` for `fix/*`), as a suggestion. */
export function suggestRef(ref: string, accepted: readonly string[]): string[] {
  const leaf = ref.split("/").pop() ?? ref;
  return accepted.filter((p) => p.endsWith("/*")).map((p) => `${p.slice(0, -1)}${leaf}`).slice(
    0,
    4,
  );
}

// ---- protected runs ----

/**
 * Whether a run is on a protected branch: the repo's own default branch, or a branch Fleet's
 * settings protect (`branches.rules`), from the repo itself (a fork PR's `main` is not).
 */
export function isProtectedRun(
  repo: string,
  run: GhRun,
  repoDefault: string | null,
  s: FleetSettings,
): boolean {
  const branch = run.head_branch ?? "";
  if (!branch) return false;
  const head = run.head_repository?.full_name;
  const own = run.repository?.full_name ?? repo;
  if (typeof head === "string" && head.toLowerCase() !== own.toLowerCase()) return false;
  if (run.event === "pull_request" || run.event === "pull_request_target") return false;
  if (repoDefault !== null && branch === repoDefault) return true;
  return protectingRule(repo, branch, repoDefault, s) !== undefined;
}

// ---- jobs ----

const FAILED = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);

/** Whether a finished job is one GitHub's "re-run failed jobs" re-runs. */
export function jobFailed(j: Pick<GhJob, "status" | "conclusion">): boolean {
  return j.status === "completed" && FAILED.has(j.conclusion ?? "");
}

/** A job that picks the other jobs' runners (a `pick runners` job, the pick-runners action). */
export function isPickerJob(j: Pick<GhJob, "name">): boolean {
  return /^pick[ -]?runners?\b/i.test(j.name.trim());
}

/** What to ask GitHub for a re-run. */
export type RerunPlan =
  | { readonly kind: "refuse"; readonly why: string }
  | {
    readonly kind: "failed" | "job";
    /** `job`: the job to re-run (GitHub re-runs its dependents too). */
    readonly jobId?: number;
    /** What reroute did (for the answer and the audit). */
    readonly reroute: string;
    /** Passing jobs GitHub will run again (a picker re-run takes its dependents along). */
    readonly passingRerun: number;
  };

/**
 * The re-run: `want` is `failed` or job ids; with `reroute` and a picker job, the picker is re-run
 * (GitHub then re-runs every job that needs it, so routing is computed afresh). A protected run's
 * passing jobs are never re-run: reroute is skipped there, and a passing job asked for is refused.
 */
export function planRerun(
  jobs: readonly GhJob[],
  want: "failed" | readonly number[],
  reroute: boolean,
  protectedRun: boolean,
): RerunPlan {
  const failed = jobs.filter(jobFailed);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  let targets: GhJob[];
  if (want === "failed") {
    if (failed.length === 0) return { kind: "refuse", why: "no job of this run failed" };
    targets = failed;
  } else {
    const missing = want.filter((id) => !byId.has(id));
    if (missing.length) {
      return {
        kind: "refuse",
        why: `not jobs of this run's latest attempt: ${missing.join(", ")}`,
      };
    }
    targets = want.map((id) => byId.get(id)!);
    if (protectedRun) {
      const passing = targets.filter((j) => !jobFailed(j));
      if (passing.length) {
        return {
          kind: "refuse",
          why: `protected run: never re-runs passing jobs (${
            passing.map((j) => capText(j.name, 60)).join(", ")
          })`,
        };
      }
    }
  }
  const pickers = jobs.filter(isPickerJob);
  const passingCount = jobs.filter((j) => !jobFailed(j) && !isPickerJob(j)).length;
  if (reroute && pickers.length > 0) {
    if (protectedRun) {
      // The picker passed, and re-running it re-runs every job that needs it.
      const plain = plainPlan(
        targets,
        failed,
        "skipped: protected run (re-running the picker " +
          "would re-run its passing jobs)",
      );
      return plain;
    }
    const p = pickers[0];
    return {
      kind: "job",
      jobId: p.id,
      reroute: `picker "${capText(p.name, 40)}" re-run: GitHub re-runs every job that needs it` +
        (pickers.length > 1 ? ` (${pickers.length - 1} other picker job(s) not re-run)` : ""),
      passingRerun: passingCount,
    };
  }
  return plainPlan(
    targets,
    failed,
    reroute ? "none: this run has no picker job" : "off (the previous routing is reused)",
  );
}

function plainPlan(targets: GhJob[], failed: GhJob[], reroute: string): RerunPlan {
  const sameAsFailed = targets.length === failed.length &&
    targets.every((t) => failed.some((f) => f.id === t.id));
  if (sameAsFailed) return { kind: "failed", reroute, passingRerun: 0 };
  if (targets.length === 1) {
    return {
      kind: "job",
      jobId: targets[0].id,
      reroute,
      passingRerun: jobFailed(targets[0]) ? 0 : 1,
    };
  }
  return {
    kind: "refuse",
    why: "GitHub re-runs one job (with its dependents) or every failed job per call: " +
      'ask for one job id, or jobs: "failed"',
  };
}

// ---- GitHub-hosted families ----

/** A GitHub-hosted job's family from its runs-on labels: macos, ubuntu, windows or other. */
export function githubFamily(labels: readonly string[]): string {
  for (const l of labels) {
    const x = l.toLowerCase();
    if (x.startsWith("macos")) return "macos";
    if (x.startsWith("ubuntu")) return "ubuntu";
    if (x.startsWith("windows")) return "windows";
  }
  return "other";
}

/** A GitHub-hosted family counts as saturated once a job has queued this long. */
export const SATURATED_MS = 3 * 60_000;
