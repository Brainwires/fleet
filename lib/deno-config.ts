// The runner settings' machine side: the configuration helper's path when it exists here, running it
// (argv, no shell; JSON on stdout, kept apart from stderr), and Fleet's caller token for it.
//
// The token: the helper accepts a change from Fleet only with the token Fleet keeps in its own data
// folder (`runner-config.token`, mode 0600, never in the settings, a log or the snapshot), handed to
// the helper on stdin. Fleet makes it on first use; a file with the wrong mode, a symlink or bad
// content is replaced. It is a guardrail against an agent changing the fleet on its own, not a
// security boundary: any process of this user can read the file.

import { expandHome, type RunnerSchedulerIntegration } from "./settings.ts";
import { home } from "./deno-pools.ts";

/** The token file's name in Fleet's data folder (the helper reads it from there). */
export const CONFIG_TOKEN_FILE = "runner-config.token";
const TOKEN = /^[A-Za-z0-9_-]{32,128}$/;

/** The configuration helper's absolute path when the integration names one and it exists here. */
export function localConfigHelper(sched: RunnerSchedulerIntegration | null): string | null {
  const raw = sched?.controls?.configHelper ?? "";
  if (!raw) return null;
  const p = expandHome(raw, home());
  if (!p) return null;
  try {
    return Deno.statSync(p).isFile ? p : null;
  } catch {
    return null;
  }
}

/** A fresh token: 32 random bytes, base64url (43 characters). */
export function newToken(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Whether the file at `path` is a usable token file: regular, not a symlink, mode 0600, valid. */
export function tokenFileOk(path: string): boolean {
  try {
    const st = Deno.lstatSync(path);
    if (!st.isFile || st.isSymlink) return false;
    if (st.mode !== null && (st.mode & 0o777) !== 0o600) return false;
    return TOKEN.test(Deno.readTextFileSync(path).trim());
  } catch {
    return false;
  }
}

/**
 * The token (made, or remade, when the file is missing or not usable). `null` when the data folder
 * can't be written. The value is returned to the caller only to pass on stdin; never log it.
 */
export function ensureConfigToken(dataDir: string): string | null {
  if (!dataDir) return null;
  const path = `${dataDir}/${CONFIG_TOKEN_FILE}`;
  try {
    if (!tokenFileOk(path)) {
      try {
        const st = Deno.lstatSync(path);
        if (st.isDirectory) return null;
        Deno.removeSync(path);
      } catch {
        // missing: nothing to remove
      }
      Deno.writeTextFileSync(path, `${newToken()}\n`, { mode: 0o600, createNew: true });
      Deno.chmodSync(path, 0o600);
    }
    const t = Deno.readTextFileSync(path).trim();
    return TOKEN.test(t) ? t : null;
  } catch {
    return null;
  }
}

/** A helper run's outcome: its exit code and its stdout as JSON (`null` when it wasn't JSON). */
export interface JsonRun {
  readonly code: number;
  readonly json: unknown;
  /** The first 300 characters of stderr, for a message when there is no JSON. */
  readonly err: string;
}

/** Run the helper (argv, no shell) at most `timeoutMs`; stdin is `input` when given, else empty. */
export async function runProgramJson(
  program: string,
  args: readonly string[],
  input?: string,
  timeoutMs = 60_000,
): Promise<JsonRun> {
  try {
    const child = new Deno.Command(program, {
      args: [...args],
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(timeoutMs),
    }).spawn();
    if (input !== undefined) {
      const w = child.stdin.getWriter();
      await w.write(new TextEncoder().encode(input));
      await w.close();
    }
    const r = await child.output();
    const dec = new TextDecoder();
    const out = dec.decode(r.stdout.slice(0, 256 * 1024));
    let json: unknown = null;
    try {
      json = JSON.parse(out);
    } catch {
      json = null;
    }
    return { code: r.code, json, err: dec.decode(r.stderr.slice(0, 2048)).trim().slice(0, 300) };
  } catch (err) {
    return { code: -1, json: null, err: err instanceof Error ? err.name : "failed to start" };
  }
}
