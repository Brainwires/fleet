// What the page's Updates panel and the machine cards' chips show, built from the config, the
// status file, the run in flight, the audit, the schedules and the request spool. Pure (no Deno,
// no DOM): the backend builds it, the page renders it, the tray takes one line of it.

import { canInstall } from "./config.ts";
import { heldPoolsFromAudit, withHeldPools } from "./files.ts";
import {
  type AuditEntry,
  CANCELLABLE_STEPS,
  emptyStatus,
  type Level,
  type MachineKind,
  type MachineStatus,
  type RebootPolicy,
  type RunRecord,
  type RunStep,
  severity,
  type SeverityCause,
  type Thresholds,
  type UpdateMode,
  type UpdateSchedule,
  type UpdatesConfig,
  type UpdatesOs,
} from "./model.ts";
import type { UpdateRequest } from "./requests.ts";
import { nextWindow } from "./schedule.ts";

/** One machine in the panel. */
export interface UpdatesMachineView {
  readonly id: string;
  readonly os: UpdatesOs;
  readonly kind: MachineKind;
  /** The machine Fleet runs on: notices only, no install controls. */
  readonly self: boolean;
  /** Update now and schedules are offered (not self, install isn't `none`). */
  readonly canInstall: boolean;
  readonly install: UpdateMode | "none";
  /** Installs on its own when out of date (never restarts on its own). */
  readonly autoInstall: boolean;
  readonly pools: readonly string[];
  readonly reboot: RebootPolicy;
  readonly drainCapMinutes: number;
  readonly level: Level;
  readonly causes: readonly SeverityCause[];
  /** The card's chip: a few words and a longer hover text. */
  readonly chip: { readonly text: string; readonly title: string };
  readonly status: MachineStatus;
  /** The last five runs, newest first. */
  readonly runs: readonly AuditEntry[];
}

/** A restart window with the next window's start (ms; `null`: none within eight days). */
export interface ScheduleView extends UpdateSchedule {
  readonly next: number | null;
}

/** The panel's whole view. */
export interface UpdatesView {
  /** `integrations.updates` is set. */
  readonly configured: boolean;
  readonly machines: readonly UpdatesMachineView[];
  /** The run in flight, with whether Cancel is still accepted. */
  readonly run: (RunRecord & { readonly cancellable: boolean }) | null;
  readonly schedules: readonly ScheduleView[];
  /** Agents' requests awaiting approval, oldest first. */
  readonly requests: readonly UpdateRequest[];
  /** The recent runs of every machine, newest first (at most 20). */
  readonly history: readonly AuditEntry[];
  /** The zone schedules are in (an IANA id). */
  readonly tz: string;
  readonly thresholds: Thresholds;
  /**
   * Check now and Update now can act (the host helpers are wired in this build); else a reason the
   * panel shows beside its disabled buttons.
   */
  readonly engine: { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly now: number;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** An age in words: "5 min", "3 h", "4 d". */
export function ageText(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  if (m < 60) return `${m} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.floor(ms / DAY)} d`;
}

/** The chip's text and hover title for a status (see docs/updates.md, "Machines view"). */
export function chipText(
  s: MachineStatus,
  level: Level,
  now: number,
): { text: string; title: string } {
  const parts: string[] = [];
  const h = s.host;
  if (s.checkedAt === null || !h) {
    parts.push(s.error ? "Check failed" : "Never checked");
  } else {
    if (h.pending.total > 0) {
      parts.push(
        `${h.pending.total} update${h.pending.total === 1 ? "" : "s"}` +
          (h.pending.security > 0 ? `, ${h.pending.security} security` : ""),
      );
    }
    if (h.reboot.required) {
      const since = s.firstSeen.reboot ?? h.reboot.since;
      parts.push(since !== null ? `Restart pending ${ageText(now - since)}` : "Restart pending");
    }
    if (parts.length === 0) parts.push("Up to date");
  }
  if (s.heldPools.length) parts.push(`Pools held: ${s.heldPools.join(", ")}`);
  const checked = s.checkedAt === null
    ? "never checked"
    : `checked ${ageText(now - s.checkedAt)} ago`;
  const title = [
    `Updates: ${level}`,
    checked,
    ...(s.error ? [`last check failed: ${s.error}`] : []),
  ].join(" · ");
  // The check's age joins the chip when it matters (stale or never).
  const text = level !== "ok" && s.checkedAt !== null && now - s.checkedAt >= DAY
    ? `${parts.join(" · ")} · Checked ${ageText(now - s.checkedAt)} ago`
    : parts.join(" · ");
  return { text, title };
}

/** What builds the view. */
export interface ViewInput {
  readonly config: UpdatesConfig | null;
  readonly statuses: Readonly<Record<string, MachineStatus>>;
  readonly run: RunRecord | null;
  /** The audit, oldest first. */
  readonly audit: readonly AuditEntry[];
  readonly schedules: readonly UpdateSchedule[];
  readonly requests: readonly UpdateRequest[];
  readonly tz: string;
  readonly now: number;
  readonly engine: UpdatesView["engine"];
  /** Whether a run's kept hold is still in force (drops a pool the user resumed). */
  readonly stillHeld?: (pool: string, runId: string) => boolean;
}

/** The panel's view. */
export function buildUpdatesView(i: ViewInput): UpdatesView {
  const cfg = i.config;
  const empty: UpdatesView = {
    configured: false,
    machines: [],
    run: null,
    schedules: [],
    requests: [],
    history: [],
    tz: i.tz,
    thresholds: { securityDays: 7, rebootDays: 7, staleHours: 24, noCheckHours: 72 },
    engine: i.engine,
    now: i.now,
  };
  if (!cfg) return empty;
  const held = heldPoolsFromAudit(i.audit, i.stillHeld);
  const machines = cfg.machines.map((m): UpdatesMachineView => {
    const status = withHeldPools(i.statuses[m.id] ?? emptyStatus(m.id), held);
    const sev = severity(status, i.now, cfg.thresholds);
    return {
      id: m.id,
      os: m.os,
      kind: m.kind,
      self: m.self,
      canInstall: canInstall(m),
      install: m.install,
      autoInstall: m.autoInstall,
      pools: m.pools,
      reboot: m.reboot,
      drainCapMinutes: m.drainCapMinutes,
      level: sev.level,
      causes: sev.causes,
      chip: chipText(status, sev.level, i.now),
      status,
      runs: i.audit.filter((e) => e.machine === m.id).slice(-5).reverse(),
    };
  });
  const known = new Set(cfg.machines.map((m) => m.id));
  return {
    ...empty,
    configured: true,
    machines,
    run: i.run ? { ...i.run, cancellable: CANCELLABLE_STEPS.includes(i.run.step) } : null,
    schedules: i.schedules.filter((s) => known.has(s.machine)).map((s) => ({
      ...s,
      next: s.enabled ? nextWindow(s, i.tz, i.now)?.start ?? null : null,
    })),
    requests: [...i.requests].filter((r) => known.has(r.machine)).sort((a, b) => a.at - b.at),
    history: i.audit.slice(-20).reverse(),
    thresholds: cfg.thresholds,
  };
}

/** A run step in words, for the panel and the tray. */
export function stepText(step: RunStep): string {
  switch (step) {
    case "preflight":
      return "checking";
    case "hold":
      return "holding the pools";
    case "drain":
      return "draining";
    case "final-check":
      return "final check";
    case "install":
      return "installing";
    case "reboot":
      return "restarting";
    case "wait-boot":
      return "waiting for it to come back";
    case "verify":
      return "verifying";
    case "resume":
      return "resuming the pools";
    case "report":
      return "reporting";
  }
}

/** The tray's one updates line (and whether the attention icon is due), or `null`. */
export function updatesTrayLine(
  v: UpdatesView | null,
): { line: string; bad: boolean; cancellable: string | null } | null {
  if (!v || !v.configured) return null;
  const bad = v.machines.some((m) => m.level === "bad");
  if (v.run) {
    return {
      line: `Updating ${v.run.machine}: ${stepText(v.run.step)}`,
      bad,
      cancellable: v.run.cancellable ? v.run.id : null,
    };
  }
  const need = v.machines.filter((m) => m.level === "warn" || m.level === "bad").length;
  if (need === 0) return null;
  return {
    line: `${need} machine${need === 1 ? " needs" : "s need"} updates`,
    bad,
    cancellable: null,
  };
}

/** The bridge event the page re-reads the Updates panel on (`{ show: true }`: open the panel). */
export const UPDATES_EVENT = "updates";
