// The machine updates on the real machine (lib/updates/ has the pure model): running the one ssh
// argv (lib/updates/remote.ts), the data files (0600 in the data folder: status, schedules, the run
// in flight, the append-only audit log) and reading the MCP server's request spool. Everything a
// host prints is capped here and stays untrusted text: it is never put into argv or a later command.
//
// ssh runs with a cleared environment (no agent socket, no inherited options), its config file named
// with -F (so neither ~/.ssh/config nor /etc/ssh/ssh_config is read), no stdin and a time cap. Fleet
// passes the config's path and never reads a key.

import type {
  AuditEntry,
  RemotePort,
  RemoteResult,
  RemoteVerb,
  RunRecord,
  UpdatesMachine,
  UpdatesStore,
} from "./updates/model.ts";
import { SSH_BIN, SSH_FAILED_EXIT, sshArgv } from "./updates/remote.ts";

/** A verb's time cap when the caller gives none (the collectors' 120 s); never more than an hour. */
export const REMOTE_TIMEOUT_MS = 120_000;
const REMOTE_TIMEOUT_MAX = 60 * 60_000;
/** At most this much of a verb's stdout is kept (a status document is far smaller). */
export const REMOTE_STDOUT_MAX = 1_000_000;

/** The data files' names, in the data folder. */
export const UPDATE_FILES = {
  status: "updates.json",
  schedules: "update-schedules.json",
  run: "update-run.json",
  runs: "update-runs.jsonl",
  requests: "update-requests",
  sshDir: "updates",
} as const;

/** Data files: the owner only. */
const FILE_MODE = 0o600;
/** Folders: the owner only. */
const DIR_MODE = 0o700;
/** One audit line is at most this long (the orchestrator redacts and caps output tails first). */
const AUDIT_LINE_MAX = 256 * 1024;
/** A request file is at most this large; a bigger one is skipped unread. */
export const REQUEST_FILE_MAX = 4 * 1024;
/** At most this many request files are read per pass (Fleet keeps at most 20 pending). */
export const REQUEST_SCAN_MAX = 64;
/** A request file's name: what the MCP server writes (`<id>.json`). */
const REQUEST_NAME = /^[A-Za-z0-9_-]{1,64}\.json$/;

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

/** The update data files: the orchestrator's store plus status, schedules and the request spool. */
export interface UpdateFiles extends UpdatesStore {
  /** `updates.json` / `update-schedules.json`, parsed, or `null` when missing or not JSON. */
  readJson(name: typeof UPDATE_FILES.status | typeof UPDATE_FILES.schedules): Promise<unknown>;
  /** Replace `updates.json` / `update-schedules.json` atomically (0600). */
  writeJson(
    name: typeof UPDATE_FILES.status | typeof UPDATE_FILES.schedules,
    data: unknown,
  ): Promise<void>;
  /** The last `limit` audit lines, oldest first (lines that aren't JSON are skipped; untyped). */
  readAudit(limit: number): Promise<unknown[]>;
  /** The pending request files (raw, untrusted JSON; validated by the caller), by name. */
  readRequests(): Promise<{ id: string; doc: unknown }[]>;
  /** Remove one request file (approved, refused or expired). */
  removeRequest(id: string): Promise<void>;
}

/** The update data files in `dataDir`. */
export function createUpdateFiles(dataDir: string): UpdateFiles {
  const path = (name: string) => join(dataDir, name);
  const runFile = path(UPDATE_FILES.run);
  const reqDir = path(UPDATE_FILES.requests);
  const readJsonFile = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await Deno.readTextFile(file));
    } catch {
      return null;
    }
  };
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
  const readRun = async (): Promise<RunRecord | null> => {
    const doc = await readJsonFile(runFile);
    return doc && typeof doc === "object" && (doc as { v?: unknown }).v === 1 &&
        typeof (doc as { id?: unknown }).id === "string"
      ? doc as RunRecord
      : null;
  };
  return {
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
    readJson: (name) => readJsonFile(path(name)),
    writeJson: (name, data) => replace(path(name), data),
    async readAudit(limit) {
      let text: string;
      try {
        text = await Deno.readTextFile(path(UPDATE_FILES.runs));
      } catch {
        return [];
      }
      const out: unknown[] = [];
      for (const line of text.split("\n")) {
        if (!line) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // A torn or edited line: skipped.
        }
      }
      return out.slice(-Math.max(0, Math.floor(limit)));
    },
    async readRequests() {
      const names: string[] = [];
      try {
        for await (const e of Deno.readDir(reqDir)) {
          if (e.isFile && REQUEST_NAME.test(e.name)) names.push(e.name);
        }
      } catch {
        return [];
      }
      names.sort();
      const out: { id: string; doc: unknown }[] = [];
      for (const name of names.slice(0, REQUEST_SCAN_MAX)) {
        const file = join(reqDir, name);
        try {
          // lstat: a symlink planted in the spool is never followed.
          const st = await Deno.lstat(file);
          if (!st.isFile || st.size > REQUEST_FILE_MAX) continue;
          out.push({
            id: name.slice(0, -".json".length),
            doc: JSON.parse(await Deno.readTextFile(file)),
          });
        } catch {
          // Unreadable or not JSON: skipped (the caller expires stale files by name).
        }
      }
      return out;
    },
    async removeRequest(id) {
      if (!REQUEST_NAME.test(`${id}.json`)) return;
      await Deno.remove(join(reqDir, `${id}.json`)).catch(() => {});
    },
  };
}
