// The machine updates' remote side, pure: the one ssh argv Fleet ever runs (docs/updates.md). Nothing
// here comes from GitHub data, host output or a page request: the alias is the local config's, the
// verb is one of the gate's fixed verbs (REMOTE_VERBS), the config file is Fleet's own. An alias or a
// verb outside its pattern never reaches argv (`sshArgv` answers `null`).
//
// On the host, a forced command (host/linux/fleet-update-gate, host/macos/fleet-update-gate,
// host/windows/gate.ps1) reads the verb from SSH_ORIGINAL_COMMAND and runs exactly its command;
// anything else exits 64. The status key's line pins it to `status`.

import { SSH_ALIAS } from "./config.ts";
import { REMOTE_VERBS, type RemoteVerb } from "./model.ts";

/** The ssh client: the only program the remote runner starts (an internal build's `--allow-run`). */
export const SSH_BIN = "/usr/bin/ssh";

/** The exit code a gate answers an unknown verb with (EX_USAGE). */
export const GATE_USAGE_EXIT = 64;
/** The exit code `busy` answers when a host's busy hook says so. */
export const GATE_BUSY_EXIT = 10;
/** The exit code an install answers when one is already running on the host (EX_TEMPFAIL). */
export const GATE_RUNNING_EXIT = 75;
/** ssh's own exit code for a connection, authentication or host-key failure. */
export const SSH_FAILED_EXIT = 255;

/**
 * The suffix of the status key's `Host` entry in Fleet's ssh config: `status` connects to
 * `<alias>-status` (the status key, pinned to that verb on the host), every other verb to `<alias>`.
 */
export const STATUS_HOST_SUFFIX = "-status";

/** Whether `v` is one of the gate's verbs. */
export function isRemoteVerb(v: unknown): v is RemoteVerb {
  return typeof v === "string" && (REMOTE_VERBS as readonly string[]).includes(v);
}

/** Whether `v` is an alias Fleet will put in argv (never an option: no leading `-`). */
export function validSshAlias(v: unknown): v is string {
  return typeof v === "string" && SSH_ALIAS.test(v);
}

/**
 * Whether `v` can be the `-F` file: an absolute POSIX path (so never an option), with no control
 * characters. Fleet's own file in its data folder; ssh reads it, Fleet never does.
 */
export function validSshConfigPath(v: unknown): v is string {
  if (typeof v !== "string" || v.length === 0 || v.length > 1024) return false;
  if (/\p{Cc}/u.test(v)) return false;
  return v.startsWith("/");
}

/** The `Host` a verb connects to, or `null` when the alias or the verb isn't valid. */
export function sshHost(alias: string, verb: RemoteVerb): string | null {
  if (!validSshAlias(alias) || !isRemoteVerb(verb)) return null;
  return verb === "status" ? `${alias}${STATUS_HOST_SUFFIX}` : alias;
}

/**
 * The ssh argv for one verb on one machine, exactly:
 * `-F <config> -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes
 *  -o ClearAllForwardings=yes -o PermitLocalCommand=no <host> <verb>`.
 * `null` when the config path, the alias or the verb is outside its pattern.
 */
export function sshArgv(configFile: string, alias: string, verb: RemoteVerb): string[] | null {
  if (!validSshConfigPath(configFile)) return null;
  const host = sshHost(alias, verb);
  if (host === null) return null;
  return [
    "-F",
    configFile,
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "PermitLocalCommand=no",
    host,
    verb,
  ];
}

/**
 * The ssh program the local config names, when it is the one Fleet runs (`null`: refused). The
 * config validator accepts any absolute path; the runner and the build grant only ever use SSH_BIN.
 */
export function sshProgram(configured: unknown): typeof SSH_BIN | null {
  return configured === undefined || configured === null || configured === SSH_BIN ? SSH_BIN : null;
}
