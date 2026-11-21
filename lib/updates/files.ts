// The machine-update files in the data folder, parsed: `updates.json` (status per machine),
// `update-run.json` (the run in flight) and `update-runs.jsonl` (the audit). Pure: shared by the
// backend (lib/deno-updates.ts reads the bytes and is the one writer) and the MCP server (mcp/fleet-mcp.ts). Fleet
// writes these files itself, but each holds text a host printed, so every field is re-checked and
// clamped here: a garbled or planted file yields nothing, never a throw.
//
// Also the audit's held pools: a run that ended with its pools kept (host down, verify failed)
// leaves them in `keptHolds`; until a later run of the same machine ends without kept holds (or the
// pause is gone), they are the machine's `heldPools`, which makes its severity bad.

import {
  type AuditEntry,
  clampInt,
  clampNames,
  clampTail,
  clampText,
  emptyStatus,
  type HostStatus,
  type MachineStatus,
  MAX_COUNT,
  MAX_REASON_LEN,
  REBOOT_POLICIES,
  type RebootPolicy,
  RUN_ACTIONS,
  RUN_STEPS,
  type RunAction,
  type RunOrigin,
  type RunOutcome,
  type RunRecord,
  type RunStep,
  type StepLog,
  UPDATE_MODES,
  type UpdateMode,
} from "./model.ts";

/** `updates.json`: `{ "v": 1, "machines": { "<id>": MachineStatus } }`. */
export interface StatusFile {
  readonly v: 1;
  readonly machines: Readonly<Record<string, MachineStatus>>;
}

/** An `updates.json` document for `statuses` (what the collector writes). */
export function statusFile(statuses: readonly MachineStatus[]): StatusFile {
  return { v: 1, machines: Object.fromEntries(statuses.map((s) => [s.machine, s])) };
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
/** A plausible epoch-ms time (2000 .. 2200), else `null`. */
const ms = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v >= 946_684_800_000 && v <= 7_258_118_400_000
    ? Math.trunc(v)
    : null;
const names = (v: unknown): string[] => (Array.isArray(v) ? clampNames(v.slice(0, 200)) : []);
const poolIds = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.filter((p): p is string => typeof p === "string" && /^[\w.-]{1,200}$/.test(p)))]
      .slice(0, 50)
    : [];

function parseHost(v: unknown): HostStatus | null {
  if (!isObj(v)) return null;
  const p = isObj(v.pending) ? v.pending : {};
  const r = isObj(v.reboot) ? v.reboot : {};
  const required = r.required === true;
  return {
    pending: {
      total: clampInt(p.total, 0, MAX_COUNT, 0),
      security: clampInt(p.security, 0, MAX_COUNT, 0),
      names: names(p.names),
      securityNames: names(p.securityNames),
    },
    reboot: {
      required,
      since: required ? ms(r.since) : null,
      packages: required ? names(r.packages) : [],
    },
    indexAt: ms(v.indexAt),
  };
}

/** One machine's status from a file, or `null` when it isn't one. */
export function parseMachineStatus(v: unknown, id: string): MachineStatus | null {
  if (!isObj(v)) return null;
  const fs = isObj(v.firstSeen) ? v.firstSeen : {};
  return {
    ...emptyStatus(id),
    checkedAt: ms(v.checkedAt),
    attemptAt: ms(v.attemptAt),
    error: v.error === null || v.error === undefined ? null : clampText(v.error, MAX_REASON_LEN) ||
      "check failed",
    host: parseHost(v.host),
    firstSeen: { security: ms(fs.security), reboot: ms(fs.reboot) },
    heldPools: poolIds(v.heldPools),
  };
}

/** `updates.json` parsed: status per machine id (only ids `known` accepts, when given). */
export function parseStatusFile(
  raw: unknown,
  known?: (id: string) => boolean,
): Record<string, MachineStatus> {
  if (!isObj(raw) || raw.v !== 1 || !isObj(raw.machines)) return {};
  const out: Record<string, MachineStatus> = {};
  for (const [id, v] of Object.entries(raw.machines).slice(0, 200)) {
    if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(id) || (known && !known(id))) continue;
    const s = parseMachineStatus(v, id);
    if (s) out[id] = s;
  }
  return out;
}

const RUN_OUTCOMES: readonly RunOutcome[] = [
  "succeeded",
  "nothing-to-do",
  "aborted",
  "cancelled",
  "deferred-busy",
  "install-failed",
  "reboot-pending",
  "host-down",
  "verify-failed",
  "resume-failed",
];

function parseOrigin(v: unknown): RunOrigin | null {
  if (!isObj(v)) return null;
  const id = (x: unknown) => (typeof x === "string" ? clampText(x, 80) : "");
  if (v.kind === "user") return { kind: "user" };
  if (v.kind === "auto") return { kind: "auto" };
  if (v.kind === "schedule" && id(v.scheduleId)) {
    return { kind: "schedule", scheduleId: id(v.scheduleId) };
  }
  if (v.kind === "request" && id(v.requestId)) {
    return { kind: "request", requestId: id(v.requestId) };
  }
  return null;
}

function parseStep(v: unknown): StepLog | null {
  if (!isObj(v) || !RUN_STEPS.includes(v.step as RunStep)) return null;
  const startedAt = ms(v.startedAt), endedAt = ms(v.endedAt);
  if (startedAt === null || endedAt === null) return null;
  return {
    step: v.step as RunStep,
    startedAt,
    endedAt,
    ok: v.ok === true,
    detail: clampText(v.detail, MAX_REASON_LEN),
    ...(typeof v.code === "number" ? { code: clampInt(v.code, -1, 1_000_000) } : {}),
    ...(typeof v.tail === "string" ? { tail: clampTail(v.tail) } : {}),
  };
}

const steps = (v: unknown): StepLog[] =>
  Array.isArray(v) ? v.slice(0, 100).map(parseStep).filter((s): s is StepLog => s !== null) : [];
const mode = (v: unknown): UpdateMode | null =>
  UPDATE_MODES.includes(v as UpdateMode) ? v as UpdateMode : null;
const action = (v: unknown): { action?: RunAction } =>
  RUN_ACTIONS.includes(v as RunAction) ? { action: v as RunAction } : {};
const reboot = (v: unknown): RebootPolicy | null =>
  REBOOT_POLICIES.includes(v as RebootPolicy) ? v as RebootPolicy : null;

/** One audit line, or `null` when it isn't one. */
export function parseAuditEntry(v: unknown): AuditEntry | null {
  if (!isObj(v) || v.v !== 1) return null;
  const id = typeof v.id === "string" ? clampText(v.id, 80) : "";
  const machine = typeof v.machine === "string" ? clampText(v.machine, 64) : "";
  const origin = parseOrigin(v.origin);
  const m = mode(v.mode), r = reboot(v.reboot);
  const startedAt = ms(v.startedAt), endedAt = ms(v.endedAt);
  const outcome = RUN_OUTCOMES.includes(v.outcome as RunOutcome) ? v.outcome as RunOutcome : null;
  if (!id || !machine || !origin || !m || !r || startedAt === null || endedAt === null) return null;
  if (!outcome) return null;
  return {
    v: 1,
    id,
    machine,
    origin,
    ...action(v.action),
    mode: m,
    reboot: r,
    startedAt,
    endedAt,
    outcome,
    steps: steps(v.steps),
    keptHolds: poolIds(v.keptHolds),
  };
}

/** `update-runs.jsonl` parsed, oldest first (bad lines skipped; the last `max` kept). */
export function parseAudit(text: string, max = 500): AuditEntry[] {
  const out: AuditEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const e = parseAuditEntry(JSON.parse(line));
      if (e) out.push(e);
    } catch {
      // A torn or garbled line: skip it.
    }
  }
  return out.slice(-max);
}

/** `update-run.json` parsed (the fields the page and agents show), or `null`. */
export function parseRunFile(raw: unknown): RunRecord | null {
  if (!isObj(raw) || raw.v !== 1) return null;
  const id = typeof raw.id === "string" ? clampText(raw.id, 80) : "";
  const machine = typeof raw.machine === "string" ? clampText(raw.machine, 64) : "";
  const origin = parseOrigin(raw.origin);
  const m = mode(raw.mode), r = reboot(raw.reboot);
  const startedAt = ms(raw.startedAt), stepAt = ms(raw.stepAt);
  const step = RUN_STEPS.includes(raw.step as RunStep) ? raw.step as RunStep : null;
  if (!id || !machine || !origin || !m || !r || startedAt === null || !step) return null;
  const holds = Array.isArray(raw.holds)
    ? raw.holds.slice(0, 50).flatMap((h) =>
      isObj(h) && typeof h.pool === "string" && /^[\w.-]{1,200}$/.test(h.pool)
        ? [{ pool: h.pool, until: ms(h.until), pausedBefore: h.pausedBefore === true }]
        : []
    )
    : [];
  return {
    v: 1,
    id,
    machine,
    origin,
    ...action(raw.action),
    mode: m,
    reboot: r,
    drainCapMinutes: clampInt(raw.drainCapMinutes, 0, 1440, 0),
    windowEnd: ms(raw.windowEnd),
    startedAt,
    step,
    stepAt: stepAt ?? startedAt,
    holds,
    bootId: null,
    baseline: null,
    installAt: ms(raw.installAt),
    installOk: typeof raw.installOk === "boolean" ? raw.installOk : null,
    rebootNeeded: raw.rebootNeeded === true,
    rebooted: raw.rebooted === true,
    steps: steps(raw.steps),
    outcome: RUN_OUTCOMES.includes(raw.outcome as RunOutcome) ? raw.outcome as RunOutcome : null,
    keptHolds: poolIds(raw.keptHolds),
  };
}

/**
 * Pools each machine's last run left held: the newest audit entry per machine, when it kept holds.
 * A later run that ended without kept holds clears them. `stillHeld(pool, runId)`, when given,
 * drops a pool whose hold is gone (the user resumed it, or it expired).
 */
export function heldPoolsFromAudit(
  entries: readonly AuditEntry[],
  stillHeld?: (pool: string, runId: string) => boolean,
): Record<string, string[]> {
  const last = new Map<string, AuditEntry>();
  for (const e of entries) {
    const prev = last.get(e.machine);
    if (!prev || e.endedAt >= prev.endedAt) last.set(e.machine, e);
  }
  const out: Record<string, string[]> = {};
  for (const [machine, e] of last) {
    const pools = e.keptHolds.filter((p) => !stillHeld || stillHeld(p, e.id));
    if (pools.length) out[machine] = pools;
  }
  return out;
}

/** A status with its `heldPools` from the audit (see {@linkcode heldPoolsFromAudit}). */
export function withHeldPools(
  s: MachineStatus,
  held: Readonly<Record<string, readonly string[]>>,
): MachineStatus {
  const pools = held[s.machine] ?? [];
  const same = pools.length === s.heldPools.length && pools.every((p, i) => s.heldPools[i] === p);
  return same ? s : { ...s, heldPools: [...pools] };
}
