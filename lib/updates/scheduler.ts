// The scheduler's 60 s tick in the app's backend. Two kinds of run, one at a time fleet-wide:
//
// - Install on its own: a machine with `autoInstall` (default on; never the self machine) that is
//   out of date (security updates pending, or any update for `install: "all"`) gets an install
//   run as soon as nothing else runs. Its policy is `never` restart: a restart the install needs
//   leaves the run `reboot-pending` with the pools resumed, and the machine shows "Restart pending".
//   The busy, drain and hold rules still apply (a job is never stopped); a machine still busy at
//   the drain cap is tried again an hour later, one that installed six hours later.
// - Restart windows (`update-schedules.json`, set by the user): in a window, a machine whose
//   restart is pending gets a restart run (nothing installs) through lib/updates/schedule.ts's
//   `scheduleTick`: the ten-minute notice, then the run, never a catch-up, a skip recorded when
//   nothing is pending or too little window is left, and a notice after three busy windows.
//
// Pure over ports (config, files, orchestrator, clock, state, notices), so the tests use fakes.

import { canInstall } from "./config.ts";
import type {
  MachineStatus,
  RunOutcome,
  RunRecord,
  UpdateSchedule,
  UpdatesConfig,
  UpdatesMachine,
} from "./model.ts";
import type { OrchestratorHandle } from "./backend.ts";
import { BUSY_STREAK_ALERT, busyStreak, scheduleTick } from "./schedule.ts";

/** The tick runs this often. */
export const TICK_MS = 60_000;
/** After an auto-install that installed (or found nothing), the next waits this long. */
export const AUTO_AFTER_SUCCESS_MS = 6 * 3600_000;
/** After one that was busy, refused or failed, the next waits this long. */
export const AUTO_AFTER_FAILURE_MS = 3600_000;
/** Outcomes kept per restart window. */
const MAX_OUTCOMES = 10;

/** One restart window's memory. */
export interface WindowState {
  /** The window this schedule last started or skipped (its start). */
  readonly handled: number | null;
  readonly notice: { readonly window: number; readonly at: number } | null;
  /** Its recent windows' outcomes (a run's outcome, or `skip:<reason>`), oldest first. */
  readonly outcomes: readonly string[];
}

/** `update-scheduler.json`. */
export interface SchedulerState {
  readonly v: 1;
  readonly windows: Readonly<Record<string, WindowState>>;
  /** Per machine: the last auto-install's start and outcome (`null` while it runs). */
  readonly auto: Readonly<Record<string, { readonly at: number; readonly outcome: string | null }>>;
}

export const EMPTY_SCHEDULER_STATE: SchedulerState = { v: 1, windows: {}, auto: {} };

/** A scheduler state from a file (anything else reads as empty). */
export function parseSchedulerState(raw: unknown): SchedulerState {
  if (typeof raw !== "object" || raw === null) return EMPTY_SCHEDULER_STATE;
  const r = raw as Record<string, unknown>;
  if (r.v !== 1) return EMPTY_SCHEDULER_STATE;
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const windows: Record<string, WindowState> = {};
  if (typeof r.windows === "object" && r.windows !== null) {
    for (const [id, w] of Object.entries(r.windows as Record<string, unknown>).slice(0, 200)) {
      if (typeof w !== "object" || w === null) continue;
      const x = w as Record<string, unknown>;
      const n = x.notice as Record<string, unknown> | null;
      windows[id] = {
        handled: num(x.handled),
        notice: n && num(n.window) !== null && num(n.at) !== null
          ? { window: num(n.window)!, at: num(n.at)! }
          : null,
        outcomes: Array.isArray(x.outcomes)
          ? x.outcomes.filter((o): o is string => typeof o === "string").slice(-MAX_OUTCOMES)
          : [],
      };
    }
  }
  const auto: Record<string, { at: number; outcome: string | null }> = {};
  if (typeof r.auto === "object" && r.auto !== null) {
    for (const [id, a] of Object.entries(r.auto as Record<string, unknown>).slice(0, 200)) {
      const x = (a ?? {}) as Record<string, unknown>;
      const at = num(x.at);
      if (at !== null) auto[id] = { at, outcome: typeof x.outcome === "string" ? x.outcome : null };
    }
  }
  return { v: 1, windows, auto };
}

/** What the scheduler tells the notices (lib/notify.ts) and the event log. */
export type SchedulerEvent =
  | {
    readonly kind: "restart-soon";
    readonly scheduleId: string;
    readonly machine: string;
    readonly window: number;
    readonly runAt: number;
  }
  | {
    readonly kind: "skip";
    readonly scheduleId: string;
    readonly machine: string;
    readonly window: number;
    readonly reason: string;
  }
  | {
    readonly kind: "busy-streak";
    readonly scheduleId: string;
    readonly machine: string;
    readonly window: number;
    readonly count: number;
  }
  | {
    readonly kind: "started";
    readonly machine: string;
    readonly runId: string;
    readonly action: "install" | "restart";
    readonly origin: "auto" | "schedule";
  }
  | { readonly kind: "refused"; readonly machine: string; readonly reason: string };

/** What the scheduler runs over. */
export interface SchedulerDeps {
  config(): UpdatesConfig | null;
  schedules(config: UpdatesConfig): Promise<UpdateSchedule[]>;
  statuses(): Promise<Record<string, MachineStatus>>;
  readonly orchestrator: OrchestratorHandle;
  now(): number;
  tz(): string;
  loadState(): Promise<SchedulerState>;
  saveState(s: SchedulerState): Promise<void>;
  events(e: SchedulerEvent): void;
}

/** Whether a machine is out of date for what it installs. */
export function outOfDate(m: UpdatesMachine, s: MachineStatus | undefined): boolean {
  const h = s?.host;
  if (!h || s.error) return false;
  return m.install === "all" ? h.pending.total > 0 : h.pending.security > 0;
}

const SUCCESSISH = new Set<string>(["succeeded", "nothing-to-do", "reboot-pending"]);

/** The scheduler. */
export function createUpdatesScheduler(d: SchedulerDeps) {
  let state: SchedulerState | null = null;
  let busy = false;

  const load = async () => (state ??= await d.loadState().catch(() => EMPTY_SCHEDULER_STATE));
  const save = async (next: SchedulerState) => {
    state = next;
    await d.saveState(next).catch(() => {});
  };
  const setWindow = (id: string, patch: Partial<WindowState>) => {
    const cur = state!.windows[id] ?? { handled: null, notice: null, outcomes: [] };
    return save({ ...state!, windows: { ...state!.windows, [id]: { ...cur, ...patch } } });
  };
  const pushOutcome = async (s: UpdateSchedule, window: number, outcome: string) => {
    await load();
    const cur = state!.windows[s.id] ?? { handled: null, notice: null, outcomes: [] };
    const outcomes = [...cur.outcomes, outcome].slice(-MAX_OUTCOMES);
    await setWindow(s.id, { outcomes });
    const streak = busyStreak(outcomes);
    if (outcome === "deferred-busy" && streak >= BUSY_STREAK_ALERT) {
      d.events({
        kind: "busy-streak",
        scheduleId: s.id,
        machine: s.machine,
        window,
        count: streak,
      });
    }
  };

  /** The restart windows: at most one start. Whether a run started. */
  async function windows(cfg: UpdatesConfig, statuses: Record<string, MachineStatus>, now: number) {
    for (const s of await d.schedules(cfg)) {
      const m = cfg.machines.find((x) => x.id === s.machine);
      if (!m || !canInstall(m)) continue;
      const w = state!.windows[s.id];
      const decision = scheduleTick({
        schedule: s,
        tz: d.tz(),
        now,
        hasPools: m.pools.length > 0,
        due: statuses[m.id]?.host?.reboot.required === true,
        handledWindow: w?.handled ?? null,
        notice: w?.notice ?? null,
      });
      if (decision.kind === "idle") continue;
      if (decision.kind === "notice") {
        await setWindow(s.id, { notice: { window: decision.window.start, at: now } });
        d.events({
          kind: "restart-soon",
          scheduleId: s.id,
          machine: m.id,
          window: decision.window.start,
          runAt: decision.runAt,
        });
        continue;
      }
      if (decision.kind === "skip") {
        await setWindow(s.id, { handled: decision.window.start });
        await pushOutcome(s, decision.window.start, `skip:${decision.reason}`);
        d.events({
          kind: "skip",
          scheduleId: s.id,
          machine: m.id,
          window: decision.window.start,
          reason: decision.reason,
        });
        continue;
      }
      const started = await d.orchestrator.start({
        machine: m.id,
        origin: { kind: "schedule", scheduleId: s.id },
        action: "restart",
        drainCapMinutes: s.drainCapMinutes,
        windowEnd: decision.window.end,
      });
      await setWindow(s.id, { handled: decision.window.start });
      if (!started.ok) {
        await pushOutcome(s, decision.window.start, "refused");
        d.events({ kind: "refused", machine: m.id, reason: started.reason });
        continue;
      }
      d.events({
        kind: "started",
        machine: m.id,
        runId: started.runId,
        action: "restart",
        origin: "schedule",
      });
      const win = decision.window.start;
      void started.done.then(
        (rec: RunRecord) => pushOutcome(s, win, rec.outcome ?? "aborted"),
        () => pushOutcome(s, win, "aborted"),
      );
      return true;
    }
    return false;
  }

  /** Auto-install: the first out-of-date machine due again. Whether a run started. */
  async function autoInstall(
    cfg: UpdatesConfig,
    statuses: Record<string, MachineStatus>,
    now: number,
  ) {
    for (const m of cfg.machines) {
      if (!m.autoInstall || !canInstall(m)) continue;
      const st = statuses[m.id];
      if (!outOfDate(m, st) || (st?.heldPools.length ?? 0) > 0) continue;
      const last = state!.auto[m.id];
      if (last) {
        // No outcome and no run in flight (the tick checked): Fleet stopped mid-run; a failure.
        const wait = last.outcome !== null && SUCCESSISH.has(last.outcome)
          ? AUTO_AFTER_SUCCESS_MS
          : AUTO_AFTER_FAILURE_MS;
        if (now - last.at < wait) continue;
      }
      const started = await d.orchestrator.start({
        machine: m.id,
        origin: { kind: "auto" },
        mode: m.install === "all" ? "all" : "security",
        // Never restarts on its own: a needed restart waits for a restart window.
        reboot: "never",
      });
      const at = now;
      if (!started.ok) {
        await save({ ...state!, auto: { ...state!.auto, [m.id]: { at, outcome: "refused" } } });
        d.events({ kind: "refused", machine: m.id, reason: started.reason });
        continue;
      }
      await save({ ...state!, auto: { ...state!.auto, [m.id]: { at, outcome: null } } });
      d.events({
        kind: "started",
        machine: m.id,
        runId: started.runId,
        action: "install",
        origin: "auto",
      });
      const done = (outcome: RunOutcome | "aborted") =>
        load().then(() => save({ ...state!, auto: { ...state!.auto, [m.id]: { at, outcome } } }));
      void started.done.then((rec) => done(rec.outcome ?? "aborted"), () => done("aborted"));
      return true;
    }
    return false;
  }

  return {
    /** One tick: a restart window first (they are time-bound), else an auto-install. */
    async tick(): Promise<void> {
      if (busy) return;
      busy = true;
      try {
        const cfg = d.config();
        if (!cfg) return;
        // One run at a time: a window or install that waits now is looked at again next tick.
        if (d.orchestrator.current()) return;
        await load();
        const now = d.now();
        const statuses = await d.statuses();
        if (await windows(cfg, statuses, now)) return;
        await autoInstall(cfg, statuses, now);
      } finally {
        busy = false;
      }
    },
    /** The state (tests). */
    state: () => state,
  };
}
