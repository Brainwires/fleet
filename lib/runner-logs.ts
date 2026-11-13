// A runner scheduler's logs (settings `integrations.runnerScheduler.logsDir`), parsed: the
// per-job launcher logs `jobs/<pool>-<slot>-<epoch>.log`, the scheduler's `job done` lines (which
// job a launcher log took, its result, length and disk), and which scheduler / alert lines are
// about a pool. Pure: the readers (lib/deno-logs.ts, the MCP server) hand in text.
//
// What a launcher log says is read from conventional markers, any of which may be missing:
// `…RUNNER_RESULT rc=N`, `job finished rc=N after Ns`, `…DISK_BEFORE_GB=N` / `…DISK_AFTER_GB=N`,
// the runner's `Running job: <name>` and `Job <name> completed with result: <R>` lines, and the
// timestamps the lines start with.

/** A launcher log's name: `<pool>-<slot>-<epoch>.log`. */
export const LAUNCHER_LOG = /^(.+)-(\d+)-(\d{9,11})\.log$/;

/** A launcher log, from its name and what its text says. */
export interface LauncherLog {
  /** The file name (no folder). */
  readonly file: string;
  readonly pool: string;
  readonly slot: number;
  /** When the launcher started (the name's epoch, ms). */
  readonly startedAt: number;
  /** The file's last change (ms), when known. */
  readonly modifiedAt: number | null;
  readonly size: number | null;
  /** The runner's result code (`null`: not finished, or not said). */
  readonly rc: number | null;
  /** The job's length as the launcher reports it (ms). */
  readonly durationMs: number | null;
  readonly diskBeforeGb: number | null;
  readonly diskAfterGb: number | null;
  /** The job the runner took (its name, from the runner's own lines). */
  readonly jobName: string | null;
  /** The runner's verdict on it (`Succeeded`, `Failed`, `Canceled`). */
  readonly jobResult: string | null;
  /** From the scheduler's `job done` line: the job, run and repo. */
  readonly jobId: number | null;
  readonly runId: number | null;
  readonly repo: string | null;
  /** The runner's registered name, when the scheduler logs it. */
  readonly runner: string | null;
}

/** A launcher log's name parts, or `null`. */
export function parseLauncherName(
  file: string,
): { pool: string; slot: number; epoch: number } | null {
  const m = LAUNCHER_LOG.exec(file);
  if (!m) return null;
  return { pool: m[1], slot: Number(m[2]), epoch: Number(m[3]) };
}

const num = (s: string | undefined): number | null => {
  if (s === undefined) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** What a launcher log's text says (its head and tail are enough). */
export function parseLauncherText(text: string): {
  rc: number | null;
  durationMs: number | null;
  diskBeforeGb: number | null;
  diskAfterGb: number | null;
  jobName: string | null;
  jobResult: string | null;
} {
  const last = (re: RegExp): RegExpExecArray | null => {
    let found: RegExpExecArray | null = null;
    const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m: RegExpExecArray | null;
    while ((m = g.exec(text))) found = m;
    return found;
  };
  const rcMarker = last(/\b[A-Z_]*RUNNER_RESULT rc=(-?\d+)/);
  const finished = last(/job finished rc=(-?\d+)(?: after (\d+)s)?/);
  const before = last(/\b[A-Z_]*DISK_BEFORE_GB=(\d+(?:\.\d+)?)/) ??
    last(/free disk[^:\n]*: (\d+(?:\.\d+)?) GB before/);
  const after = last(/\b[A-Z_]*DISK_AFTER_GB=(\d+(?:\.\d+)?)/) ??
    last(/free disk[^:\n]*: \d+(?:\.\d+)? GB before, (\d+(?:\.\d+)?) GB after/);
  const running = last(/Running job: (.+?)\s*$/m);
  const result = last(/Job .+? completed with result: (\w+)/);
  const dur = num(finished?.[2]);
  return {
    rc: num(rcMarker?.[1] ?? finished?.[1]),
    durationMs: dur === null ? null : dur * 1000,
    diskBeforeGb: num(before?.[1]),
    diskAfterGb: num(after?.[1]),
    jobName: running?.[1]?.slice(0, 200) ?? null,
    jobResult: result?.[1] ?? null,
  };
}

/** `key=value` pairs of a line (values without spaces). */
export function keyValues(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of line.matchAll(/(?:^|\s)([a-z_]+)=(\S+)/g)) {
    if (!(m[1] in out)) out[m[1]] = m[2];
  }
  return out;
}

/** A scheduler `job done` line's facts. */
export interface JobDone {
  readonly pool: string;
  readonly slot: number | null;
  readonly repo: string | null;
  readonly runId: number | null;
  readonly jobId: number | null;
  readonly rc: number | null;
  readonly durationMs: number | null;
  /** The launcher log's file name (the line's `log=` path's last part). */
  readonly file: string | null;
}

/** A `job done pool=… slot=… repo=… run=… job=… result=rc=N duration=Ns … log=<path>` line. */
export function parseJobDone(line: string): JobDone | null {
  if (!/\bjob done\b/.test(line)) return null;
  const kv = keyValues(line);
  if (!kv.pool) return null;
  const rc = /rc=(-?\d+)/.exec(kv.result ?? "")?.[1];
  const dur = /^(\d+)s$/.exec(kv.duration ?? "")?.[1];
  const file = kv.log ? kv.log.split(/[\\/]/).pop() ?? null : null;
  return {
    pool: kv.pool,
    slot: num(kv.slot),
    repo: kv.repo && /^[\w.-]+\/[\w.-]+$/.test(kv.repo) ? kv.repo : null,
    runId: num(kv.run),
    jobId: num(kv.job),
    rc: num(rc),
    durationMs: dur ? Number(dur) * 1000 : null,
    file: file && LAUNCHER_LOG.test(file) ? file : null,
  };
}

/**
 * `pool <p> slot <n>: launcher started (…) for <repo> run <run> job <job> …; log <path>`: which job
 * a launcher log is for, before it finishes.
 */
export function parseLauncherStarted(line: string): JobDone | null {
  const m =
    /\bpool (\S+) slot (\d+): launcher started .*?\bfor ([\w.-]+\/[\w.-]+) run (\d+) job (\d+).*?\blog (\S+)/
      .exec(line);
  if (!m) return null;
  const file = m[6].split(/[\\/]/).pop() ?? "";
  return {
    pool: m[1],
    slot: Number(m[2]),
    repo: m[3],
    runId: Number(m[4]),
    jobId: Number(m[5]),
    rc: null,
    durationMs: null,
    file: LAUNCHER_LOG.test(file) ? file : null,
  };
}

/** `pool <p> slot <n>: <runner> ran job <id> …`: the runner that took a job. */
export function parseRanJob(line: string): { pool: string; runner: string; jobId: number } | null {
  const m = /\bpool (\S+) slot \d+: (\S+) ran job (\d+)/.exec(line);
  return m ? { pool: m[1], runner: m[2], jobId: Number(m[3]) } : null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Whether a scheduler line is about `pool`: `pool <p>` / `pool=<p>` / `<p>:` / `<p>/<slot>` as a
 * whole word (so `linux-x64` doesn't take `linux-x64-docker`'s lines).
 */
export function schedulerLineFor(line: string, pool: string): boolean {
  const p = escape(pool);
  return new RegExp(`(?:\\bpool[ =]${p}(?![\\w-])|(?:^|\\s)${p}(?::|/\\d)(?![\\w-]))`).test(line);
}

/** Whether an alerts line (`<time> <pool> <message>`) is about `pool`. */
export function alertLineFor(line: string, pool: string): boolean {
  const parts = line.split(/\s+/, 3);
  return parts[1] === pool || schedulerLineFor(line, pool);
}

/** A line's leading time (`2026-11-13 00:41:35` local, or ISO), ms, or `null`. */
export function lineTime(line: string): number | null {
  const m = /^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(Z|[+-]\d\d:?\d\d)?/.exec(line);
  if (!m) return null;
  const zone = m[3] ? (m[3] === "Z" ? "Z" : m[3].replace(/^([+-]\d\d)(\d\d)$/, "$1:$2")) : "";
  const t = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isFinite(t) ? t : null;
}

/**
 * Index the scheduler's `job done` and `ran job` lines by launcher log file: which job, run and
 * repo each took, and the runner's name.
 */
export function indexJobDone(
  lines: readonly string[],
): Map<string, JobDone & { runner: string | null }> {
  const byFile = new Map<string, JobDone & { runner: string | null }>();
  const runners = new Map<number, string>();
  for (const line of lines) {
    const ran = parseRanJob(line);
    if (ran) runners.set(ran.jobId, ran.runner);
  }
  for (const line of lines) {
    const d = parseJobDone(line) ?? parseLauncherStarted(line);
    if (!d?.file) continue;
    // A `job done` line beats the launcher's start line.
    if (d.rc === null && byFile.get(d.file)?.rc != null) continue;
    byFile.set(d.file, { ...d, runner: d.jobId !== null ? runners.get(d.jobId) ?? null : null });
  }
  return byFile;
}

/** A launcher log entry from its name, its stat, its head + tail text and the scheduler index. */
export function launcherLog(
  file: string,
  stat: { modifiedAt: number | null; size: number | null },
  text: string,
  done: (JobDone & { runner: string | null }) | undefined,
): LauncherLog | null {
  const n = parseLauncherName(file);
  if (!n) return null;
  const t = parseLauncherText(text);
  return {
    file,
    pool: n.pool,
    slot: n.slot,
    startedAt: n.epoch * 1000,
    modifiedAt: stat.modifiedAt,
    size: stat.size,
    rc: t.rc ?? done?.rc ?? null,
    durationMs: t.durationMs ?? done?.durationMs ?? null,
    diskBeforeGb: t.diskBeforeGb,
    diskAfterGb: t.diskAfterGb,
    jobName: t.jobName,
    jobResult: t.jobResult,
    jobId: done?.jobId ?? null,
    runId: done?.runId ?? null,
    repo: done?.repo ?? null,
    runner: done?.runner ?? null,
  };
}

/** One GitHub job log line group (`##[group]Title` … `##[endgroup]`), by line index. */
export interface LogGroup {
  readonly title: string;
  /** The group's header line. */
  readonly start: number;
  /** The last line inside it (inclusive). */
  readonly end: number;
}

/** GitHub's log timestamp prefix (`2026-11-13T06:40:15.1234567Z `). */
const GH_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z ?/;

/** The `##[group]` sections of a GitHub job log (unclosed groups end at the last line). */
export function logGroups(lines: readonly string[]): LogGroup[] {
  const out: LogGroup[] = [];
  let open: { title: string; start: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].replace(GH_STAMP, "");
    if (l.startsWith("##[group]")) {
      if (open) out.push({ ...open, end: i - 1 });
      open = { title: l.slice(9).trim() || "group", start: i };
    } else if (l.startsWith("##[endgroup]") && open) {
      out.push({ ...open, end: i });
      open = null;
    }
  }
  if (open) out.push({ ...open, end: lines.length - 1 });
  return out;
}
