// The `ci` server's tools (mcp/ci-mcp.ts serves them): reads (ci_status, ci_logs, ci_capacity),
// the run-state evaluation behind ci_watch / ci_wait, and the guarded mutations (ci_dispatch,
// ci_rerun, ci_cancel) with their audit lines. Every GitHub call goes through `CiGitHub`, every file
// through the deps, so the tests run it with stubs. Fleet's cache (snapshot.json) is read first for
// anything it holds; GitHub is asked only for what it lacks or what a guard must see live.

import { type AgentSnapshot, agentText, capText } from "../lib/agent-snapshot.ts";
import {
  CI_AUDIT_FILE,
  CI_LEDGER_MAX_BYTES,
  CI_LEDGER_READ_MAX,
  CI_NOTICES_FILE,
  type CiAuditRecord,
  type CiNoticeRecord,
  type CiOwnership,
  ownershipOf,
  parseCiText,
} from "../lib/ci-ledger.ts";
import { runProvenance } from "../lib/classify.ts";
import type { GhJob, GhRun } from "../lib/github-types.ts";
import { DEFAULT_SETTINGS, type FleetSettings, validateSettings } from "../lib/settings.ts";
import {
  type Allowlist,
  ArgError,
  canonicalInputs,
  fullRepoArg,
  inputsArg,
  isProtectedRun,
  jobFailed,
  optBool,
  optCount,
  optInt,
  optStr,
  ownerArg,
  parseAllowlist,
  planRerun,
  purposeArg,
  refArg,
  reqInt,
  reqStr,
  shaArg,
  skipCiMarker,
  suggestRef,
  vetDispatchRef,
  workflowArg,
} from "./ci-guards.ts";
import { type CiGitHub, GitHubError } from "./ci-github.ts";
import { freshness } from "./queries.ts";
import {
  annotationsOut,
  failedTests,
  familiesOut,
  type GhCheckAnnotation,
  grepLines,
  jobOut,
  logLines,
  ms,
  poolsOut,
  schedulerOut,
  type SharedBudget,
  sharedOut,
} from "./ci-read.ts";

export type { SharedBudget };

type Json = Record<string, unknown>;

/** Where the files are. */
export interface CiPaths {
  /** Fleet's data folder (snapshot.json, fleet-settings.json). */
  readonly dataDir: string;
  /** The runner scheduler's folder (health.json; the ledger is written here). `null`: none. */
  readonly runnersDir: string | null;
  /** The runner scheduler's allowlist.json (read-only), or `null`. */
  readonly allowlist: string | null;
  /** A `KEY=value` file (the scheduler's tunables) a shared budget's maximum is read from. */
  readonly tunables: string | null;
  /** Pools that share one machine's VM budget (ci_capacity), or `null`. */
  readonly shared?: SharedBudget | null;
}

/** What the tools need from the machine. */
export interface CiDeps {
  readonly paths: CiPaths;
  readonly github: CiGitHub;
  readonly now: () => number;
  /** A text file's content, or `null` when it can't be read. */
  readonly readText: (path: string) => Promise<string | null>;
  /** Append one line (with its newline) to a ledger file. */
  readonly append: (path: string, line: string) => Promise<void>;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const enc = (ref: string) => ref.split("/").map(encodeURIComponent).join("/");

/** The default Deno file access (the server's own, under its --allow-read / --allow-write). */
export const fileDeps = {
  async readText(path: string): Promise<string | null> {
    try {
      const st = await Deno.stat(path);
      if (st.size <= CI_LEDGER_READ_MAX) return await Deno.readTextFile(path);
      const f = await Deno.open(path, { read: true });
      try {
        await f.seek(st.size - CI_LEDGER_READ_MAX, Deno.SeekMode.Start);
        const buf = new Uint8Array(CI_LEDGER_READ_MAX);
        let off = 0;
        while (off < buf.length) {
          const n = await f.read(buf.subarray(off));
          if (n === null) break;
          off += n;
        }
        const text = new TextDecoder().decode(buf.subarray(0, off));
        return text.slice(text.indexOf("\n") + 1);
      } finally {
        f.close();
      }
    } catch {
      return null;
    }
  },
  async append(path: string, line: string): Promise<void> {
    try {
      if ((await Deno.stat(path)).size > CI_LEDGER_MAX_BYTES) await Deno.rename(path, `${path}.1`);
    } catch {
      // Not there yet, or another server rotated it first.
    }
    // One write with O_APPEND: lines from several agents' servers never interleave.
    await Deno.writeTextFile(path, line, { append: true, create: true, mode: 0o600 });
  },
};

/** One run's state as ci_watch / ci_wait report it. */
export interface RunState {
  readonly repo: string;
  readonly run_id: number;
  readonly status: string;
  readonly conclusion: string | null;
  readonly failed_jobs: readonly string[];
  readonly html_url: string | null;
  /** Where it came from: Fleet's cache or GitHub. */
  readonly source: "fleet" | "github";
}

/** The tools over `deps`. */
export class CiTools {
  readonly deps: CiDeps;
  #defaults = new Map<string, { branch: string | null; at: number }>();
  #ghRuns = new Map<number, { at: number; state: RunState }>();

  constructor(deps: CiDeps) {
    this.deps = deps;
  }

  // ---- files ----

  async snapshot(): Promise<AgentSnapshot | null> {
    const raw = await this.deps.readText(join(this.deps.paths.dataDir, "snapshot.json"));
    if (!raw) return null;
    try {
      const s = JSON.parse(raw) as AgentSnapshot;
      return s?.v === 1 && Array.isArray(s.runs) && Array.isArray(s.jobs) ? s : null;
    } catch {
      return null;
    }
  }

  async #json(path: string | null): Promise<unknown> {
    if (!path) return null;
    const raw = await this.deps.readText(path);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async settings(): Promise<FleetSettings> {
    const raw = await this.#json(join(this.deps.paths.dataDir, "fleet-settings.json"));
    const r = raw === null ? null : validateSettings(raw);
    return r?.ok ? r.settings : DEFAULT_SETTINGS;
  }

  async health(): Promise<Json | null> {
    const dir = this.deps.paths.runnersDir;
    const h = await this.#json(dir ? join(dir, "health.json") : null);
    return typeof h === "object" && h !== null ? h as Json : null;
  }

  async allowlist(): Promise<Allowlist | null> {
    return parseAllowlist(await this.#json(this.deps.paths.allowlist));
  }

  /** The audit ledger (the newest 2 MB). */
  async ledger(): Promise<CiAuditRecord[]> {
    const dir = this.deps.paths.runnersDir;
    if (!dir) return [];
    const text = await this.deps.readText(join(dir, CI_AUDIT_FILE));
    return text ? parseCiText(text).filter((r): r is CiAuditRecord => r.kind === "audit") : [];
  }

  async ownership(): Promise<Map<number, CiOwnership>> {
    return ownershipOf(await this.ledger());
  }

  #ledgerDir(): string {
    const dir = this.deps.paths.runnersDir;
    if (!dir) {
      throw new ArgError(
        "No runner folder: start the ci server with --runners-dir (the audit log lives there).",
      );
    }
    return dir;
  }

  async audit(rec: Omit<CiAuditRecord, "v" | "kind" | "at">): Promise<string | null> {
    const line: CiAuditRecord = { v: 1, kind: "audit", at: this.deps.now(), ...rec };
    try {
      await this.deps.append(join(this.#ledgerDir(), CI_AUDIT_FILE), JSON.stringify(line) + "\n");
      return null;
    } catch {
      return "the audit line couldn't be written";
    }
  }

  async notice(rec: Omit<CiNoticeRecord, "v" | "kind" | "at">): Promise<void> {
    const dir = this.deps.paths.runnersDir;
    if (!dir) return;
    const line: CiNoticeRecord = { v: 1, kind: "notice", at: this.deps.now(), ...rec };
    await this.deps.append(join(dir, CI_NOTICES_FILE), JSON.stringify(line) + "\n").catch(() => {});
  }

  // ---- GitHub helpers ----

  async repoDefault(repo: string, signal?: AbortSignal): Promise<string | null> {
    const hit = this.#defaults.get(repo.toLowerCase());
    if (hit && this.deps.now() - hit.at < 3600_000) return hit.branch;
    let branch: string | null = null;
    try {
      const r = await this.deps.github.get<{ default_branch?: string }>(`/repos/${repo}`, signal);
      branch = typeof r.default_branch === "string" ? r.default_branch : null;
    } catch (err) {
      if (!(err instanceof GitHubError && err.kind === "not-found")) throw err;
    }
    this.#defaults.set(repo.toLowerCase(), { branch, at: this.deps.now() });
    return branch;
  }

  async run(repo: string, id: number, signal?: AbortSignal): Promise<GhRun> {
    return await this.deps.github.get<GhRun>(`/repos/${repo}/actions/runs/${id}`, signal);
  }

  async jobs(repo: string, id: number, signal?: AbortSignal): Promise<GhJob[]> {
    const out: GhJob[] = [];
    for (let page = 1; page <= 3; page++) {
      const r = await this.deps.github.get<{ jobs?: GhJob[]; total_count?: number }>(
        `/repos/${repo}/actions/runs/${id}/jobs?filter=latest&per_page=100&page=${page}`,
        signal,
      );
      out.push(...(r.jobs ?? []));
      if ((r.jobs ?? []).length < 100) break;
    }
    return out;
  }

  /**
   * The repo a call is about: `owner/name` as given, a bare name under the one watched owner, or the
   * run's repo from Fleet's cache.
   */
  async resolveRepo(args: Json, runId?: number, jobId?: number): Promise<string> {
    const raw = optStr(args, "repo", 140);
    const snap = await this.snapshot();
    if (raw?.includes("/")) return fullRepoArg(raw);
    if (raw) {
      const owners = snap?.owners ?? [];
      if (owners.length === 1) return fullRepoArg(`${owners[0]}/${raw}`);
      throw new ArgError("repo must be owner/name (Fleet watches more than one owner)");
    }
    const hit = runId !== undefined
      ? snap?.runs.find((r) => r.run_id === runId)?.repo ??
        snap?.jobs.find((j) => j.run_id === runId)?.repo
      : snap?.jobs.find((j) => j.job_id === jobId)?.repo;
    if (hit) return hit;
    throw new ArgError("repo is required (Fleet's cache doesn't hold this run / job)");
  }

  // ---- pools ----

  // ---- ci_status ----

  async status(args: Json, signal?: AbortSignal) {
    const runId = reqInt(args, "run_id");
    const repo = await this.resolveRepo(args, runId);
    const [run, jobs, health, owners, s] = await Promise.all([
      this.run(repo, runId, signal),
      this.jobs(repo, runId, signal),
      this.health(),
      this.ownership(),
      this.settings(),
    ]);
    const def = await this.repoDefault(repo, signal);
    const prov = runProvenance(repo, run, def);
    const untrusted = prov.untrusted;
    const now = this.deps.now();
    const failed = jobs.filter(jobFailed).slice(0, 8);
    const notes = new Map<number, unknown[]>();
    await Promise.all(failed.map(async (j) => {
      notes.set(j.id, await this.#annotations(repo, j.id, untrusted, signal));
    }));
    const own = owners.get(runId) ?? null;
    return {
      repo,
      run_id: runId,
      workflow: capText(run.name ?? "", 120),
      title: agentText(run.display_title ?? "", 120, untrusted),
      branch: capText(run.head_branch ?? "", 120),
      sha: run.head_sha,
      event: run.event,
      attempt: run.run_attempt ?? null,
      status: run.status,
      conclusion: run.conclusion ?? null,
      protected: isProtectedRun(repo, run, def, s),
      untrusted,
      owner: own?.owner ?? null,
      purpose: own?.purpose ?? null,
      created_at: run.created_at,
      html_url: run.html_url,
      counts: jobCounts(jobs),
      jobs: jobs.map((j) => jobOut(j, health, now, untrusted, notes.get(j.id))),
    };
  }

  async #annotations(repo: string, jobId: number, untrusted: boolean, signal?: AbortSignal) {
    try {
      const list = await this.deps.github.get<GhCheckAnnotation[]>(
        `/repos/${repo}/check-runs/${jobId}/annotations?per_page=50`,
        signal,
      );
      return annotationsOut(list, untrusted);
    } catch {
      return [];
    }
  }

  // ---- ci_logs ----

  async logs(args: Json, signal?: AbortSignal) {
    const jobId = reqInt(args, "job_id");
    const repo = await this.resolveRepo(args, undefined, jobId);
    const grep = optStr(args, "grep", 200);
    const context = Math.min(optCount(args, "context") ?? 2, 10);
    const tail = Math.min(optInt(args, "tail") ?? 150, 1000);
    const maxMatches = Math.min(optInt(args, "max_matches") ?? 40, 200);
    let re: RegExp | null = null;
    if (grep) {
      try {
        re = new RegExp(grep, optBool(args, "case_sensitive", false) ? "" : "i");
      } catch {
        throw new ArgError("grep must be a valid regular expression");
      }
    }
    const job = await this.deps.github.get<GhJob>(`/repos/${repo}/actions/jobs/${jobId}`, signal);
    const base = { repo, job_id: jobId, name: capText(job.name, 120), status: job.status };
    if (job.status !== "completed") {
      return {
        ...base,
        available: false,
        message: `GitHub serves a job's log once the job completes (this one is ${job.status}); ` +
          "it is available when the job (at the latest the run) completes. Meanwhile ci_status " +
          "shows its steps; ci_watch / ci_wait tell you when it finishes.",
      };
    }
    let log;
    try {
      log = await this.deps.github.log(
        `/repos/${repo}/actions/jobs/${jobId}/logs`,
        4 * 1024 * 1024,
        signal,
      );
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "not-found") {
        return {
          ...base,
          available: false,
          message: "GitHub has no log for this job yet (or it expired): it is available when " +
            "the run completes. Try again after ci_watch / ci_wait reports the run finished.",
        };
      }
      throw err;
    }
    const lines = logLines(log.text);
    // A failed job's answer names its failed tests, whatever excerpt was asked for.
    const failed = job.conclusion === "success" ? null : failedTests(lines);
    const done = {
      ...base,
      available: true,
      conclusion: job.conclusion ?? null,
      total_lines: lines.length,
      truncated: log.truncated,
      ...(failed && failed.tests.length
        ? {
          failed_tests: failed.tests.map((t) => capText(t, 200)),
          ...(failed.more ? { failed_tests_more: true } : {}),
        }
        : {}),
    };
    if (!re) return { ...done, text: lines.slice(-tail).join("\n") };
    return { ...done, ...grepLines(lines, re, context, maxMatches) };
  }

  // ---- ci_capacity ----

  async capacity() {
    const now = this.deps.now();
    const [snap, health, tun] = await Promise.all([
      this.snapshot(),
      this.health(),
      this.deps.paths.tunables ? this.deps.readText(this.deps.paths.tunables) : null,
    ]);
    const ghNow = now + (snap?.clock_offset_ms ?? 0);
    const pools = poolsOut(snap, health, ghNow);
    const families = familiesOut(snap, ghNow);
    return {
      ...freshness(snap, now),
      pools,
      free_slots: pools.reduce((n, p) => n + (p.free ?? 0), 0),
      github: { families, saturated: families.filter((f) => f.saturated).map((f) => f.family) },
      shared_budget: sharedOut(this.deps.paths.shared ?? null, pools, tun),
      scheduler: schedulerOut(health, now),
    };
  }

  // ---- run state (ci_watch / ci_wait) ----

  /**
   * A run's state: from Fleet's cache when fresh and it holds the run, else GitHub (at most every
   * `ghEveryMs` per run; the last answer is reused in between).
   */
  async runState(
    repo: string | null,
    runId: number,
    ghEveryMs: number,
    signal?: AbortSignal,
  ): Promise<RunState | null> {
    const cached = stateFromSnapshot(await this.snapshot(), runId, this.deps.now());
    if (cached) return cached;
    const hit = this.#ghRuns.get(runId);
    if (hit && this.deps.now() - hit.at < ghEveryMs) return hit.state;
    const rp = repo ?? hit?.state.repo ?? null;
    return rp ? await this.#stateFromGitHub(rp, runId, signal) : null;
  }

  async #stateFromGitHub(repo: string, runId: number, signal?: AbortSignal): Promise<RunState> {
    const run = await this.run(repo, runId, signal);
    const clean = run.status === "completed" && run.conclusion === "success";
    const failed = clean
      ? []
      : (await this.jobs(repo, runId, signal)).filter(jobFailed).map((j) => capText(j.name, 120));
    const state: RunState = {
      repo,
      run_id: runId,
      status: run.status ?? "unknown",
      conclusion: run.conclusion ?? null,
      failed_jobs: failed,
      html_url: run.html_url,
      source: "github",
    };
    this.#ghRuns.set(runId, { at: this.deps.now(), state });
    if (this.#ghRuns.size > 500) this.#ghRuns.delete(this.#ghRuns.keys().next().value!);
    return state;
  }

  // ---- ci_dispatch ----

  async dispatch(args: Json, signal?: AbortSignal) {
    const repo = fullRepoArg(args.repo);
    const workflow = workflowArg(args);
    const ref = refArg(args);
    const expect = shaArg(args);
    const inputs = inputsArg(args);
    const purpose = purposeArg(args);
    const owner = ownerArg(args);
    const unlistedOk = optBool(args, "unlisted_ref_ok", false);
    this.#ledgerDir();
    const base = { owner, purpose, repo, workflow, ref, inputs: canonicalInputs(inputs) };
    try {
      const def = await this.repoDefault(repo, signal);
      const head = await this.#checkHead(repo, ref, expect, signal);
      const sha = head.sha;
      const allowlist = await this.#checkAllowlist(repo, ref, def, head.tag, unlistedOk);
      const marker = await this.#checkSkipCi(repo, sha, purpose, signal);
      const twin = await this.#inflightTwin(repo, workflow, ref, sha, base.inputs, signal);
      if (twin) {
        const auditError = await this.audit({
          op: "dispatch",
          ok: true,
          run_id: twin.run_id,
          ...base,
          sha,
          deduped: true,
          url: twin.html_url,
        });
        return withAudit({
          ok: true,
          deduped: true,
          run_id: twin.run_id,
          html_url: twin.html_url,
          dispatched_by: twin.owner,
          message: `an identical dispatch (run ${twin.run_id}, by ${twin.owner}) is still ` +
            `${twin.status}: no new run`,
          allowlist,
        }, auditError);
      }
      const run = await this.#send(repo, workflow, ref, inputs, sha, signal);
      const auditError = await this.audit({ op: "dispatch", ok: true, ...base, sha, ...run });
      return withAudit({
        ok: true,
        deduped: false,
        run_id: run.run_id,
        html_url: run.url,
        sha,
        ...(marker ? { note: `the head carries ${marker} (fine for ${purpose})` } : {}),
        ...(run.run_id === null ? { warning: NO_RUN_ID } : {}),
        allowlist,
      }, auditError);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      const auditError = await this.audit({
        op: "dispatch",
        ok: false,
        run_id: null,
        ...base,
        refused: err.message,
      });
      return withAudit({ ok: false, refused: err.message, ...err.extra }, auditError);
    }
  }

  /** The ref's head on GitHub, which must be the SHA the caller pushed. */
  async #checkHead(repo: string, ref: string, expect: string, signal?: AbortSignal) {
    const resolved = await this.#resolveRef(repo, ref, signal);
    if (!resolved) throw new Refusal(`${ref} is not a branch or tag of ${repo} on GitHub`);
    if (!resolved.sha.startsWith(expect)) {
      throw new Refusal(
        `${ref} is at ${resolved.sha.slice(0, 12)} on GitHub, not ${expect.slice(0, 12)}: ` +
          "your push didn't land (or someone pushed since). Push, then dispatch with the new SHA.",
        { remote_sha: resolved.sha },
      );
    }
    return resolved;
  }

  /** The runner allowlist's verdict on the ref (read-only); refuses what a pool would refuse. */
  async #checkAllowlist(
    repo: string,
    ref: string,
    def: string | null,
    tag: boolean,
    unlistedOk: boolean,
  ): Promise<Json> {
    const allow = await this.allowlist();
    if (!allow) return { checked: false, note: "no allowlist configured (--allowlist)" };
    const health = await this.health();
    const labels = Object.values((health?.pools ?? {}) as Record<string, Json>).flatMap((p) =>
      Array.isArray(p.labels) ? p.labels.filter((l): l is string => typeof l === "string") : []
    );
    const v = vetDispatchRef(allow, repo, ref, def, tag, labels);
    const allowlist = { checked: true, ...v };
    const eg = suggestRef(ref, allow.refs);
    const fix = `Accepted everywhere: the default branch${def ? ` (${def})` : ""}, a tag, or ` +
      allow.refs.join(", ") + (eg.length ? ` (e.g. ${eg.join(", ")})` : "");
    if (v.served === "none") {
      throw new Refusal(`the runner allowlist refuses it: ${v.reason}. ${fix}`, { allowlist });
    }
    if (v.served === "widened" && !unlistedOk) {
      throw new Refusal(
        `${v.reason} (${v.refusing_labels.join(", ")}): a job routed there is refused and the ` +
          `pool closes. ${fix}. Pass unlisted_ref_ok: true only when no job of this workflow ` +
          "can reach those pools.",
        { allowlist },
      );
    }
    return allowlist;
  }

  /** The head commit's [skip ci] marker (refused for a release gate), or `null`. */
  async #checkSkipCi(repo: string, sha: string, purpose: string, signal?: AbortSignal) {
    const commit = await this.deps.github.get<{ message?: string }>(
      `/repos/${repo}/git/commits/${sha}`,
      signal,
    );
    const marker = skipCiMarker(commit.message ?? "");
    if (marker && purpose === "release-gate") {
      throw new Refusal(
        `the head commit's message carries ${marker}: the release script doesn't count a run of ` +
          "a [skip ci] commit. Make a commit without it (or dispatch for another purpose).",
      );
    }
    return marker;
  }

  /** POST the dispatch; the run from GitHub's answer, else found by SHA. */
  async #send(
    repo: string,
    workflow: string,
    ref: string,
    inputs: Record<string, string>,
    sha: string,
    signal?: AbortSignal,
  ): Promise<{ run_id: number | null; url: string | null }> {
    const since = this.deps.now();
    const res = await this.deps.github.post(
      `/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
      { ref, inputs, return_run_details: true },
      signal,
    );
    const body = (res.body ?? {}) as { workflow_run_id?: unknown; html_url?: unknown };
    if (typeof body.workflow_run_id === "number") {
      return {
        run_id: body.workflow_run_id,
        url: typeof body.html_url === "string" ? body.html_url : null,
      };
    }
    const found = await this.#findDispatched(repo, workflow, sha, since, signal);
    return { run_id: found?.id ?? null, url: found?.html_url ?? null };
  }

  async #resolveRef(
    repo: string,
    ref: string,
    signal?: AbortSignal,
  ): Promise<{ sha: string; tag: boolean } | null> {
    type Ref = { object?: { sha?: string; type?: string } };
    const get = async (kind: "heads" | "tags") => {
      try {
        return await this.deps.github.get<Ref | Ref[]>(
          `/repos/${repo}/git/ref/${kind}/${enc(ref)}`,
          signal,
        );
      } catch (err) {
        if (err instanceof GitHubError && err.kind === "not-found") return null;
        throw err;
      }
    };
    const head = await get("heads");
    if (head && !Array.isArray(head) && head.object?.sha) {
      return { sha: head.object.sha.toLowerCase(), tag: false };
    }
    const tag = await get("tags");
    if (!tag || Array.isArray(tag) || !tag.object?.sha) return null;
    if (tag.object.type === "tag") {
      const t = await this.deps.github.get<Ref>(
        `/repos/${repo}/git/tags/${tag.object.sha}`,
        signal,
      );
      return t.object?.sha ? { sha: t.object.sha.toLowerCase(), tag: true } : null;
    }
    return { sha: tag.object.sha.toLowerCase(), tag: true };
  }

  async #inflightTwin(
    repo: string,
    workflow: string,
    ref: string,
    sha: string,
    inputs: string,
    signal?: AbortSignal,
  ) {
    const now = this.deps.now();
    const same = (await this.ledger()).filter((r) =>
      r.op === "dispatch" && r.ok && r.run_id !== null && now - r.at < 24 * 3600_000 &&
      r.repo.toLowerCase() === repo.toLowerCase() && r.workflow === workflow && r.ref === ref &&
      r.sha === sha && (r.inputs ?? "{}") === inputs
    ).reverse();
    const seen = new Set<number>();
    for (const r of same) {
      if (seen.has(r.run_id!)) continue;
      seen.add(r.run_id!);
      const st = await this.runState(repo, r.run_id!, 0, signal).catch(() => null);
      if (st && st.status !== "completed") {
        return { run_id: r.run_id!, owner: r.owner, status: st.status, html_url: st.html_url };
      }
    }
    return null;
  }

  async #findDispatched(
    repo: string,
    workflow: string,
    sha: string,
    since: number,
    signal?: AbortSignal,
  ) {
    const known = new Set((await this.ledger()).map((r) => r.run_id));
    for (let i = 0; i < 4; i++) {
      await this.deps.sleep(2000, signal);
      const r = await this.deps.github.get<{ workflow_runs?: GhRun[] }>(
        `/repos/${repo}/actions/workflows/${
          encodeURIComponent(workflow)
        }/runs?event=workflow_dispatch&head_sha=${sha}&per_page=20`,
        signal,
      ).catch(() => null);
      const hit = (r?.workflow_runs ?? []).filter((x) =>
        !known.has(x.id) && (ms(x.created_at) ?? 0) >= since - 10_000
      ).sort((a, b) =>
        b.id - a.id
      )[0];
      if (hit) return hit;
    }
    return null;
  }

  // ---- ci_rerun ----

  async rerun(args: Json, signal?: AbortSignal) {
    const runId = reqInt(args, "run_id");
    const owner = ownerArg(args);
    const purpose = purposeArg(args, "rerun");
    const reroute = optBool(args, "reroute", true);
    const want = jobsArg(args);
    this.#ledgerDir();
    const repo = await this.resolveRepo(args, runId);
    const jobsAsked = want === "failed" ? "failed" : want.join(",");
    const base = { owner, purpose, repo, run_id: runId, jobs: jobsAsked };
    const [run, jobs, s] = await Promise.all([
      this.run(repo, runId, signal),
      this.jobs(repo, runId, signal),
      this.settings(),
    ]);
    const prot = isProtectedRun(repo, run, await this.repoDefault(repo, signal), s);
    const plan = run.status === "completed" ? planRerun(jobs, want, reroute, prot) : {
      kind: "refuse" as const,
      why: `run ${runId} is ${run.status}: GitHub re-runs only a finished run (wait, or ` +
        "cancel it first)",
    };
    if (plan.kind === "refuse") {
      const auditError = await this.audit({ op: "rerun", ok: false, ...base, refused: plan.why });
      return withAudit({ ok: false, refused: plan.why }, auditError);
    }
    const path = plan.kind === "failed"
      ? `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`
      : `/repos/${repo}/actions/jobs/${plan.jobId}/rerun`;
    await this.deps.github.post(path, undefined, signal);
    const auditError = await this.audit({
      op: "rerun",
      ok: true,
      ...base,
      reroute: plan.reroute,
      ...runFields(run),
    });
    return withAudit({
      ok: true,
      run_id: runId,
      protected: prot,
      asked: plan.kind === "failed"
        ? "re-run failed jobs"
        : `re-run job ${plan.jobId} (and the jobs that need it)`,
      reroute: plan.reroute,
      passing_jobs_rerun: plan.passingRerun,
      html_url: run.html_url,
    }, auditError);
  }

  // ---- ci_cancel ----

  async cancel(args: Json, signal?: AbortSignal) {
    const runId = reqInt(args, "run_id");
    const owner = ownerArg(args);
    const reason = reqStr(args, "reason", 300);
    const supersededBy = optInt(args, "superseded_by") ?? null;
    this.#ledgerDir();
    const repo = await this.resolveRepo(args, runId);
    const base = { owner, purpose: "", repo, run_id: runId, reason, superseded_by: supersededBy };
    try {
      const { run, own } = await this.#checkCancel(repo, runId, owner, supersededBy, signal);
      await this.deps.github.post(`/repos/${repo}/actions/runs/${runId}/cancel`, undefined, signal);
      const auditError = await this.audit({
        op: "cancel",
        ok: true,
        ...base,
        purpose: own?.purpose ?? "",
        ...runFields(run),
      });
      return withAudit({
        ok: true,
        run_id: runId,
        owner_was: own?.owner ?? null,
        html_url: run.html_url,
      }, auditError);
    } catch (err) {
      if (!(err instanceof Refusal)) throw err;
      const auditError = await this.audit({
        op: "cancel",
        ok: false,
        ...base,
        refused: err.message,
      });
      return withAudit({ ok: false, refused: err.message }, auditError);
    }
  }

  /** The cancel guards: not finished, not protected, the caller's (or superseded). */
  async #checkCancel(
    repo: string,
    runId: number,
    owner: string,
    supersededBy: number | null,
    signal?: AbortSignal,
  ) {
    const [run, s, owners] = await Promise.all([
      this.run(repo, runId, signal),
      this.settings(),
      this.ownership(),
    ]);
    if (run.status === "completed") throw new Refusal(`run ${runId} already completed`);
    if (isProtectedRun(repo, run, await this.repoDefault(repo, signal), s)) {
      throw new Refusal(
        `run ${runId} is on protected branch ${run.head_branch}: never cancelled here`,
      );
    }
    const own = owners.get(runId) ?? null;
    if (own && own.owner !== owner && supersededBy === null) {
      throw new Refusal(
        `run ${runId} belongs to ${own.owner} (${own.purpose}): pass superseded_by with the run ` +
          "that replaces it, or ask its owner",
      );
    }
    if (supersededBy !== null) await this.#checkSuperseding(repo, runId, supersededBy, signal);
    return { run, own };
  }

  async #checkSuperseding(repo: string, runId: number, by: number, signal?: AbortSignal) {
    if (by === runId) throw new Refusal("superseded_by is this run");
    try {
      await this.run(repo, by, signal);
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "not-found") {
        throw new Refusal(`superseded_by ${by} is not a run of ${repo}`);
      }
      throw err;
    }
  }
}

/** Jobs by state: a finished job by its conclusion, the rest by status. */
function jobCounts(jobs: readonly GhJob[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const j of jobs) {
    const k = j.status === "completed" ? j.conclusion ?? "completed" : j.status;
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}

/** A run's state from Fleet's cache, when it is fresh and holds the run. */
function stateFromSnapshot(
  snap: AgentSnapshot | null,
  runId: number,
  now: number,
): RunState | null {
  if (!snap || freshness(snap, now).stale) return null;
  const r = snap.runs.find((x) => x.run_id === runId);
  if (!r) return null;
  return {
    repo: r.repo,
    run_id: runId,
    status: r.status,
    conclusion: r.conclusion,
    failed_jobs: snap.jobs.filter((j) => j.run_id === runId && jobFailed(j)).map((j) => j.name),
    html_url: r.html_url,
    source: "fleet",
  };
}

/** A guard's refusal: audited, then answered as `{ ok: false, refused }`. */
class Refusal extends Error {
  constructor(message: string, readonly extra: Json = {}) {
    super(message);
  }
}

const NO_RUN_ID = "dispatched, but GitHub didn't name the run yet: find it with fleet_runs (sha)";

/** A run's fields for its audit line. */
function runFields(run: GhRun) {
  return {
    workflow: capText(run.name ?? "", 120),
    ref: run.head_branch ?? undefined,
    sha: run.head_sha,
    url: run.html_url,
  };
}

/** An answer with the audit failure, when there was one. */
function withAudit<T extends Json>(answer: T, auditError: string | null): T {
  return auditError ? { ...answer, audit_error: auditError } : answer;
}

/** ci_rerun's `jobs`: `"failed"` (default) or job ids. */
function jobsArg(args: Json): "failed" | number[] {
  const v = args.jobs;
  if (v === undefined || v === null || v === "failed") return "failed";
  if (!Array.isArray(v) || v.length === 0 || v.length > 50) {
    throw new ArgError('jobs must be "failed" or a list of job ids');
  }
  return v.map((x) => {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) {
      throw new ArgError("jobs must hold job ids");
    }
    return x;
  });
}
