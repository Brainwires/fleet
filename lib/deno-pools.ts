// The runner scheduler integration on the real machine (settings `integrations.runnerScheduler`):
// its pool commands, only when the configured pause script exists here, and the watchdog's local
// health file merged over the variable. Programs run by exact path with argv (no shell).

import { type PoolPaths, poolPaths } from "./controls.ts";
import type { HealthState } from "./health.ts";
import { mergeLocalHealth } from "./local-health.ts";
import { expandHome, type RunnerSchedulerIntegration } from "./settings.ts";

/** $HOME, or `null`. */
export function home(): string | null {
  try {
    return Deno.env.get("HOME") ?? null;
  } catch {
    return null;
  }
}

/** The pool commands when the integration configures them and the pause script exists here. */
export function localPoolPaths(sched: RunnerSchedulerIntegration | null): PoolPaths | null {
  const p = poolPaths(sched?.controls ?? null, home());
  if (!p) return null;
  try {
    return Deno.statSync(p.pausePool).isFile ? p : null;
  } catch {
    return null;
  }
}

/**
 * The integration's local health reader (its `localHealthFile`, paused from `paused-<pool>` files
 * in `pausedDir`), or `undefined` when it has none.
 */
export function localHealthReader(
  sched: RunnerSchedulerIntegration | null,
): ((variable: HealthState) => Promise<HealthState>) | undefined {
  if (!sched?.localHealthFile) return undefined;
  const file = expandHome(sched.localHealthFile, home());
  const pausedDir = sched.pausedDir ? expandHome(sched.pausedDir, home()) : null;
  if (!file) return undefined;
  return (variable) => readLocalHealth(variable, file, pausedDir);
}

/** The local health file merged over the variable's state (unchanged when unreadable). */
export async function readLocalHealth(
  variable: HealthState,
  file: string,
  pausedDir: string | null,
): Promise<HealthState> {
  let json: unknown;
  try {
    json = JSON.parse(await Deno.readTextFile(file));
  } catch {
    return variable;
  }
  const paused = new Set<string>();
  if (pausedDir) {
    try {
      for await (const e of Deno.readDir(pausedDir)) {
        if (e.isFile && e.name.startsWith("paused-")) paused.add(e.name.slice("paused-".length));
      }
    } catch {
      // No pauses readable: none shown.
    }
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
