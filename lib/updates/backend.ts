// The Updates panel's backend (Update now, Restart now, restart windows, agents' requests): what the bridge methods (desktop/fleet.ts) call. Every request from
// the page is untrusted: a machine id is looked up in the config, the enums are checked, and
// nothing runs before the OS dialog (lib/updates/dialog.ts) returns the confirm button; "Don't"
// is its default. Agents' requests are approved only here, through the same dialog. Pure over
// ports (the files, the engine, the dialog, the clock), so the tests use fakes.

import type { NewEvent } from "../events.ts";
import type { ConfirmFn } from "../control-runner.ts";
import { canInstall, MACHINE_ID, SCHEDULE_ID, validateSchedules } from "./config.ts";
import { restartDialog, scheduleDialog, updateDialog } from "./dialog.ts";
import { checkExclusive } from "./exclusive.ts";
import { heldPoolsFromAudit } from "./files.ts";
import { heldByRun } from "./pools.ts";
import {
  type AuditEntry,
  clampText,
  type MachineStatus,
  type PeersPort,
  type PoolPause,
  REBOOT_POLICIES,
  type RebootPolicy,
  type RunOrigin,
  type RunRecord,
  type StatusPort,
  UPDATE_MODES,
  type UpdateMode,
  type UpdateSchedule,
  type UpdatesConfig,
  type UpdatesMachine,
} from "./model.ts";
import type { CancelResult, RunRequest, StartResult } from "./orchestrator.ts";
import { REQUEST_ID, type UpdateRequest } from "./requests.ts";
import { buildUpdatesView, type UpdatesView } from "./view.ts";

/** The files the panel reads and the one it writes (`update-schedules.json`). */
export interface UpdatesFilesPort {
  statuses(): Promise<Record<string, MachineStatus>>;
  run(): Promise<RunRecord | null>;
  /** The audit, oldest first. */
  audit(): Promise<AuditEntry[]>;
  /** The schedules, validated against `config` (an invalid file reads as none). */
  schedules(config: UpdatesConfig): Promise<UpdateSchedule[]>;
  saveSchedules(list: readonly UpdateSchedule[]): Promise<void>;
  /** The agents' requests still valid, oldest first. */
  requests(config: UpdatesConfig, now: number): Promise<UpdateRequest[]>;
  removeRequest(id: string): Promise<void>;
}

/** The orchestrator's surface the panel uses. */
export interface OrchestratorHandle {
  start(req: RunRequest): Promise<StartResult>;
  cancel(runId: string): CancelResult;
  current(): RunRecord | null;
}

/** What acts on hosts: wired only where the host helpers exist (docs/updates.md). */
export interface UpdatesEngine {
  readonly orchestrator: OrchestratorHandle;
  readonly status: StatusPort;
  readonly peers: PeersPort;
}

/** What the backend runs over. */
export interface UpdatesBackendDeps {
  config(): UpdatesConfig | null;
  readonly files: UpdatesFilesPort;
  /** `null`: this build can't reach hosts (the panel shows why). */
  engine(): UpdatesEngine | null;
  readonly confirm: ConfirmFn;
  /** Open the OS's Software Update pane (the self machine's only control). */
  openSoftwareUpdate(): Promise<{ ok: boolean; message: string }>;
  now(): number;
  /** The zone schedules are in. */
  tz(): string;
  log(e: Omit<NewEvent, "at" | "user">): Promise<void>;
  /** Something the panel shows changed (a run started or ended, a schedule saved). */
  onChange?(): void;
  /** Test builds: dialogs show, nothing runs or is saved. */
  readonly dryRun?: boolean;
  /**
   * The pause in force on each of these pools (`null`: not paused), so a run's kept hold that the
   * user resumed (or that expired) stops counting as held. Absent: the audit alone decides.
   */
  holds?(pools: readonly string[]): Promise<ReadonlyMap<string, PoolPause | null>>;
}

/** A panel action's outcome. */
export type UpdatesResult =
  | { readonly ok: true; readonly message: string; readonly runId?: string }
  | {
    readonly ok: false;
    readonly message: string;
    readonly cancelled?: boolean;
    readonly errors?: readonly string[];
  };

const NOT_SET_UP = "Machine updates aren't set up (the settings' integrations.updates).";
const NO_ENGINE =
  "This build can't reach the machines (an internal build whose local config has integrations.updates runs ssh).";
const DRY = "Dry run: nothing was done.";

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};

/** The backend. */
export function createUpdatesBackend(d: UpdatesBackendDeps) {
  const machineOf = (cfg: UpdatesConfig, raw: unknown): UpdatesMachine | null =>
    typeof raw === "string" && MACHINE_ID.test(raw)
      ? cfg.machines.find((m) => m.id === raw) ?? null
      : null;
  const event = (sev: NewEvent["sev"], workflow: string, text: string) =>
    d.log({ repo: "", workflow, job: null, url: null, sev, kind: "action", text }).catch(() => {});

  async function view(): Promise<UpdatesView> {
    const cfg = d.config();
    const engine = d.engine();
    const now = d.now();
    const engineView = engine ? { ok: true as const } : { ok: false as const, reason: NO_ENGINE };
    if (!cfg) {
      return buildUpdatesView({
        config: null,
        statuses: {},
        run: null,
        audit: [],
        schedules: [],
        requests: [],
        tz: d.tz(),
        now,
        engine: engineView,
      });
    }
    const [statuses, fileRun, audit, schedules, requests] = await Promise.all([
      d.files.statuses(),
      d.files.run(),
      d.files.audit(),
      d.files.schedules(cfg),
      d.files.requests(cfg, now),
    ]);
    const kept = [...new Set(Object.values(heldPoolsFromAudit(audit)).flat())];
    const pauses = kept.length && d.holds ? await d.holds(kept).catch(() => null) : null;
    return buildUpdatesView({
      ...(pauses
        ? {
          stillHeld: (pool: string, runId: string) =>
            !pauses.has(pool) || heldByRun(pauses.get(pool) ?? null, runId, now),
        }
        : {}),
      config: cfg,
      statuses,
      run: engine?.orchestrator.current() ?? fileRun,
      audit,
      schedules,
      requests,
      tz: d.tz(),
      now,
      engine: engineView,
    });
  }

  /** Watch a started run to its end: the outcome in the event log, the panel told. */
  function follow(machine: string, done: Promise<RunRecord>): void {
    void done.then((rec) => {
      const bad = rec.outcome !== "succeeded" && rec.outcome !== "nothing-to-do";
      void event(
        bad ? "warn" : "info",
        `update ${machine}`,
        `update run ${rec.id}: ${rec.outcome}`,
      );
    }, () => {}).finally(() => d.onChange?.());
  }

  /** The dialog, then the run. Shared by Update now and an approved request. */
  async function confirmAndStart(
    cfg: UpdatesConfig,
    m: UpdatesMachine,
    r: Record<string, unknown>,
    origin: RunOrigin,
    request: UpdateRequest | null,
  ): Promise<UpdatesResult> {
    if (!canInstall(m)) {
      return {
        ok: false,
        message: m.self
          ? `${m.id} is the machine Fleet runs on: use Open Software Update.`
          : `${m.id} installs nothing (install: none).`,
      };
    }
    const engine = d.engine();
    if (!engine) return { ok: false, message: NO_ENGINE };
    const mode =
      (r.mode ?? request?.mode ?? (m.install === "all" ? "all" : "security")) as UpdateMode;
    // A restart only ever happens when one is needed: "always" is never sent, and by default a
    // needed restart waits for the restart window (`never` here = not in this run).
    const asked = (r.reboot ?? request?.reboot ?? "never") as RebootPolicy;
    if (!UPDATE_MODES.includes(mode)) return { ok: false, message: "Unknown install mode." };
    if (!REBOOT_POLICIES.includes(asked)) return { ok: false, message: "Unknown reboot policy." };
    const reboot: RebootPolicy = asked === "never" || m.reboot === "never" ? "never" : "if-needed";
    if (m.kind === "server" && r.acknowledgeOutage !== true) {
      return {
        ok: false,
        message: `${m.id} is a server: confirm the outage in the panel first.`,
      };
    }
    const facts = await engine.peers.facts();
    const verdict = checkExclusive(
      m,
      cfg,
      facts,
      engine.orchestrator.current() ?? await d.files.run(),
    );
    if (!verdict.ok) return { ok: false, message: verdict.reason };
    const host = (await d.files.statuses())[m.id]?.host ?? null;
    const answer = await d.confirm(updateDialog({
      machine: m,
      mode,
      reboot,
      drainCapMinutes: m.drainCapMinutes,
      pending: host ? { total: host.pending.total, security: host.pending.security } : null,
      labels: verdict.labels,
      soleLabels: verdict.soleLabels,
      request: request ? { id: request.id, reason: request.reason } : null,
      dryRun: d.dryRun,
    }));
    if (answer !== 1) return { ok: false, cancelled: true, message: "Not updated." };
    if (d.dryRun) return { ok: false, message: DRY };
    // An approved request is spent before the run starts: it can't be approved twice.
    if (request) await d.files.removeRequest(request.id);
    const started = await engine.orchestrator.start({ machine: m.id, origin, mode, reboot });
    if (!started.ok) {
      await event("warn", `update ${m.id}`, `update refused: ${started.reason}`);
      return { ok: false, message: started.reason };
    }
    await event(
      "info",
      `update ${m.id}`,
      `update run ${started.runId} started (${mode}, reboot ${reboot}${
        request ? `, agent request ${request.id}` : ""
      })`,
    );
    follow(m.id, started.done);
    d.onChange?.();
    return { ok: true, runId: started.runId, message: `Updating ${m.id}.` };
  }

  return {
    view,

    /** Update now: the machine, its mode and reboot policy; a server needs `acknowledgeOutage`. */
    async updateNow(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const r = obj(raw);
      const m = machineOf(cfg, r.machine);
      if (!m) return { ok: false, message: "That machine isn't configured." };
      return await confirmAndStart(cfg, m, r, { kind: "user" }, null);
    },

    /**
     * Restart now: a machine whose restart is pending, nothing installed (a restart run). A server
     * needs `acknowledgeOutage`. Refused when no restart is pending.
     */
    async restartNow(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const r = obj(raw);
      const m = machineOf(cfg, r.machine);
      if (!m) return { ok: false, message: "That machine isn't configured." };
      if (!canInstall(m)) {
        return { ok: false, message: `${m.id} is notify-only: restart it yourself.` };
      }
      const engine = d.engine();
      if (!engine) return { ok: false, message: NO_ENGINE };
      const host = (await d.files.statuses())[m.id]?.host ?? null;
      if (!host?.reboot.required) {
        return { ok: false, message: `No restart is pending on ${m.id}.` };
      }
      if (m.kind === "server" && r.acknowledgeOutage !== true) {
        return {
          ok: false,
          message: `${m.id} is a server: confirm the outage in the panel first.`,
        };
      }
      const facts = await engine.peers.facts();
      const verdict = checkExclusive(
        m,
        cfg,
        facts,
        engine.orchestrator.current() ?? await d.files.run(),
      );
      if (!verdict.ok) return { ok: false, message: verdict.reason };
      const answer = await d.confirm(restartDialog({
        machine: m,
        drainCapMinutes: m.drainCapMinutes,
        packages: host.reboot.packages,
        labels: verdict.labels,
        soleLabels: verdict.soleLabels,
        dryRun: d.dryRun,
      }));
      if (answer !== 1) return { ok: false, cancelled: true, message: "Not restarted." };
      if (d.dryRun) return { ok: false, message: DRY };
      const started = await engine.orchestrator.start({
        machine: m.id,
        origin: { kind: "user" },
        action: "restart",
      });
      if (!started.ok) {
        await event("warn", `update ${m.id}`, `restart refused: ${started.reason}`);
        return { ok: false, message: started.reason };
      }
      await event("info", `update ${m.id}`, `restart run ${started.runId} started`);
      follow(m.id, started.done);
      d.onChange?.();
      return { ok: true, runId: started.runId, message: `Restarting ${m.id}.` };
    },

    /** Approve an agent's request: the same dialog, naming the request and its reason. */
    async approveRequest(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const r = obj(raw);
      const id = typeof r.id === "string" && REQUEST_ID.test(r.id) ? r.id : null;
      const req = id ? (await d.files.requests(cfg, d.now())).find((q) => q.id === id) : undefined;
      if (!req) return { ok: false, message: "That request is gone (expired or already handled)." };
      const m = machineOf(cfg, req.machine);
      if (!m) return { ok: false, message: "That machine isn't configured." };
      // The page may only narrow what installs, never widen it past the request.
      const mode = r.mode === "security" ? "security" : req.mode;
      return await confirmAndStart(
        cfg,
        m,
        { mode, reboot: req.reboot, acknowledgeOutage: r.acknowledgeOutage },
        { kind: "request", requestId: req.id },
        req,
      );
    },

    /** Deny an agent's request: removed, logged. */
    async denyRequest(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const id = obj(raw).id;
      if (typeof id !== "string" || !REQUEST_ID.test(id)) {
        return { ok: false, message: "That request isn't valid." };
      }
      const req = (await d.files.requests(cfg, d.now())).find((q) => q.id === id);
      if (!req) return { ok: false, message: "That request is gone." };
      await d.files.removeRequest(id);
      await event("info", `update ${req.machine}`, `agent request ${id} denied`);
      d.onChange?.();
      return { ok: true, message: "Request denied." };
    },

    /** Check now: run the machine's collector once. */
    async checkNow(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const m = machineOf(cfg, obj(raw).machine);
      if (!m) return { ok: false, message: "That machine isn't configured." };
      const engine = d.engine();
      if (!engine) return { ok: false, message: NO_ENGINE };
      const s = await engine.status.refresh(m);
      d.onChange?.();
      return s.error
        ? { ok: false, message: `The check failed: ${clampText(s.error, 200)}` }
        : { ok: true, message: `${m.id} checked.` };
    },

    /** Cancel the run in flight (accepted through the final check). */
    cancel(raw: unknown): UpdatesResult {
      const engine = d.engine();
      if (!engine) return { ok: false, message: NO_ENGINE };
      const id = obj(raw).runId;
      if (typeof id !== "string") return { ok: false, message: "That run isn't in flight." };
      const r = engine.orchestrator.cancel(id);
      if (!r.ok) return { ok: false, message: r.reason };
      void event("info", "update", `update run ${id}: cancel asked`);
      d.onChange?.();
      return { ok: true, message: "Cancelling: the pools are resumed." };
    },

    /** The self machine's only control: the OS's Software Update pane. */
    async openSoftwareUpdate(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const m = machineOf(cfg, obj(raw).machine);
      if (!m?.self) return { ok: false, message: "Only for the machine Fleet runs on." };
      const r = await d.openSoftwareUpdate();
      return r.ok ? { ok: true, message: r.message } : { ok: false, message: r.message };
    },

    /**
     * Save a restart window (new: no `id`, or an existing id to replace it): validated with
     * the config, then the dialog once; an enabled window then runs unattended.
     */
    async saveSchedule(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const draft = obj(obj(raw).schedule);
      const list = await d.files.schedules(cfg);
      const id = typeof draft.id === "string" && draft.id ? draft.id : `s-${d.now().toString(36)}`;
      if (!SCHEDULE_ID.test(id)) return { ok: false, message: "That schedule id isn't valid." };
      const next = [...list.filter((s) => s.id !== id), { ...draft, id }];
      const v = validateSchedules(next, cfg);
      if (!v.ok) {
        return { ok: false, message: "The window isn't valid.", errors: v.errors.slice(0, 20) };
      }
      const saved = v.value.find((s) => s.id === id)!;
      const m = cfg.machines.find((x) => x.id === saved.machine)!;
      if (saved.enabled) {
        const answer = await d.confirm(scheduleDialog(saved, m, d.tz(), d.now(), d.dryRun));
        if (answer !== 1) return { ok: false, cancelled: true, message: "Not saved." };
      }
      if (d.dryRun) return { ok: false, message: DRY };
      await d.files.saveSchedules(v.value);
      await event("info", `update ${m.id}`, `update window ${id} saved`);
      d.onChange?.();
      return { ok: true, message: "Window saved." };
    },

    /** Turn a window off (no dialog: nothing runs) or back on (the dialog again). */
    async setScheduleEnabled(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const r = obj(raw);
      const list = await d.files.schedules(cfg);
      const s = list.find((x) => x.id === r.id);
      if (!s) return { ok: false, message: "That window is gone." };
      const enabled = r.enabled === true;
      if (enabled && !s.enabled) {
        const m = cfg.machines.find((x) => x.id === s.machine)!;
        const answer = await d.confirm(
          scheduleDialog({ ...s, enabled }, m, d.tz(), d.now(), d.dryRun),
        );
        if (answer !== 1) return { ok: false, cancelled: true, message: "Left off." };
      }
      if (d.dryRun) return { ok: false, message: DRY };
      await d.files.saveSchedules(list.map((x) => (x.id === s.id ? { ...x, enabled } : x)));
      await event("info", `update ${s.machine}`, `update window ${s.id} ${enabled ? "on" : "off"}`);
      d.onChange?.();
      return { ok: true, message: enabled ? "Window on." : "Window off." };
    },

    /** Delete a window (no dialog: nothing runs). */
    async deleteSchedule(raw: unknown): Promise<UpdatesResult> {
      const cfg = d.config();
      if (!cfg) return { ok: false, message: NOT_SET_UP };
      const id = obj(raw).id;
      const list = await d.files.schedules(cfg);
      const s = list.find((x) => x.id === id);
      if (!s) return { ok: false, message: "That window is gone." };
      if (d.dryRun) return { ok: false, message: DRY };
      await d.files.saveSchedules(list.filter((x) => x.id !== s.id));
      await event("info", `update ${s.machine}`, `update window ${s.id} deleted`);
      d.onChange?.();
      return { ok: true, message: "Window deleted." };
    },
  };
}

/** The backend's type. */
export type UpdatesBackend = ReturnType<typeof createUpdatesBackend>;
