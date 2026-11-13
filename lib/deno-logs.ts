// The runner scheduler's logs on this machine (settings `integrations.runnerScheduler.logsDir`),
// read-only and bounded: a file is never read whole past a cap (its tail, or a window after an
// offset), every line is redacted (lib/redact.ts) before it leaves, and a file name is accepted
// only when it is a launcher log of the asked pool inside the folder's `jobs/` (no paths, no
// symlinks out). Shared by the backend and the MCP server.

import { redactLine, stripAnsi } from "./redact.ts";
import {
  alertLineFor,
  indexJobDone,
  LAUNCHER_LOG,
  type LauncherLog,
  launcherLog,
  parseJobDone,
  parseLauncherName,
  parseLauncherStarted,
  schedulerLineFor,
} from "./runner-logs.ts";

/** A launcher log is read at most this much at a time (the viewer pages for more). */
export const LOG_WINDOW_BYTES = 512 * 1024;
/** The scheduler / alerts files are read from their last this many bytes. */
export const SCHEDULER_TAIL_BYTES = 2 * 1024 * 1024;
/** Launcher logs listed per pool. */
export const LAUNCHER_LIST_MAX = 60;
/** Each listed launcher log's head and tail read for its summary. */
const SUMMARY_HEAD = 4096;
const SUMMARY_TAIL = 16 * 1024;

/** A chunk of a file: complete lines only, redacted. */
export interface LogChunk {
  /** The file's size when read. */
  readonly size: number;
  /** Where the chunk starts and ends (bytes; `end` is where to read on from). */
  readonly start: number;
  readonly end: number;
  /** The file has more before `start` (the viewer offers "earlier"). */
  readonly truncated: boolean;
  readonly lines: readonly string[];
}

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** Read `len` bytes of `path` from `at` (fewer at the end). */
async function readRange(path: string, at: number, len: number): Promise<Uint8Array> {
  const file = await Deno.open(path, { read: true });
  try {
    await file.seek(at, Deno.SeekMode.Start);
    const buf = new Uint8Array(len);
    let off = 0;
    while (off < len) {
      const n = await file.read(buf.subarray(off));
      if (n === null) break;
      off += n;
    }
    return buf.subarray(0, off);
  } finally {
    file.close();
  }
}

/** Bytes to complete, redacted lines (ANSI escapes kept: the viewer colours, then strips them). */
function toLines(bytes: Uint8Array, dropFirst: boolean, keepLast: boolean): {
  lines: string[];
  used: number;
} {
  let from = 0;
  if (dropFirst) {
    const nl = bytes.indexOf(0x0a);
    from = nl < 0 ? bytes.length : nl + 1;
  }
  let to = bytes.length;
  if (!keepLast) {
    const nl = bytes.lastIndexOf(0x0a);
    to = nl < from ? from : nl + 1;
  }
  const text = new TextDecoder().decode(bytes.subarray(from, to));
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return { lines: lines.map((l) => redactLine(l.replace(/\r$/, ""))), used: to };
}

/**
 * The last `maxBytes` of a file as complete, redacted lines (a partial first line is dropped, a
 * partial last line kept only when the file isn't growing: `final`).
 */
export async function readTail(path: string, maxBytes = LOG_WINDOW_BYTES): Promise<LogChunk> {
  const size = (await Deno.stat(path)).size;
  const start = Math.max(0, size - maxBytes);
  const bytes = await readRange(path, start, size - start);
  const { lines, used } = toLines(bytes, start > 0, false);
  const firstNl = start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
  return {
    size,
    start: start + firstNl,
    end: start + used,
    truncated: start > 0,
    lines,
  };
}

/** Complete, redacted lines after `offset`, at most `maxBytes` (a live file's new lines). */
export async function readAfter(
  path: string,
  offset: number,
  maxBytes = LOG_WINDOW_BYTES,
): Promise<LogChunk> {
  const size = (await Deno.stat(path)).size;
  if (offset > size) offset = 0; // the file was replaced or truncated: start over
  const len = Math.min(maxBytes, size - offset);
  const bytes = await readRange(path, offset, len);
  const { lines, used } = toLines(bytes, false, false);
  return { size, start: offset, end: offset + used, truncated: offset > 0, lines };
}

/** Lines before `offset` (the viewer's "earlier"), at most `maxBytes`. */
export async function readBefore(
  path: string,
  offset: number,
  maxBytes = LOG_WINDOW_BYTES,
): Promise<LogChunk> {
  const size = (await Deno.stat(path)).size;
  const end = Math.min(offset, size);
  const start = Math.max(0, end - maxBytes);
  const bytes = await readRange(path, start, end - start);
  const { lines } = toLines(bytes, start > 0, true);
  const firstNl = start > 0 ? bytes.indexOf(0x0a) + 1 : 0;
  return { size, start: start + firstNl, end, truncated: start > 0, lines };
}

/**
 * A launcher log's path when `file` is one of `pool`'s inside `<logsDir>/jobs/` (a plain name, no
 * separators; the resolved path must stay in the folder), else `null`.
 */
export async function launcherPath(
  logsDir: string,
  pool: string,
  file: string,
): Promise<string | null> {
  if (!LAUNCHER_LOG.test(file) || /[\\/]/.test(file) || file.startsWith(".")) return null;
  if (parseLauncherName(file)?.pool !== pool) return null;
  const jobs = join(logsDir, "jobs");
  const path = join(jobs, file);
  try {
    const [real, dir] = await Promise.all([Deno.realPath(path), Deno.realPath(jobs)]);
    if (!real.startsWith(dir.endsWith("/") ? dir : `${dir}/`)) return null;
    const st = await Deno.lstat(path);
    return st.isFile ? real : null;
  } catch {
    return null;
  }
}

/** The scheduler's `job done` lines (its log's tail), by launcher log file. */
async function jobDoneIndex(logsDir: string) {
  try {
    return indexJobDone(
      (await readTail(join(logsDir, "scheduler.log"), SCHEDULER_TAIL_BYTES)).lines,
    );
  } catch {
    return new Map();
  }
}

/** A launcher log's head and tail, for its summary (never the whole file). */
async function headAndTail(path: string, size: number): Promise<string> {
  const dec = new TextDecoder();
  if (size <= SUMMARY_HEAD + SUMMARY_TAIL) return dec.decode(await readRange(path, 0, size));
  const head = dec.decode(await readRange(path, 0, SUMMARY_HEAD));
  const tail = dec.decode(await readRange(path, size - SUMMARY_TAIL, SUMMARY_TAIL));
  return `${head}\n${tail}`;
}

/** `pool`'s launcher logs, newest first (at most `limit`), each with what it says. */
export async function listLauncherLogs(
  logsDir: string,
  pool: string,
  limit = LAUNCHER_LIST_MAX,
): Promise<LauncherLog[]> {
  const names: { file: string; epoch: number }[] = [];
  try {
    for await (const e of Deno.readDir(join(logsDir, "jobs"))) {
      if (!e.isFile) continue;
      const n = parseLauncherName(e.name);
      if (n && n.pool === pool) names.push({ file: e.name, epoch: n.epoch });
    }
  } catch {
    return [];
  }
  names.sort((a, b) => b.epoch - a.epoch || b.file.localeCompare(a.file));
  const index = await jobDoneIndex(logsDir);
  const out: LauncherLog[] = [];
  for (const { file } of names.slice(0, limit)) {
    const path = join(join(logsDir, "jobs"), file);
    try {
      const st = await Deno.stat(path);
      const text = stripAnsi(await headAndTail(path, st.size));
      const entry = launcherLog(
        file,
        { modifiedAt: st.mtime?.getTime() ?? null, size: st.size },
        text,
        index.get(file),
      );
      if (entry) out.push(entry);
    } catch {
      // Gone meanwhile: skip it.
    }
  }
  return out;
}

/** The scheduler's or the watchdog's lines about `pool` (the file's tail), newest last. */
export async function poolLogLines(
  logsDir: string,
  pool: string,
  which: "scheduler" | "alerts",
  maxLines = 300,
): Promise<{ lines: string[]; size: number }> {
  const path = join(logsDir, which === "scheduler" ? "scheduler.log" : "alerts.log");
  try {
    const chunk = await readTail(path, SCHEDULER_TAIL_BYTES);
    const test = which === "scheduler" ? schedulerLineFor : alertLineFor;
    const lines = chunk.lines.filter((l) => test(l, pool)).slice(-maxLines);
    return { lines, size: chunk.size };
  } catch {
    return { lines: [], size: 0 };
  }
}

/** The launcher log that took job `jobId`, from the scheduler's `job done` lines, or `null`. */
export async function launcherForJob(
  logsDir: string,
  jobId: number,
): Promise<{ pool: string; file: string } | null> {
  const candidates = ["scheduler.log"];
  try {
    const rotated: string[] = [];
    for await (const e of Deno.readDir(logsDir)) {
      if (e.isFile && /^scheduler\.log\.[\w.-]+$/.test(e.name)) rotated.push(e.name);
    }
    candidates.push(...rotated.sort().reverse().slice(0, 3));
  } catch {
    return null;
  }
  for (const name of candidates) {
    try {
      const { lines } = await readTail(join(logsDir, name), SCHEDULER_TAIL_BYTES);
      for (let i = lines.length - 1; i >= 0; i--) {
        const d = parseJobDone(lines[i]) ?? parseLauncherStarted(lines[i]);
        if (d?.jobId === jobId && d.file) return { pool: d.pool, file: d.file };
      }
    } catch {
      // Missing: the next one.
    }
  }
  return null;
}

/** A runner log for the viewer. */
export interface RunnerLogView {
  readonly kind: "runner";
  readonly title: string;
  readonly lines: readonly string[];
  readonly truncated: boolean;
  readonly start: number;
  readonly end: number;
  readonly size: number;
  readonly live: boolean;
  readonly file: string;
}

/** A launcher log counts as live while it changed this recently and says no result yet. */
export const LIVE_WITHIN_MS = 3 * 60_000;

/**
 * A launcher log of `pool` for the viewer: its tail (default), the lines after `after` (following a
 * live one), or before `before` (paging back). `null` when the file isn't one of the pool's.
 */
export async function runnerLogView(
  logsDir: string,
  pool: string,
  file: string,
  opts: { after?: number; before?: number; now?: number } = {},
): Promise<RunnerLogView | null> {
  const path = await launcherPath(logsDir, pool, file);
  if (!path) return null;
  const chunk = typeof opts.after === "number" && opts.after >= 0
    ? await readAfter(path, opts.after)
    : typeof opts.before === "number" && opts.before > 0
    ? await readBefore(path, opts.before)
    : await readTail(path);
  const st = await Deno.stat(path);
  const recent = (opts.now ?? Date.now()) - (st.mtime?.getTime() ?? 0) < LIVE_WITHIN_MS;
  const done = chunk.lines.some((l) => /\b[A-Z_]*RUNNER_RESULT rc=/.test(l));
  return {
    kind: "runner",
    title: file,
    lines: chunk.lines,
    truncated: chunk.truncated,
    start: chunk.start,
    end: chunk.end,
    size: chunk.size,
    live: recent && !done,
    file,
  };
}
