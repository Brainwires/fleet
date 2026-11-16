// The `ci` server's read answers, pure: a job's pool from the scheduler's health file, a job as
// ci_status lists it, check-run annotations, a log's lines and their grep excerpt, and ci_capacity's
// parts (pools, GitHub-hosted families, a shared VM budget, the scheduler). mcp/ci-tools.ts feeds
// them what it read.

import { type AgentSnapshot, agentText, capText } from "../lib/agent-snapshot.ts";
import type { GhJob } from "../lib/github-types.ts";
import { redactLine, stripAnsi } from "../lib/redact.ts";
import { githubFamily, isPickerJob, jobFailed, SATURATED_MS } from "./ci-guards.ts";

type Json = Record<string, unknown>;

export const ms = (s: string | null | undefined): number | null => {
  const t = s ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? t : null;
};
const secs = (x: number | null): number | null =>
  x === null ? null : Math.max(0, Math.round(x / 1000));

const poolsOf = (health: Json | null) =>
  Object.entries((health?.pools ?? {}) as Record<string, Json>);

/** The pool whose runner prefix (the longest) starts `name`. */
function poolByRunner(pools: [string, Json][], name: string): string | null {
  let best: [string, number] | null = null;
  for (const [id, p] of pools) {
    const pre = typeof p.runner_prefix === "string" ? p.runner_prefix : "";
    if (pre && name.startsWith(pre) && (!best || pre.length > best[1])) best = [id, pre.length];
  }
  return best?.[0] ?? null;
}

/** The pool serving one of `labels`. */
function poolByLabel(pools: [string, Json][], labels: readonly string[]): string | null {
  for (const [id, p] of pools) {
    const ls = Array.isArray(p.labels) ? p.labels : [p.label];
    if (ls.some((l) => typeof l === "string" && labels.includes(l.toLowerCase()))) return id;
  }
  return null;
}

/** A job's pool from the scheduler's health file (runner prefix, then label), else `github`. */
function poolOf(
  job: Pick<GhJob, "runner_name" | "labels" | "status">,
  health: Json | null,
): string | null {
  const pools = poolsOf(health);
  const name = job.runner_name ?? "";
  const labels = (job.labels ?? []).map((l) => l.toLowerCase());
  const pool = poolByRunner(pools, name) ?? poolByLabel(pools, labels);
  if (pool) return pool;
  if (labels.includes("self-hosted")) return null;
  return name || job.status !== "completed" ? "github" : null;
}

/** The step that failed, for a failed job. */
function failedStepOf(j: GhJob): string | null {
  if (!jobFailed(j)) return null;
  return j.steps?.find((s) => s.conclusion === "failure" || s.conclusion === "timed_out")?.name ??
    null;
}

/** How long a job waited for a runner (queued: so far). */
function queueWait(j: GhJob, now: number): number | null {
  const created = ms(j.created_at);
  if (created === null) return null;
  const started = ms(j.started_at) ?? (j.status === "queued" ? now : created);
  return secs(started - created);
}

/** One job as ci_status lists it. */
export function jobOut(
  j: GhJob,
  health: Json | null,
  now: number,
  untrusted: boolean,
  notes: readonly unknown[] = [],
) {
  const started = ms(j.started_at);
  const step = failedStepOf(j);
  return {
    job_id: j.id,
    name: capText(j.name, 120),
    status: j.status,
    conclusion: j.conclusion ?? null,
    ...(isPickerJob(j) ? { picker: true } : {}),
    runner: j.runner_name ? capText(j.runner_name, 120) : null,
    pool: poolOf(j, health),
    labels: (j.labels ?? []).map((l) => capText(l, 60)),
    queue_wait_s: queueWait(j, now),
    duration_s: started === null ? null : secs((ms(j.completed_at) ?? now) - started),
    ...(step !== null ? { failed_step: agentText(step, 120, untrusted) } : {}),
    ...(notes.length ? { annotations: notes } : {}),
    html_url: j.html_url ?? null,
  };
}

/** A check-run annotation as GitHub lists it. */
export interface GhCheckAnnotation {
  readonly annotation_level?: string;
  readonly message?: string;
  readonly title?: string;
  readonly path?: string;
  readonly start_line?: number;
}

const RANK: Record<string, number> = { failure: 0, warning: 1 };

/** A job's annotations: failures first, notices left out, at most 5, text capped / wrapped. */
export function annotationsOut(list: unknown, untrusted: boolean) {
  const all = Array.isArray(list) ? list as GhCheckAnnotation[] : [];
  return all
    .filter((a) => a.annotation_level !== "notice")
    .sort((a, b) => (RANK[a.annotation_level ?? ""] ?? 2) - (RANK[b.annotation_level ?? ""] ?? 2))
    .slice(0, 5)
    .map((a) => ({
      level: a.annotation_level ?? "unknown",
      message: agentText([a.title, a.message].filter(Boolean).join(": "), 300, untrusted),
      ...(a.path && a.path !== ".github" ? { path: capText(a.path, 200) } : {}),
      ...(typeof a.start_line === "number" && a.start_line > 0 ? { line: a.start_line } : {}),
    }));
}

/** A log's lines: ANSI and GitHub's timestamps off, secrets redacted, each ≤ 500 characters. */
export function logLines(text: string): string[] {
  return text.split("\n").map((l) =>
    redactLine(stripAnsi(l).replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z /, "")).slice(0, 500)
  );
}

/** The lines matching `re` with `context` around each, numbered, `--` between separate hunks. */
export function grepLines(lines: readonly string[], re: RegExp, context: number, max: number) {
  const keep = new Set<number>();
  let matches = 0;
  for (let i = 0; i < lines.length && matches < max; i++) {
    if (!re.test(lines[i])) continue;
    matches++;
    const end = Math.min(lines.length - 1, i + context);
    for (let k = Math.max(0, i - context); k <= end; k++) keep.add(k);
  }
  const out: string[] = [];
  let prev = -2;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i !== prev + 1 && out.length) out.push("--");
    out.push(`${i + 1}: ${lines[i]}`);
    prev = i;
  }
  return { matches, capped: matches >= max, text: out.join("\n") };
}

// ---- ci_capacity ----

/** The self-hosted pools: Fleet's cards with the scheduler's health. */
export function poolsOut(snap: AgentSnapshot | null, health: Json | null, ghNow: number) {
  const hp = (health?.pools ?? {}) as Record<string, Json>;
  return (snap?.pools ?? []).filter((p) => p.id !== "github").map((p) => {
    const h = hp[p.id];
    const oldest = ms(p.oldest_queued_since);
    return {
      pool: p.id,
      label: p.label,
      state: p.state,
      ...(h ? { healthy: h.healthy === true, reason: capText(String(h.reason ?? ""), 120) } : {}),
      slots: p.slots,
      busy: p.busy,
      free: p.slots === null ? null : Math.max(0, p.slots - p.busy),
      queued: p.queued,
      oldest_queued_s: oldest === null ? null : secs(ghNow - oldest),
    };
  });
}

/** GitHub-hosted jobs by family, with saturation (a job queued ≥ 3 min). */
export function familiesOut(snap: AgentSnapshot | null, ghNow: number) {
  const fams = new Map<string, { running: number; queued: number; oldest: number | null }>();
  for (const j of snap?.jobs ?? []) {
    if (j.pool !== "github" || j.status === "completed") continue;
    const f = githubFamily(j.labels);
    const e = fams.get(f) ?? { running: 0, queued: 0, oldest: null };
    fams.set(f, e);
    if (j.status === "in_progress") {
      e.running++;
      continue;
    }
    e.queued++;
    const c = ms(j.created_at);
    if (c !== null) e.oldest = Math.min(e.oldest ?? c, c);
  }
  return [...fams].map(([family, e]) => {
    const waited = e.oldest === null ? null : ghNow - e.oldest;
    return {
      family,
      running: e.running,
      queued: e.queued,
      oldest_queued_s: secs(waited),
      saturated: waited !== null && waited >= SATURATED_MS,
    };
  });
}

/** Pools sharing one VM budget on one machine. */
export interface SharedBudget {
  /** The machine's name, as the answer shows it. */
  readonly name: string;
  readonly pools: readonly string[];
  /** The tunables key holding the maximum (`KEY=N`), or a fixed number. */
  readonly max: string | number;
}

/** `KEY=N` from a tunables file's text, or NaN. */
function tunable(text: string | null, key: string): number {
  for (const line of (text ?? "").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(\d+)\s*(?:#.*)?$/.exec(line);
    if (m && m[1] === key) return Number(m[2]);
  }
  return NaN;
}

/** The shared budget's use by CI. */
export function sharedOut(
  shared: SharedBudget | null,
  pools: readonly { pool: string; busy: number; queued: number }[],
  tunables: string | null,
) {
  if (!shared) return null;
  const mine = pools.filter((p) => shared.pools.includes(p.pool));
  const max = typeof shared.max === "number" ? shared.max : tunable(tunables, shared.max);
  const busy = mine.reduce((n, p) => n + p.busy, 0);
  const known = Number.isFinite(max);
  return {
    name: shared.name,
    pools: shared.pools,
    max_vms: known ? max : null,
    ci_busy: busy,
    queued: mine.reduce((n, p) => n + p.queued, 0),
    free: known ? Math.max(0, max - busy) : null,
    note: "One VM budget for these pools together: a VM started outside CI (a lab or pre-test " +
      "VM) takes from it too; only CI jobs are counted here.",
  };
}

/** The scheduler's own health line. */
export function schedulerOut(health: Json | null, now: number) {
  const sched = health?.scheduler as Json | undefined;
  if (!sched) return null;
  const checked = typeof health?.checked_at_epoch === "number"
    ? health.checked_at_epoch * 1000
    : null;
  return {
    healthy: sched.healthy === true,
    reason: capText(String(sched.reason ?? ""), 120),
    age_s: checked === null ? null : secs(now - checked),
  };
}
