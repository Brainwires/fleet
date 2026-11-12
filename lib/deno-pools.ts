// Pool controls and local health on the Mac mini: only where the runner scheduler's ops checkout is
// (pause-pool.sh at its fixed place). Programs run by exact path with argv (no shell).

import { type PoolPaths, poolPaths } from "./controls.ts";
import type { HealthState } from "./health.ts";
import { mergeLocalHealth } from "./local-health.ts";

function home(): string | null {
  try {
    return Deno.env.get("HOME") ?? null;
  } catch {
    return null;
  }
}

/** The pool scripts' paths when this is the machine with the scheduler, else `null`. */
export function localPoolPaths(): PoolPaths | null {
  const h = home();
  if (Deno.build.os !== "darwin" || !h) return null;
  const p = poolPaths(h);
  try {
    return Deno.statSync(p.pausePool).isFile ? p : null;
  } catch {
    return null;
  }
}

/** The local health file merged over the variable's state (unchanged when unreadable). */
export async function readLocalHealth(variable: HealthState): Promise<HealthState> {
  const h = home();
  if (!h) return variable;
  const dir = `${h}/.denext-runners`;
  let json: unknown;
  try {
    json = JSON.parse(await Deno.readTextFile(`${dir}/health.json`));
  } catch {
    return variable;
  }
  const paused = new Set<string>();
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isFile && e.name.startsWith("paused-")) paused.add(e.name.slice("paused-".length));
    }
  } catch {
    // No pauses readable: none shown.
  }
  return mergeLocalHealth(variable, json, paused, Date.now());
}

/** Run one allowlisted program (argv, no shell), at most 10 minutes; its first 2 KB of output. */
export async function runProgram(
  program: string,
  args: readonly string[],
): Promise<{ code: number; out: string }> {
  try {
    const r = await new Deno.Command(program, {
      args: [...args],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(10 * 60_000),
    }).output();
    const dec = new TextDecoder();
    const out = (dec.decode(r.stdout) + "\n" + dec.decode(r.stderr)).slice(0, 2048);
    return { code: r.code, out };
  } catch (err) {
    return { code: -1, out: err instanceof Error ? err.name : "failed to start" };
  }
}
