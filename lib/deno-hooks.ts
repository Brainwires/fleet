// The webhook receiver on the real machine, as the settings' `webhooks` section configures it: on
// only when enabled, with the secret readable (the macOS login keychain through `/usr/bin/security`,
// or the extension's own secure store) and, when the settings name one, the public endpoint's launchd
// job file present. Anywhere else it stays off and Fleet polls. The secret is read into memory only;
// it is never logged, written, or shown.

import {
  createHookHandler,
  DEDUPE_KEEP,
  HOOK_HOST,
  HOOK_PORT,
  type HookDelivery,
  readSpool,
  type SpoolCursor,
  spoolLine,
} from "./hooks.ts";
import { expandHome, type WebhookSettings } from "./settings.ts";
import { type WatchFn, watchState } from "./state-watch.ts";

/** The keychain tool, by absolute path (baked as Fleet's only extra --allow-run besides gh). */
export const SECURITY_BIN = "/usr/bin/security";
/** The spool's folder in the app's data folder, when the settings name none. */
export const DEFAULT_SPOOL_SUBDIR = "hooks";
export const HOOKS_LOG = "events.jsonl";
/** The secure-store key of the webhook secret (`secret.source: "secure-store"`). */
export const WEBHOOK_SECRET_KEY = "github-webhook-secret";
/** Rotate at this size, keeping this many files (events.jsonl and events.jsonl.1). */
export const ROTATE_BYTES = 20 * 1024 * 1024;
/** The shortest webhook secret accepted (GitHub's HMAC key; a short one is guessable offline). */
export const MIN_SECRET_LENGTH = 32;
/** The spool's folder mode: the owner only. */
export const HOOKS_DIR_MODE = 0o700;

/** Create the spool folder owner-only (and tighten one made earlier). */
async function ensureDir(dir: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: HOOKS_DIR_MODE });
  if (Deno.build.os === "windows") return;
  try {
    const st = await Deno.stat(dir);
    if (st.mode !== null && (st.mode & 0o777) !== HOOKS_DIR_MODE) {
      await Deno.chmod(dir, HOOKS_DIR_MODE);
    }
  } catch {
    // Best effort: the files inside are 0600 anyway.
  }
}

function home(): string | null {
  try {
    return Deno.env.get("HOME") ?? null;
  } catch {
    return null;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** The spool folder the settings name (`~/` expanded), else `hooks/` in `dataDir`; `null`: none. */
export function spoolDirOf(cfg: WebhookSettings, dataDir: string | null): string | null {
  if (cfg.spoolDir) return expandHome(cfg.spoolDir, home());
  return dataDir ? `${dataDir.replace(/[\\/]$/, "")}/${DEFAULT_SPOOL_SUBDIR}` : null;
}

/** Where a launchd job file for `label` may be (the user's agents, then the system's). */
export function launchdJobPaths(label: string, h: string | null = home()): string[] {
  const plist = `${label}.plist`;
  return [
    ...(h ? [`${h}/Library/LaunchAgents/${plist}`] : []),
    `/Library/LaunchDaemons/${plist}`,
    `/Library/LaunchAgents/${plist}`,
  ];
}

/** A secret store (the extension's `host.secureStore`). */
export interface SecretReader {
  get(key: string): Promise<string | null>;
}

/**
 * Why webhooks are off on this machine, or `null` when they can turn on: enabled, the launchd job
 * file present when one is required (macOS), and the secret's item present.
 */
export async function hooksUnavailable(
  cfg: WebhookSettings,
  store?: SecretReader,
): Promise<string | null> {
  if (!cfg.enabled) return "webhooks are off in the settings";
  if (cfg.requireLaunchdJob) {
    if (Deno.build.os !== "darwin") return "a launchd job is required, and this isn't macOS";
    let found = false;
    for (const p of launchdJobPaths(cfg.requireLaunchdJob)) if (await exists(p)) found = true;
    if (!found) return "the required launchd job file isn't installed";
  }
  if (cfg.secret.source === "secure-store") {
    return (await store?.get(WEBHOOK_SECRET_KEY).catch(() => null))
      ? null
      : "no webhook secret stored";
  }
  if (Deno.build.os !== "darwin") return "the keychain secret works on macOS only";
  try {
    // Without -w: only whether the item exists (its attributes go to /dev/null, never the secret).
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", cfg.secret.service, "-a", cfg.secret.account],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return r.success ? null : "the keychain item isn't there";
  } catch {
    return "the keychain couldn't be read";
  }
}

/** A secret as read, if it is long enough to use (never logged either way). */
export function usableSecret(raw: string): string | null {
  const s = raw.replace(/\r?\n$/, "");
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

/** The webhook secret, into memory only; `null` when it can't be read or is too short. */
export async function readHookSecret(
  cfg: WebhookSettings,
  store?: SecretReader,
): Promise<string | null> {
  if (cfg.secret.source === "secure-store") {
    const v = await store?.get(WEBHOOK_SECRET_KEY).catch(() => null);
    return v ? usableSecret(v) : null;
  }
  try {
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", cfg.secret.service, "-a", cfg.secret.account, "-w"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!r.success) return null;
    return usableSecret(new TextDecoder().decode(r.stdout));
  } catch {
    return null;
  }
}

/** Append one verified delivery to the spool's events.jsonl, rotating at 20 MB. */
export async function appendHookLine(d: HookDelivery, dir: string | null): Promise<void> {
  if (!dir) return;
  await ensureDir(dir);
  const path = `${dir}/${HOOKS_LOG}`;
  const line = JSON.stringify({
    received_at: new Date(d.receivedAt).toISOString(),
    delivery: d.id,
    event: d.event,
    payload: d.payload,
  }) + "\n";
  try {
    const st = await Deno.stat(path);
    if (st.size + line.length > ROTATE_BYTES) await Deno.rename(path, `${path}.1`);
  } catch {
    // No file yet.
  }
  await Deno.writeTextFile(path, line, { append: true, mode: 0o600 });
}

/**
 * The spool's deliveries received after `sinceMs` (the rotated `.1` first, then the live file),
 * oldest first, each id once: the back-fill's input. Lines are skipped by their leading
 * `received_at` before any JSON parse (the spool holds tens of MB of payloads). `[]` without a
 * spool.
 */
export async function readSpoolSince(
  sinceMs: number,
  dir: string | null,
): Promise<HookDelivery[]> {
  if (!dir) return [];
  const out: HookDelivery[] = [];
  const seen = new Set<string>();
  for (const path of [`${dir}/${HOOKS_LOG}.1`, `${dir}/${HOOKS_LOG}`]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line) continue;
      const at = leadingReceivedAt(line);
      if (at !== null && at <= sinceMs) continue;
      const d = spoolLine(line);
      if (!d || d.receivedAt <= sinceMs || seen.has(d.id)) continue;
      seen.add(d.id);
      out.push(d);
    }
  }
  return out.sort((a, b) => a.receivedAt - b.receivedAt);
}

/**
 * The delivery ids of the spool's newest lines (the rotated file, then the live one), at most
 * `max`: the receiver's de-duplication set after a restart, so a replayed delivery id isn't
 * accepted twice. Ids are read with a pattern from each line's head (no JSON parse); `[]` without a
 * spool.
 */
export async function recentSpoolIds(
  dir: string | null,
  max: number = DEDUPE_KEEP,
): Promise<string[]> {
  if (!dir) return [];
  const ids: string[] = [];
  for (const path of [`${dir}/${HOOKS_LOG}.1`, `${dir}/${HOOKS_LOG}`]) {
    let text: string;
    try {
      text = await Deno.readTextFile(path);
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const m = /^\{"received_at":"[^"]{1,40}","delivery":"([^"\\]{1,100})"/.exec(line);
      if (m) ids.push(m[1]);
    }
  }
  return ids.slice(-max);
}

/** A spool line's `received_at` when it leads the line (as `appendHookLine` writes it). */
function leadingReceivedAt(line: string): number | null {
  const m = /^\{"received_at":"([^"]{1,40})"/.exec(line);
  if (!m) return null;
  const t = Date.parse(m[1]);
  return Number.isFinite(t) ? t : null;
}

/**
 * The newest delivery's time in the spool (its last complete line that parses, else the rotated
 * file's), or `null`: the "last delivery" a tail starts with, so a restart during a quiet spell
 * doesn't read as "no delivery yet".
 */
export async function lastSpoolDeliveryAt(dir: string | null): Promise<number | null> {
  if (!dir) return null;
  for (const path of [`${dir}/${HOOKS_LOG}`, `${dir}/${HOOKS_LOG}.1`]) {
    const at = await lastLineAt(path);
    if (at !== null) return at;
  }
  return null;
}

/** The last parseable delivery line's time in one file, read backwards in 256 KB steps. */
async function lastLineAt(path: string): Promise<number | null> {
  let f: Deno.FsFile;
  try {
    f = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    const size = (await f.stat()).size;
    const step = 256 * 1024;
    let end = size;
    let tail = "";
    while (end > 0) {
      const start = Math.max(0, end - step);
      const buf = new Uint8Array(end - start);
      await f.seek(start, Deno.SeekMode.Start);
      let n = 0;
      while (n < buf.length) {
        const r = await f.read(buf.subarray(n));
        if (r === null || r === 0) break;
        n += r;
      }
      tail = new TextDecoder().decode(buf.subarray(0, n)) + tail;
      // The first line of the window may be cut (unless the window reaches the file's start).
      const lines = tail.split("\n");
      const complete = start === 0 ? lines : lines.slice(1);
      for (let i = complete.length - 1; i >= 0; i--) {
        const d = complete[i] ? spoolLine(complete[i]) : null;
        if (d && d.receivedAt > 0) return d.receivedAt;
      }
      end = start;
      if (size - end > 8 * step) break; // a spool of garbage: give up
    }
    return null;
  } catch {
    return null;
  } finally {
    f.close();
  }
}

/** While the spool's folder is watched, it is still re-read this often (a missed event). */
export const SPOOL_SAFETY_MS = 15_000;

/**
 * Tail the receiver's spool (another process holds the port: `denext task hooks`, or a launchd
 * receiver): from its current end, rotation-aware. Event-driven: the spool's folder is watched
 * and each append is read at once (within ~50 ms; a rotation, which renames the file, is seen
 * too), with a re-read every {@linkcode SPOOL_SAFETY_MS} as a safety net; without a watch
 * (`watch: false`, or the folder can't be watched) it re-reads every `everyMs`. Returns the stop
 * function and the newest delivery's time already in the spool (the "last delivery" to start
 * from), or `null` when there is no spool.
 */
export async function tailSpool(
  onDelivery: (d: HookDelivery) => void,
  dir: string | null,
  everyMs = 2000,
  seen: Iterable<string> = [],
  opts: { watch?: boolean | WatchFn } = {},
): Promise<{ stop: () => void; lastDeliveryAt: number | null } | null> {
  if (!dir) return null;
  const path = `${dir}/${HOOKS_LOG}`;
  let size: number;
  try {
    size = (await Deno.stat(path)).size;
  } catch {
    return null;
  }
  const cursor: SpoolCursor = { offset: size, partial: "", seen: new Set(seen) };
  let busy = false;
  /** A change arrived while a read ran: read again when it ends (no append is left unread). */
  let again = false;
  const tick = async (): Promise<void> => {
    if (busy) {
      again = true;
      return;
    }
    busy = true;
    again = false;
    try {
      const st = await Deno.stat(path);
      const f = await Deno.open(path, { read: true });
      try {
        const deliveries = readSpool(cursor, st.size, (from) => {
          const len = Math.min(st.size - from, 4 * 1024 * 1024);
          const buf = new Uint8Array(len);
          f.seekSync(from, Deno.SeekMode.Start);
          let n = 0;
          while (n < len) {
            const r = f.readSync(buf.subarray(n));
            if (r === null || r === 0) break;
            n += r;
          }
          return buf.subarray(0, n);
        });
        for (const d of deliveries) onDelivery(d);
      } finally {
        f.close();
      }
    } catch {
      // Mid-rotation or briefly missing: the next tick reads it.
    } finally {
      busy = false;
    }
    if (again) return tick();
  };
  const lastDeliveryAt = await lastSpoolDeliveryAt(dir);
  const watcher = opts.watch === false ? null : watchState({
    targets: [{ dir, names: [HOOKS_LOG] }],
    onChange: () => void tick(),
    debounceMs: 50,
    maxWaitMs: 250,
    ...(typeof opts.watch === "function" ? { watch: opts.watch } : {}),
  });
  // Watched: the interval is only a safety net. Not watched (yet): the old 2 s re-read.
  const id = setInterval(
    () => void tick(),
    watcher && watcher.watching > 0 ? Math.max(everyMs, SPOOL_SAFETY_MS) : everyMs,
  );
  return {
    stop: () => {
      clearInterval(id);
      watcher?.stop();
    },
    lastDeliveryAt,
  };
}

/** A running receiver. */
export interface Receiver {
  readonly port: number;
  stop(): Promise<void>;
}

/** What the receiver reports (kinds and counts only: no bodies, headers or secret). */
export interface ReceiverHooks {
  onDelivery(d: HookDelivery): void;
  onVerified(event: string, at: number): void;
  onReject?(why: string): void;
}

/** The receiver's options. */
export interface ReceiverOptions {
  readonly port?: number;
  /** Delivery ids already in the spool ({@linkcode recentSpoolIds}): never accepted again. */
  readonly seen?: Iterable<string>;
  /** GitHub's clock minus ours (ms), for the replay window. */
  readonly clockOffset?: () => number;
  /** The spool folder every verified delivery is appended to (`null`: none). */
  readonly spoolDir?: string | null;
}

/**
 * Start the receiver on 127.0.0.1 (loopback only; port 8789 unless the options say), or `null` when
 * the port is taken or the listen is refused.
 */
export function startReceiver(
  secret: string,
  hooks: ReceiverHooks,
  options: ReceiverOptions = {},
): Receiver | null {
  const port = options.port ?? HOOK_PORT;
  const handler = createHookHandler({
    secret,
    ...(options.seen ? { seen: options.seen } : {}),
    ...(options.clockOffset ? { clockOffset: options.clockOffset } : {}),
    onDelivery: (d) => {
      hooks.onDelivery(d);
      appendHookLine(d, options.spoolDir ?? null).catch(() => hooks.onReject?.("log-write"));
    },
    onVerified: hooks.onVerified,
    onReject: hooks.onReject,
  });
  try {
    const server = Deno.serve({ hostname: HOOK_HOST, port, onListen: () => {} }, handler);
    return { port, stop: () => server.shutdown() };
  } catch {
    return null;
  }
}
