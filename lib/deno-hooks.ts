// The webhook receiver on the real machine: only on the Mac mini that runs the Cloudflare tunnel
// (`com.brainwires.denext-ci-hooks-tunnel`) and holds the webhook secret in its login keychain.
// Anywhere else it stays off and Fleet polls as before. The secret is read into memory by running
// `/usr/bin/security` (an exact path); it is never logged, written, or shown.

import {
  createHookHandler,
  HOOK_HOST,
  HOOK_PORT,
  type HookDelivery,
  readSpool,
  type SpoolCursor,
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

/** The webhook secret, into memory only; `null` when it can't be read. */
export async function readHookSecret(): Promise<string | null> {
  try {
    const r = await new Deno.Command(SECURITY_BIN, {
      args: ["find-generic-password", "-s", SECRET_SERVICE, "-a", SECRET_ACCOUNT, "-w"],
      stdin: "null",
      stdout: "piped",
      stderr: "null",
    }).output();
    if (!r.success) return null;
    const s = new TextDecoder().decode(r.stdout).replace(/\r?\n$/, "");
    return s.length >= 8 ? s : null;
  } catch {
    return null;
  }
}

/** Append one verified delivery to ~/.denext-runners/hooks/events.jsonl, rotating at 20 MB. */
export async function appendHookLine(d: HookDelivery, dir = defaultLogDir()): Promise<void> {
  if (!dir) return;
  await Deno.mkdir(dir, { recursive: true });
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
 * Tail the receiver's spool (another process holds the port: `denext task hooks`, or a launchd
 * receiver): from its current end, every 2 s, rotation-aware. Returns the stop function, or `null`
 * when there is no spool.
 */
export async function tailSpool(
  onDelivery: (d: HookDelivery) => void,
  dir = defaultLogDir(),
  everyMs = 2000,
): Promise<(() => void) | null> {
  if (!dir) return null;
  const path = `${dir}/${HOOKS_LOG}`;
  let size: number;
  try {
    size = (await Deno.stat(path)).size;
  } catch {
    return null;
  }
  const cursor: SpoolCursor = { offset: size, partial: "", seen: new Set() };
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
  const id = setInterval(() => void tick(), everyMs);
  return () => clearInterval(id);
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

/**
 * Start the receiver on 127.0.0.1:8789 (loopback only), or `null` when the port is taken or the
 * listen is refused.
 */
export function startReceiver(
  secret: string,
  hooks: ReceiverHooks,
  port = HOOK_PORT,
): Receiver | null {
  const handler = createHookHandler({
    secret,
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
