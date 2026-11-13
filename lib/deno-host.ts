// The real machine for the service: the GitHub CLI's token, the state file in the app's data
// folder, and native notifications through the Deno Desktop runtime. Kept apart from the logic so
// the tests never spawn gh or touch the user's folders.

import type { FleetNotification } from "./notify.ts";
import type { PersistedState } from "./poller.ts";
import { type FleetSettings, LOCAL_CONFIG_FILE, SETTINGS_FILE } from "./settings.ts";
import type { FleetEvent } from "./events.ts";
import {
  AGENT_SNAPSHOT_FILE,
  HISTORY_FILE,
  JOURNAL_FILE,
  JOURNAL_MAX_BYTES,
  JOURNAL_OLD_FILE,
  LOG_FILE,
} from "./agent-files.ts";

export { JOURNAL_FILE, JOURNAL_OLD_FILE, LOG_FILE };

/**
 * Where `gh` may be, by OS: absolute paths only, the same list the app bakes as its `--allow-run`
 * (denext.config.ts reads it), so nothing on PATH is ever run.
 */
export const GH_PATHS: Readonly<Record<string, readonly string[]>> = {
  darwin: ["/opt/homebrew/bin/gh", "/usr/local/bin/gh"],
  linux: ["/usr/bin/gh", "/usr/local/bin/gh"],
  windows: ["C:\\Program Files\\GitHub CLI\\gh.exe"],
};

/** Every gh path, for the baked `--allow-run`. */
export const ALL_GH_PATHS: readonly string[] = Object.values(GH_PATHS).flat();

/**
 * The GitHub CLI's token (`gh auth token`), or `null`. Its output goes only into the returned
 * string: stderr is discarded, nothing is logged, and a failure says nothing about the token.
 */
export async function ghToken(os: string = Deno.build.os): Promise<string | null> {
  for (const path of GH_PATHS[os] ?? []) {
    try {
      const st = await Deno.stat(path);
      if (!st.isFile) continue;
    } catch {
      continue;
    }
    try {
      const out = await new Deno.Command(path, {
        args: ["auth", "token", "--hostname", "github.com"],
        stdin: "null",
        stdout: "piped",
        stderr: "null",
      }).output();
      if (!out.success) continue;
      const token = new TextDecoder().decode(out.stdout).trim();
      if (/^[A-Za-z0-9_]{20,255}$/.test(token)) return token;
    } catch {
      // Not runnable here (permission, broken install): try the next path.
    }
  }
  return null;
}

/** The state file's name in the app's data folder. */
export const STATE_FILE = "fleet-state.json";
/** Data files: the owner only (CI state names the owners' infrastructure). */
export const FILE_MODE = 0o600;
/** The data folder: the owner only. */
export const DIR_MODE = 0o700;

const posix = () => Deno.build.os !== "windows";
/** Folders already made / tightened by this process. */
const madeDirs = new Set<string>();

/** Create `dir` owner-only, and tighten one created before (once per process; POSIX only). */
async function ensureDir(dir: string): Promise<void> {
  if (madeDirs.has(dir)) return;
  await Deno.mkdir(dir, { recursive: true, mode: DIR_MODE });
  if (posix()) {
    try {
      const st = await Deno.stat(dir);
      if (st.mode !== null && (st.mode & 0o777) !== DIR_MODE) await Deno.chmod(dir, DIR_MODE);
    } catch {
      // Best effort: the files inside are 0600.
    }
  }
  madeDirs.add(dir);
}

/** Join a folder and a file name with the OS's separator. */
function join(dir: string, name: string): string {
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith(sep) ? dir + name : dir + sep + name;
}

/** Read the persisted state (`null` when missing or unreadable). */
export async function loadState(dir: string): Promise<PersistedState | null> {
  try {
    const data = JSON.parse(await Deno.readTextFile(join(dir, STATE_FILE)));
    if (typeof data !== "object" || data === null) return null;
    return {
      durations: typeof data.durations === "object" && data.durations ? data.durations : {},
      notified: typeof data.notified === "object" && data.notified ? data.notified : {},
      prefs: typeof data.prefs === "object" && data.prefs ? data.prefs : {},
    };
  } catch {
    return null;
  }
}

/** Write the persisted state (atomically: a temp file renamed over it). */
export function saveState(dir: string, state: PersistedState): Promise<void> {
  return writeJson(dir, STATE_FILE, state);
}

/**
 * A JSON file's value: `null` when it doesn't exist, the string `"unreadable"` when it exists but
 * can't be read or parsed (so validation reports it, and it is never mistaken for "no file").
 */
async function readJsonFile(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await Deno.readTextFile(path);
  } catch (err) {
    return err instanceof Deno.errors.NotFound ? null : "unreadable";
  }
  try {
    return JSON.parse(text);
  } catch {
    return "unreadable";
  }
}

/** The settings file and the machine's local config, as found (see settings.ts startupSettings). */
export async function loadSettingsFiles(
  dir: string,
): Promise<{ settingsRaw: unknown; localConfigRaw: unknown }> {
  return {
    settingsRaw: await readJsonFile(join(dir, SETTINGS_FILE)),
    localConfigRaw: await readJsonFile(join(dir, LOCAL_CONFIG_FILE)),
  };
}

/** Write the settings (0600, atomically). */
export function saveSettings(dir: string, s: FleetSettings): Promise<void> {
  return writeJson(dir, SETTINGS_FILE, s, 2);
}

/** Read the event log file (`null` when missing or unreadable). */
export async function loadLog(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(join(dir, LOG_FILE)));
  } catch {
    return null;
  }
}

/** Write the event log file. */
export function saveLog(dir: string, data: unknown): Promise<void> {
  return writeJson(dir, LOG_FILE, data);
}

/** The agents' snapshot (lib/agent-snapshot.ts), written atomically like the state file. */
export function saveAgentSnapshot(dir: string, snap: unknown): Promise<void> {
  return writeJson(dir, AGENT_SNAPSHOT_FILE, snap);
}

/** The usage history file, or `null` when there is none (or it doesn't parse). */
export async function loadHistory(dir: string): Promise<unknown> {
  try {
    return JSON.parse(await Deno.readTextFile(join(dir, HISTORY_FILE)));
  } catch {
    return null;
  }
}

/** Write the usage history (0600, atomically). */
export function saveHistory(dir: string, doc: unknown): Promise<void> {
  return writeJson(dir, HISTORY_FILE, doc);
}

/** The event journal's events (the rotated file, then the live one), oldest first. */
export async function readJournal(dir: string): Promise<FleetEvent[]> {
  const out: FleetEvent[] = [];
  for (const name of [JOURNAL_OLD_FILE, JOURNAL_FILE]) {
    let text: string;
    try {
      text = await Deno.readTextFile(join(dir, name));
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as FleetEvent;
        if (typeof e?.seq === "number" && typeof e.at === "number" && typeof e.text === "string") {
          out.push(e);
        }
      } catch {
        // A torn line: skip it.
      }
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/**
 * Append events to the journal, one JSON line each, rotating it to {@linkcode JOURNAL_OLD_FILE}
 * past {@linkcode JOURNAL_MAX_BYTES} first. Lines are only ever appended, so a reader that pages by
 * `seq` never sees one change.
 */
export async function appendJournal(
  dir: string,
  events: readonly { readonly seq: number }[],
  maxBytes = JOURNAL_MAX_BYTES,
): Promise<void> {
  if (events.length === 0) return;
  await ensureDir(dir);
  const target = join(dir, JOURNAL_FILE);
  try {
    const st = await Deno.stat(target);
    if (st.size >= maxBytes) {
      await Deno.rename(target, join(dir, JOURNAL_OLD_FILE));
    } else if (posix() && st.mode !== null && (st.mode & 0o777) !== FILE_MODE) {
      // A journal from a build before 0600: tightened once.
      await Deno.chmod(target, FILE_MODE);
    }
  } catch {
    // No journal yet.
  }
  const text = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await Deno.writeTextFile(target, text, { append: true, mode: FILE_MODE });
}

/** The journal's last `seq` (0 when there is none), so a lost log file never reuses a number. */
export async function journalLastSeq(dir: string): Promise<number> {
  for (const name of [JOURNAL_FILE, JOURNAL_OLD_FILE]) {
    let file: Deno.FsFile | undefined;
    try {
      const path = join(dir, name);
      const size = (await Deno.stat(path)).size;
      file = await Deno.open(path, { read: true });
      const from = Math.max(0, size - 64 * 1024);
      await file.seek(from, Deno.SeekMode.Start);
      const buf = new Uint8Array(size - from);
      let off = 0;
      while (off < buf.length) {
        const n = await file.read(buf.subarray(off));
        if (n === null) break;
        off += n;
      }
      const lines = new TextDecoder().decode(buf.subarray(0, off)).split("\n").reverse();
      for (const line of lines) {
        try {
          const seq = (JSON.parse(line) as { seq?: unknown }).seq;
          if (typeof seq === "number") return seq;
        } catch {
          // A partial first line (or a torn last one): skip it.
        }
      }
    } catch {
      // Missing: try the rotated one.
    } finally {
      file?.close();
    }
  }
  return 0;
}

/**
 * Write JSON atomically: a fresh temp file with a random name (0600, created exclusively, so
 * nothing pre-placed is written through), renamed over the target.
 */
async function writeJson(
  dir: string,
  name: string,
  data: unknown,
  indent?: number,
): Promise<void> {
  await ensureDir(dir);
  const target = join(dir, name);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    const text = JSON.stringify(data, null, indent) + (indent ? "\n" : "");
    await Deno.writeTextFile(tmp, text, { createNew: true, mode: FILE_MODE });
    await Deno.rename(tmp, target);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/** The slice of `Deno.desktop.notifications` Fleet uses (denext's Deno Desktop runtime). */
interface NativeNotifications {
  schedule(options: { title: string; body?: string; at: number; tag?: string }): Promise<string>;
  requestPermission?(): Promise<string>;
}

/** `Deno.desktop.notifications`, or `undefined` outside the desktop runtime. */
function nativeNotifications(): NativeNotifications | undefined {
  const desktop =
    (Deno as unknown as { desktop?: { notifications?: NativeNotifications } }).desktop;
  return desktop?.notifications;
}

let permissionAsked: Promise<unknown> | null = null;

/** The runtime tag of every notification Fleet posts: `fleet-<key>`. */
export const NOTIFICATION_TAG_PREFIX = "fleet-";

/** A click on a notification, as `Deno.desktop`'s `"notificationresponse"` reports it. */
interface NotificationResponse {
  readonly tag?: unknown;
}

/** Whether a notification response is a click on one of Fleet's own notifications. */
export function isFleetNotificationClick(r: NotificationResponse | null | undefined): boolean {
  return typeof r?.tag === "string" && r.tag.startsWith(NOTIFICATION_TAG_PREFIX);
}

/**
 * Call `fn` for every click on one of Fleet's notifications: the click that launched the app
 * (`Deno.desktop.launchNotificationResponses`) and every later one (`"notificationresponse"`).
 * Outside denext's desktop runtime it does nothing.
 */
export function onNotificationClick(fn: () => void): void {
  const desktop = (Deno as unknown as {
    desktop?: {
      launchNotificationResponses?: readonly NotificationResponse[];
      addEventListener?(type: string, listener: (e: Event) => void): void;
    };
  }).desktop;
  if (!desktop) return;
  const launched = desktop.launchNotificationResponses;
  if (Array.isArray(launched) && launched.some(isFleetNotificationClick)) fn();
  desktop.addEventListener?.("notificationresponse", (e) => {
    if (isFleetNotificationClick((e as CustomEvent<NotificationResponse>).detail)) fn();
  });
}

/**
 * Post a notification now, from the app's process (it must work while every window is hidden, when
 * a page may be suspended). Tagged by its key, so the OS replaces rather than stacks a repeat.
 * Outside the desktop runtime it does nothing.
 */
export async function postNotification(n: FleetNotification): Promise<void> {
  const api = nativeNotifications();
  if (!api) return;
  permissionAsked ??= api.requestPermission?.().catch(() => null) ?? Promise.resolve(null);
  await permissionAsked;
  const tag = `${NOTIFICATION_TAG_PREFIX}${n.key.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 120)}`;
  await api.schedule({ title: n.title, body: n.body, at: Date.now(), tag });
}
