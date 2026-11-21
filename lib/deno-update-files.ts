// The Updates panel's files in the data folder, on Deno: it reads the status, the run in flight and
// the audit (lib/updates/files.ts parses them), reads and writes `update-schedules.json` (written
// only after the dialog) and the scheduler's `update-scheduler.json`, and lists and removes the
// agents' requests in `update-requests/`. Every write is atomic and 0600. Large or garbled files
// read as nothing; nothing here runs a program.

import {
  UPDATE_NOTIFIED_FILE,
  UPDATE_REQUESTS_DIR,
  UPDATE_RUN_FILE,
  UPDATE_RUNS_FILE,
  UPDATE_SCHEDULER_FILE,
  UPDATE_SCHEDULES_FILE,
  UPDATES_FILE,
} from "./agent-files.ts";
import { FILE_MODE } from "./deno-host.ts";
import type { UpdatesFilesPort } from "./updates/backend.ts";
import { validateSchedules } from "./updates/config.ts";
import { parseAudit, parseRunFile, parseStatusFile } from "./updates/files.ts";
import type { UpdateSchedule, UpdatesConfig } from "./updates/model.ts";
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

/** The audit's tail read at most (bytes). */
const AUDIT_TAIL_BYTES = 512 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

async function readJson(path: string, max = MAX_JSON_BYTES): Promise<unknown> {
  try {
    const st = await Deno.stat(path);
    if (!st.isFile || st.size > max) return null;
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, name);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmp, JSON.stringify(data, null, 1) + "\n", {
      createNew: true,
      mode: FILE_MODE,
    });
    await Deno.rename(tmp, target);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** The last `max` bytes of a file, from a line start. */
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

/** The files port for the data folder `dir`. */
export function updateFiles(dir: string): UpdatesFilesPort & {
  loadSchedulerState(): Promise<SchedulerState>;
  saveSchedulerState(s: SchedulerState): Promise<void>;
  loadNotified(): Promise<Map<string, number>>;
  saveNotified(seen: ReadonlyMap<string, number>): Promise<void>;
} {
  const spool = join(dir, UPDATE_REQUESTS_DIR);
  return {
    async statuses() {
      return parseStatusFile(await readJson(join(dir, UPDATES_FILE)));
    },
    async run() {
      return parseRunFile(await readJson(join(dir, UPDATE_RUN_FILE)));
    },
    async audit() {
      return parseAudit(await readTail(join(dir, UPDATE_RUNS_FILE), AUDIT_TAIL_BYTES));
    },
    async schedules(config: UpdatesConfig) {
      const raw = await readJson(join(dir, UPDATE_SCHEDULES_FILE));
      if (raw === null) return [];
      const v = validateSchedules(raw, config);
      return v.ok ? v.value : [];
    },
    async saveSchedules(list: readonly UpdateSchedule[]) {
      await writeJson(dir, UPDATE_SCHEDULES_FILE, list);
    },
    async requests(config: UpdatesConfig, now: number) {
      const out: UpdateRequest[] = [];
      try {
        for await (const e of Deno.readDir(spool)) {
          const id = e.isFile ? requestIdOf(e.name) : null;
          if (!id) continue;
          const path = join(spool, e.name);
          const raw = await readJson(path, MAX_REQUEST_BYTES);
          const req = parseRequest(raw, id, config, now);
          if (req) out.push(req);
          else {
            // Expired or invalid: dropped (an expired one by its own `at`, else unreadable).
            const at = (raw as { at?: unknown } | null)?.at;
            if (raw === null || typeof at !== "number" || requestExpired(at, now)) {
              await Deno.remove(path).catch(() => {});
            }
          }
          if (out.length >= 100) break;
        }
      } catch {
        return [];
      }
      return out.sort((a, b) => a.at - b.at);
    },
    async removeRequest(id: string) {
      if (!REQUEST_ID.test(id)) return;
      await Deno.remove(join(spool, requestFile(id))).catch(() => {});
    },
    async loadSchedulerState() {
      const raw = await readJson(join(dir, UPDATE_SCHEDULER_FILE));
      return raw === null ? EMPTY_SCHEDULER_STATE : parseSchedulerState(raw);
    },
    async saveSchedulerState(s: SchedulerState) {
      await writeJson(dir, UPDATE_SCHEDULER_FILE, s);
    },
    async loadNotified() {
      const raw = await readJson(join(dir, UPDATE_NOTIFIED_FILE));
      const out = new Map<string, number>();
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        for (const [k, v] of Object.entries(raw).slice(0, 2000)) {
          if (typeof v === "number" && Number.isFinite(v)) out.set(k, v);
        }
      }
      return out;
    },
    async saveNotified(seen: ReadonlyMap<string, number>) {
      await writeJson(dir, UPDATE_NOTIFIED_FILE, Object.fromEntries(seen));
    },
  };
}
