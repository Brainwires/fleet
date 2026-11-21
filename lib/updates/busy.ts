// The busy plugins (config `busy`): each says free or busy, with one line of reason. A new plugin
// is one function here plus its name in BUSY_PLUGIN_NAMES (lib/updates/model.ts).
//
// - pools: every listed pool idle (`pause-pool.sh --status`). A pause (this run's hold) is not busy.
// - remote: the host's root-owned `/etc/fleet-update/busy.d/*` through the gate's `busy` verb;
//   exit 10 = busy, 0 = free, anything else (or no answer) = busy, since free is never assumed.
// - telemetry: the machines service shows no job on the machine (unknown counts as busy).
// - local-vms: no guest in `verify.reach` is itself mid-run or running a job.

import {
  type BusyPluginName,
  clampText,
  MAX_REASON_LEN,
  type PoolsPort,
  type RemotePort,
  type RunRecord,
  type TelemetryPort,
  type UpdatesConfig,
  type UpdatesMachine,
} from "./model.ts";

/** A plugin's verdict. */
export interface BusyVerdict {
  readonly plugin: BusyPluginName;
  readonly busy: boolean;
  readonly reason: string;
}

/** What the plugins may look at. */
export interface BusyContext {
  readonly machine: UpdatesMachine;
  readonly config: UpdatesConfig;
  readonly pools: PoolsPort;
  readonly remote: RemotePort;
  readonly telemetry: TelemetryPort | null;
  /** The run in flight, if any (a guest mid-run makes its host busy). */
  readonly activeRun: RunRecord | null;
  readonly signal?: AbortSignal;
}

/** The `busy` verb's time limit. */
export const BUSY_TIMEOUT_MS = 60_000;
/** The `busy` verb's exit code for busy. */
export const REMOTE_BUSY_CODE = 10;

type Plugin = (ctx: BusyContext) => Promise<BusyVerdict>;

const free = (plugin: BusyPluginName): BusyVerdict => ({ plugin, busy: false, reason: "" });
const busy = (plugin: BusyPluginName, reason: string): BusyVerdict => ({
  plugin,
  busy: true,
  reason: clampText(reason, MAX_REASON_LEN),
});

async function poolsIdle(plugin: BusyPluginName, pools: readonly string[], port: PoolsPort) {
  for (const p of pools) {
    const s = await port.state(p);
    if (!s.idle) return busy(plugin, `${p}: ${s.jobs} job${s.jobs === 1 ? "" : "s"} running`);
  }
  return free(plugin);
}

/** The plugins by name. */
export const BUSY_PLUGINS: Readonly<Record<BusyPluginName, Plugin>> = {
  pools: (ctx) => poolsIdle("pools", ctx.machine.pools, ctx.pools),
  remote: async (ctx) => {
    const r = await ctx.remote.run(ctx.machine, "busy", {
      timeoutMs: BUSY_TIMEOUT_MS,
      signal: ctx.signal,
    });
    if (r.code === 0) return free("remote");
    if (r.code === REMOTE_BUSY_CODE) {
      return busy("remote", clampText(r.stdout.split("\n")[0]) || "the host says it is busy");
    }
    return busy(
      "remote",
      r.unreachable
        ? "the host didn't answer"
        : r.timedOut
        ? "busy check timed out"
        : `busy check failed (exit ${r.code})`,
    );
  },
  telemetry: (ctx) => {
    const jobs = ctx.telemetry?.jobsOn(ctx.machine.id) ?? null;
    if (jobs === null) {
      return Promise.resolve(busy("telemetry", "the machines service doesn't know"));
    }
    return Promise.resolve(
      jobs > 0
        ? busy("telemetry", `${jobs} job${jobs === 1 ? "" : "s"} on the machine`)
        : free("telemetry"),
    );
  },
  "local-vms": async (ctx) => {
    for (const id of ctx.machine.verify.reach) {
      if (ctx.activeRun && ctx.activeRun.machine === id) {
        return busy("local-vms", `guest ${id} is mid-update`);
      }
      const guest = ctx.config.machines.find((m) => m.id === id);
      if (!guest) continue;
      const v = await poolsIdle("local-vms", guest.pools, ctx.pools);
      if (v.busy) return busy("local-vms", `guest ${id}: ${v.reason}`);
    }
    return free("local-vms");
  },
};

/** Every configured plugin's verdict, in config order. */
export async function checkBusy(ctx: BusyContext): Promise<BusyVerdict[]> {
  const out: BusyVerdict[] = [];
  for (const name of ctx.machine.busy) out.push(await BUSY_PLUGINS[name](ctx));
  return out;
}

/** The first busy verdict's line, or `null` when every plugin says free. */
export function busyReason(verdicts: readonly BusyVerdict[]): string | null {
  const b = verdicts.find((v) => v.busy);
  return b ? `${b.plugin}: ${b.reason}` : null;
}
