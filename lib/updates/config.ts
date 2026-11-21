// `integrations.updates` (fleet-settings.json, file-only) and `update-schedules.json`, validated.
// Pure. The self-machine rules live here: the machine Fleet runs on is notify-only, so a self
// machine that would install, or a schedule for one, is a config error, and `via: "local"` is only
// for it. A `server` (a service host with no CI) has no pools.

import { validPath } from "../settings.ts";
import {
  BUSY_PLUGIN_NAMES,
  type BusyPluginName,
  DEFAULT_THRESHOLDS,
  MACHINE_KINDS,
  type MachineVia,
  REBOOT_POLICIES,
  type Thresholds,
  UPDATE_MODES,
  UPDATE_OSES,
  type UpdateMode,
  type UpdateSchedule,
  type UpdatesConfig,
  type UpdatesMachine,
} from "./model.ts";

/** A machine id: the machines service's id (letters, digits, `.`, `_`, `-`). */
export const MACHINE_ID = /^[A-Za-z0-9][\w.-]{0,63}$/;
/** An alias in Fleet's ssh config (never an option: no leading `-`). */
export const SSH_ALIAS = /^[A-Za-z0-9][\w.-]{0,63}$/;
/** A pool id, as the runner scheduler names it. */
const POOL_ID = /^[\w.-]{1,200}$/;
/** A schedule id. */
export const SCHEDULE_ID = /^[A-Za-z0-9][\w-]{0,63}$/;
/** A mount point on a host. */
const MOUNT = /^\/[\w./ -]{0,255}$/;

/** The default ssh program. */
export const DEFAULT_SSH = "/usr/bin/ssh";
/** Drain cap bounds (minutes). */
export const DRAIN_CAP_MIN = 5;
export const DRAIN_CAP_MAX = 720;
export const DEFAULT_DRAIN_CAP = 90;
/** A window needs the drain cap plus this much (minutes) for install, reboot and verify. */
export const WINDOW_MARGIN_MINUTES = 90;

export type ConfigResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly errors: readonly string[] };

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

class Reader {
  readonly errors: string[] = [];
  err(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string): Record<string, unknown> {
    if (v === undefined) return {};
    if (!isObj(v)) return (this.err(path, "must be an object"), {});
    return v;
  }
  bool(v: unknown, path: string, dflt: boolean): boolean {
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") return (this.err(path, "must be true or false"), dflt);
    return v;
  }
  int(v: unknown, path: string, min: number, max: number, dflt: number): number {
    if (v === undefined) return dflt;
    if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) {
      return (this.err(path, `a whole number from ${min} to ${max}`), dflt);
    }
    return v;
  }
  str(v: unknown, path: string, ok: (s: string) => boolean, what: string): string | null {
    if (typeof v !== "string" || !ok(v)) return (this.err(path, what), null);
    return v;
  }
  oneOf<T extends string>(v: unknown, path: string, options: readonly T[], dflt: T): T {
    if (v === undefined) return dflt;
    if (typeof v !== "string" || !options.includes(v as T)) {
      return (this.err(path, `must be one of ${options.join(", ")}`), dflt);
    }
    return v as T;
  }
  list<T>(v: unknown, path: string, max: number, item: (x: unknown, p: string) => T | null): T[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) return (this.err(path, "must be a list"), []);
    if (v.length > max) this.err(path, `at most ${max} entries`);
    const out: T[] = [];
    v.slice(0, max).forEach((x, i) => {
      const r = item(x, `${path}[${i}]`);
      if (r !== null) out.push(r);
    });
    return out;
  }
}

const P = "integrations.updates";

function readMachine(r: Reader, x: unknown, p: string): UpdatesMachine | null {
  if (!isObj(x)) return (r.err(p, "must be an object"), null);
  const id = r.str(
    x.id,
    `${p}.id`,
    (s) => MACHINE_ID.test(s),
    "a machine id (letters, digits, .-_)",
  );
  const os = r.oneOf(x.os, `${p}.os`, UPDATE_OSES, "ubuntu");
  if (x.os === undefined) r.err(`${p}.os`, `required: one of ${UPDATE_OSES.join(", ")}`);
  const kind = r.oneOf(x.kind, `${p}.kind`, MACHINE_KINDS, "runner");
  let via: MachineVia | null = null;
  if (x.via === "local") via = "local";
  else if (isObj(x.via)) {
    const alias = r.str(x.via.ssh, `${p}.via.ssh`, (s) => SSH_ALIAS.test(s), "an ssh alias");
    if (alias) via = { ssh: alias };
  } else r.err(`${p}.via`, `"local" or { "ssh": "<alias>" }`);
  const self = r.bool(x.self, `${p}.self`, false);
  const install = r.oneOf(
    x.install,
    `${p}.install`,
    [...UPDATE_MODES, "none"] as const,
    self ? "none" : "security",
  );
  const pools = r.list(
    x.pools,
    `${p}.pools`,
    50,
    (v, q) => r.str(v, q, (s) => POOL_ID.test(s) && !s.startsWith("-"), "a pool id"),
  );
  const busy = r.list(
    x.busy,
    `${p}.busy`,
    BUSY_PLUGIN_NAMES.length,
    (v, q) => r.oneOf<BusyPluginName>(v, q, BUSY_PLUGIN_NAMES, "pools"),
  );
  const vo = r.obj(x.verify, `${p}.verify`);
  const mounts = r.list(
    vo.mounts,
    `${p}.verify.mounts`,
    50,
    (v, q) =>
      r.str(v, q, (s) => MOUNT.test(s) && !s.split("/").includes(".."), "an absolute mount point"),
  );
  const reach = r.list(
    vo.reach,
    `${p}.verify.reach`,
    20,
    (v, q) => r.str(v, q, (s) => MACHINE_ID.test(s), "a machine id"),
  );
  const reboot = r.oneOf(x.reboot, `${p}.reboot`, REBOOT_POLICIES, "if-needed");
  const drainCapMinutes = r.int(
    x.drainCapMinutes,
    `${p}.drainCapMinutes`,
    DRAIN_CAP_MIN,
    DRAIN_CAP_MAX,
    DEFAULT_DRAIN_CAP,
  );

  // The self-machine rules.
  if (self && install !== "none") {
    r.err(`${p}.install`, "the machine Fleet runs on is notify-only (self: true): no install");
  }
  if (via === "local" && !self) {
    r.err(`${p}.via`, `"local" is only for the machine Fleet runs on (self: true)`);
  }
  // Service hosts and pools.
  if (kind === "server" && pools.length > 0) {
    r.err(`${p}.pools`, "a server (no CI) has no pools");
  }
  if (busy.includes("pools") && pools.length === 0) {
    r.err(`${p}.busy`, `"pools" needs at least one pool`);
  }
  if (!id || !via) return null;
  return {
    id,
    os,
    kind,
    via,
    self,
    install,
    pools: [...new Set(pools)],
    busy: x.busy === undefined ? (pools.length > 0 ? ["pools"] : []) : [...new Set(busy)],
    verify: { mounts, reach: [...new Set(reach)] },
    reboot,
    drainCapMinutes,
  };
}

/** Validate `integrations.updates` (`null`/absent: the feature is off). */
export function validateUpdatesConfig(raw: unknown): ConfigResult<UpdatesConfig | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  const r = new Reader();
  if (!isObj(raw)) return { ok: false, errors: [`${P}: must be an object`] };
  const so = r.obj(raw.ssh, `${P}.ssh`);
  const program = so.program === undefined
    ? DEFAULT_SSH
    : r.str(so.program, `${P}.ssh.program`, (s) =>
      validPath(s) && !s.startsWith("~/"), "an absolute path") ?? DEFAULT_SSH;
  const configFile = so.configFile === undefined
    ? ""
    : r.str(so.configFile, `${P}.ssh.configFile`, validPath, "an absolute or ~/ path") ?? "";
  const to = r.obj(raw.thresholds, `${P}.thresholds`);
  const d = DEFAULT_THRESHOLDS;
  const thresholds: Thresholds = {
    securityDays: r.int(to.securityDays, `${P}.thresholds.securityDays`, 1, 365, d.securityDays),
    rebootDays: r.int(to.rebootDays, `${P}.thresholds.rebootDays`, 1, 365, d.rebootDays),
    staleHours: r.int(to.staleHours, `${P}.thresholds.staleHours`, 1, 720, d.staleHours),
    noCheckHours: r.int(to.noCheckHours, `${P}.thresholds.noCheckHours`, 1, 2160, d.noCheckHours),
  };
  if (thresholds.noCheckHours < thresholds.staleHours) {
    r.err(`${P}.thresholds.noCheckHours`, "at least staleHours");
  }
  const minFreeDiskMb = r.int(raw.minFreeDiskMb, `${P}.minFreeDiskMb`, 0, 1_000_000, 2048);
  const machines = r.list(raw.machines, `${P}.machines`, 100, (x, p) => readMachine(r, x, p));

  const ids = new Set<string>();
  machines.forEach((m, i) => {
    const k = m.id.toLowerCase();
    if (ids.has(k)) r.err(`${P}.machines[${i}].id`, `"${m.id}" is listed twice`);
    ids.add(k);
  });
  if (machines.filter((m) => m.self).length > 1) {
    r.err(`${P}.machines`, "at most one machine is the one Fleet runs on (self: true)");
  }
  for (const m of machines) {
    for (const g of m.verify.reach) {
      if (g.toLowerCase() === m.id.toLowerCase()) {
        r.err(`${P}.machines.${m.id}.verify.reach`, "not itself");
      } else if (!ids.has(g.toLowerCase())) {
        r.err(`${P}.machines.${m.id}.verify.reach`, `"${g}" isn't a configured machine`);
      }
    }
  }
  if (machines.some((m) => m.via !== "local") && !configFile) {
    r.err(`${P}.ssh.configFile`, "required when a machine is reached over ssh");
  }
  if (r.errors.length) return { ok: false, errors: r.errors };
  return {
    ok: true,
    value: { ssh: { program, configFile }, thresholds, minFreeDiskMb, machines },
  };
}

/** Whether a machine may be updated at all (not the self machine, not install `none`). */
export function canInstall(m: UpdatesMachine): boolean {
  return !m.self && m.install !== "none";
}

/** Validate `update-schedules.json` against the config. */
export function validateSchedules(
  raw: unknown,
  config: UpdatesConfig,
): ConfigResult<UpdateSchedule[]> {
  const r = new Reader();
  const list = r.list(raw, "schedules", 100, (x, p): UpdateSchedule | null => {
    if (!isObj(x)) return (r.err(p, "must be an object"), null);
    const id = r.str(x.id, `${p}.id`, (s) => SCHEDULE_ID.test(s), "a schedule id");
    const machineId = r.str(x.machine, `${p}.machine`, (s) => MACHINE_ID.test(s), "a machine id");
    const machine = machineId
      ? config.machines.find((m) => m.id.toLowerCase() === machineId.toLowerCase())
      : undefined;
    if (machineId && !machine) r.err(`${p}.machine`, `"${machineId}" isn't a configured machine`);
    if (machine?.self) {
      r.err(`${p}.machine`, "the machine Fleet runs on is notify-only (self: true): no schedule");
    } else if (machine && machine.install === "none") {
      r.err(`${p}.machine`, `"${machine.id}" installs nothing (install: none)`);
    }
    const days = r.list(x.days, `${p}.days`, 7, (v, q) => {
      if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > 6) {
        return (r.err(q, "a day of the week, 0 (Sunday) to 6"), null);
      }
      return v;
    });
    if (days.length === 0) r.err(`${p}.days`, "at least one day");
    const start = r.str(
      x.start,
      `${p}.start`,
      (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s),
      "a time, HH:MM",
    );
    const windowMinutes = r.int(x.windowMinutes, `${p}.windowMinutes`, 30, 1440, 240);
    const mode = r.oneOf<UpdateMode>(x.mode, `${p}.mode`, UPDATE_MODES, "security");
    const reboot = r.oneOf(
      x.reboot,
      `${p}.reboot`,
      REBOOT_POLICIES,
      machine?.reboot ?? "if-needed",
    );
    const drainCapMinutes = r.int(
      x.drainCapMinutes,
      `${p}.drainCapMinutes`,
      DRAIN_CAP_MIN,
      DRAIN_CAP_MAX,
      machine?.drainCapMinutes ?? DEFAULT_DRAIN_CAP,
    );
    const enabled = r.bool(x.enabled, `${p}.enabled`, true);
    const needed = (machine && machine.pools.length === 0 ? 0 : drainCapMinutes) +
      WINDOW_MARGIN_MINUTES;
    if (windowMinutes < needed) {
      r.err(
        `${p}.windowMinutes`,
        `at least ${needed} (the drain cap plus ${WINDOW_MARGIN_MINUTES})`,
      );
    }
    if (!id || !machine || !start) return null;
    return {
      id,
      machine: machine.id,
      days: [...new Set(days)].sort(),
      start,
      windowMinutes,
      mode,
      reboot,
      drainCapMinutes,
      enabled,
    };
  });
  const ids = new Set<string>();
  for (const s of list) {
    if (ids.has(s.id)) r.err("schedules", `"${s.id}" is listed twice`);
    ids.add(s.id);
  }
  if (r.errors.length) return { ok: false, errors: r.errors };
  return { ok: true, value: list };
}
