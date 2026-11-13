// The loopback event stream's machine side: its token file, the file that says where it listens,
// and the 127.0.0.1 listener. Kept apart from lib/stream.ts so its tests need no data folder.

import { STREAM_STATE_FILE, STREAM_TOKEN_FILE } from "./agent-files.ts";
import { type FleetStream } from "./stream.ts";

/** The loopback address the stream binds (never a LAN address). */
export const STREAM_HOST = "127.0.0.1";
/** A token file's content: 43 base64url characters (32 random bytes). */
const TOKEN_RE = /^[A-Za-z0-9_-]{32,128}$/;

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);
const posix = () => Deno.build.os !== "windows";

/** 32 random bytes as base64url. */
export function newStreamToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Write a file 0600 through a fresh temp name (created exclusively), renamed over the target. */
async function writePrivate(dir: string, name: string, text: string): Promise<void> {
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const target = join(dir, name);
  const tmp = `${target}.${crypto.randomUUID()}.tmp`;
  try {
    await Deno.writeTextFile(tmp, text, { createNew: true, mode: 0o600 });
    await Deno.rename(tmp, target);
  } catch (err) {
    await Deno.remove(tmp).catch(() => {});
    throw err;
  }
}

/**
 * The per-install token in `<dir>/fleet-stream-token` (0600): read, or made once. A file that
 * isn't a token is replaced; one that is readable by others is tightened.
 */
export async function ensureStreamToken(dir: string): Promise<string> {
  const path = join(dir, STREAM_TOKEN_FILE);
  try {
    const t = (await Deno.readTextFile(path)).trim();
    if (TOKEN_RE.test(t)) {
      if (posix()) {
        const st = await Deno.stat(path);
        if (st.mode !== null && (st.mode & 0o077) !== 0) await Deno.chmod(path, 0o600);
      }
      return t;
    }
  } catch {
    // None yet.
  }
  const token = newStreamToken();
  await writePrivate(dir, STREAM_TOKEN_FILE, token + "\n");
  return token;
}

/** What `fleet-stream.json` says. */
export interface StreamState {
  readonly port: number;
  readonly pid: number;
  readonly started_at: string;
}

/** Note where the stream listens (the CLI reads it). */
export function writeStreamState(dir: string, state: StreamState): Promise<void> {
  return writePrivate(dir, STREAM_STATE_FILE, JSON.stringify(state) + "\n");
}

/** A running listener. */
export interface StreamListener {
  readonly port: number;
  stop(): Promise<void>;
}

/**
 * Listen on 127.0.0.1:`port` (0: any free port, for tests). `null` when the port is taken (or
 * listening isn't allowed): Fleet runs on without the stream.
 */
export function listenStream(stream: FleetStream, port: number): StreamListener | null {
  try {
    const server = Deno.serve(
      { hostname: STREAM_HOST, port, onListen: () => {} },
      (req) => stream.handler(req),
    );
    const addr = server.addr as Deno.NetAddr;
    return {
      port: addr.port,
      stop: async () => {
        stream.stop();
        await server.shutdown().catch(() => {});
      },
    };
  } catch {
    return null;
  }
}
