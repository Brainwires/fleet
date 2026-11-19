// The extra permissions an internal build bakes (denext.config.ts), derived from the build machine's
// local config (lib/settings.ts LOCAL_CONFIG_FILE) instead of from anything in this repo: the runner
// scheduler integration's pool commands and routing helper (`--allow-run`), a webhook spool folder
// outside the app's data folder (`--allow-write`) and the machines service's address (`--allow-net`). Only with FLEET_INTERNAL=1; a release build gets none of it.

import { APP_ID } from "./agent-files.ts";
import { poolPaths, poolPrograms } from "./controls.ts";
import { expandHome, LOCAL_CONFIG_FILE, validateSettings } from "./settings.ts";

/** The grants. */
export interface BuildGrants {
  readonly run: readonly string[];
  readonly write: readonly string[];
  /** Hosts (`host:port`) the app may connect to beside GitHub: the machines service. */
  readonly net: readonly string[];
}

/** The grants a local config calls for (`home` expands `~/`). Throws on an invalid config. */
export function grantsFromConfig(raw: unknown, home: string | null): BuildGrants {
  const r = validateSettings(raw);
  if (!r.ok) throw new Error(`the local config isn't valid: ${r.errors.join("; ")}`);
  const s = r.settings;
  const paths = poolPaths(s.integrations.runnerScheduler?.controls ?? null, home);
  const run = paths ? [...poolPrograms(paths)] : [];
  // The routing helper, like the configuration helper (controls.ts poolPrograms covers that one).
  const routing = expandHome(s.integrations.runnerScheduler?.controls?.routingHelper ?? "", home);
  if (routing) run.push(routing);
  const net: string[] = [];
  if (s.integrations.machines) {
    const u = new URL(s.integrations.machines.url);
    net.push(u.port ? u.host : `${u.hostname}:${u.protocol === "https:" ? 443 : 80}`);
  }
  const write: string[] = [];
  if (s.webhooks.enabled && s.webhooks.spoolDir) {
    const dir = expandHome(s.webhooks.spoolDir, home);
    if (dir) write.push(dir);
  }
  return { run: [...new Set(run)], write, net };
}

/** Where the build machine's local config is: $FLEET_LOCAL_CONFIG, else the macOS data folder's. */
export function localConfigPath(env: (k: string) => string | undefined): string | null {
  const explicit = env("FLEET_LOCAL_CONFIG");
  if (explicit) return explicit;
  const home = env("HOME");
  return home ? `${home}/Library/Application Support/${APP_ID}/${LOCAL_CONFIG_FILE}` : null;
}

/**
 * The internal build's grants: none unless FLEET_INTERNAL=1; then the local config's, and a build
 * without a readable, valid local config fails rather than ship without its controls.
 */
export function internalGrants(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
  read: (path: string) => string = (p) => Deno.readTextFileSync(p),
): BuildGrants {
  if (env("FLEET_INTERNAL") !== "1") return { run: [], write: [], net: [] };
  const path = localConfigPath(env);
  if (!path) throw new Error("FLEET_INTERNAL=1: no HOME and no FLEET_LOCAL_CONFIG");
  let raw: unknown;
  try {
    raw = JSON.parse(read(path));
  } catch (err) {
    throw new Error(
      `FLEET_INTERNAL=1: can't read the local config ${path} (${
        err instanceof Error ? err.name : "error"
      })`,
    );
  }
  return grantsFromConfig(raw, env("HOME") ?? null);
}
