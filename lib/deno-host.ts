// The real machine for the service: the GitHub CLI's token, the state file in the app's data
// folder, and native notifications through the Deno Desktop runtime. Kept apart from the logic so
// the tests never spawn gh or touch the user's folders.

import type { FleetNotification } from "./notify.ts";
import type { PersistedState } from "./poller.ts";

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

/** The event log's file (the last 2,000 lines and the tracker), in the app's data folder. */
export const LOG_FILE = "fleet-events.json";

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

async function writeJson(dir: string, name: string, data: unknown): Promise<void> {
  await Deno.mkdir(dir, { recursive: true });
  const target = join(dir, name);
  const tmp = `${target}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(data));
  await Deno.rename(tmp, target);
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
  const tag = `fleet-${n.key.replace(/[^A-Za-z0-9:_-]/g, "_").slice(0, 120)}`;
  await api.schedule({ title: n.title, body: n.body, at: Date.now(), tag });
}
