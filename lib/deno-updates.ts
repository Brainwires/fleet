// The machine updates on the real machine (lib/updates/ has the pure model): running the one ssh
// argv (lib/updates/remote.ts), the one module for the data files (0600 in the data folder: status,
// schedules, the run in flight, the append-only audit log, the scheduler's and the notices' memory,
// the MCP server's request spool; lib/updates/files.ts parses what is read back), and the runner
// scheduler's pools as the orchestrator sees them. Everything a host prints is capped here and stays
// untrusted text: it is never put into argv or a later command.
//
// ssh runs with a cleared environment (no agent socket, no inherited options), its config file named
// with -F (so neither ~/.ssh/config nor /etc/ssh/ssh_config is read), no stdin and a time cap. Fleet
// passes the config's path and never reads a key.

import {
  UPDATE_NOTIFIED_FILE,
  UPDATE_REQUESTS_DIR,
  UPDATE_RUN_FILE,
  UPDATE_RUNS_FILE,
  UPDATE_SCHEDULER_FILE,
  UPDATE_SCHEDULES_FILE,
  UPDATES_FILE,
} from "./agent-files.ts";
import type { PoolCommand, PoolPaths } from "./controls.ts";
import type { UpdatesFilesPort } from "./updates/backend.ts";
import { validateSchedules } from "./updates/config.ts";
import { parseAudit, parseRunFile, parseStatusFile, statusFile } from "./updates/files.ts";
import type {
  AuditEntry,
  CommandResult,
  MachineStatus,
  PoolPause,
  PoolsPort,
  PoolState,
  RemotePort,
  RemoteResult,
  RemoteVerb,
  RunRecord,
  UpdateSchedule,
  UpdatesConfig,
  UpdatesMachine,
  UpdatesStore,
} from "./updates/model.ts";
import { parsePauseStatus } from "./updates/pools.ts";
import { SSH_BIN, SSH_FAILED_EXIT, sshArgv } from "./updates/remote.ts";
import {
  MAX_REQUEST_BYTES,
  parseRequest,
  REQUEST_ID,
  requestExpired,
  requestFile,
  requestIdOf,
  type UpdateRequest,
} from "./updates/requests.ts";
import {
  EMPTY_SCHEDULER_STATE,
  parseSchedulerState,
  type SchedulerState,
} from "./updates/scheduler.ts";

/** A verb's time cap when the caller gives none (the collectors' 120 s); never more than an hour. */
export const REMOTE_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MAX = 60 * 60_000;
/** At most this much of a verb's stdout is kept (a status document is far smaller). */
export const REMOTE_STDOUT_MAX = 1_000_000;

/** The data files' names, in the data folder (lib/agent-files.ts names each). */
export const UPDATE_FILES = {
  status: UPDATES_FILE,
  schedules: UPDATE_SCHEDULES_FILE,
  run: UPDATE_RUN_FILE,
  runs: UPDATE_RUNS_FILE,
  scheduler: UPDATE_SCHEDULER_FILE,
  notified: UPDATE_NOTIFIED_FILE,
  requests: UPDATE_REQUESTS_DIR,
  sshDir: "updates",
} as const;

/** Data files: the owner only. */
const FILE_MODE = 0o600;
/** Folders: the owner only. */
const DIR_MODE = 0o700;
/** One audit line is at most this long (the orchestrator redacts and caps output tails first). */
const AUDIT_LINE_MAX = 256 * 1024;
/** A request file is at most this large; a bigger one is skipped unread. */
export const REQUEST_FILE_MAX = MAX_REQUEST_BYTES;
/** At most this many request files are read per pass (Fleet keeps at most 20 pending). */
export const REQUEST_SCAN_MAX = 64;
/** A JSON data file larger than this reads as nothing. */
const JSON_FILE_MAX = 2 * 1024 * 1024;
/** The audit's tail read for the panel and the agents (bytes). */
const AUDIT_TAIL_BYTES = 512 * 1024;

/** Read up to `max` bytes of a stream, then drain and drop the rest. */
async function readCapped(stream: ReadableStream<Uint8Array>, max: number): Promise<string> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    if (size >= max) continue;
    const part = chunk.length > max - size ? chunk.subarray(0, max - size) : chunk;
    chunks.push(part);
    size += part.length;
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(all);
}

/** What the ssh runner needs. */
export interface SshRemoteOptions {
  /** Fleet's ssh config (`updates/ssh_config` in the data folder), absolute. */
  readonly configFile: string;
  /** The program: always SSH_BIN in the app; a test passes a fake that records its argv. */
  readonly program?: string;
}

const refused: RemoteResult = { code: -1, stdout: "", unreachable: false, timedOut: false };

/**
 * The real remote port: one ssh per verb, the fixed argv, no shell, a cleared environment. A machine
 * reached `"local"` (Fleet's own, notify-only) or a verb / alias outside its pattern answers code -1
 * without starting anything. ssh's own failure (exit 255: no route, refused key, changed host key)
 * is `unreachable`.
 */
export function createSshRemote(opts: SshRemoteOptions): RemotePort {
  const program = opts.program ?? SSH_BIN;
  return {
    async run(
      machine: UpdatesMachine,
      verb: RemoteVerb,
      o: { readonly timeoutMs: number; readonly signal?: AbortSignal },
    ): Promise<RemoteResult> {
      if (machine.via === "local") return refused;
      const args = sshArgv(opts.configFile, machine.via.ssh, verb);
      if (args === null || o.signal?.aborted) return refused;
      const timeoutMs = Math.max(
        1_000,
        Math.min(o.timeoutMs || REMOTE_TIMEOUT_MS, REMOTE_TIMEOUT_MAX),
      );
      const ctl = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, timeoutMs);
      const onAbort = () => ctl.abort();
      o.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const child = new Deno.Command(program, {
          args,
          clearEnv: true,
          env: { LC_ALL: "C" },
          stdin: "null",
          stdout: "piped",
          stderr: "null",
          signal: ctl.signal,
        }).spawn();
        const [stdout, status] = await Promise.all([
          readCapped(child.stdout, REMOTE_STDOUT_MAX),
          child.status,
        ]);
        if (timedOut || ctl.signal.aborted) {
          return { code: -1, stdout, unreachable: false, timedOut };
        }
        return {
          code: status.code,
          stdout,
          unreachable: status.code === SSH_FAILED_EXIT,
          timedOut,
        };
      } catch {
        return { code: -1, stdout: "", unreachable: true, timedOut };
      } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

/** Join a folder and a name (POSIX; the data folder on macOS / Linux). */
function join(dir: string, name: string): string {
  return dir.endsWith("/") ? dir + name : `${dir}/${name}`;
}

/** Create `dir` owner-only, tightening one made looser before. */
async function ensureDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (Deno.build.os === "windows") return;
  try {
    const st = await Deno.stat(dir);
    if (st.mode !== null && (st.mode & 0o777) !== DIR_MODE) await Deno.chmod(dir, DIR_MODE);
  } catch {
    // Best effort: the files inside are 0600.
  }
}

/** Write `data` as JSON to a fresh temp file beside `target` (0600, created exclusively). */
async function writeTemp(target: string, data: unknown): Promise<string> {
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data, null, 2) + "\n", {
    createNew: true,
    mode: FILE_MODE,
  });
  return tmp;
}

/**
 * The update data files: the orchestrator's store (the run lock, the audit), the status the
 * collector writes, and the panel's, scheduler's and notices' files. The one writer of every file
 * here; the readers parse what they read back with lib/updates/files.ts (the same shapes the MCP
 * server reads: `updates.json` is `{ v: 1, machines: { <id>: MachineStatus } }`, each audit line an
 * `AuditEntry`, each spool file an `UpdateRequest`).
 */
export interface UpdateFiles extends UpdatesStore, UpdatesFilesPort {
  /** Replace `updates.json` with these statuses (`{ v: 1, machines }`). */
  saveStatuses(statuses: Readonly<Record<string, MachineStatus>>): Promise<void>;
  loadSchedulerState(): Promise<SchedulerState>;
  saveSchedulerState(s: SchedulerState): Promise<void>;
  loadNotified(): Promise<Map<string, number>>;
  saveNotified(seen: ReadonlyMap<string, number>): Promise<void>;
}

/** A JSON file, parsed, or `null` when missing, not a plain file, too large or not JSON. */
async function readJsonFile(file: string, max = JSON_FILE_MAX): Promise<unknown> {
  try {
    // lstat: a symlink planted in the data folder or the spool is never followed.
    const st = await Deno.lstat(file);
    if (!st.isFile || st.size > max) return null;
    return JSON.parse(await Deno.readTextFile(file));
  } catch {
    return null;
  }
}

/** The last `max` bytes of a file, from a line start (`""` when missing). */
async function readTail(path: string, max: number): Promise<string> {
  let file: Deno.FsFile | null = null;
  try {
    const size = (await Deno.stat(path)).size;
    file = await Deno.open(path, { read: true });
    const from = Math.max(0, size - max);
    if (from > 0) await file.seek(from, Deno.SeekMode.Start);
    const buf = new Uint8Array(size - from);
    let off = 0;
    while (off < buf.length) {
      const n = await file.read(buf.subarray(off));
      if (n === null) break;
      off += n;
    }
    const text = new TextDecoder().decode(buf.subarray(0, off));
    return from > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } catch {
    return "";
  } finally {
    file?.close();
  }
}

/** The update data files in `dataDir`. */
export function createUpdateFiles(dataDir: string): UpdateFiles {
  const path = (name: string) => join(dataDir, name);
  const runFile = path(UPDATE_FILES.run);
  const spool = path(UPDATE_FILES.requests);
  const replace = async (file: string, data: unknown): Promise<void> => {
    await ensureDir(dataDir);
    const tmp = await writeTemp(file, data);
    try {
      await Deno.rename(tmp, file);
    } catch (err) {
      await Deno.remove(tmp).catch(() => {});
      throw err;
    }
  };
  /** The full run record (the orchestrator re-attaches from it: boot id and baseline kept). */
  const readRun = async (): Promise<RunRecord | null> => {
    const doc = await readJsonFile(runFile);
    return doc && typeof doc === "object" && (doc as { v?: unknown }).v === 1 &&
        typeof (doc as { id?: unknown }).id === "string"
      ? doc as RunRecord
      : null;
  };
  return {
    // ---- the orchestrator's store ----
    readRun,
    async claimRun(run) {
      await ensureDir(dataDir);
      // Written whole to a temp file, then hard-linked into place: the link fails when a run file
      // exists, so the lock is taken atomically and never seen half-written.
      const tmp = await writeTemp(runFile, run);
      try {
        await Deno.link(tmp, runFile);
        return true;
      } catch (err) {
        if (err instanceof Deno.errors.AlreadyExists) return false;
        throw err;
      } finally {
        await Deno.remove(tmp).catch(() => {});
      }
    },
    async saveRun(run) {
      const cur = await readRun();
      if (cur && cur.id !== run.id) throw new Error("another run holds the update lock");
      await replace(runFile, run);
    },
    async clearRun(runId) {
      const cur = await readRun();
      if (cur && cur.id !== runId) return;
      await Deno.remove(runFile).catch(() => {});
    },
    async appendAudit(entry: AuditEntry) {
      await ensureDir(dataDir);
      let line = JSON.stringify(entry);
      if (line.length > AUDIT_LINE_MAX) {
        line = JSON.stringify({ ...entry, steps: [], truncated: true });
      }
      await Deno.writeTextFile(path(UPDATE_FILES.runs), line + "\n", {
        append: true,
        mode: FILE_MODE,
      });
    },

    // ---- status (the collector writes, everyone reads) ----
    async statuses() {
      return parseStatusFile(await readJsonFile(path(UPDATE_FILES.status)));
    },
    async saveStatuses(statuses) {
      await replace(path(UPDATE_FILES.status), statusFile(Object.values(statuses)));
    },

    // ---- the panel ----
    async run() {
      return parseRunFile(await readJsonFile(runFile));
    },
    async audit() {
      return parseAudit(await readTail(path(UPDATE_FILES.runs), AUDIT_TAIL_BYTES));
    },
    async schedules(config: UpdatesConfig) {
      const raw = await readJsonFile(path(UPDATE_FILES.schedules));
      if (raw === null) return [];
      const v = validateSchedules(raw, config);
      return v.ok ? v.value : [];
    },
    async saveSchedules(list: readonly UpdateSchedule[]) {
      await replace(path(UPDATE_FILES.schedules), list);
    },
    async requests(config: UpdatesConfig, now: number) {
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(spool)) {
          if (e.isFile && requestIdOf(e.name)) names.push(e.name);
        }
      } catch {
        return [];
      }
      names.sort();
      const out: UpdateRequest[] = [];
      for (const name of names.slice(0, REQUEST_SCAN_MAX)) {
        const id = requestIdOf(name)!;
        const file = join(spool, name);
        const raw = await readJsonFile(file, REQUEST_FILE_MAX);
        const req = parseRequest(raw, id, config, now);
        if (req) {
          out.push(req);
          continue;
        }
        // Expired or unreadable: dropped (an expired one by its own `at`).
        const at = (raw as { at?: unknown } | null)?.at;
        if (raw === null || typeof at !== "number" || requestExpired(at, now)) {
          await Deno.remove(file).catch(() => {});
        }
      }
      return out.sort((a, b) => a.at - b.at);
    },
    async removeRequest(id: string) {
      if (!REQUEST_ID.test(id)) return;
      await Deno.remove(join(spool, requestFile(id))).catch(() => {});
    },

    // ---- the scheduler's and the notices' memory ----
    async loadSchedulerState() {
      const raw = await readJsonFile(path(UPDATE_FILES.scheduler));
      return raw === null ? EMPTY_SCHEDULER_STATE : parseSchedulerState(raw);
    },
    async saveSchedulerState(st: SchedulerState) {
      await replace(path(UPDATE_FILES.scheduler), st);
    },
    async loadNotified() {
      const raw = await readJsonFile(path(UPDATE_FILES.notified));
      const out = new Map<string, number>();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw).slice(0, 2000)) {
          if (typeof v === "number" && Number.isFinite(v)) out.set(k, v);
        }
      }
      return out;
    },
    async saveNotified(seen: ReadonlyMap<string, number>) {
      await replace(path(UPDATE_FILES.notified), Object.fromEntries(seen));
    },
  };
}

// ---- the runner scheduler's pools ----

/** What the pools port runs over on this machine. */
export interface PoolsPortDeps {
  /** The pool commands' programs now (`null`: no runner scheduler here). */
  paths(): PoolPaths | null;
  /** Run one program by exact path with argv (lib/deno-pools.ts runProgram). */
  run(program: string, args: readonly string[]): Promise<{ code: number; out: string }>;
  /** A pool's card facts from Fleet's snapshot (`null`: no card for it). */
  card(pool: string): { readonly jobs: number; readonly healthy: boolean } | null;
  /** Re-read the scheduler's state after a watchdog pass. */
  refresh(): Promise<void>;
}

/**
 * The orchestrator's pools over the runner scheduler's `pause-pool.sh`: `--status <pool>` says
 * whether every slot is idle (exit 0) and prints the pause in force (its reason and expiry), the
 * snapshot gives the running jobs and health, and `run` executes exactly the command the
 * orchestrator built with lib/controls.ts (`holdPoolCommand` / `resumeHoldCommand`).
 */
export function createPoolsPort(d: PoolsPortDeps): PoolsPort {
  return {
    async state(pool: string): Promise<PoolState> {
      const card = d.card(pool);
      const paths = d.paths();
      if (!paths) {
        return { idle: false, jobs: card?.jobs ?? 0, pause: null, healthy: card?.healthy ?? false };
      }
      const r = await d.run(paths.pausePool, ["--status", pool]);
      const pause: PoolPause | null = parsePauseStatus(r.out);
      return {
        idle: r.code === 0,
        jobs: card?.jobs ?? (r.code === 0 ? 0 : 1),
        pause,
        healthy: card?.healthy ?? true,
      };
    },
    async run(command: PoolCommand): Promise<CommandResult> {
      const paths = d.paths();
      // Only the pause script: the orchestrator's holds and resumes are never anything else.
      if (!paths || command.program !== paths.pausePool) {
        return { code: -1, output: "not the runner scheduler's pause command" };
      }
      const r = await d.run(command.program, command.args);
      return { code: r.code, output: r.out };
    },
    async ready(pools: readonly string[]) {
      const paths = d.paths();
      if (!paths) return { ok: false, reason: "no runner scheduler here" };
      if (paths.watchdog) {
        const w = await d.run(paths.watchdog, []);
        if (w.code !== 0) return { ok: false, reason: `the watchdog pass failed (exit ${w.code})` };
      }
      await d.refresh().catch(() => {});
      const bad = pools.filter((p) => d.card(p)?.healthy === false);
      return bad.length
        ? { ok: false, reason: `unhealthy after the pass: ${bad.join(", ")}` }
        : { ok: true, reason: "" };
    },
  };
}
