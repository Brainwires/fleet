// The webhook receiver on the real machine: only on the Mac mini that runs the Cloudflare tunnel
// (`com.brainwires.denext-ci-hooks-tunnel`) and holds the webhook secret in its login keychain.
// Anywhere else it stays off and Fleet polls as before. The secret is read into memory by running
// `/usr/bin/security` (an exact path); it is never logged, written, or shown.

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

/** The keychain item. */
export const SECRET_SERVICE = "denext-ci-hooks";
export const SECRET_ACCOUNT = "github-webhook-secret";
/** The tunnel's launchd label. */
export const TUNNEL_LABEL = "com.brainwires.denext-ci-hooks-tunnel";
/** The keychain tool, by absolute path (baked as Fleet's only extra --allow-run besides gh). */
export const SECURITY_BIN = "/usr/bin/security";
/** The scheduler-facing log, relative to $HOME. */
export const HOOKS_LOG_DIR = ".denext-runners/hooks";
export const HOOKS_LOG = "events.jsonl";
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

/** Whether this machine receives the hooks: macOS, the tunnel's launchd job, the keychain item. */
export async function hooksAvailable(): Promise<boolean> {
  if (Deno.build.os !== "darwin") return false;
  const h = home();
  const plist = `${TUNNEL_LABEL}.plist`;
  const tunnel = (h && await exists(`${h}/Library/LaunchAgents/${plist}`)) ||
    await exists(`/Library/LaunchDaemons/${plist}`) ||
    await exists(`/Library/LaunchAgents/${plist}`);
  if (!tunnel) return false;
  try {
    // Without -w: only whether the item exists (its attributes go to /dev/null, never the secret).
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", SECRET_SERVICE, "-a", SECRET_ACCOUNT],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).output();
    return r.success;
  } catch {
    return false;
  }
}

/** A secret as read from the keychain, if it is long enough to use (never logged either way). */
export function usableSecret(raw: string): string | null {
  const s = raw.replace(/\r?\n$/, "");
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

/** The webhook secret, into memory only; `null` when it can't be read or is too short. */
export async function readHookSecret(): Promise<string | null> {
  try {
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", SECRET_SERVICE, "-a", SECRET_ACCOUNT, "-w"],
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

/** Append one verified delivery to ~/.denext-runners/hooks/events.jsonl, rotating at 20 MB. */
export async function appendHookLine(d: HookDelivery, dir = defaultLogDir()): Promise<void> {
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

function defaultLogDir(): string | null {
  const h = home();
  return h ? `${h}/${HOOKS_LOG_DIR}` : null;
}

/**
 * The spool's deliveries received after `sinceMs` (the rotated `.1` first, then the live file),
 * oldest first, each id once: the back-fill's input. Lines are skipped by their leading
 * `received_at` before any JSON parse (the spool holds tens of MB of payloads). `[]` without a
 * spool.
 */
export async function readSpoolSince(
  sinceMs: number,
  dir = defaultLogDir(),
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
export async function recentSpoolIds(dir = defaultLogDir(), max = DEDUPE_KEEP): Promise<string[]> {
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
export async function lastSpoolDeliveryAt(dir = defaultLogDir()): Promise<number | null> {
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

/**
 * Tail the receiver's spool (another process holds the port: `denext task hooks`, or a launchd
 * receiver): from its current end, every 2 s, rotation-aware. Returns the stop function and the
 * newest delivery's time already in the spool (the "last delivery" to start from), or `null` when
 * there is no spool.
 */
export async function tailSpool(
  onDelivery: (d: HookDelivery) => void,
  dir = defaultLogDir(),
  everyMs = 2000,
  seen: Iterable<string> = [],
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
  const tick = async () => {
    if (busy) return;
    busy = true;
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
  };
  const lastDeliveryAt = await lastSpoolDeliveryAt(dir);
  const id = setInterval(() => void tick(), everyMs);
  return { stop: () => clearInterval(id), lastDeliveryAt };
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
}

/**
 * Start the receiver on 127.0.0.1:8789 (loopback only), or `null` when the port is taken or the
 * listen is refused.
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
      appendHookLine(d).catch(() => hooks.onReject?.("log-write"));
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
