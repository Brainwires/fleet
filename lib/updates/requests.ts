// Agents' update requests: the MCP server's only write is one file in the data folder's
// `update-requests/` spool; Fleet shows each as "asked by an agent" and runs one only after the
// user approves it through Update now's dialog. Pure: the MCP server (mcp/update-requests.ts
// writes the file) and the backend (lib/deno-updates.ts lists them) share these rules.
//
// A request is untrusted input on both sides: a configured machine that may install, the enum
// fields, a reason stripped of control characters and at most 200 characters, at most 20 pending,
// gone after 7 days. Nothing in a request is ever put into an argv: an approved one becomes a run
// of the configured machine with the mode and reboot policy the user saw in the dialog.

import { canInstall, MACHINE_ID } from "./config.ts";
import {
  clampText,
  MAX_REASON_LEN,
  REBOOT_POLICIES,
  type RebootPolicy,
  UPDATE_MODES,
  type UpdateMode,
  type UpdatesConfig,
} from "./model.ts";

/** At most this many requests wait at once; the next is refused. */
export const MAX_PENDING_REQUESTS = 20;
/** A request not approved within this long is dropped. */
export const REQUEST_TTL_MS = 7 * 24 * 3600_000;
/** A reason longer than this (after stripping) is refused by the MCP tool, cut by the reader. */
export const MAX_REQUEST_REASON = MAX_REASON_LEN;
/** A request file larger than this is ignored unread. */
export const MAX_REQUEST_BYTES = 4096;
/** A request id (also its file's name, `<id>.json`). */
export const REQUEST_ID = /^req-[a-z0-9]{6,40}$/;

/** One request in the spool. */
export interface UpdateRequest {
  readonly v: 1;
  readonly id: string;
  readonly machine: string;
  readonly mode: UpdateMode;
  readonly reboot: RebootPolicy;
  /** Why, as the agent put it: untrusted text, shown as a quote. */
  readonly reason: string;
  /** When it was filed (ms). */
  readonly at: number;
  readonly by: "agent";
}

/** A request's file name. */
export const requestFile = (id: string): string => `${id}.json`;

/** A request id from a file name, or `null` when the name isn't one. */
export function requestIdOf(file: string): string | null {
  const m = /^(req-[a-z0-9]{6,40})\.json$/.exec(file);
  return m ? m[1] : null;
}

/** A fresh request id. */
export function newRequestId(now: number, random: () => number = Math.random): string {
  let r = "";
  for (let i = 0; i < 8; i++) r += Math.floor(random() * 36).toString(36);
  return `req-${now.toString(36)}${r}`;
}

/** The answer to a request the MCP tool is asked to file. */
export type BuildResult =
  | { readonly ok: true; readonly request: UpdateRequest }
  | { readonly ok: false; readonly error: string };

const strip = (s: string) =>
  s.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ").replace(/\s+/g, " ").trim();

/** The configured machine `id` names (case-insensitively), or `undefined`. */
function machineOf(config: UpdatesConfig, id: string) {
  return config.machines.find((m) => m.id.toLowerCase() === id.toLowerCase());
}

/**
 * Check the MCP tool's arguments and build the request: refused for an unknown or notify-only
 * machine, a mode or reboot policy outside its enum, a missing or oversized reason, or when
 * `pending` requests already wait.
 */
export function buildRequest(
  args: Record<string, unknown>,
  config: UpdatesConfig | null,
  pending: number,
  now: number,
  id: string,
): BuildResult {
  if (!config) return { ok: false, error: "Machine updates aren't set up in Fleet." };
  const mid = args.machine;
  if (typeof mid !== "string" || !MACHINE_ID.test(mid)) {
    return {
      ok: false,
      error: "machine must be a configured machine's id (fleet_updates lists them)",
    };
  }
  const m = machineOf(config, mid);
  if (!m) return { ok: false, error: `no such machine: ${mid} (fleet_updates lists them)` };
  if (!canInstall(m)) {
    return {
      ok: false,
      error: m.self
        ? `${m.id} is the machine Fleet runs on: notify only, it can't be updated from Fleet`
        : `${m.id} installs nothing (install: none)`,
    };
  }
  const mode = args.mode;
  if (!UPDATE_MODES.includes(mode as UpdateMode)) {
    return { ok: false, error: `mode must be one of ${UPDATE_MODES.join(", ")}` };
  }
  const reboot = args.reboot;
  if (!REBOOT_POLICIES.includes(reboot as RebootPolicy)) {
    return { ok: false, error: `reboot must be one of ${REBOOT_POLICIES.join(", ")}` };
  }
  if (typeof args.reason !== "string" || args.reason.length > MAX_REQUEST_REASON * 4) {
    return {
      ok: false,
      error: `reason must be a string of at most ${MAX_REQUEST_REASON} characters`,
    };
  }
  const reason = strip(args.reason);
  if (!reason) return { ok: false, error: "reason is required (why this machine needs updating)" };
  if (reason.length > MAX_REQUEST_REASON) {
    return { ok: false, error: `reason is over ${MAX_REQUEST_REASON} characters` };
  }
  if (pending >= MAX_PENDING_REQUESTS) {
    return {
      ok: false,
      error: `${MAX_PENDING_REQUESTS} requests already await the user's approval in Fleet`,
    };
  }
  if (!REQUEST_ID.test(id)) return { ok: false, error: "bad request id" };
  return {
    ok: true,
    request: {
      v: 1,
      id,
      machine: m.id,
      mode: mode as UpdateMode,
      reboot: reboot as RebootPolicy,
      reason,
      at: now,
      by: "agent",
    },
  };
}

/**
 * A request file read back (untrusted): a configured machine that may install, the enums, the
 * reason stripped and cut to 200, not expired, and its id matching its file's. `null` otherwise.
 */
export function parseRequest(
  raw: unknown,
  fileId: string,
  config: UpdatesConfig,
  now: number,
): UpdateRequest | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1 || r.id !== fileId || !REQUEST_ID.test(fileId)) return null;
  const m = typeof r.machine === "string" ? machineOf(config, r.machine) : undefined;
  if (!m || !canInstall(m)) return null;
  if (!UPDATE_MODES.includes(r.mode as UpdateMode)) return null;
  if (!REBOOT_POLICIES.includes(r.reboot as RebootPolicy)) return null;
  const at = typeof r.at === "number" && Number.isFinite(r.at) ? Math.trunc(r.at) : NaN;
  if (!(at > 0) || at > now + 5 * 60_000 || now - at >= REQUEST_TTL_MS) return null;
  return {
    v: 1,
    id: fileId,
    machine: m.id,
    mode: r.mode as UpdateMode,
    reboot: r.reboot as RebootPolicy,
    reason: clampText(typeof r.reason === "string" ? r.reason : "", MAX_REQUEST_REASON),
    at,
    by: "agent",
  };
}

/** Whether a request (by its filing time) has expired. */
export const requestExpired = (at: number, now: number): boolean => now - at >= REQUEST_TTL_MS;
