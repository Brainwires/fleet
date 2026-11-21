// What acts on hosts, assembled: one UpdateOrchestrator over the remote, pools, store, status, peers
// and telemetry ports, the status port (the gate's `status` verb through the per-OS parsers, folded
// into `updates.json`), and the collector's schedule. Pure over ports: desktop/fleet.ts supplies the
// Deno ones (lib/deno-updates.ts), the tests fakes.
//
// The settings may change while Fleet runs. The orchestrator takes its config once, so a changed
// `integrations.updates` builds a new one, but only while no run is in flight: a run always finishes
// on the config it started with. The handle the panel and the scheduler hold follows the swap.

import type { PoolPaths } from "../controls.ts";
import type { OrchestratorHandle, UpdatesEngine } from "./backend.ts";
import { parseStatusDocument } from "./collect.ts";
import {
  type Clock,
  emptyStatus,
  type MachineStatus,
  type PeerFacts,
  type PeersPort,
  type PoolsPort,
  type RemotePort,
  type RunEvents,
  type StatusPort,
  type TelemetryPort,
  type UpdatesConfig,
  type UpdatesMachine,
  type UpdatesStore,
  withCheck,
  withCheckError,
} from "./model.ts";
import { type OrchestratorDeps, UpdateOrchestrator } from "./orchestrator.ts";

/** A collector run's cap (one host at a time). */
export const COLLECT_TIMEOUT_MS = 120_000;
/** Each machine is checked this often (and after each run, and on Check now). */
export const COLLECT_EVERY_MS = 6 * 3600_000;

/** The status file, as the engine reads and writes it. */
export interface StatusFilePort {
  statuses(): Promise<Record<string, MachineStatus>>;
  saveStatuses(statuses: Readonly<Record<string, MachineStatus>>): Promise<void>;
}

/** What the engine runs over. */
export interface EngineDeps {
  config(): UpdatesConfig | null;
  /** The pool commands' programs now (`null`: no runner scheduler). */
  paths(): PoolPaths | null;
  readonly remote: RemotePort;
  readonly pools: PoolsPort;
  readonly store: UpdatesStore;
  readonly files: StatusFilePort;
  readonly clock: Clock;
  readonly telemetry: TelemetryPort | null;
  /** The rest of the fleet, from these statuses (pool cards, unreachable machines). */
  peers(config: UpdatesConfig, statuses: Readonly<Record<string, MachineStatus>>): PeerFacts;
  readonly events: RunEvents;
  /** Tests pass a fixed run id. */
  readonly newRunId?: OrchestratorDeps["newRunId"];
}

/** The engine: the panel's and the scheduler's surface, plus startup and the collector's tick. */
export interface Engine extends UpdatesEngine {
  /**
   * After a Fleet restart: pick up `update-run.json`'s run (`true` when there was one; its steps
   * and its end arrive as run events like any run's).
   */
  reattach(): Promise<boolean>;
  /** Check the next machine whose last check is older than COLLECT_EVERY_MS (at most one). */
  collectTick(): Promise<MachineStatus | null>;
}

/** The machines due a check now: never checked, or the last attempt older than COLLECT_EVERY_MS. */
export function collectDue(
  config: UpdatesConfig,
  statuses: Readonly<Record<string, MachineStatus>>,
  now: number,
  busyMachine: string | null,
): UpdatesMachine[] {
  return config.machines.filter((m) => {
    if (m.via === "local" || m.id === busyMachine) return false;
    const at = statuses[m.id]?.attemptAt ?? null;
    return at === null || now - at >= COLLECT_EVERY_MS;
  });
}

/** Build the engine. */
export function createUpdatesEngine(d: EngineDeps): Engine {
  /** The last known statuses (loaded from the file on first use, then kept in step with it). */
  let cache: Record<string, MachineStatus> | null = null;
  const load = async (): Promise<
    Record<string, MachineStatus>
  > => (cache ??= await d.files.statuses().catch(() => ({})));
  /** One collector at a time: refreshes queue behind each other. */
  let chain: Promise<unknown> = Promise.resolve();

  async function collectOne(m: UpdatesMachine): Promise<MachineStatus> {
    const all = await load();
    const prev = all[m.id] ?? emptyStatus(m.id);
    // The machine Fleet runs on is checked by its own OS (notify only): nothing to run.
    if (m.via === "local") return prev;
    const now = d.clock.now();
    const r = await d.remote.run(m, "status", { timeoutMs: COLLECT_TIMEOUT_MS });
    let next: MachineStatus;
    if (r.code === 0) {
      const parsed = parseStatusDocument(m.os, r.stdout);
      next = parsed.ok
        ? withCheck(prev, parsed.status, now)
        : withCheckError(prev, parsed.error, now);
    } else {
      next = withCheckError(
        prev,
        r.unreachable
          ? "unreachable over ssh (connection, key or host key)"
          : r.timedOut
          ? "the status check timed out"
          : r.code === -1
          ? "the status check couldn't run"
          : `the status check failed (exit ${r.code})`,
        now,
      );
    }
    const known = new Set((d.config()?.machines ?? []).map((x) => x.id));
    const merged: Record<string, MachineStatus> = { ...await load(), [m.id]: next };
    const kept: Record<string, MachineStatus> = {};
    for (const [id, st] of Object.entries(merged)) if (known.has(id)) kept[id] = st;
    cache = kept;
    await d.files.saveStatuses(kept).catch(() => {});
    return next;
  }

  const status: StatusPort = {
    refresh(m) {
      const p = chain.then(() => collectOne(m));
      chain = p.catch(() => {});
      return p;
    },
    current: (id) => cache?.[id] ?? null,
  };

  const peers: PeersPort = {
    async facts() {
      const cfg = d.config();
      if (!cfg) return { pools: {}, unreachable: [] };
      return d.peers(cfg, await load());
    },
  };

  let orch: UpdateOrchestrator | null = null;
  let orchConfig: UpdatesConfig | null = null;
  let orchPaths: PoolPaths | null = null;
  /** The orchestrator for the config now (rebuilt only between runs). */
  function orchestrator(): UpdateOrchestrator | null {
    const cfg = d.config();
    const paths = d.paths();
    if (orch && orch.current() !== null) return orch;
    if (!cfg) return (orch = null, orchConfig = null, null);
    if (!orch || cfg !== orchConfig || !samePaths(paths, orchPaths)) {
      orchConfig = cfg;
      orchPaths = paths;
      orch = new UpdateOrchestrator({
        config: cfg,
        paths,
        pools: d.pools,
        remote: d.remote,
        clock: d.clock,
        store: d.store,
        status,
        peers,
        telemetry: d.telemetry,
        events: d.events,
        ...(d.newRunId ? { newRunId: d.newRunId } : {}),
      });
    }
    return orch;
  }

  const handle: OrchestratorHandle = {
    async start(req) {
      const o = orchestrator();
      if (!o) return { ok: false, reason: "Machine updates aren't set up." };
      return await o.start(req);
    },
    cancel(runId) {
      return orch?.cancel(runId) ?? { ok: false, reason: "That run isn't in flight." };
    },
    current: () => orch?.current() ?? null,
  };

  return {
    orchestrator: handle,
    status,
    peers,
    async reattach() {
      await load();
      if (!await d.store.readRun()) return false;
      // Resolves only when the run ends (the orchestrator adopts the run's own promise).
      void orchestrator()?.reattach().catch(() => {});
      return true;
    },
    async collectTick() {
      const cfg = d.config();
      if (!cfg) return null;
      const due = collectDue(cfg, await load(), d.clock.now(), orch?.current()?.machine ?? null);
      return due.length ? await status.refresh(due[0]) : null;
    },
  };
}

function samePaths(a: PoolPaths | null, b: PoolPaths | null): boolean {
  if (a === null || b === null) return a === b;
  return a.pausePool === b.pausePool && a.watchdog === b.watchdog;
}
