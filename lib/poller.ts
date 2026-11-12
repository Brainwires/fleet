// The poller: one round reads the org's repos (every 10 min), the active runs of the watched repos,
// each active run's jobs, the org's runners and the pool-health variable, then builds a Snapshot.
// Runs that leave the active set get one last jobs read, so their conclusions reach "recently
// finished" and their lengths the usual-length history. Every GitHub call goes through the
// injected client (ETag cache, rate limit, back-off); a failed call keeps the last good data.

import { type ActiveRun, durationKey, median, time } from "./classify.ts";
import type { GitHubClient } from "./github.ts";
import { GitHubError } from "./github.ts";
import type {
  GhAnnotation,
  GhJob,
  GhJobList,
  GhRepo,
  GhRun,
  GhRunList,
  GhRunner,
  GhRunnerList,
  GhVariable,
} from "./github-types.ts";
import { type HealthState, parsePoolHealth } from "./health.ts";
import type { AuthState, FinishedJob, Snapshot } from "./model.ts";
import {
  CORE_REPOS,
  DEFAULT_BRANCHES,
  derivePools,
  GITHUB_POOL,
  ORG,
  poolFromLabels,
  poolFromRunnerName,
  setPools,
} from "./pools.ts";
import { buildSnapshot } from "./snapshot.ts";
import { type HookDelivery, payloadRepo } from "./hooks.ts";

/** One run as the event tracker sees it after a round: active, or just finished (final state). */
export interface ObservedRun {
  readonly repo: string;
  readonly run: GhRun;
  readonly jobs: readonly GhJob[];
}

/** What one round saw, for the event log (lib/events.ts). */
export interface Observation {
  readonly now: number;
  /** The active runs, and the runs that finished since the last round (with their final jobs). */
  readonly runs: readonly ObservedRun[];
  readonly health: HealthState;
  /** The first failure annotation of failed jobs, by job id. */
  readonly annotations: ReadonlyMap<number, string>;
}

/** Conclusions that get a failure annotation read. */
const FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

/** The org's repo list is re-read this often (and every repo swept for runs then). */
export const REPOS_REFRESH_MS = 10 * 60_000;
/** A repo with no active run on this many polls in a row is idle… */
export const IDLE_AFTER_POLLS = 3;
/** …and is polled this often (and on the 10-minute sweep). */
export const IDLE_POLL_MS = 5 * 60_000;
/** "Recently finished" keeps this long. */
export const FINISHED_KEEP_MS = 30 * 60_000;
/** An endpoint refused for permissions (403) is retried this often. */
export const FORBIDDEN_RETRY_MS = 10 * 60_000;
/** The run statuses that count as active. */
export const ACTIVE_STATUSES = ["queued", "in_progress", "waiting"] as const;
/** Lengths remembered per job. */
export const DURATION_SAMPLES = 10;
/** Samples needed before a usual length is shown. */
export const MIN_SAMPLES = 3;
/** Pages of jobs read per run at most (100 a page). */
const MAX_JOB_PAGES = 3;
/** Requests in flight at once. */
const CONCURRENCY = 6;

/** The org variable. */
export const HEALTH_VARIABLE = "DENEXT_POOL_HEALTH";

/** What survives a relaunch (no token). */
export interface PersistedState {
  readonly durations: Record<string, number[]>;
  readonly notified: Record<string, number>;
  readonly prefs?: {
    readonly notificationsPaused?: boolean;
    readonly loginDefaulted?: boolean;
    readonly launched?: boolean;
  };
}

/** The poller's options. */
export interface PollerOptions {
  readonly client: GitHubClient;
  readonly auth: AuthState;
  readonly now?: () => number;
  /** Lengths learned before (from {@linkcode PersistedState}). */
  readonly durations?: Record<string, number[]>;
  /** Unauthenticated: only the core repos, no org endpoints. */
  readonly publicOnly?: boolean;
  /** The Mac mini's local health (fresher than the variable), merged over it. */
  readonly localHealth?: (variable: HealthState) => Promise<HealthState>;
}

/** Run `fn` over `items`, at most `n` at a time. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/** The poller. */
export class Poller {
  readonly #client: GitHubClient;
  readonly #now: () => number;
  readonly #publicOnly: boolean;
  readonly #localHealth?: (variable: HealthState) => Promise<HealthState>;
  #auth: AuthState;
  #repos: GhRepo[] = [];
  #reposAt = -Infinity;
  #runs = new Map<number, ActiveRun>();
  #jobs = new Map<number, GhJob[]>();
  #runners: GhRunner[] | null = null;
  #health: HealthState = { state: "unavailable", message: "pool health not read yet" };
  #finished = new Map<number, FinishedJob>();
  #durations = new Map<string, number[]>();
  #counted = new Set<number>();
  #forbidden = new Map<string, number>();
  /** Polls in a row each repo had no active run, and when it was last polled. */
  #idle = new Map<string, number>();
  #polledAt = new Map<string, number>();
  /** Each active run's `updated_at` when its jobs were last read. */
  #runUpdated = new Map<number, string>();
  #lastOk: number | null = null;
  #lastError = "";
  #ok = true;
  #intervalMs = 15_000;
  #rounds = 0;
  #finishedRuns: ObservedRun[] = [];
  #annotations = new Map<number, string>();
  #annotated = new Set<number>();

  constructor(options: PollerOptions) {
    this.#client = options.client;
    this.#auth = options.auth;
    this.#now = options.now ?? Date.now;
    this.#publicOnly = options.publicOnly ?? false;
    this.#localHealth = options.localHealth;
    for (const [k, v] of Object.entries(options.durations ?? {})) {
      if (Array.isArray(v)) this.#durations.set(k, v.filter((n) => typeof n === "number"));
    }
  }

  /** The poll interval the scheduler uses (shown in the status line). */
  set intervalMs(ms: number) {
    this.#intervalMs = ms;
  }

  /** Why polling is slowed (shown as a banner). */
  slow: "low" | "floor" | "budget" | null = null;

  /** The learned lengths, for persisting. */
  durations(): Record<string, number[]> {
    return Object.fromEntries(this.#durations);
  }

  /** The usual length of a job. */
  usual = (repo: string, workflow: string, job: string): number | null => {
    const d = this.#durations.get(durationKey(repo, workflow, job));
    return d && d.length >= MIN_SAMPLES ? median(d) : null;
  };

  /** One GET, a 403 permission refusal remembered so it isn't retried every round. */
  async #get<T>(path: string): Promise<{ body: T; next: string | null } | null> {
    const refused = this.#forbidden.get(path);
    if (refused !== undefined && this.#now() - refused < FORBIDDEN_RETRY_MS) return null;
    try {
      const r = await this.#client.get<T>(path);
      this.#forbidden.delete(path);
      return r;
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "http" && err.status === 403) {
        this.#forbidden.set(path, this.#now());
        return null;
      }
      throw err;
    }
  }

  async #refreshRepos(): Promise<boolean> {
    if (this.#publicOnly) return false;
    if (this.#now() - this.#reposAt < REPOS_REFRESH_MS) return false;
    const all: GhRepo[] = [];
    let url: string | null = `/orgs/${ORG}/repos?per_page=100&type=all`;
    for (let page = 0; url && page < 10; page++) {
      const r: { body: GhRepo[]; next: string | null } | null = await this.#get<GhRepo[]>(url);
      if (!r) break;
      all.push(...r.body);
      url = r.next;
    }
    if (all.length) this.#repos = all.filter((r) => !r.archived && !r.disabled);
    this.#reposAt = this.#now();
    return true;
  }

  /** The repos to poll this round: the core ones, hot ones, and every repo on a sweep. */
  /**
   * The repos to poll this round: every repo on a sweep (the repo list's 10-minute refresh), else
   * those active in the last {@linkcode IDLE_AFTER_POLLS} polls, and idle ones every
   * {@linkcode IDLE_POLL_MS}. The core repos are always candidates, even without the repo list.
   */
  #reposToPoll(sweep: boolean): string[] {
    const now = this.#now();
    const all = new Set([...CORE_REPOS, ...this.#repos.map((r) => r.full_name)]);
    return [...all].filter((repo) =>
      sweep || (this.#idle.get(repo) ?? 0) < IDLE_AFTER_POLLS ||
      now - (this.#polledAt.get(repo) ?? -Infinity) >= IDLE_POLL_MS
    );
  }

  /** Repos polled this round, and which of them had active runs. */
  #notePolled(repos: readonly string[], active: readonly ActiveRun[]): void {
    const now = this.#now();
    const busy = new Set(active.map((a) => a.repo));
    for (const repo of repos) {
      this.#polledAt.set(repo, now);
      this.#idle.set(repo, busy.has(repo) ? 0 : (this.#idle.get(repo) ?? 0) + 1);
    }
  }

  async #activeRuns(repos: readonly string[]): Promise<ActiveRun[]> {
    const lists = await pool(
      repos.flatMap((repo) => ACTIVE_STATUSES.map((status) => ({ repo, status }))),
      CONCURRENCY,
      async ({ repo, status }) => {
        const r = await this.#get<GhRunList>(
          `/repos/${repo}/actions/runs?status=${status}&per_page=100`,
        )
          .catch((err) => {
            if (err instanceof GitHubError && err.kind === "not-found") return null;
            throw err;
          });
        return (r?.body.workflow_runs ?? []).map((run) => ({ repo, run }));
      },
    );
    const byId = new Map<number, ActiveRun>();
    for (const a of lists.flat()) byId.set(a.run.id, a);
    return [...byId.values()];
  }

  async #jobsOf(repo: string, runId: number): Promise<GhJob[]> {
    const jobs: GhJob[] = [];
    let url: string | null = `/repos/${repo}/actions/runs/${runId}/jobs?per_page=100`;
    for (let page = 0; url && page < MAX_JOB_PAGES; page++) {
      const r: { body: GhJobList; next: string | null } | null = await this.#get<GhJobList>(url);
      if (!r) break;
      jobs.push(...r.body.jobs);
      url = r.next;
    }
    return jobs;
  }

  /** Record completed jobs: recently finished, and successful lengths for the usual length. */
  #recordCompleted(repo: string, run: GhRun, jobs: readonly GhJob[]): void {
    const now = this.#now();
    const branch = run.head_branch ?? "";
    for (const j of jobs) {
      if (j.status !== "completed") continue;
      const done = time(j.completed_at);
      const start = time(j.started_at);
      const dur = done !== null && start !== null && done >= start ? done - start : null;
      if (j.conclusion === "success" && dur !== null && !this.#counted.has(j.id)) {
        this.#counted.add(j.id);
        const key = durationKey(repo, run.name ?? "workflow", j.name);
        const list = [...(this.#durations.get(key) ?? []), dur].slice(-DURATION_SAMPLES);
        this.#durations.set(key, list);
      }
      if (done === null || now - done > FINISHED_KEEP_MS) continue;
      if (j.conclusion === "skipped") continue;
      const labelPool = poolFromLabels(j.labels ?? []);
      const runnerPool = j.runner_name ? poolFromRunnerName(j.runner_name) : null;
      this.#finished.set(j.id, {
        id: j.id,
        runId: j.run_id,
        repo,
        name: j.name,
        workflow: run.name ?? "workflow",
        branch,
        defaultBranch: DEFAULT_BRANCHES.has(branch),
        conclusion: j.conclusion ?? "unknown",
        url: j.html_url ?? null,
        pool: runnerPool ?? labelPool ?? GITHUB_POOL,
        completedAt: done,
        durationMs: dur,
      });
    }
  }

  async #readHealth(): Promise<void> {
    if (this.#publicOnly) {
      this.#health = { state: "unavailable", message: "pool health needs a token" };
      return;
    }
    try {
      const r = await this.#get<GhVariable>(`/orgs/${ORG}/actions/variables/${HEALTH_VARIABLE}`);
      this.#health = r
        ? parsePoolHealth(typeof r.body.value === "string" ? r.body.value : "", this.#now())
        : { state: "unavailable", message: "pool health unavailable (no access)" };
    } catch (err) {
      if (err instanceof GitHubError && err.kind === "not-found") {
        this.#health = parsePoolHealth(null, this.#now());
      } else throw err;
    }
  }

  async #readRunners(): Promise<void> {
    if (this.#publicOnly) return;
    const r = await this.#get<GhRunnerList>(`/orgs/${ORG}/actions/runners?per_page=100`);
    if (r) this.#runners = [...r.body.runners];
  }

  /**
   * One round. Never throws: a failure is kept for the status line and the last good data stays.
   * An auth failure (401) is reported through the returned value.
   */
  async poll(): Promise<{ ok: boolean; authFailed: boolean }> {
    this.#rounds++;
    try {
      const sweep = await this.#refreshRepos();
      const repos = this.#reposToPoll(sweep);
      const polled = await this.#activeRuns(repos);
      this.#notePolled(repos, polled);
      // Runs of repos not polled this round stay as they were.
      const polledSet = new Set(repos);
      const kept = [...this.#runs.values()].filter((a) => !polledSet.has(a.repo));
      const active = [...polled, ...kept];
      const activeIds = new Set(active.map((a) => a.run.id));
      // Runs that finished since the last round: one last jobs read.
      // Runs that finished since the last round: their final state and one last jobs read.
      const gone = [...this.#runs.values()].filter((a) => !activeIds.has(a.run.id));
      const finished: ObservedRun[] = [];
      await pool(gone, CONCURRENCY, async (a) => {
        const jobs = await this.#jobsOf(a.repo, a.run.id).catch(() => []);
        const run = await this.#get<GhRun>(`/repos/${a.repo}/actions/runs/${a.run.id}`)
          .then((r) => r?.body ?? a.run)
          .catch(() => a.run);
        this.#recordCompleted(a.repo, run, jobs);
        this.#jobs.delete(a.run.id);
        this.#runUpdated.delete(a.run.id);
        finished.push({ repo: a.repo, run, jobs });
      });
      this.#finishedRuns = [...this.#finishedRuns, ...finished];
      this.#runs = new Map(active.map((a) => [a.run.id, a]));
      await pool(active, CONCURRENCY, async (a) => {
        // Jobs only for runs that changed (`updated_at`), or that had no jobs listed yet.
        const cached = this.#jobs.get(a.run.id);
        const updated = a.run.updated_at ?? "";
        if (cached && cached.length > 0 && updated && this.#runUpdated.get(a.run.id) === updated) {
          return;
        }
        const jobs = await this.#jobsOf(a.repo, a.run.id);
        this.#jobs.set(a.run.id, jobs);
        this.#runUpdated.set(a.run.id, updated);
        this.#recordCompleted(a.repo, a.run, jobs);
      });
      await Promise.all([this.#readRunners(), this.#readHealth(), this.#readAnnotations()]);
      if (this.#localHealth) {
        this.#health = await this.#localHealth(this.#health).catch(() => this.#health);
      }
      // The pool list follows the data: a pool the watchdog stops reporting leaves the cards.
      const h = this.#health;
      const pools = derivePools(
        h.state === "ok" || h.state === "stale" ? h.doc : null,
        this.#runners,
      );
      if (pools) setPools(pools);
      this.#prune();
      this.#ok = true;
      this.#lastError = "";
      this.#lastOk = this.#now();
      return { ok: true, authFailed: false };
    } catch (err) {
      this.#ok = false;
      this.#lastError = err instanceof GitHubError ? err.message : "unexpected error";
      this.#prune();
      return { ok: false, authFailed: err instanceof GitHubError && err.kind === "auth" };
    }
  }

  /** The first failure annotation of each newly failed job (one request per failure, once). */
  async #readAnnotations(): Promise<void> {
    const failed: { repo: string; id: number }[] = [];
    const all = [
      ...[...this.#runs.values()].map((a) => ({
        repo: a.repo,
        jobs: this.#jobs.get(a.run.id) ?? [],
      })),
      ...this.#finishedRuns.map((f) => ({ repo: f.repo, jobs: f.jobs })),
    ];
    for (const { repo, jobs } of all) {
      for (const j of jobs) {
        if (
          j.status === "completed" && FAILED_CONCLUSIONS.has(j.conclusion ?? "") &&
          !this.#annotated.has(j.id)
        ) {
          this.#annotated.add(j.id);
          failed.push({ repo, id: j.id });
        }
      }
    }
    await pool(failed.slice(0, 20), CONCURRENCY, async ({ repo, id }) => {
      const r = await this.#get<GhAnnotation[]>(
        `/repos/${repo}/check-runs/${id}/annotations?per_page=10`,
      ).catch(() => null);
      const a = r?.body.find((x) => x.annotation_level === "failure") ?? r?.body[0];
      if (a?.message) this.#annotations.set(id, a.message.split("\n")[0].slice(0, 300));
    });
  }

  /**
   * Apply a verified webhook delivery (`workflow_job` / `workflow_run`) to the same state a poll
   * builds. The payload is data: only typed fields are read. Returns whether it changed anything.
   */
  applyHook(d: HookDelivery): boolean {
    const repo = payloadRepo(d.payload);
    if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) return false;
    if (d.event === "workflow_run") {
      const run = asRun(d.payload.workflow_run);
      if (!run) return false;
      if (run.status === "completed") {
        const jobs = this.#jobs.get(run.id) ?? [];
        this.#runs.delete(run.id);
        this.#jobs.delete(run.id);
        this.#runUpdated.delete(run.id);
        this.#recordCompleted(repo, run, jobs);
        this.#finishedRuns = [...this.#finishedRuns, { repo, run, jobs }];
      } else {
        this.#runs.set(run.id, { repo, run });
        if (!this.#jobs.has(run.id)) this.#jobs.set(run.id, []);
      }
      return true;
    }
    const job = asJob(d.payload.workflow_job);
    if (!job) return false;
    let active = this.#runs.get(job.run_id);
    if (!active) {
      if (job.status === "completed") return false; // a run we never saw: the next poll has it
      active = {
        repo,
        run: {
          id: job.run_id,
          name: job.workflow_name ?? "workflow",
          head_branch: job.head_branch ?? "",
          head_sha: typeof (job as { head_sha?: unknown }).head_sha === "string"
            ? (job as unknown as { head_sha: string }).head_sha
            : "",
          event: "",
          status: job.status === "in_progress" ? "in_progress" : "queued",
          html_url: `https://github.com/${repo}/actions/runs/${job.run_id}`,
          created_at: job.created_at,
        },
      };
      this.#runs.set(job.run_id, active);
    }
    const jobs = [...(this.#jobs.get(job.run_id) ?? [])];
    const i = jobs.findIndex((j) => j.id === job.id);
    if (i === -1) jobs.push(job);
    else jobs[i] = job;
    this.#jobs.set(job.run_id, jobs);
    if (job.status === "completed") this.#recordCompleted(repo, active.run, [job]);
    return true;
  }

  /** A tracked run and its jobs, or `undefined`. */
  run(runId: number): { repo: string; run: GhRun; jobs: readonly GhJob[] } | undefined {
    const a = this.#runs.get(runId);
    return a ? { repo: a.repo, run: a.run, jobs: this.#jobs.get(runId) ?? [] } : undefined;
  }

  /** A repo's default branch from the org list, when known. */
  defaultBranch(repo: string): string | null {
    return this.#repos.find((r) => r.full_name === repo)?.default_branch ?? null;
  }

  /** The watched repos (core + the org's non-archived ones). */
  repoNames(): string[] {
    return [...new Set([...CORE_REPOS, ...this.#repos.map((r) => r.full_name)])];
  }

  /** Forget the finished runs once the event log has seen them. */
  consumeFinished(): void {
    this.#finishedRuns = [];
  }

  /** Active runs now (for the missed-delivery guard). */
  get activeRuns(): number {
    return this.#runs.size;
  }

  /** What this round saw, for the event log. */
  observation(): Observation {
    return {
      now: this.#now(),
      runs: [
        ...[...this.#runs.values()].map((a) => ({
          repo: a.repo,
          run: a.run,
          jobs: this.#jobs.get(a.run.id) ?? [],
        })),
        ...this.#finishedRuns,
      ],
      health: this.#health,
      annotations: this.#annotations,
    };
  }

  #prune(): void {
    if (this.#annotations.size > 500) {
      this.#annotations = new Map([...this.#annotations].slice(-200));
    }
    if (this.#annotated.size > 5000) this.#annotated = new Set([...this.#annotated].slice(-2000));
    const now = this.#now();
    for (const [id, f] of this.#finished) {
      if (now - f.completedAt > FINISHED_KEEP_MS) this.#finished.delete(id);
    }
    if (this.#counted.size > 5000) this.#counted = new Set([...this.#counted].slice(-2000));
  }

  /** Set the auth state shown (the backend changes it when a token is refused or replaced). */
  set auth(a: AuthState) {
    this.#auth = a;
  }

  /** The page's snapshot now. */
  snapshot(): Snapshot {
    const repos = new Set(CORE_REPOS);
    for (const a of this.#runs.values()) repos.add(a.repo);
    return buildSnapshot({
      now: this.#now(),
      auth: this.#auth,
      poll: {
        ok: this.#ok,
        message: this.#lastError,
        lastSuccessAt: this.#lastOk,
        intervalMs: this.#intervalMs,
        backoffUntil: this.#client.backoffUntil(),
        slow: this.slow,
      },
      rate: this.#client.rate(),
      health: this.#health,
      runs: [...this.#runs.values()],
      jobsByRun: this.#jobs,
      runners: this.#runners,
      finished: [...this.#finished.values()],
      usual: this.usual,
      repos: [...repos],
    });
  }

  /** Rounds run (for tests). */
  get rounds(): number {
    return this.#rounds;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";

/** A webhook's `workflow_run`, typed, or `null`. */
function asRun(v: unknown): GhRun | null {
  const r = v as Record<string, unknown> | null;
  if (!r || typeof r.id !== "number" || !isStr(r.status) || !isStr(r.html_url)) return null;
  if (!isStr(r.created_at) || !isStr(r.head_sha) || !isStr(r.event)) return null;
  if (!r.html_url.startsWith("https://github.com/")) return null;
  return r as unknown as GhRun;
}

/** A webhook's `workflow_job`, typed, or `null`. */
function asJob(v: unknown): GhJob | null {
  const j = v as Record<string, unknown> | null;
  if (!j || typeof j.id !== "number" || typeof j.run_id !== "number") return null;
  if (!isStr(j.name) || !isStr(j.status) || !isStr(j.created_at)) return null;
  if (j.html_url !== undefined && j.html_url !== null && !isStr(j.html_url)) return null;
  if (j.labels !== undefined && !Array.isArray(j.labels)) return null;
  return j as unknown as GhJob;
}
