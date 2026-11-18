// The `ci` MCP server: the one contract agents use to touch GitHub Actions (plans/fleet/
// ci-dispatch-contract.md, phases 1 and 2). Reads come from Fleet's cache first (snapshot.json) and
// GitHub for the rest; mutations are guarded (a dispatch only on the SHA the caller pushed, never a
// release gate on a [skip ci] head, never a ref the runner allowlist refuses, an identical in-flight
// dispatch answered with its run; a re-run re-runs the runner picker so routing is fresh, never a
// protected run's passing jobs; a cancel never on a protected branch nor another agent's run without
// superseded_by), and each is written to the audit log (`ci-audit.log` beside the scheduler's health
// file), which Fleet turns into an event and shows on the run's card.
//
// Nothing blocks: every tool answers within 60 s, except ci_wait (at most 300 s, then
// `still_running`). ci_watch returns a watch id at once; its outcome (the first failure, or
// completion) arrives as an MCP `notifications/message` (logger `ci`) and as a Fleet event
// (`ci-notices.jsonl`), which fleet-stream delivers to the owner's monitor.
//
//   deno run --no-config --no-prompt --allow-read=<data dir>,<runners dir>,<allowlist>,<tunables>,<gh> \
//     --allow-write=<the four ledger files> --allow-net=api.github.com,<log hosts> --allow-run=<gh> \
//     --allow-env=GH_TOKEN,GITHUB_TOKEN mcp/ci-mcp.ts --data-dir <data dir> \
//     --runners-dir <runners dir> [--allowlist <file>] [--tunables <file>] \
//     [--shared-budget <name>:<pool,pool>:<KEY|N>]
//
// (`deno run --no-config mcp/ci-mcp.ts <the same flags> --print-command` prints that line, with every
// grant, as JSON argv.) Zero dependencies: newline-delimited JSON-RPC 2.0 over stdio, like
// mcp/fleet-mcp.ts.

import {
  INVALID_REQUEST,
  onNotification,
  progressFor,
  protocolFor,
  rpcRequest,
  serveLines,
} from "./stdio.ts";
import { APP_ID } from "../lib/agent-files.ts";
import { LOG_HOSTS } from "../lib/github.ts";
import { ArgError, optInt, optStr, ownerArg } from "./ci-guards.ts";
import { ciGitHub, GitHubError } from "./ci-github.ts";
import { CI_AUDIT_FILE, CI_NOTICES_FILE } from "../lib/ci-ledger.ts";
import {
  type CiDeps,
  type CiPaths,
  CiTools,
  fileDeps,
  type RunState,
  type SharedBudget,
} from "./ci-tools.ts";
import { UNTRUSTED_NOTE } from "./fleet-mcp.ts";

const SERVER_VERSION = "0.1.0";

/** Every tool but ci_wait answers within this (the contract says 60 s). */
const TOOL_DEADLINE_MS = 55_000;
/** ci_wait's longest wait, and its default. */
const MAX_WAIT_S = 300;
const DEFAULT_WAIT_S = 120;
/** How often a watch / wait re-reads Fleet's cache. */
const TICK_MS = 3_000;
/** A run missing from a fresh cache is asked of GitHub at most this often (ci_watch / ci_wait). */
const GH_EVERY_MS = 60_000;
/** Watches per server, and how long one lives by default / at most. */
const MAX_WATCHES = 25;
const DEFAULT_WATCH_S = 6 * 3600;
const MAX_WATCH_S = 24 * 3600;

const ownerProp = {
  type: "string",
  description: "Your agent id (letters, digits, ._:@/-): who the run belongs to.",
};
const repoProp = {
  type: "string",
  description: "owner/name (or just name when Fleet watches one owner). Optional when Fleet's " +
    "cache holds the run.",
};

export const TOOLS = [
  {
    name: "ci_status",
    description:
      "One workflow run now (live from GitHub): status, conclusion, protected branch or not, its " +
      "owner and purpose when dispatched through ci_dispatch, job counts, and every job with its " +
      "runner, pool, queue wait, duration, picker flag, and for a failed job the failed step and " +
      "its check-run annotations (failures first, ≤ 5) — usually enough without the log. " +
      UNTRUSTED_NOTE,
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "integer" }, repo: repoProp },
      required: ["run_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ci_logs",
    description:
      "A job's log excerpt (redacted, timestamps stripped): the last `tail` lines (default 150, " +
      "≤ 1000), or with `grep` (a regular expression, case-insensitive unless case_sensitive) the " +
      "matching lines with `context` lines around each (default 2, ≤ 10), at most `max_matches` " +
      "(default 40, ≤ 200), numbered. A job that did not succeed also gets `failed_tests`: the " +
      "failed test names its log shows (cargo / Deno test, TAP, FAIL lines; ≤ 100), so the names " +
      "need no grep. GitHub serves a job's log only once the job completes: " +
      "before that the answer says `available: false` and when it will be. " + UNTRUSTED_NOTE,
    inputSchema: {
      type: "object",
      properties: {
        job_id: { type: "integer" },
        repo: repoProp,
        grep: { type: "string" },
        case_sensitive: { type: "boolean", default: false },
        context: { type: "integer", minimum: 0, maximum: 10, default: 2 },
        tail: { type: "integer", minimum: 1, maximum: 1000, default: 150 },
        max_matches: { type: "integer", minimum: 1, maximum: 200, default: 40 },
      },
      required: ["job_id"],
      additionalProperties: false,
    },
  },
  {
    name: "ci_capacity",
    description:
      "Runner capacity from Fleet's cache and the scheduler's health file (no GitHub call): per " +
      "pool health, slots, busy, free, queued and the oldest queue wait; GitHub-hosted families " +
      "(macos / ubuntu / windows) with running / queued counts and `saturated` (a job queued ≥ 3 " +
      "min: GitHub's concurrency cap); a machine's shared VM budget when configured; the " +
      "scheduler's health. Check `stale` first.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "ci_watch",
    description:
      "Subscribe to runs WITHOUT blocking: returns a watch id at once. When `until` is reached " +
      "(`any_failure`, the default: the first failed job of any run, or all completed; " +
      "`completed`: all completed) the outcome is delivered as an MCP notification " +
      "(notifications/message, logger `ci`) and as a Fleet event addressed to `owner` (text " +
      "`ci[<owner>] watch <id>: …`, kind `action`, on the event stream / fleet_events). Watches " +
      `live in this server process, at most ${MAX_WATCHES}, for expires_in_s (default 6 h, ≤ 24 h). ` +
      "Use ci_wait with the watch id for a bounded check.",
    inputSchema: {
      type: "object",
      properties: {
        run_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 20 },
        repo: repoProp,
        until: { type: "string", enum: ["any_failure", "completed"], default: "any_failure" },
        owner: ownerProp,
        notify: { type: "boolean", default: true, description: "Send the MCP notification." },
        expires_in_s: { type: "integer", minimum: 60, maximum: MAX_WATCH_S },
      },
      required: ["run_ids", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "ci_wait",
    description:
      `Wait for runs (or a watch) at most timeout_s (default ${DEFAULT_WAIT_S}, ≤ ${MAX_WAIT_S}): ` +
      "returns `triggered: failure | completed` with the runs' state, or `still_running` when the " +
      "time is up — then do other work, or prefer ci_watch. The only ci tool that may take over " +
      "60 s.",
    inputSchema: {
      type: "object",
      properties: {
        run_ids: { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 20 },
        watch_id: { type: "string" },
        repo: repoProp,
        until: { type: "string", enum: ["any_failure", "completed"], default: "any_failure" },
        timeout_s: { type: "integer", minimum: 1, maximum: MAX_WAIT_S, default: DEFAULT_WAIT_S },
      },
      additionalProperties: false,
    },
  },
  {
    name: "ci_dispatch",
    description:
      "Dispatch a workflow (workflow_dispatch), guarded: refused unless `ref` (a branch or tag) " +
      "is at `expect_sha` on GitHub (push first; a stale head is never dispatched); refused when " +
      "the runner scheduler's allowlist would refuse the ref on any pool — the " +
      "answer names the prefixes accepted (unlisted_ref_ok: true only for a workflow that can't " +
      "reach the narrow pools); refused for purpose `release-gate` when the head commit carries " +
      "[skip ci]. An identical dispatch (repo, workflow, ref, SHA, inputs) still in flight is " +
      "answered with its run id (`deduped: true`) instead of a new run. Records owner and purpose " +
      "(audit log, a Fleet event, the run's card). Returns the run id.",
    inputSchema: {
      type: "object",
      properties: {
        repo: { type: "string", description: "owner/name." },
        workflow: { type: "string", description: "Workflow file name (ci.yml) or id." },
        ref: { type: "string", description: "Branch or tag." },
        inputs: { type: "object", additionalProperties: { type: ["string", "number", "boolean"] } },
        expect_sha: { type: "string", description: "The SHA you pushed (7–40 hex)." },
        purpose: { type: "string", enum: ["pre-test", "release-gate", "diagnostic", "rerun"] },
        owner: ownerProp,
        unlisted_ref_ok: { type: "boolean", default: false },
      },
      required: ["repo", "workflow", "ref", "expect_sha", "purpose", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "ci_rerun",
    description:
      'Re-run a finished run\'s jobs. `jobs`: "failed" (default) or job ids (GitHub takes one ' +
      "job, with the jobs that need it, or every failed job, per call). With `reroute` (default " +
      "true) and a runner-picker job in the run, the picker is re-run instead, so GitHub re-runs " +
      "every job that needs it with routing computed afresh (a job stranded on a saturated GitHub " +
      "family can move to our pools); the answer counts the passing jobs that re-run. On a " +
      "protected branch passing jobs are never re-run: reroute is skipped and a passing job id is " +
      "refused. Audited like every mutation.",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "integer" },
        repo: repoProp,
        jobs: {
          oneOf: [
            { type: "string", enum: ["failed"] },
            { type: "array", items: { type: "integer" }, minItems: 1, maxItems: 50 },
          ],
          default: "failed",
        },
        reroute: { type: "boolean", default: true },
        owner: ownerProp,
        purpose: {
          type: "string",
          enum: ["pre-test", "release-gate", "diagnostic", "rerun"],
          default: "rerun",
        },
      },
      required: ["run_id", "owner"],
      additionalProperties: false,
    },
  },
  {
    name: "ci_cancel",
    description:
      "Cancel a run, guarded: refused on a protected branch (the repo's default branch and " +
      "Fleet's protected-branch rules), and refused for a run another agent dispatched unless " +
      "`superseded_by` names the run that replaces it. `reason` is required and logged (audit log " +
      "and a Fleet event).",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "integer" },
        repo: repoProp,
        reason: { type: "string" },
        superseded_by: { type: "integer" },
        owner: ownerProp,
      },
      required: ["run_id", "reason", "owner"],
      additionalProperties: false,
    },
  },
] as const;

type Json = Record<string, unknown>;
type Send = (msg: Json) => void;
type Until = "any_failure" | "completed";

/** A watch's (or a wait's) verdict over the runs' states. */
export function verdict(
  states: readonly (RunState | null)[],
  until: Until,
): "failure" | "completed" | null {
  if (
    until === "any_failure" && states.some((s) => s && (s.failed_jobs.length > 0 || isFailed(s)))
  ) {
    return "failure";
  }
  return states.length > 0 && states.every((s) => s?.status === "completed") ? "completed" : null;
}

const NOTIFY_LEVEL = { failure: "error", expired: "warning", completed: "notice" } as const;

/** The runs a fired watch writes a notice for: the failed one, else every run known. */
function noticeRuns(last: readonly (RunState | null)[], outcome: string): RunState[] {
  const known = last.filter((s): s is RunState => s !== null);
  const failed = known.find((s) => s.failed_jobs.length > 0 || isFailed(s));
  return outcome === "failure" && failed ? [failed] : known;
}

const isFailed = (s: RunState) =>
  s.status === "completed" &&
  ["failure", "timed_out", "startup_failure"].includes(s.conclusion ?? "");

interface Watch {
  readonly id: string;
  readonly owner: string;
  readonly repo: string | null;
  readonly runIds: readonly number[];
  readonly until: Until;
  readonly notify: boolean;
  readonly expiresAt: number;
  readonly send: Send;
  last: (RunState | null)[];
  fired: "failure" | "completed" | "expired" | null;
}

const LOG_LEVELS = [
  "debug",
  "info",
  "notice",
  "warning",
  "error",
  "critical",
  "alert",
  "emergency",
];

/** Server options (tests shorten the clock). */
export interface CiServerOptions {
  readonly tickMs?: number;
  readonly ghEveryMs?: number;
  readonly toolDeadlineMs?: number;
  readonly newId?: () => string;
}

/** The server over `tools`: `handle` answers one JSON-RPC message. */
export function createCiMcp(tools: CiTools, options: CiServerOptions = {}) {
  const deps = tools.deps;
  const tickMs = options.tickMs ?? TICK_MS;
  const ghEvery = options.ghEveryMs ?? GH_EVERY_MS;
  const deadlineMs = options.toolDeadlineMs ?? TOOL_DEADLINE_MS;
  const newId = options.newId ?? (() => crypto.randomUUID().slice(0, 8));
  const inflight = new Map<string | number, AbortController>();
  const watches = new Map<string, Watch>();
  let logLevel: number | null = null;
  let ticker: number | null = null;

  const states = (
    repo: string | null,
    ids: readonly number[],
    every: number,
    signal?: AbortSignal,
  ) => Promise.all(ids.map((id) => tools.runState(repo, id, every, signal).catch(() => null)));

  /** A watch reached its end: the notification (when asked for), then a notice per run. */
  async function fire(w: Watch, outcome: "failure" | "completed" | "expired") {
    w.fired = outcome;
    watches.delete(w.id);
    const level = NOTIFY_LEVEL[outcome];
    if (w.notify && (logLevel === null || LOG_LEVELS.indexOf(level) >= logLevel)) {
      const runs = w.last.map((s, i) => s ?? { run_id: w.runIds[i], status: "unknown" });
      w.send({
        jsonrpc: "2.0",
        method: "notifications/message",
        params: { level, logger: "ci", data: { watch_id: w.id, owner: w.owner, outcome, runs } },
      });
    }
    for (const s of noticeRuns(w.last, outcome)) {
      await tools.notice({
        watch_id: w.id,
        owner: w.owner,
        repo: s.repo,
        run_id: s.run_id,
        outcome,
        conclusion: s.conclusion,
        failed_jobs: s.failed_jobs,
        url: s.html_url,
      });
    }
  }

  /** One pass over the watches (a pass already running is awaited first, then a new one runs). */
  async function pass() {
    for (const w of [...watches.values()]) {
      w.last = await states(w.repo, w.runIds, ghEvery);
      const v = verdict(w.last, w.until);
      if (v) await fire(w, v);
      else if (deps.now() >= w.expiresAt) await fire(w, "expired");
    }
    if (watches.size === 0 && ticker !== null) {
      clearInterval(ticker);
      ticker = null;
    }
  }

  let running: Promise<void> | null = null;
  async function tick(): Promise<void> {
    while (running) await running.catch(() => {});
    running = pass().finally(() => (running = null));
    await running;
  }

  async function watch(args: Json, send: Send) {
    const owner = ownerArg(args);
    const ids = runIdsArg(args, true)!;
    const until = untilArg(args);
    const repo = await tools.resolveRepo(args, ids[0]);
    const ttl = Math.min(optInt(args, "expires_in_s") ?? DEFAULT_WATCH_S, MAX_WATCH_S);
    if (watches.size >= MAX_WATCHES) {
      throw new ArgError(`at most ${MAX_WATCHES} watches per server`);
    }
    const w: Watch = {
      id: `w-${newId()}`,
      owner,
      repo,
      runIds: ids,
      until,
      notify: args.notify !== false,
      expiresAt: deps.now() + ttl * 1000,
      send,
      last: [],
      fired: null,
    };
    watches.set(w.id, w);
    // The interval skips a beat while a pass is still running.
    ticker ??= setInterval(() => {
      if (!running) void tick().catch(() => {});
    }, tickMs) as unknown as number;
    // The first look right away (in the background: this call returns at once).
    queueMicrotask(() => void tick().catch(() => {}));
    return {
      watch_id: w.id,
      owner,
      run_ids: ids,
      until,
      expires_at: new Date(w.expiresAt).toISOString(),
      delivery: "notifications/message (logger ci) + a Fleet event `ci[" + owner + "] watch " +
        w.id +
        ": …` (fleet-stream / fleet_events)",
    };
  }

  async function wait(args: Json, signal: AbortSignal, progress: (s: number) => void) {
    const timeoutS = Math.min(optInt(args, "timeout_s") ?? DEFAULT_WAIT_S, MAX_WAIT_S);
    const watchId = optStr(args, "watch_id", 40);
    let ids: readonly number[];
    let until: Until;
    let repo: string | null;
    if (watchId) {
      const w = watches.get(watchId);
      if (!w) {
        throw new ArgError(
          `no active watch ${watchId} in this server (fired, expired or another session's)`,
        );
      }
      ids = w.runIds;
      until = w.until;
      repo = w.repo;
    } else {
      ids = runIdsArg(args, true)!;
      until = untilArg(args);
      repo = await tools.resolveRepo(args, ids[0]);
    }
    const start = deps.now();
    const end = start + timeoutS * 1000;
    let lastProgress = start;
    let last: (RunState | null)[] = [];
    while (true) {
      last = await states(repo, ids, Math.min(ghEvery, 30_000), signal);
      const v = verdict(last, until);
      const t = deps.now();
      if (v) return { triggered: v, waited_s: Math.round((t - start) / 1000), runs: last };
      if (t >= end || signal.aborted) {
        return {
          triggered: "still_running",
          waited_s: Math.round((t - start) / 1000),
          runs: last,
          hint: "Still running: do other work and check again, or ci_watch for a notification.",
        };
      }
      if (t - lastProgress >= 25_000) {
        lastProgress = t;
        progress(Math.round((t - start) / 1000));
      }
      await deps.sleep(Math.min(tickMs, end - t), signal);
    }
  }

  async function callTool(
    name: string,
    args: Json,
    send: Send,
    signal: AbortSignal,
    progress: (s: number) => void,
  ) {
    switch (name) {
      case "ci_status":
        return await tools.status(args, signal);
      case "ci_logs":
        return await tools.logs(args, signal);
      case "ci_capacity":
        return await tools.capacity();
      case "ci_watch":
        return await watch(args, send);
      case "ci_wait":
        return await wait(args, signal, progress);
      case "ci_dispatch":
        return await tools.dispatch(args, signal);
      case "ci_rerun":
        return await tools.rerun(args, signal);
      case "ci_cancel":
        return await tools.cancel(args, signal);
      default:
        throw new ArgError(`unknown tool ${name}`);
    }
  }

  /** A tools/call's result (an error result for a refusal, a failure or the deadline). */
  async function toolsCall(id: string | number, params: Json, send: Send): Promise<Json> {
    const name = String(params.name ?? "");
    const raw = params.arguments;
    const args = (typeof raw === "object" && raw !== null ? raw : {}) as Json;
    const progress = progressFor(send, params);
    const ac = new AbortController();
    inflight.set(id, ac);
    // Every tool but ci_wait is cut off before 60 s (ci_wait bounds itself at 300 s).
    const limit = name === "ci_wait" ? null : setTimeout(() => ac.abort(), deadlineMs);
    try {
      const result = await callTool(name, args, send, ac.signal, progress);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: errorText(err, ac.signal.aborted) }],
        isError: true,
      };
    } finally {
      if (limit !== null) clearTimeout(limit);
      inflight.delete(id);
    }
  }

  async function handle(msg: unknown, send: Send): Promise<Json | null> {
    const rq = rpcRequest(msg);
    if (!rq) return INVALID_REQUEST;
    const { id, method, params, reply, fail } = rq;
    if (id === undefined) {
      onNotification(rq, inflight);
      return null;
    }
    switch (method) {
      case "initialize": {
        return reply({
          protocolVersion: protocolFor(params),
          capabilities: { tools: { listChanged: false }, logging: {} },
          serverInfo: { name: "ci", version: SERVER_VERSION },
          instructions:
            "The one way to touch GitHub Actions: ci_dispatch / ci_rerun / ci_cancel are guarded " +
            "and audited (always pass your agent id as `owner`), ci_status / ci_logs / ci_capacity " +
            "read, ci_watch subscribes without blocking (the outcome arrives as a notification and " +
            "a Fleet event), ci_wait waits at most 300 s. Never write watch loops or block on CI. " +
            UNTRUSTED_NOTE,
        });
      }
      case "ping":
        return reply({});
      case "logging/setLevel": {
        const i = LOG_LEVELS.indexOf(String(params.level));
        if (i < 0) return fail(-32602, `level must be one of ${LOG_LEVELS.join(", ")}`);
        logLevel = i;
        return reply({});
      }
      case "tools/list":
        return reply({ tools: TOOLS });
      case "tools/call":
        return reply(await toolsCall(id, params, send));
      default:
        return fail(-32601, `method not found: ${method}`);
    }
  }

  return {
    handle,
    /** The active watches (tests). */
    watches: () =>
      [...watches.values()].map((w) => ({ id: w.id, owner: w.owner, runIds: w.runIds })),
    /** Run one watch pass now (tests). */
    tick,
    /** Abort everything and drop the watches (stdin closed). */
    close: () => {
      inflight.forEach((ac) => ac.abort());
      watches.clear();
      if (ticker !== null) clearInterval(ticker);
      ticker = null;
    },
  };
}

function errorText(err: unknown, aborted: boolean): string {
  if (err instanceof ArgError) return err.message;
  if (aborted) {
    return "Stopped: the call took too long (GitHub slow?). Nothing beyond what an audit line says was done; retry.";
  }
  if (err instanceof GitHubError) return `GitHub: ${err.message}`;
  return "The ci server failed to answer (files or GitHub unreachable).";
}

function runIdsArg(args: Json, required: boolean): number[] | null {
  const v = args.run_ids;
  if (v === undefined || v === null) {
    if (required) throw new ArgError("run_ids is required");
    return null;
  }
  if (!Array.isArray(v) || v.length === 0 || v.length > 20) {
    throw new ArgError("run_ids must list 1–20 run ids");
  }
  return v.map((x) => {
    if (typeof x !== "number" || !Number.isSafeInteger(x) || x <= 0) {
      throw new ArgError("run_ids must hold run ids");
    }
    return x;
  });
}

function untilArg(args: Json): Until {
  const u = args.until ?? "any_failure";
  if (u !== "any_failure" && u !== "completed") {
    throw new ArgError("until must be any_failure or completed");
  }
  return u;
}

/** Serve MCP over stdin / stdout until stdin closes. */
function serveStdio(tools: CiTools, options: CiServerOptions = {}): Promise<void> {
  const server = createCiMcp(tools, options);
  return serveLines({ handle: server.handle, close: server.close });
}

const USAGE = "usage: ci-mcp.ts --data-dir <Fleet data dir> --runners-dir <runner scheduler dir> " +
  "[--allowlist <allowlist.json>] [--tunables <file>] [--shared-budget <name>:<pool,pool>:<KEY|N>] " +
  "[--print-command]";

/** A flag's value (`--flag v` or `--flag=v`). */
function flag(args: readonly string[], name: string): string | undefined {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name) return args[i + 1];
    if (args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
  }
  return undefined;
}

/** `--shared-budget <name>:<pool,pool>:<KEY|N>` (the maximum: a tunables key or a number). */
export function parseSharedBudget(v: string | undefined): SharedBudget | null | string {
  if (v === undefined) return null;
  const m = /^([\w.-]{1,40}):([\w.,-]{1,400}):([A-Za-z_][A-Za-z0-9_]{0,63}|\d{1,4})$/.exec(v);
  if (!m) return `--shared-budget must be <name>:<pool,pool>:<KEY|N>\n${USAGE}`;
  return {
    name: m[1],
    pools: m[2].split(",").filter(Boolean),
    max: /^\d+$/.test(m[3]) ? Number(m[3]) : m[3],
  };
}

/**
 * The paths from the arguments (`--data-dir` defaults to macOS's data folder when HOME is
 * granted). Without `--runners-dir` the reads work and every mutation is refused (no audit log).
 */
export function ciPathsFromArgs(args: readonly string[]): CiPaths | string {
  let home: string | undefined;
  if (Deno.permissions.querySync({ name: "env", variable: "HOME" }).state === "granted") {
    home = Deno.env.get("HOME");
  }
  const dataDir = flag(args, "--data-dir") ??
    (home ? `${home}/Library/Application Support/${APP_ID}` : undefined);
  if (!dataDir) return USAGE;
  const shared = parseSharedBudget(flag(args, "--shared-budget"));
  if (typeof shared === "string") return shared;
  return {
    dataDir,
    runnersDir: flag(args, "--runners-dir") ?? null,
    allowlist: flag(args, "--allowlist") ?? null,
    tunables: flag(args, "--tunables") ?? null,
    shared,
  };
}

/** The gh paths `gh auth token` may run from (read for the stat, run for the token). */
const GH_BINS = ["/opt/homebrew/bin/gh", "/usr/local/bin/gh", "/usr/bin/gh"];

/**
 * The least-privilege command that runs this server for `paths`, for an MCP client's config:
 * reads only its files, writes only the ledger files, talks only to GitHub's API and log hosts,
 * runs only gh.
 */
export function serverCommand(paths: CiPaths, script: string): string[] {
  const r = paths.runnersDir?.replace(/\/$/, "");
  const reads = [paths.dataDir, r, paths.allowlist, paths.tunables, ...GH_BINS]
    .filter((x): x is string => !!x);
  const writes = r
    ? [CI_AUDIT_FILE, CI_NOTICES_FILE].flatMap((f) => [`${r}/${f}`, `${r}/${f}.1`])
    : [];
  const out = [
    "deno",
    "run",
    "--no-config",
    "--no-prompt",
    `--allow-read=${reads.join(",")}`,
    ...(writes.length ? [`--allow-write=${writes.join(",")}`] : []),
    `--allow-net=${NET_HOSTS.join(",")}`,
    `--allow-run=${GH_BINS.join(",")}`,
    "--allow-env=GH_TOKEN,GITHUB_TOKEN",
    script,
    "--data-dir",
    paths.dataDir,
  ];
  if (r) out.push("--runners-dir", r);
  if (paths.allowlist) out.push("--allowlist", paths.allowlist);
  if (paths.tunables) out.push("--tunables", paths.tunables);
  if (paths.shared) {
    out.push(
      "--shared-budget",
      `${paths.shared.name}:${paths.shared.pools.join(",")}:${paths.shared.max}`,
    );
  }
  return out;
}

/** The live deps. */
function liveDeps(paths: CiPaths): CiDeps {
  return {
    paths,
    github: ciGitHub(),
    now: Date.now,
    readText: fileDeps.readText,
    append: fileDeps.append,
    sleep: (ms, signal) =>
      new Promise((resolve) => {
        const t = setTimeout(done, Math.max(0, ms));
        function done() {
          clearTimeout(t);
          signal?.removeEventListener("abort", done);
          resolve();
        }
        signal?.addEventListener("abort", done, { once: true });
      }),
  };
}

/** The hosts a job-log download may reach (for the run command's --allow-net). */
const NET_HOSTS: readonly string[] = ["api.github.com", ...LOG_HOSTS];

if (import.meta.main) {
  const paths = ciPathsFromArgs(Deno.args);
  if (typeof paths === "string") {
    console.error(paths);
    Deno.exit(2);
  }
  if (Deno.args.includes("--print-command")) {
    // The registration line: `{ "command": argv[0], "args": argv.slice(1) }` in an MCP config.
    console.log(JSON.stringify(serverCommand(paths, new URL(import.meta.url).pathname)));
    Deno.exit(0);
  }
  await serveStdio(new CiTools(liveDeps(paths)));
}
