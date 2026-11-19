// Machines: hardware telemetry per PHYSICAL machine, read from a machines service (settings
// `integrations.machines`; docs/machines.md has its API). Pure: the service's documents parsed
// defensively (it is another program's word: every number clamped, every list capped, every text
// stripped of control characters), the live stream's frames, the state the page shows (the newest
// reading per machine plus a short trail for the sparklines), a history as chart series, and the
// agents' `machines.json`. No I/O here (lib/deno-machines.ts connects; the page renders).

/** The desktop event the backend emits when the machines view changed. */
export const MACHINES_EVENT = "machines";

/** A VM, a container or a process tree on a machine. */
export interface Sandbox {
  readonly kind: string;
  readonly name: string;
  /** Percent of ONE core (400: four cores busy). */
  readonly cpuPct: number;
  readonly rssMb: number;
}

/** A share of a machine. */
export interface Use {
  readonly cpuPct: number;
  readonly rssMb: number;
}

/** One reading of a machine. */
export interface MachineSample {
  readonly t: number;
  readonly cpu: {
    readonly pct: number;
    readonly cores: readonly number[];
    readonly load: readonly number[] | null;
  };
  readonly mem: {
    readonly totalMb: number;
    readonly usedMb: number;
    readonly availMb: number;
    readonly pressure: number | null;
  };
  readonly swap: { readonly usedMb: number; readonly totalMb: number };
  readonly disk: readonly {
    readonly name: string;
    readonly mount: string;
    readonly totalGb: number;
    readonly freeGb: number;
  }[];
  readonly net: { readonly rxBps: number; readonly txBps: number };
  readonly temps: readonly { readonly name: string; readonly c: number }[];
  readonly gpu: { readonly pct: number } | null;
  readonly sandboxes: readonly Sandbox[];
  /** Per pool: its sandboxes' sum. */
  readonly pools: Readonly<Record<string, Use>>;
}

/** A job on a machine, with what its sandbox uses now. */
export interface MachineJob {
  readonly pool: string;
  readonly slot: number;
  readonly phase: string;
  readonly since: number;
  readonly job:
    | {
      readonly repo: string;
      readonly runId: number;
      readonly jobId: number;
      readonly name: string | null;
    }
    | null;
  readonly runner: string | null;
  readonly cpuPct: number | null;
  readonly rssMb: number | null;
  readonly sandbox: string | null;
}

/** A pool, nested in its machine. */
export interface MachinePool {
  readonly name: string;
  readonly label: string;
  readonly slots: number;
  readonly busy: number;
  readonly state: string;
  readonly reason: string;
  readonly use: Use | null;
  readonly jobs: readonly MachineJob[];
}

/** One physical machine. */
export interface Machine {
  readonly id: string;
  readonly name: string;
  readonly info: {
    readonly os: string;
    readonly arch: string;
    readonly cpuModel: string;
    readonly host: string;
    readonly bootAt: number | null;
  } | null;
  /** Where its readings come from, as the service says (`agent`, `bridge`), or `null`. */
  readonly source: string | null;
  readonly lastAt: number | null;
  readonly online: boolean;
  readonly latest: MachineSample | null;
  readonly pools: readonly MachinePool[];
}

export interface MachinesDoc {
  readonly at: number;
  readonly machines: readonly Machine[];
}

/** Caps on what Fleet keeps from the service. */
export const MAX_MACHINES = 32;
export const MAX_POOLS = 32;
export const MAX_JOBS = 64;
export const MAX_SANDBOXES = 64;
export const MAX_CORES = 256;

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const list = (v: unknown, max: number): unknown[] => Array.isArray(v) ? v.slice(0, max) : [];
const num = (v: unknown, min: number, max: number, dflt = 0): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : dflt;
const numOrNull = (v: unknown, min: number, max: number): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
const text = (v: unknown, max: number): string =>
  // deno-lint-ignore no-control-regex
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
const id = (v: unknown): string => {
  const s = text(v, 100);
  return /^[\w.+-]{1,100}$/.test(s) ? s : "";
};

function parseUse(v: unknown): Use | null {
  const o = obj(v);
  return typeof o.cpuPct === "number" && typeof o.rssMb === "number"
    ? { cpuPct: num(o.cpuPct, 0, 1e5), rssMb: num(o.rssMb, 0, 1e8) }
    : null;
}

/** A sample from the service, or `null` when it isn't one. */
export function parseSample(raw: unknown): MachineSample | null {
  const r = obj(raw);
  const cpu = obj(r.cpu), mem = obj(r.mem), swap = obj(r.swap), net = obj(r.net), gpu = obj(r.gpu);
  if (typeof r.t !== "number" || typeof cpu.pct !== "number" || typeof mem.totalMb !== "number") {
    return null;
  }
  const pools: Record<string, Use> = {};
  for (const [k, v] of Object.entries(obj(r.pools)).slice(0, MAX_POOLS)) {
    const u = parseUse(v);
    if (id(k) && u) pools[k] = u;
  }
  return {
    t: num(r.t, 0, 1e14),
    cpu: {
      pct: num(cpu.pct, 0, 100),
      cores: list(cpu.cores, MAX_CORES).map((x) => num(x, 0, 100)),
      load: Array.isArray(cpu.load) ? cpu.load.slice(0, 3).map((x) => num(x, 0, 1e5)) : null,
    },
    mem: {
      totalMb: num(mem.totalMb, 0, 1e8),
      usedMb: num(mem.usedMb, 0, 1e8),
      availMb: num(mem.availMb, 0, 1e8),
      pressure: numOrNull(mem.pressure, 0, 100),
    },
    swap: { usedMb: num(swap.usedMb, 0, 1e8), totalMb: num(swap.totalMb, 0, 1e8) },
    disk: list(r.disk, 8).map(obj).filter((d) => text(d.name, 32)).map((d) => ({
      name: text(d.name, 32),
      mount: text(d.mount, 128),
      totalGb: num(d.totalGb, 0, 1e7),
      freeGb: num(d.freeGb, 0, 1e7),
    })),
    net: { rxBps: num(net.rxBps, 0, 1e12), txBps: num(net.txBps, 0, 1e12) },
    temps: list(r.temps, 16).map(obj).filter((x) => text(x.name, 48) && typeof x.c === "number")
      .map((x) => ({ name: text(x.name, 48), c: num(x.c, -50, 200) })),
    gpu: typeof gpu.pct === "number" ? { pct: num(gpu.pct, 0, 100) } : null,
    sandboxes: list(r.sandboxes, MAX_SANDBOXES).map(obj).filter((s) => text(s.name, 96)).map(
      (s) => ({
        kind: text(s.kind, 16),
        name: text(s.name, 96),
        cpuPct: num(s.cpuPct, 0, 1e5),
        rssMb: num(s.rssMb, 0, 1e8),
      }),
    ),
    pools,
  };
}

function parseJob(raw: unknown): MachineJob | null {
  const r = obj(raw);
  const pool = id(r.pool);
  if (!pool || typeof r.slot !== "number") return null;
  const j = obj(r.job);
  const job = typeof j.jobId === "number"
    ? {
      repo: text(j.repo, 140),
      runId: num(j.runId, 0, Number.MAX_SAFE_INTEGER),
      jobId: num(j.jobId, 0, Number.MAX_SAFE_INTEGER),
      name: typeof j.name === "string" ? text(j.name, 200) : null,
    }
    : null;
  return {
    pool,
    slot: num(r.slot, 0, 1000),
    phase: text(r.phase, 24),
    since: num(r.since, 0, 1e14),
    job,
    runner: typeof r.runner === "string" ? text(r.runner, 140) : null,
    cpuPct: numOrNull(r.cpuPct, 0, 1e5),
    rssMb: numOrNull(r.rssMb, 0, 1e8),
    sandbox: typeof r.sandbox === "string" ? text(r.sandbox, 96) : null,
  };
}

function parseMachine(raw: unknown): Machine | null {
  const r = obj(raw);
  const mid = id(r.id);
  if (!mid) return null;
  const i = obj(r.info);
  return {
    id: mid,
    name: text(r.name, 64) || mid,
    info: typeof i.os === "string"
      ? {
        os: text(i.os, 64),
        arch: text(i.arch, 32),
        cpuModel: text(i.cpuModel, 80),
        host: text(i.host, 64),
        bootAt: numOrNull(i.bootAt, 0, 1e14),
      }
      : null,
    source: typeof r.source === "string" ? text(r.source, 16) : null,
    lastAt: numOrNull(r.lastAt, 0, 1e14),
    online: r.online === true,
    latest: r.latest ? parseSample(r.latest) : null,
    pools: list(r.pools, MAX_POOLS).map(obj).filter((p) => id(p.name)).map((p) => ({
      name: id(p.name),
      label: text(p.label, 100),
      slots: num(p.slots, 0, 1000),
      busy: num(p.busy, 0, 1000),
      state: text(p.state, 24),
      reason: text(p.reason, 300),
      use: parseUse(p.use),
      jobs: list(p.jobs, MAX_JOBS).map(parseJob).filter((j): j is MachineJob => j !== null),
    })),
  };
}

/** The service's machines document, or `null`. */
export function parseMachinesDoc(raw: unknown): MachinesDoc | null {
  const r = obj(raw);
  if (!Array.isArray(r.machines)) return null;
  return {
    at: num(r.at, 0, 1e14),
    machines: list(r.machines, MAX_MACHINES).map(parseMachine).filter((m): m is Machine =>
      m !== null
    ),
  };
}

// ---- the live stream (Server-Sent Events) ----

/** One frame of the stream. */
export interface Frame {
  readonly event: string;
  readonly data: string;
}

/** A frame larger than this is dropped (a machines document is tens of KB). */
export const MAX_FRAME = 4 * 1024 * 1024;

/** The complete frames in `buffer`, and what is left of it. */
export function sseFrames(buffer: string): { frames: Frame[]; rest: string } {
  const frames: Frame[] = [];
  let rest = buffer.replace(/\r\n/g, "\n");
  for (;;) {
    const end = rest.indexOf("\n\n");
    if (end < 0) break;
    const block = rest.slice(0, end);
    rest = rest.slice(end + 2);
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length) frames.push({ event, data: data.join("\n") });
  }
  if (rest.length > MAX_FRAME) rest = "";
  return { frames, rest };
}

// ---- the state the page shows ----

/** A machine's recent readings, for the sparklines (parallel arrays, oldest first). */
export interface Trail {
  readonly t: readonly number[];
  readonly cpu: readonly number[];
  /** Memory used, percent of the total. */
  readonly mem: readonly number[];
  /** Swap used, MB. */
  readonly swap: readonly number[];
  readonly rx: readonly number[];
  readonly tx: readonly number[];
}

/** What the page gets. */
export interface MachinesView {
  /** The integration is set up. */
  readonly configured: boolean;
  /** The live stream is connected. */
  readonly connected: boolean;
  /** Why it is not, in plain words; `""` while it is. */
  readonly error: string;
  /** When the newest document or sample arrived (Fleet's clock). */
  readonly at: number | null;
  readonly machines: readonly Machine[];
  readonly trails: Readonly<Record<string, Trail>>;
}

/** The sparklines' span and size. */
export const TRAIL_MS = 15 * 60_000;
export const TRAIL_MAX = 240;

const TRAIL_KEYS = ["t", "cpu", "mem", "swap", "rx", "tx"] as const;
type MutTrail = {
  t: number[];
  cpu: number[];
  mem: number[];
  swap: number[];
  rx: number[];
  tx: number[];
};

/** The stream's state: the newest document, each machine's newest reading and trail. */
export class MachinesState {
  private doc: MachinesDoc | null = null;
  private readonly latest = new Map<string, MachineSample>();
  private readonly trails = new Map<string, MutTrail>();
  private at: number | null = null;
  connected = false;
  error = "";

  /** The newest sample time seen (the `since` of a reconnect). */
  newest(): number {
    let t = 0;
    for (const s of this.latest.values()) t = Math.max(t, s.t);
    return t;
  }

  /** Keep a sample: the newest is the machine's reading; every one joins the trail in time order. */
  private push(host: string, s: MachineSample): boolean {
    const prev = this.latest.get(host);
    if (!prev || s.t > prev.t) this.latest.set(host, s);
    const tr = this.trails.get(host) ?? { t: [], cpu: [], mem: [], swap: [], rx: [], tx: [] };
    this.trails.set(host, tr);
    // Where it goes: the end for a live sample, earlier for a reconnect's replay.
    let i = tr.t.length;
    while (i > 0 && tr.t[i - 1] > s.t) i--;
    if (i > 0 && tr.t[i - 1] === s.t) return false; // seen before
    const newest = Math.max(s.t, tr.t.length ? tr.t[tr.t.length - 1] : 0);
    if (s.t < newest - TRAIL_MS) return !prev || s.t > prev.t;
    const row = {
      t: s.t,
      cpu: s.cpu.pct,
      mem: s.mem.totalMb > 0 ? Math.round(1000 * s.mem.usedMb / s.mem.totalMb) / 10 : 0,
      swap: s.swap.usedMb,
      rx: s.net.rxBps,
      tx: s.net.txBps,
    };
    for (const k of TRAIL_KEYS) tr[k].splice(i, 0, row[k]);
    let drop = Math.max(0, tr.t.length - TRAIL_MAX);
    while (drop < tr.t.length && tr.t[drop] < newest - TRAIL_MS) drop++;
    if (drop > 0) { for (const k of TRAIL_KEYS) tr[k].splice(0, drop); }
    return true;
  }

  /** Apply one frame; `true` when the state changed. */
  apply(frame: Frame, now: number): boolean {
    let data: unknown;
    try {
      data = JSON.parse(frame.data);
    } catch {
      return false;
    }
    if (frame.event === "machines") {
      const doc = parseMachinesDoc(data);
      if (!doc) return false;
      this.doc = doc;
      for (const m of doc.machines) if (m.latest) this.push(m.id, m.latest);
      this.at = now;
      return true;
    }
    if (frame.event === "samples") {
      const r = obj(data);
      const host = id(r.host);
      if (!host) return false;
      let changed = false;
      for (const raw of list(r.samples, 720)) {
        const s = parseSample(raw);
        if (!s) continue;
        changed = this.push(host, s) || changed;
      }
      if (changed) this.at = now;
      return changed;
    }
    return false;
  }

  /** The page's view: each machine with its NEWEST reading (a sample newer than the document's). */
  view(configured: boolean): MachinesView {
    const machines = (this.doc?.machines ?? []).map((m) => {
      const s = this.latest.get(m.id);
      return s && (!m.latest || s.t > m.latest.t) ? { ...m, latest: s, lastAt: s.t } : m;
    });
    const trails: Record<string, Trail> = {};
    for (const [k, v] of this.trails) trails[k] = v;
    return {
      configured,
      connected: this.connected,
      error: this.error,
      at: this.at,
      machines,
      trails,
    };
  }
}

// ---- history ----

export type MachineRange = "1h" | "24h" | "7d";
export const MACHINE_RANGES: readonly MachineRange[] = ["1h", "24h", "7d"];
export const isMachineRange = (v: unknown): v is MachineRange =>
  v === "1h" || v === "24h" || v === "7d";

/** A machine's history, as columns aligned with `t`. */
export interface MachineSeries {
  readonly host: string;
  readonly range: string;
  readonly stepMs: number;
  readonly from: number;
  readonly to: number;
  readonly t: readonly number[];
  readonly cpu: readonly number[];
  readonly cpuMax: readonly number[];
  readonly load1: readonly (number | null)[];
  readonly memUsedMb: readonly number[];
  readonly memTotalMb: number;
  readonly swapUsedMb: readonly number[];
  readonly rxBps: readonly number[];
  readonly txBps: readonly number[];
  readonly tempMaxC: readonly (number | null)[];
  readonly gpu: readonly (number | null)[];
  readonly disk: Readonly<Record<string, readonly (number | null)[]>>;
  readonly pools: Readonly<
    Record<string, { readonly cpuPct: readonly number[]; readonly rssMb: readonly number[] }>
  >;
}

/** The longest history Fleet draws (a 1 h range of 5 s samples is 720 points). */
export const MAX_POINTS = 2000;

/** The service's history answer, or `null`. */
export function parseSeries(raw: unknown): MachineSeries | null {
  const r = obj(raw);
  if (!Array.isArray(r.t) || !id(r.host)) return null;
  const n = Math.min(r.t.length, MAX_POINTS);
  const nums = (v: unknown, max: number): number[] => {
    const a = list(v, n).map((x) => num(x, 0, max));
    while (a.length < n) a.push(0);
    return a;
  };
  const maybe = (v: unknown, max: number): (number | null)[] => {
    const a = list(v, n).map((x) => numOrNull(x, -1e6, max));
    while (a.length < n) a.push(null);
    return a;
  };
  const disk: Record<string, (number | null)[]> = {};
  for (const [k, v] of Object.entries(obj(r.disk)).slice(0, 8)) {
    if (text(k, 32)) disk[text(k, 32)] = maybe(v, 1e7);
  }
  const pools: Record<string, { cpuPct: number[]; rssMb: number[] }> = {};
  for (const [k, v] of Object.entries(obj(r.pools)).slice(0, MAX_POOLS)) {
    if (id(k)) pools[k] = { cpuPct: nums(obj(v).cpuPct, 1e5), rssMb: nums(obj(v).rssMb, 1e8) };
  }
  return {
    host: id(r.host),
    range: text(r.range, 8),
    stepMs: num(r.stepMs, 1000, 24 * 3600_000, 60_000),
    from: num(r.from, 0, 1e14),
    to: num(r.to, 0, 1e14),
    t: list(r.t, n).map((x) => num(x, 0, 1e14)),
    cpu: nums(r.cpu, 100),
    cpuMax: nums(r.cpuMax, 100),
    load1: maybe(r.load1, 1e5),
    memUsedMb: nums(r.memUsedMb, 1e8),
    memTotalMb: num(r.memTotalMb, 0, 1e8),
    swapUsedMb: nums(r.swapUsedMb, 1e8),
    rxBps: nums(r.rxBps, 1e12),
    txBps: nums(r.txBps, 1e12),
    tempMaxC: maybe(r.tempMaxC, 200),
    gpu: maybe(r.gpu, 100),
    disk,
    pools,
  };
}

/** A metric the comparison chart can draw for every machine. */
export type CompareMetric = "cpu" | "mem" | "swap" | "net";
export const COMPARE_METRICS: readonly { key: CompareMetric; label: string; unit: string }[] = [
  { key: "cpu", label: "CPU", unit: "%" },
  { key: "mem", label: "Memory", unit: "%" },
  { key: "swap", label: "Swap", unit: " GB" },
  { key: "net", label: "Network", unit: " MB/s" },
];

/** One machine's values of a metric (in the comparison's unit). */
export function metricValues(s: MachineSeries, metric: CompareMetric): number[] {
  const r1 = (x: number) => Math.round(x * 10) / 10;
  switch (metric) {
    case "cpu":
      return s.cpu.map(r1);
    case "mem":
      return s.memUsedMb.map((v) => (s.memTotalMb > 0 ? r1(100 * v / s.memTotalMb) : 0));
    case "swap":
      return s.swapUsedMb.map((v) => Math.round(v / 102.4) / 10);
    case "net":
      return s.rxBps.map((v, i) => Math.round((v + (s.txBps[i] ?? 0)) / 1e5) / 10);
  }
}

/**
 * Several machines on ONE time axis: their points fall into shared steps (each machine's value in
 * a step it has no point for is `null`, drawn as a gap).
 */
export function alignSeries(
  all: readonly MachineSeries[],
  metric: CompareMetric,
): { times: number[]; stepMs: number; values: Record<string, (number | null)[]> } {
  const have = all.filter((s) => s.t.length > 0);
  if (have.length === 0) return { times: [], stepMs: 60_000, values: {} };
  const from = Math.min(...have.map((s) => s.t[0]));
  const to = Math.max(...have.map((s) => s.t[s.t.length - 1]));
  // At most ~240 steps, never finer than the coarsest series.
  const stepMs = Math.max(
    ...have.map((s) => s.stepMs),
    Math.ceil((to - from + 1) / 240 / 1000) * 1000,
  );
  const n = Math.max(1, Math.floor((to - from) / stepMs) + 1);
  const times = Array.from({ length: n }, (_, i) => from + i * stepMs);
  const values: Record<string, (number | null)[]> = {};
  for (const s of all) {
    const sum = new Array<number>(n).fill(0), cnt = new Array<number>(n).fill(0);
    const vs = metricValues(s, metric);
    s.t.forEach((t, i) => {
      const k = Math.min(n - 1, Math.max(0, Math.floor((t - from) / stepMs)));
      sum[k] += vs[i];
      cnt[k]++;
    });
    values[s.host] = sum.map((v, i) => (cnt[i] ? Math.round(10 * v / cnt[i]) / 10 : null));
  }
  return { times, stepMs, values };
}

// ---- text ----

/** A byte rate in plain words ("1.2 MB/s"). */
export function rateText(bps: number): string {
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(bps >= 1e7 ? 0 : 1)} MB/s`;
  if (bps >= 1e3) return `${Math.round(bps / 1e3)} kB/s`;
  return `${Math.round(bps)} B/s`;
}

/** Megabytes as GB with one decimal ("14.3 GB"), or MB below one. */
export function memText(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

// ---- the agents' file ----

/** The agents' machines document: the latest per-machine stats and per-job usage, snake_case. */
export function agentMachines(view: MachinesView, now: number): Record<string, unknown> {
  return {
    v: 1,
    written_at: Math.round(now / 1000),
    configured: view.configured,
    connected: view.connected,
    error: view.error || null,
    updated_at: view.at === null ? null : Math.round(view.at / 1000),
    machines: view.machines.map((m) => {
      const s = m.latest;
      return {
        id: m.id,
        name: m.name,
        online: m.online,
        source: m.source,
        last_sample_at: m.lastAt === null ? null : Math.round(m.lastAt / 1000),
        os: m.info?.os ?? null,
        arch: m.info?.arch ?? null,
        cpu_model: m.info?.cpuModel ?? null,
        boot_at: m.info?.bootAt ? Math.round(m.info.bootAt / 1000) : null,
        stats: s
          ? {
            cpu_pct: s.cpu.pct,
            cores: s.cpu.cores.length,
            per_core_pct: s.cpu.cores,
            load: s.cpu.load,
            mem_used_mb: s.mem.usedMb,
            mem_available_mb: s.mem.availMb,
            mem_total_mb: s.mem.totalMb,
            mem_pressure_pct: s.mem.pressure,
            swap_used_mb: s.swap.usedMb,
            swap_total_mb: s.swap.totalMb,
            disk: s.disk.map((d) => ({
              name: d.name,
              mount: d.mount,
              free_gb: d.freeGb,
              total_gb: d.totalGb,
            })),
            net_rx_bps: s.net.rxBps,
            net_tx_bps: s.net.txBps,
            temps_c: Object.fromEntries(s.temps.map((x) => [x.name, x.c])),
            gpu_pct: s.gpu?.pct ?? null,
            sandboxes: s.sandboxes.map((b) => ({
              kind: b.kind,
              name: b.name,
              cpu_pct: b.cpuPct,
              rss_mb: b.rssMb,
            })),
          }
          : null,
        pools: m.pools.map((p) => ({
          pool: p.name,
          label: p.label,
          slots: p.slots,
          busy: p.busy,
          state: p.state,
          reason: p.reason || null,
          cpu_pct: p.use?.cpuPct ?? null,
          rss_mb: p.use?.rssMb ?? null,
          jobs: p.jobs.map((j) => ({
            slot: j.slot,
            phase: j.phase,
            since: j.since ? Math.round(j.since / 1000) : null,
            repo: j.job?.repo ?? null,
            run_id: j.job?.runId ?? null,
            job_id: j.job?.jobId ?? null,
            job: j.job?.name ?? null,
            runner: j.runner,
            cpu_pct: j.cpuPct,
            rss_mb: j.rssMb,
            sandbox: j.sandbox,
          })),
        })),
      };
    }),
  };
}
