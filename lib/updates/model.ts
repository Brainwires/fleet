// Machine updates: the types every part shares, the severity rule, the clamps and caps for anything
// a host prints, and the ports the orchestrator runs over (pools, remote, clock, store, status,
// peers, telemetry, events). Pure: no Deno API here; `lib/deno-updates.ts` implements the ports.
//
// Host output is untrusted text: every string a host prints is stripped of control and bidi
// characters and capped, every list is capped, every number is clamped. None of it ever reaches an
// argv or a later command.

import type { PoolCommand } from "../controls.ts";

// ---- enums ----

/** The operating systems a machine may run. */
export const UPDATE_OSES = ["ubuntu", "fedora", "macos", "windows"] as const;
export type UpdatesOs = typeof UPDATE_OSES[number];

/** What installs: security updates only, or everything pending. */
export const UPDATE_MODES = ["security", "all"] as const;
export type UpdateMode = typeof UPDATE_MODES[number];

/** Whether a run may reboot the machine. */
export const REBOOT_POLICIES = ["if-needed", "always", "never"] as const;
export type RebootPolicy = typeof REBOOT_POLICIES[number];

/** A machine's update severity. */
export type Level = "ok" | "info" | "warn" | "bad";

/** The busy plugins a machine may list (lib/updates/busy.ts implements them). */
export const BUSY_PLUGIN_NAMES = ["pools", "remote", "telemetry", "local-vms"] as const;
export type BusyPluginName = typeof BUSY_PLUGIN_NAMES[number];

/** The gate's verbs: the only commands Fleet ever sends a host. */
export const REMOTE_VERBS = [
  "status",
  "busy",
  "install-security",
  "install-all",
  "result",
  "verify",
  "reboot",
  "boot-id",
] as const;
export type RemoteVerb = typeof REMOTE_VERBS[number];

// ---- caps ----

/** At most this many package names are kept per list. */
export const MAX_NAMES = 50;
/** A package name, label or title is cut to this length. */
export const MAX_NAME_LEN = 120;
/** A one-line reason or error is cut to this length. */
export const MAX_REASON_LEN = 200;
/** An output tail (audit, run steps) keeps at most this many characters. */
export const MAX_TAIL_LEN = 2000;
/** A status document larger than this is refused unread. */
export const MAX_DOC_BYTES = 1_000_000;
/** A count is clamped to this. */
export const MAX_COUNT = 100_000;

// ---- clamps ----

/**
 * Text a host printed, fit to show: control characters, newlines and bidi overrides become spaces,
 * runs of space collapse, capped at `max` with "…". Anything but a string is `""`.
 */
export function clampText(v: unknown, max = MAX_NAME_LEN): string {
  if (typeof v !== "string") return "";
  const t = v.slice(0, max * 4)
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** A multi-line tail a host printed: control characters out (newlines kept), the last `max` chars. */
export function clampTail(v: unknown, max = MAX_TAIL_LEN): string {
  if (typeof v !== "string") return "";
  const t = v.slice(-max * 2)
    .replace(/\r\n?/g, "\n")
    .replace(/[\p{Cf}\u2028\u2029]/gu, "")
    // deno-lint-ignore no-control-regex
    .replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, " ");
  return t.length > max ? `…${t.slice(-(max - 1))}` : t;
}

/** A whole number in `[min, max]`; anything else is `dflt`. */
export function clampInt(v: unknown, min: number, max: number, dflt = min): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, Math.trunc(v)));
}

/** A list of names: each clamped, empties and duplicates dropped, at most `max`. */
export function clampNames(v: readonly unknown[], max = MAX_NAMES): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const x of v) {
    if (out.length >= max) break;
    const s = clampText(x);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/** An epoch time in seconds (as hosts print it) to ms; `null` when absent or implausible. */
export function epochSecondsToMs(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  // 2000-01-01 .. 2200-01-01.
  if (v < 946_684_800 || v > 7_258_118_400) return null;
  return Math.trunc(v * 1000);
}

// ---- status ----

/** What one collector run found on a host (one status document, parsed). */
export interface HostStatus {
  readonly pending: {
    readonly total: number;
    readonly security: number;
    /** Up to MAX_NAMES pending names, security ones first. */
    readonly names: readonly string[];
    /** Up to MAX_NAMES pending security names. */
    readonly securityNames: readonly string[];
  };
  readonly reboot: {
    readonly required: boolean;
    /** When the host says the need began (ms), when it says. */
    readonly since: number | null;
    /** Packages that asked for it, up to MAX_NAMES. */
    readonly packages: readonly string[];
  };
  /** When the package index was last refreshed (ms); `null`: not reported (macOS, Windows). */
  readonly indexAt: number | null;
}

/** A collector's verdict. */
export type CollectResult =
  | { readonly ok: true; readonly status: HostStatus }
  | { readonly ok: false; readonly error: string };

/** A machine's entry in `updates.json`. */
export interface MachineStatus {
  readonly machine: string;
  /** The last successful check (ms), or `null`. */
  readonly checkedAt: number | null;
  /** The last attempt, successful or not (ms), or `null`. */
  readonly attemptAt: number | null;
  /** The last attempt's error, clamped; `null` when it succeeded. */
  readonly error: string | null;
  /** The last successful check's findings. */
  readonly host: HostStatus | null;
  /** When Fleet first saw a security update pending / a reboot required in this stretch (ms). */
  readonly firstSeen: { readonly security: number | null; readonly reboot: number | null };
  /** Pools a failed run left held (its outcome kept them); `[]` when none. */
  readonly heldPools: readonly string[];
}

/** An empty status for a machine never checked. */
export function emptyStatus(machine: string): MachineStatus {
  return {
    machine,
    checkedAt: null,
    attemptAt: null,
    error: null,
    host: null,
    firstSeen: { security: null, reboot: null },
    heldPools: [],
  };
}

/** A successful check folded into the previous status (first-seen times kept while it lasts). */
export function withCheck(prev: MachineStatus, host: HostStatus, now: number): MachineStatus {
  return {
    ...prev,
    checkedAt: now,
    attemptAt: now,
    error: null,
    host,
    firstSeen: {
      security: host.pending.security > 0 ? prev.firstSeen.security ?? now : null,
      reboot: host.reboot.required ? prev.firstSeen.reboot ?? host.reboot.since ?? now : null,
    },
  };
}

/** A failed check folded into the previous status (the last good findings kept). */
export function withCheckError(prev: MachineStatus, error: string, now: number): MachineStatus {
  return { ...prev, attemptAt: now, error: clampText(error, MAX_REASON_LEN) || "check failed" };
}

// ---- severity ----

/** The severity thresholds (config `thresholds`). */
export interface Thresholds {
  /** A security update pending longer than this is bad. */
  readonly securityDays: number;
  /** A reboot pending longer than this is bad. */
  readonly rebootDays: number;
  /** A last check or package index older than this is warn. */
  readonly staleHours: number;
  /** No successful check for this long is bad. */
  readonly noCheckHours: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = Object.freeze({
  securityDays: 7,
  rebootDays: 7,
  staleHours: 24,
  noCheckHours: 72,
});

/** Why a machine is at its level; one notice per machine and cause. */
export type SeverityCause =
  | "updates-pending"
  | "security-pending"
  | "reboot-required"
  | "check-stale"
  | "index-stale"
  | "security-old"
  | "reboot-old"
  | "no-check"
  | "held-after-failure";

/** A machine's severity, with every cause that applies (the level is the worst). */
export interface Severity {
  readonly level: Level;
  readonly causes: readonly SeverityCause[];
}

const RANK: Record<Level, number> = { ok: 0, info: 1, warn: 2, bad: 3 };
const CAUSE_LEVEL: Record<SeverityCause, Level> = {
  "updates-pending": "info",
  "security-pending": "warn",
  "reboot-required": "warn",
  "check-stale": "warn",
  "index-stale": "warn",
  "security-old": "bad",
  "reboot-old": "bad",
  "no-check": "bad",
  "held-after-failure": "bad",
};

/** The worse of two levels. */
export const worse = (a: Level, b: Level): Level => (RANK[a] >= RANK[b] ? a : b);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * A machine's severity (the table in docs/updates.md):
 * - ok: nothing pending, checked within `staleHours`;
 * - info: only non-security updates pending;
 * - warn: a security update pending; a reboot required; the last check or the index older than
 *   `staleHours`;
 * - bad: a security update pending longer than `securityDays`; a reboot pending longer than
 *   `rebootDays`; no successful check for `noCheckHours` (or ever); a failed run's pools held.
 */
export function severity(
  s: MachineStatus,
  now: number,
  t: Thresholds = DEFAULT_THRESHOLDS,
): Severity {
  const causes: SeverityCause[] = [];
  const h = s.host;
  if (s.checkedAt === null || now - s.checkedAt >= t.noCheckHours * HOUR) causes.push("no-check");
  else if (now - s.checkedAt >= t.staleHours * HOUR) causes.push("check-stale");
  if (h) {
    if (h.pending.security > 0) {
      const since = s.firstSeen.security ?? s.checkedAt ?? now;
      causes.push(now - since >= t.securityDays * DAY ? "security-old" : "security-pending");
    } else if (h.pending.total > 0) causes.push("updates-pending");
    if (h.reboot.required) {
      const since = s.firstSeen.reboot ?? h.reboot.since ?? s.checkedAt ?? now;
      causes.push(now - since >= t.rebootDays * DAY ? "reboot-old" : "reboot-required");
    }
    if (h.indexAt !== null && now - h.indexAt >= t.staleHours * HOUR) causes.push("index-stale");
  }
  if (s.heldPools.length > 0) causes.push("held-after-failure");
  const level = causes.reduce<Level>((l, c) => worse(l, CAUSE_LEVEL[c]), "ok");
  return { level, causes };
}

// ---- configuration (validated in lib/updates/config.ts) ----

/** How Fleet reaches a machine: an alias in Fleet's own ssh config, or this machine itself. */
export type MachineVia = { readonly ssh: string } | "local";

/** One machine under `integrations.updates.machines`. */
export interface UpdatesMachine {
  /** The machines service's id when there is one. */
  readonly id: string;
  readonly os: UpdatesOs;
  readonly via: MachineVia;
  /** Fleet's own machine: notify only (no schedule, no install, no reboot). */
  readonly self: boolean;
  /** What a run installs by default; `"none"` for a self machine. */
  readonly install: UpdateMode | "none";
  /** Pools held for a run; `[]` for a host with no runners. */
  readonly pools: readonly string[];
  readonly busy: readonly BusyPluginName[];
  readonly verify: {
    /** Mount points that must be present after a run. */
    readonly mounts: readonly string[];
    /** Other configured machines (guests) that must answer after a run. */
    readonly reach: readonly string[];
  };
  readonly reboot: RebootPolicy;
  readonly drainCapMinutes: number;
}

/** `integrations.updates`. */
export interface UpdatesConfig {
  readonly ssh: { readonly program: string; readonly configFile: string };
  readonly thresholds: Thresholds;
  /** Preflight refuses a run with less free disk than this on the host (MB). */
  readonly minFreeDiskMb: number;
  readonly machines: readonly UpdatesMachine[];
}

/** A maintenance window (`update-schedules.json`, written by the backend after the dialog). */
export interface UpdateSchedule {
  readonly id: string;
  readonly machine: string;
  /** Local days of the week, 0 = Sunday. */
  readonly days: readonly number[];
  /** Local start time, `HH:MM` (24 h). */
  readonly start: string;
  readonly windowMinutes: number;
  readonly mode: UpdateMode;
  readonly reboot: RebootPolicy;
  readonly drainCapMinutes: number;
  readonly enabled: boolean;
}

// ---- runs ----

/** The orchestrator's steps (0-9 in docs/updates.md). */
export const RUN_STEPS = [
  "preflight",
  "hold",
  "drain",
  "final-check",
  "install",
  "reboot",
  "wait-boot",
  "verify",
  "resume",
  "report",
] as const;
export type RunStep = typeof RUN_STEPS[number];

/** Steps through which a run may still be cancelled. */
export const CANCELLABLE_STEPS: readonly RunStep[] = ["preflight", "hold", "drain", "final-check"];

/** How a run ended. */
export type RunOutcome =
  /** Installed (and rebooted when needed), verified, pools back in service. */
  | "succeeded"
  /** Nothing pending, no reboot due: nothing done. */
  | "nothing-to-do"
  /** Preflight or a check refused it; nothing installed; this run's holds resumed. */
  | "aborted"
  /** The user cancelled it (through step 3); this run's holds resumed. */
  | "cancelled"
  /** Still busy at the drain cap or the window's end; nothing installed; holds resumed. */
  | "deferred-busy"
  /** The install failed or timed out; no reboot; verified; holds resumed only if verify passed. */
  | "install-failed"
  /** Installed; a reboot is required but the policy (or a busy check) kept it from happening. */
  | "reboot-pending"
  /** The host didn't come back after the reboot; holds kept and renewed. */
  | "host-down"
  /** Verify failed; holds kept and renewed; the user resumes. */
  | "verify-failed"
  /** Everything passed but a pool couldn't be resumed (the alert names the command). */
  | "resume-failed";

/** Who asked for a run. */
export type RunOrigin =
  | { readonly kind: "user" }
  | { readonly kind: "schedule"; readonly scheduleId: string }
  | { readonly kind: "request"; readonly requestId: string };

/** One step's record (the audit keeps them all). */
export interface StepLog {
  readonly step: RunStep;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly ok: boolean;
  /** One line, clamped. */
  readonly detail: string;
  /** The remote verb's exit code, when one ran. */
  readonly code?: number;
  /** A capped, redacted output tail, when there is one. */
  readonly tail?: string;
}

/** A hold a run took or found. */
export interface RunHold {
  readonly pool: string;
  /** This run's pause expires then (ms), or the earlier pause's expiry (`null`: none). */
  readonly until: number | null;
  /** Paused before the run: not held by it, never resumed by it. */
  readonly pausedBefore: boolean;
}

/** `update-run.json`: the one run in flight (its presence is the fleet-wide lock). */
export interface RunRecord {
  readonly v: 1;
  readonly id: string;
  readonly machine: string;
  readonly origin: RunOrigin;
  readonly mode: UpdateMode;
  readonly reboot: RebootPolicy;
  readonly drainCapMinutes: number;
  /** The maintenance window's end (ms), or `null` for Update now. */
  readonly windowEnd: number | null;
  readonly startedAt: number;
  readonly step: RunStep;
  readonly stepAt: number;
  readonly holds: readonly RunHold[];
  /** The boot id before the run. */
  readonly bootId: string | null;
  /** The host's verify document before the run (the baseline for "no new failed unit"). */
  readonly baseline: VerifyDoc | null;
  /** When the install was asked for (ms): `result` documents older than this are someone else's. */
  readonly installAt: number | null;
  /** The install's verdict once known. */
  readonly installOk: boolean | null;
  /** The host said a reboot is needed after the install. */
  readonly rebootNeeded: boolean;
  readonly rebooted: boolean;
  readonly steps: readonly StepLog[];
  readonly outcome: RunOutcome | null;
  /** Pools left held at the end (host down, verify failed). */
  readonly keptHolds: readonly string[];
}

/** One line of `update-runs.jsonl`. */
export interface AuditEntry {
  readonly v: 1;
  readonly id: string;
  readonly machine: string;
  readonly origin: RunOrigin;
  readonly mode: UpdateMode;
  readonly reboot: RebootPolicy;
  readonly startedAt: number;
  readonly endedAt: number;
  readonly outcome: RunOutcome;
  readonly steps: readonly StepLog[];
  readonly keptHolds: readonly string[];
}

/** A run id: `<machine>-<epoch ms base 36>-<random>`, safe in argv and a pause reason. */
export const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;

// ---- host documents (the gate's `result`, `verify` and `boot-id` verbs) ----

/** `result`: the detached install's state. */
export interface ResultDoc {
  readonly state: "none" | "running" | "succeeded" | "failed";
  /** When this install started (ms). */
  readonly startedAt: number | null;
  readonly exitCode: number | null;
  /** The host needs a reboot now. */
  readonly rebootRequired: boolean;
  readonly tail: string;
}

/**
 * Parse `result`'s JSON: `{"state":"running|succeeded|failed|none","startedAt":<epoch s>,
 * "exitCode":<n>,"rebootRequired":<bool>,"tail":"<last lines>"}`. `null` when it isn't that.
 */
export function parseResultDoc(text: string): ResultDoc | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const state = raw.state;
  if (state !== "none" && state !== "running" && state !== "succeeded" && state !== "failed") {
    return null;
  }
  return {
    state,
    startedAt: epochSecondsToMs(raw.startedAt),
    exitCode: typeof raw.exitCode === "number" ? clampInt(raw.exitCode, -1, 1_000_000) : null,
    rebootRequired: raw.rebootRequired === true,
    tail: clampTail(raw.tail),
  };
}

/** `verify`: what the host looks like now (also the preflight baseline). */
export interface VerifyDoc {
  /** `systemctl is-system-running` (Linux), else `""`. */
  readonly system: string;
  readonly failedUnits: readonly string[];
  /** `active` / `inactive` / `absent`. */
  readonly docker: "active" | "inactive" | "absent";
  /** Mount points present now (capped). */
  readonly mounts: readonly string[];
  /** Each `verify.d/*` drop-in and whether it passed. */
  readonly checks: readonly { readonly name: string; readonly ok: boolean }[];
  /** macOS: the Xcode platforms listed (`null`: not macOS or no Xcode). */
  readonly xcodePlatforms: readonly string[] | null;
  /** Free disk on the system volume (MB), when reported. */
  readonly freeDiskMb: number | null;
}

/** Mounts kept from a verify document (a host can have many). */
export const MAX_MOUNTS = 200;

/**
 * Parse `verify`'s JSON: `{"system":"running","failedUnits":[…],"docker":"active","mounts":[…],
 * "checks":[{"name":…,"ok":true}],"xcodePlatforms":[…]|null,"freeDiskMb":<n>}`.
 */
export function parseVerifyDoc(text: string): VerifyDoc | null {
  const raw = parseJsonObject(text);
  if (!raw) return null;
  const list = (v: unknown, max: number) => Array.isArray(v) ? v.slice(0, max * 2) : [];
  const docker = raw.docker === "active" || raw.docker === "inactive" ? raw.docker : "absent";
  return {
    system: clampText(raw.system, 40),
    failedUnits: clampNames(list(raw.failedUnits, MAX_NAMES)),
    docker,
    mounts: clampNames(
      list(raw.mounts, MAX_MOUNTS).map((m) => (typeof m === "string" ? m : "")),
      MAX_MOUNTS,
    ),
    checks: list(raw.checks, MAX_NAMES).flatMap((c) => {
      if (!c || typeof c !== "object") return [];
      const r = c as Record<string, unknown>;
      const name = clampText(r.name);
      return name ? [{ name, ok: r.ok === true }] : [];
    }).slice(0, MAX_NAMES),
    xcodePlatforms: Array.isArray(raw.xcodePlatforms)
      ? clampNames(raw.xcodePlatforms.slice(0, 2 * MAX_NAMES))
      : null,
    freeDiskMb: typeof raw.freeDiskMb === "number"
      ? clampInt(raw.freeDiskMb, 0, 1_000_000_000)
      : null,
  };
}

/** `boot-id`: one token (Linux's boot_id, macOS's boot session uuid, Windows' last boot time). */
export function parseBootId(text: string): string | null {
  const t = text.trim();
  return /^[A-Za-z0-9:._-]{1,100}$/.test(t) ? t : null;
}

/** A JSON object from text a host printed (size-capped), or `null`. */
export function parseJsonObject(text: string): Record<string, unknown> | null {
  if (typeof text !== "string" || text.length > MAX_DOC_BYTES) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

// ---- ports ----

/** Time. `sleep` resolves early (without throwing) when `signal` aborts. */
export interface Clock {
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** A program's exit and (combined, untrusted) output. */
export interface CommandResult {
  readonly code: number;
  readonly output: string;
}

/** A pool's pause, as the scheduler recorded it. */
export interface PoolPause {
  /** The pause's reason text (a hold this run took reads `fleet-update:<runId>`). */
  readonly reason: string;
  /** When it expires (ms); `null`: no expiry. */
  readonly until: number | null;
}

/** A pool's state now. */
export interface PoolState {
  /** Every slot idle (`pause-pool.sh --status <pool>` exits 0). */
  readonly idle: boolean;
  /** Jobs running there now. */
  readonly jobs: number;
  readonly pause: PoolPause | null;
  /** The watchdog calls it healthy. */
  readonly healthy: boolean;
}

/**
 * The runner scheduler's pools. `run` executes exactly the command it is given (an absolute program
 * and argv, no shell); the orchestrator builds every hold and resume with lib/controls.ts.
 */
export interface PoolsPort {
  state(pool: string): Promise<PoolState>;
  run(command: PoolCommand): Promise<CommandResult>;
  /** One watchdog pass, then whether every slot of these pools is ready. */
  ready(pools: readonly string[]): Promise<{ readonly ok: boolean; readonly reason: string }>;
}

/** A gate verb's result. */
export interface RemoteResult {
  /** The exit code (`-1` when it never ran). */
  readonly code: number;
  /** Stdout, untrusted. */
  readonly stdout: string;
  /** ssh couldn't connect, or the host key didn't match. */
  readonly unreachable: boolean;
  readonly timedOut: boolean;
}

/** The machines, over ssh with the fixed argv (lib/updates/remote.ts builds it). */
export interface RemotePort {
  run(
    machine: UpdatesMachine,
    verb: RemoteVerb,
    opts: { readonly timeoutMs: number; readonly signal?: AbortSignal },
  ): Promise<RemoteResult>;
}

/** The files in the data folder. */
export interface UpdatesStore {
  /** `update-run.json`, or `null`. */
  readRun(): Promise<RunRecord | null>;
  /** Write `update-run.json` only if there is none (the fleet-wide lock); `false` when one exists. */
  claimRun(run: RunRecord): Promise<boolean>;
  /** Rewrite `update-run.json` (the run must hold the lock). */
  saveRun(run: RunRecord): Promise<void>;
  /** Remove `update-run.json` if it is this run's. */
  clearRun(runId: string): Promise<void>;
  /** Append one line to `update-runs.jsonl`. */
  appendAudit(entry: AuditEntry): Promise<void>;
}

/** Status collection (one host at a time, 120 s cap). */
export interface StatusPort {
  /** Run the collector now and return the folded status (an error is in `error`). */
  refresh(machine: UpdatesMachine): Promise<MachineStatus>;
  /** The last known status. */
  current(machine: string): MachineStatus | null;
}

/** The machines service's view (the `telemetry` busy plugin). */
export interface TelemetryPort {
  /** Jobs the service shows on the machine; `null`: it doesn't know the machine or is down. */
  jobsOn(machine: string): number | null;
}

/** What the exclusivity rule needs to know about the rest of the fleet. */
export interface PeerFacts {
  /** Per pool id: its runs-on label, health and whether it is paused or held. */
  readonly pools: Readonly<
    Record<string, { readonly label: string; readonly healthy: boolean; readonly held: boolean }>
  >;
  /** Configured machines whose last check failed (unreachable or erroring). */
  readonly unreachable: readonly string[];
}

/** The rest of the fleet. */
export interface PeersPort {
  facts(): Promise<PeerFacts>;
}

/** What a run tells the event log, the notifications and the tray. */
export type RunEvent =
  | {
    readonly kind: "step";
    readonly run: RunRecord;
    readonly step: RunStep;
    readonly text: string;
  }
  | { readonly kind: "alert"; readonly run: RunRecord; readonly text: string }
  | { readonly kind: "done"; readonly run: RunRecord; readonly outcome: RunOutcome };

/** Where run events go. */
export type RunEvents = (e: RunEvent) => void;
