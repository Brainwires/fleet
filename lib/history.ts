// Usage history per pool: a compact, bounded time series Fleet keeps in its data folder
// (`fleet-history.json`) for the pool detail screen and the `fleet_pool_history` MCP tool. Pure: no
// I/O, no settings, no imports beyond types, so the read-only MCP server computes the same answers
// from the same file.
//
// Two tiers per series, both updated as data arrives (no later downsampling pass):
// - fine: 1-minute buckets, kept 24 h;
// - coarse: 15-minute buckets, kept 30 days.
// A bucket holds pool samples (busy slots, capacity, queue length, the oldest wait, paused /
// unhealthy), summed so they average over any span, and the jobs that started and finished in it
// (by conclusion, billable-style minutes, a fixed log-scale duration histogram, queue waits).
// Series are keyed by pool id; GitHub-hosted usage is `github` plus `github:<image>` per runs-on
// image. Runners themselves are ephemeral (a new name per job), so nothing is keyed by runner.

/** The fine tier's bucket. */
export const FINE_MS = 60_000;
/** The fine tier's retention. */
export const FINE_KEEP_MS = 24 * 60 * 60_000;
/** The coarse tier's bucket. */
export const COARSE_MS = 15 * 60_000;
/** The coarse tier's retention. */
export const COARSE_KEEP_MS = 30 * 24 * 60 * 60_000;
/** Samples of one series closer together than this are dropped (polls and webhooks both sample). */
export const SAMPLE_MIN_GAP_MS = 10_000;
/** Job records kept per pool (the detail's recent-jobs table). */
export const JOBS_PER_POOL = 200;
/** Series kept: pools and GitHub images (the rest are dropped, least recently used first). */
export const MAX_SERIES = 64;
/** GitHub image series (`github:<image>`) kept. */
export const MAX_IMAGES = 16;
/** Job ids remembered for de-duplication. */
const SEEN_MAX = 20_000;

/**
 * The duration histogram's upper bin edges (ms): `<30s`, `30s–1m`, … `3h–6h`, then `≥6h`. Fixed, so
 * buckets merge by adding counts; percentiles interpolate inside a bin.
 */
export const DURATION_EDGES_MS: readonly number[] = [
  30e3,
  60e3,
  120e3,
  180e3,
  300e3,
  450e3,
  600e3,
  900e3,
  1200e3,
  1800e3,
  2700e3,
  3600e3,
  5400e3,
  7200e3,
  10800e3,
  21600e3,
];
const BINS = DURATION_EDGES_MS.length + 1;

/** The ranges the detail screen and the MCP tool offer. */
export type HistoryRange = "1h" | "24h" | "7d" | "30d";
export const HISTORY_RANGES: readonly HistoryRange[] = ["1h", "24h", "7d", "30d"];

/** Each range's span, tier and point step (60, 96, 168 and 120 points). */
export const RANGE_SPEC: Readonly<
  Record<HistoryRange, { spanMs: number; tier: "fine" | "coarse"; stepMs: number }>
> = {
  "1h": { spanMs: 3600_000, tier: "fine", stepMs: FINE_MS },
  "24h": { spanMs: 24 * 3600_000, tier: "coarse", stepMs: COARSE_MS },
  "7d": { spanMs: 7 * 24 * 3600_000, tier: "coarse", stepMs: 3600_000 },
  "30d": { spanMs: 30 * 24 * 3600_000, tier: "coarse", stepMs: 6 * 3600_000 },
};

/** One bucket (fields are omitted when zero in the file). */
export interface Bucket {
  /** The bucket's start (epoch ms, a multiple of its tier's size). */
  t: number;
  /** Pool samples taken in it. */
  n: number;
  /** Busy slots, summed over the samples. */
  busy: number;
  busyMax: number;
  /** Capacity: the most slots seen (0: unknown). */
  slots: number;
  /** Queued jobs, summed over the samples. */
  queued: number;
  queuedMax: number;
  /** The longest oldest-queued wait seen (ms). */
  waitMax: number;
  /** Samples with the pool paused / unhealthy. */
  paused: number;
  unhealthy: number;
  /** Jobs that started in it, and their queue waits (sum, ms). */
  started: number;
  waitSum: number;
  /** Jobs that finished in it, by conclusion. */
  ok: number;
  failed: number;
  cancelled: number;
  other: number;
  /** Billable-style minutes of the jobs that finished in it (each job rounded up). */
  minutes: number;
  /** Finished jobs' durations, by {@linkcode DURATION_EDGES_MS} bin (absent: none). */
  hist?: number[];
}

/** One series: its two tiers, oldest first. */
export interface Series {
  fine: Bucket[];
  coarse: Bucket[];
  /** The last sample's time (the gap check). */
  lastSample?: number;
}

/** A finished job, as the recent-jobs table and the counts see it. */
export interface JobRecord {
  readonly id: number;
  readonly runId: number;
  readonly repo: string;
  readonly workflow: string;
  readonly name: string;
  /** The pool id, or `github`. */
  readonly pool: string;
  /** GitHub-hosted: the runs-on image (`ubuntu-24.04`). */
  readonly image?: string | null;
  readonly runner: string | null;
  readonly created: number | null;
  readonly started: number | null;
  readonly completed: number;
  readonly conclusion: string;
  readonly url: string | null;
}

/** One pool sample (a pool card's numbers at a moment). */
export interface PoolSample {
  readonly key: string;
  readonly busy: number;
  readonly slots: number | null;
  readonly queued: number;
  /** The oldest queued job's wait now (ms), 0 with nothing queued. */
  readonly waitMs: number;
  readonly paused?: boolean;
  readonly unhealthy?: boolean;
}

/** The history file's document. */
export interface HistoryDoc {
  readonly v: 1;
  readonly savedAt: number;
  /** When the first-run back-fill ran (from the journal and the webhook spool). */
  readonly backfilledAt?: number | null;
  readonly series: Record<string, unknown>;
  readonly jobs: Record<string, unknown>;
}

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

/** A conclusion's counter. */
export function conclusionClass(c: string): "ok" | "failed" | "cancelled" | "other" {
  if (c === "success") return "ok";
  if (FAILED.has(c)) return "failed";
  if (c === "cancelled") return "cancelled";
  return "other";
}

/** The histogram bin of a duration. */
export function durationBin(ms: number): number {
  for (let i = 0; i < DURATION_EDGES_MS.length; i++) if (ms < DURATION_EDGES_MS[i]) return i;
  return DURATION_EDGES_MS.length;
}

/** A bin's span `[lo, hi)` (the last bin's `hi` is twice its `lo`, for interpolation). */
export function binSpan(i: number): [number, number] {
  const lo = i === 0 ? 0 : DURATION_EDGES_MS[i - 1];
  const hi = i < DURATION_EDGES_MS.length ? DURATION_EDGES_MS[i] : lo * 2;
  return [lo, hi];
}

/**
 * The `q` quantile (0–1) of a histogram, linearly interpolated inside its bin; `null` when empty.
 * The answer is within one bin of the exact value (bins are 30 s wide at the short end).
 */
export function histPercentile(counts: readonly number[], q: number): number | null {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  const want = Math.min(Math.max(q, 0), 1) * total;
  let cum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i] ?? 0;
    if (c === 0) continue;
    if (cum + c >= want) {
      const [lo, hi] = binSpan(i);
      return Math.round(lo + ((want - cum) / c) * (hi - lo));
    }
    cum += c;
  }
  return binSpan(counts.length - 1)[1];
}

/** The `q` quantile of plain values (nearest rank); `null` when empty. For tests and small sets. */
export function percentile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1));
  return s[i];
}

function emptyBucket(t: number): Bucket {
  return {
    t,
    n: 0,
    busy: 0,
    busyMax: 0,
    slots: 0,
    queued: 0,
    queuedMax: 0,
    waitMax: 0,
    paused: 0,
    unhealthy: 0,
    started: 0,
    waitSum: 0,
    ok: 0,
    failed: 0,
    cancelled: 0,
    other: 0,
    minutes: 0,
  };
}

const NUM_FIELDS = [
  "n",
  "busy",
  "busyMax",
  "slots",
  "queued",
  "queuedMax",
  "waitMax",
  "paused",
  "unhealthy",
  "started",
  "waitSum",
  "ok",
  "failed",
  "cancelled",
  "other",
  "minutes",
] as const;
const MAX_FIELDS = new Set(["busyMax", "slots", "queuedMax", "waitMax"]);

/** Add `b` into `into` (sums add, maxima take the larger, histograms add). */
export function mergeBucket(into: Bucket, b: Bucket): Bucket {
  for (const f of NUM_FIELDS) {
    into[f] = MAX_FIELDS.has(f) ? Math.max(into[f], b[f]) : into[f] + b[f];
  }
  if (b.hist) {
    const h = into.hist ?? new Array(BINS).fill(0);
    for (let i = 0; i < BINS; i++) h[i] += b.hist[i] ?? 0;
    into.hist = h;
  }
  return into;
}

/** A bucket for the file: zero fields left out. */
function compact(b: Bucket): Record<string, number | number[]> {
  const out: Record<string, number | number[]> = { t: b.t };
  for (const f of NUM_FIELDS) if (b[f] !== 0) out[f] = round(b[f]);
  if (b.hist && b.hist.some((x) => x > 0)) out.hist = b.hist;
  return out;
}

const round = (x: number) => Math.round(x * 1000) / 1000;
const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** A bucket from the file (garbage gives `null`). */
function readBucket(raw: unknown, size: number): Bucket | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const t = finite(r.t);
  if (t <= 0 || t % size !== 0) return null;
  const b = emptyBucket(t);
  for (const f of NUM_FIELDS) b[f] = Math.max(0, finite(r[f]));
  if (Array.isArray(r.hist)) {
    b.hist = Array.from(
      { length: BINS },
      (_, i) => Math.max(0, finite(r.hist && (r.hist as unknown[])[i])),
    );
  }
  return b;
}

function readJob(raw: unknown): JobRecord | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const opt = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  if (typeof r.id !== "number" || typeof r.completed !== "number" || !str(r.pool)) return null;
  return {
    id: r.id,
    runId: finite(r.runId),
    repo: str(r.repo),
    workflow: str(r.workflow),
    name: str(r.name),
    pool: str(r.pool),
    image: typeof r.image === "string" ? r.image : null,
    runner: typeof r.runner === "string" ? r.runner : null,
    created: opt(r.created),
    started: opt(r.started),
    completed: r.completed,
    conclusion: str(r.conclusion) || "unknown",
    url: typeof r.url === "string" && r.url.startsWith("https://github.com/") ? r.url : null,
  };
}

/** The series key of a GitHub image. */
export const imageKey = (image: string) => `github:${image}`;

/** The store. */
export class HistoryStore {
  #series = new Map<string, Series>();
  #jobs = new Map<string, JobRecord[]>();
  #seen = new Set<number>();
  backfilledAt: number | null = null;
  /** Changed since the last `toJSON()` (the writer saves only then). */
  dirty = false;

  /** The series keys held. */
  keys(): string[] {
    return [...this.#series.keys()];
  }

  /** A series (`undefined` when none). */
  series(key: string): Series | undefined {
    return this.#series.get(key);
  }

  /** A series, created empty when missing. */
  ensure(key: string): Series {
    return this.#get(key);
  }

  #get(key: string): Series {
    let s = this.#series.get(key);
    if (!s) {
      s = { fine: [], coarse: [] };
      this.#series.set(key, s);
      this.#bound(key);
    }
    return s;
  }

  /** Keep at most MAX_SERIES (and MAX_IMAGES image series), dropping the least recently sampled. */
  #bound(added: string): void {
    const by = (all: string[], max: number) => {
      if (all.length <= max) return;
      // The series just added is the newest, whatever it holds yet: it stays.
      const keys = all.filter((k) => k !== added);
      const keep = all.length === keys.length ? max : max - 1;
      const order = keys.sort((a, b) =>
        (this.#series.get(a)?.lastSample ?? 0) - (this.#series.get(b)?.lastSample ?? 0)
      );
      for (const k of order.slice(0, keys.length - keep)) this.#series.delete(k);
    };
    by(this.keys().filter((k) => k.startsWith("github:")), MAX_IMAGES);
    by(this.keys(), MAX_SERIES);
  }

  /** The bucket of `at` in a tier, created in time order; `null` when outside the retention. */
  #bucket(s: Series, tier: "fine" | "coarse", at: number, now: number): Bucket | null {
    const size = tier === "fine" ? FINE_MS : COARSE_MS;
    const keep = tier === "fine" ? FINE_KEEP_MS : COARSE_KEEP_MS;
    if (at < now - keep || at > now + size) return null;
    const t = Math.floor(at / size) * size;
    const list = s[tier];
    // Usually the newest bucket; otherwise a binary search keeps the list sorted.
    const last = list[list.length - 1];
    if (last && last.t === t) return last;
    if (!last || last.t < t) {
      const b = emptyBucket(t);
      list.push(b);
      return b;
    }
    let lo = 0;
    let hi = list.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    if (list[lo]?.t === t) return list[lo];
    const b = emptyBucket(t);
    list.splice(lo, 0, b);
    return b;
  }

  /** Apply `fn` to the bucket of `at` in both tiers. */
  #both(key: string, at: number, now: number, fn: (b: Bucket) => void): void {
    const s = this.#get(key);
    for (const tier of ["fine", "coarse"] as const) {
      const b = this.#bucket(s, tier, at, now);
      if (b) fn(b);
    }
    this.dirty = true;
  }

  /** Record pool samples taken at `at` (each series at most once per SAMPLE_MIN_GAP_MS). */
  sample(at: number, samples: readonly PoolSample[]): void {
    for (const p of samples) {
      const s = this.#get(p.key);
      if (s.lastSample !== undefined && at - s.lastSample < SAMPLE_MIN_GAP_MS) continue;
      s.lastSample = at;
      this.#both(p.key, at, at, (b) => {
        b.n++;
        b.busy += p.busy;
        b.busyMax = Math.max(b.busyMax, p.busy);
        if (p.slots !== null) b.slots = Math.max(b.slots, p.slots);
        b.queued += p.queued;
        b.queuedMax = Math.max(b.queuedMax, p.queued);
        b.waitMax = Math.max(b.waitMax, p.waitMs);
        if (p.paused) b.paused++;
        if (p.unhealthy) b.unhealthy++;
      });
    }
  }

  /**
   * Record a finished job, once per job id: its start (with its queue wait) in the bucket it
   * started, its end (conclusion, duration, minutes) in the bucket it finished; GitHub-hosted jobs
   * also count in their image's series. Returns whether it was new.
   */
  jobDone(rec: JobRecord, now: number): boolean {
    if (this.#seen.has(rec.id)) return false;
    this.#seen.add(rec.id);
    if (this.#seen.size > SEEN_MAX) this.#seen = new Set([...this.#seen].slice(-SEEN_MAX / 2));
    const keys = [rec.pool];
    if (rec.pool === "github" && rec.image) keys.push(imageKey(rec.image));
    const dur = rec.started !== null && rec.completed >= rec.started
      ? rec.completed - rec.started
      : null;
    const cls = conclusionClass(rec.conclusion);
    for (const key of keys) {
      if (rec.started !== null) {
        this.#both(key, rec.started, now, (b) => {
          b.started++;
          if (rec.created !== null && rec.started! >= rec.created) {
            b.waitSum += rec.started! - rec.created;
          }
        });
      }
      this.#both(key, rec.completed, now, (b) => {
        b[cls]++;
        if (dur !== null) {
          const h = b.hist ?? new Array(BINS).fill(0);
          h[durationBin(dur)]++;
          b.hist = h;
          b.minutes += Math.max(1, Math.ceil(dur / 60_000));
        }
      });
    }
    const list = this.#jobs.get(rec.pool) ?? [];
    list.push(rec);
    list.sort((a, b) => a.completed - b.completed);
    if (list.length > JOBS_PER_POOL) list.splice(0, list.length - JOBS_PER_POOL);
    this.#jobs.set(rec.pool, list);
    this.dirty = true;
    return true;
  }

  /** A pool's recent jobs, newest first (`pools`: several, merged). */
  jobs(pools: readonly string[], limit = 50): JobRecord[] {
    return pools.flatMap((p) => this.#jobs.get(p) ?? [])
      .sort((a, b) => b.completed - a.completed)
      .slice(0, limit);
  }

  /** Every job record held. */
  allJobs(): JobRecord[] {
    return [...this.#jobs.values()].flat();
  }

  /** A job record by id (any pool), or `undefined`. */
  job(id: number): JobRecord | undefined {
    for (const list of this.#jobs.values()) {
      const j = list.find((r) => r.id === id);
      if (j) return j;
    }
    return undefined;
  }

  /** Drop buckets past their tier's retention. */
  prune(now: number): void {
    for (const s of this.#series.values()) {
      const f = s.fine.findIndex((b) => b.t >= now - FINE_KEEP_MS);
      s.fine = f < 0 ? [] : s.fine.slice(f);
      const c = s.coarse.findIndex((b) => b.t >= now - COARSE_KEEP_MS);
      s.coarse = c < 0 ? [] : s.coarse.slice(c);
    }
    for (const [k, s] of this.#series) {
      if (s.fine.length === 0 && s.coarse.length === 0) this.#series.delete(k);
    }
    for (const [k, list] of this.#jobs) {
      const kept = list.filter((j) => j.completed >= now - COARSE_KEEP_MS);
      if (kept.length) this.#jobs.set(k, kept);
      else this.#jobs.delete(k);
    }
  }

  /** The file's document (pruned first). */
  toJSON(now: number = Date.now()): HistoryDoc {
    this.prune(now);
    this.dirty = false;
    const series: Record<string, unknown> = {};
    for (const [k, s] of this.#series) {
      series[k] = {
        fine: s.fine.map(compact),
        coarse: s.coarse.map(compact),
        ...(s.lastSample !== undefined ? { lastSample: s.lastSample } : {}),
      };
    }
    return {
      v: 1,
      savedAt: now,
      backfilledAt: this.backfilledAt,
      series,
      jobs: Object.fromEntries(this.#jobs),
    };
  }

  /** Restore from the file (garbage gives an empty store; `null` means there was no file). */
  static from(raw: unknown): HistoryStore {
    const st = new HistoryStore();
    const d = raw as Partial<HistoryDoc> | null;
    if (!d || d.v !== 1 || typeof d.series !== "object" || d.series === null) return st;
    st.backfilledAt = typeof d.backfilledAt === "number" ? d.backfilledAt : null;
    for (const [k, v] of Object.entries(d.series).slice(0, MAX_SERIES)) {
      if (typeof k !== "string" || k.length > 120) continue;
      const s = v as { fine?: unknown; coarse?: unknown; lastSample?: unknown };
      const read = (list: unknown, size: number) =>
        (Array.isArray(list) ? list : [])
          .map((b) => readBucket(b, size))
          .filter((b): b is Bucket => b !== null)
          .sort((a, b) => a.t - b.t)
          .filter((b, i, arr) => i === 0 || arr[i - 1].t !== b.t);
      st.#series.set(k, {
        fine: read(s.fine, FINE_MS),
        coarse: read(s.coarse, COARSE_MS),
        ...(typeof s.lastSample === "number" ? { lastSample: s.lastSample } : {}),
      });
    }
    if (typeof d.jobs === "object" && d.jobs !== null) {
      for (const [k, list] of Object.entries(d.jobs)) {
        if (!Array.isArray(list)) continue;
        const jobs = list.map(readJob).filter((j): j is JobRecord => j !== null)
          .slice(-JOBS_PER_POOL);
        if (jobs.length) st.#jobs.set(k, jobs);
        for (const j of jobs) st.#seen.add(j.id);
      }
    }
    return st;
  }
}

// ---- queries ----

/** One point of a series over a range (sample fields `null` where nothing was sampled). */
export interface HistoryPoint {
  /** The point's start (epoch ms). */
  readonly t: number;
  /** Average busy slots. */
  readonly busy: number | null;
  readonly busyMax: number | null;
  /** Capacity (`null`: unknown, or GitHub-hosted). */
  readonly slots: number | null;
  /** Average busy / capacity, 0–1. */
  readonly utilization: number | null;
  /** Average queued jobs. */
  readonly queued: number | null;
  readonly queuedMax: number | null;
  /** The longest oldest-queued wait (ms). */
  readonly waitMax: number | null;
  /** Share of the samples paused / unhealthy (0–1). */
  readonly paused: number | null;
  readonly unhealthy: number | null;
  readonly started: number;
  readonly ok: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly other: number;
  readonly minutes: number;
  /** Median and p90 duration of the jobs that finished in it (ms). */
  readonly p50: number | null;
  readonly p90: number | null;
}

/** A series over a range. */
export interface PoolHistory {
  readonly key: string;
  readonly range: HistoryRange;
  readonly from: number;
  readonly to: number;
  readonly stepMs: number;
  readonly points: readonly HistoryPoint[];
  readonly totals: {
    readonly started: number;
    readonly finished: number;
    readonly ok: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly other: number;
    readonly minutes: number;
    readonly p50: number | null;
    readonly p90: number | null;
    /** Average busy / capacity over the sampled time (0–1; `null` without a capacity). */
    readonly utilization: number | null;
    /** Busy vs idle: the share of slot-time busy (= utilization), and idle (1 − it). */
    readonly busyShare: number | null;
    readonly idleShare: number | null;
    readonly peakBusy: number | null;
    readonly peakQueued: number | null;
    readonly maxWaitMs: number | null;
    /** Average queue wait of the jobs that started (ms). */
    readonly avgWaitMs: number | null;
    /** Points with samples, of all points (data coverage). */
    readonly sampled: number;
  };
  /** The range's duration histogram: bin upper edges (ms; the last bin is open) and counts. */
  readonly histogram: { readonly edgesMs: readonly number[]; readonly counts: readonly number[] };
}

/** Merge a tier's buckets into points of `stepMs` over `[from, to)`. */
function aggregate(list: readonly Bucket[], from: number, to: number, stepMs: number): Bucket[] {
  const out: Bucket[] = [];
  for (let t = from; t < to; t += stepMs) out.push(emptyBucket(t));
  for (const b of list) {
    if (b.t < from || b.t >= to) continue;
    mergeBucket(out[Math.floor((b.t - from) / stepMs)], b);
  }
  return out;
}

/** The point of a merged bucket. */
function point(b: Bucket): HistoryPoint {
  const has = b.n > 0;
  const avg = (x: number) => (has ? round(x / b.n) : null);
  const slots = has && b.slots > 0 ? b.slots : null;
  const busy = avg(b.busy);
  return {
    t: b.t,
    busy,
    busyMax: has ? b.busyMax : null,
    slots,
    utilization: busy !== null && slots ? round(Math.min(1, busy / slots)) : null,
    queued: avg(b.queued),
    queuedMax: has ? b.queuedMax : null,
    waitMax: has ? b.waitMax : null,
    paused: avg(b.paused),
    unhealthy: avg(b.unhealthy),
    started: b.started,
    ok: b.ok,
    failed: b.failed,
    cancelled: b.cancelled,
    other: b.other,
    minutes: b.minutes,
    p50: b.hist ? histPercentile(b.hist, 0.5) : null,
    p90: b.hist ? histPercentile(b.hist, 0.9) : null,
  };
}

/**
 * Several series as one (a shared machine's pools): per point, busy, capacity and queue add up;
 * waits take the longest; counts and histograms add. Each member is averaged first, so members
 * sampled at different rates still add as slots.
 */
function combine(lists: readonly Bucket[][]): Bucket[] {
  if (lists.length === 1) return lists[0];
  return lists[0].map((_, i) => {
    const out = emptyBucket(lists[0][i].t);
    let any = false;
    for (const l of lists) {
      const b = l[i];
      if (b.n > 0) {
        any = true;
        out.busy += b.busy / b.n;
        out.busyMax += b.busyMax;
        out.slots += b.slots;
        out.queued += b.queued / b.n;
        out.queuedMax += b.queuedMax;
        out.waitMax = Math.max(out.waitMax, b.waitMax);
        out.paused += b.paused / b.n / lists.length;
        out.unhealthy += b.unhealthy / b.n / lists.length;
      }
      for (
        const f of ["started", "waitSum", "ok", "failed", "cancelled", "other", "minutes"] as const
      ) {
        out[f] += b[f];
      }
      if (b.hist) {
        const h = out.hist ?? new Array(BINS).fill(0);
        for (let k = 0; k < BINS; k++) h[k] += b.hist[k] ?? 0;
        out.hist = h;
      }
    }
    out.n = any ? 1 : 0;
    return out;
  });
}

/**
 * A series (or several combined) over a range ending at `now`: the points, the totals and the
 * range's duration histogram. Unknown keys give an all-empty history (the empty state).
 */
export function poolHistory(
  store: HistoryStore,
  keys: string | readonly string[],
  range: HistoryRange,
  now: number,
): PoolHistory {
  const list = typeof keys === "string" ? [keys] : [...keys];
  const spec = RANGE_SPEC[range];
  const size = spec.tier === "fine" ? FINE_MS : COARSE_MS;
  const to = Math.floor(now / size) * size + size;
  const from = to - Math.ceil(spec.spanMs / spec.stepMs) * spec.stepMs;
  const merged = combine(
    list.map((k) => aggregate(store.series(k)?.[spec.tier] ?? [], from, to, spec.stepMs)),
  );
  const points = merged.map(point);
  const all = merged.reduce((acc, b) => mergeBucket(acc, b), emptyBucket(from));
  const sampled = merged.filter((b) => b.n > 0);
  const slotSum = sampled.reduce((a, b) => a + (b.slots > 0 ? b.slots : 0), 0);
  const withSlots = sampled.filter((b) => b.slots > 0);
  const util = withSlots.length && slotSum > 0
    ? round(Math.min(1, withSlots.reduce((a, b) => a + b.busy / b.n, 0) / slotSum))
    : null;
  const counts = all.hist ?? new Array(BINS).fill(0);
  const finished = all.ok + all.failed + all.cancelled + all.other;
  return {
    key: list.join("+"),
    range,
    from,
    to,
    stepMs: spec.stepMs,
    points,
    totals: {
      started: all.started,
      finished,
      ok: all.ok,
      failed: all.failed,
      cancelled: all.cancelled,
      other: all.other,
      minutes: all.minutes,
      p50: histPercentile(counts, 0.5),
      p90: histPercentile(counts, 0.9),
      utilization: util,
      busyShare: util,
      idleShare: util === null ? null : round(1 - util),
      peakBusy: sampled.length ? Math.max(...sampled.map((b) => b.busyMax)) : null,
      peakQueued: sampled.length ? Math.max(...sampled.map((b) => b.queuedMax)) : null,
      maxWaitMs: sampled.length ? Math.max(...sampled.map((b) => b.waitMax)) : null,
      avgWaitMs: all.started > 0 && all.waitSum > 0 ? Math.round(all.waitSum / all.started) : null,
      sampled: sampled.length,
    },
    histogram: { edgesMs: DURATION_EDGES_MS, counts },
  };
}

// ---- back-fill ----

/** A job's life as the journal and the webhook spool tell it (times epoch ms). */
export interface JobInterval {
  readonly id: number;
  readonly runId: number;
  readonly repo: string;
  readonly workflow: string;
  readonly name: string;
  readonly pool: string;
  readonly image?: string | null;
  readonly runner: string | null;
  readonly created: number | null;
  readonly started: number | null;
  readonly completed: number | null;
  readonly conclusion: string | null;
  readonly url: string | null;
}

/**
 * Fill an empty store from what happened before it existed: each pool's busy slots and queue over
 * time from the jobs' intervals (time-weighted per bucket, one synthetic sample each), and every
 * finished job's counts and record. `slotsOf` gives a pool's capacity now (the closest guess for
 * the past). Buckets from the first interval to `now` are filled, idle ones as zero.
 */
export function backfillHistory(
  store: HistoryStore,
  jobs: readonly JobInterval[],
  slotsOf: (pool: string) => number | null,
  now: number,
): void {
  const byPool = new Map<string, JobInterval[]>();
  for (const j of jobs) {
    const list = byPool.get(j.pool) ?? [];
    list.push(j);
    byPool.set(j.pool, list);
    if (j.pool === "github" && j.image) {
      const k = imageKey(j.image);
      byPool.set(k, [...(byPool.get(k) ?? []), j]);
    }
  }
  for (const [key, list] of byPool) {
    const starts = list.map((j) => j.created ?? j.started ?? j.completed ?? now);
    const first = Math.max(Math.min(...starts), now - COARSE_KEEP_MS);
    const series = store.ensure(key);
    const slots = key.startsWith("github") ? null : slotsOf(key);
    for (const tier of ["fine", "coarse"] as const) {
      const size = tier === "fine" ? FINE_MS : COARSE_MS;
      const keep = tier === "fine" ? FINE_KEEP_MS : COARSE_KEEP_MS;
      const lo = Math.floor(Math.max(first, now - keep) / size) * size;
      const hi = Math.floor(now / size) * size;
      const nb = Math.max(0, Math.floor((hi - lo) / size) + 1);
      if (nb === 0) continue;
      const busy = new Float64Array(nb);
      const queued = new Float64Array(nb);
      const busyMax = new Uint16Array(nb);
      const queuedMax = new Uint16Array(nb);
      const waitMax = new Float64Array(nb);
      /** Time-weighted occupancy per bucket, and the most at once (a sweep over the edges). */
      const spread = (spans: [number, number][], into: Float64Array, max: Uint16Array) => {
        const edges: [number, number][] = [];
        for (const [a, b] of spans) {
          const s0 = Math.max(a, lo);
          const e0 = Math.min(b, hi + size);
          if (e0 <= s0) continue;
          edges.push([s0, 1], [e0, -1]);
          for (let i = Math.floor((s0 - lo) / size); i < nb; i++) {
            const bs = lo + i * size;
            if (bs >= e0) break;
            const overlap = Math.min(bs + size, e0) - Math.max(bs, s0);
            if (overlap > 0) into[i] += overlap / size;
          }
        }
        edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
        let level = 0;
        for (const [t, d] of edges) {
          level += d;
          const i = Math.min(nb - 1, Math.floor((t - lo) / size));
          if (d > 0 && i >= 0) max[i] = Math.max(max[i], level);
        }
        // A span that covers a whole bucket without an edge in it still counts there.
        let cur = 0;
        let k = 0;
        for (let i = 0; i < nb; i++) {
          const bs = lo + i * size;
          while (k < edges.length && edges[k][0] <= bs) cur += edges[k++][1];
          max[i] = Math.max(max[i], cur);
        }
      };
      const busySpans: [number, number][] = [];
      const queueSpans: [number, number][] = [];
      for (const j of list) {
        const end = j.completed ?? now;
        if (j.started !== null) busySpans.push([j.started, end]);
        if (j.created !== null) {
          const qEnd = j.started ?? j.completed ?? now;
          queueSpans.push([j.created, qEnd]);
          // The oldest wait at each bucket's end while it waited.
          for (let i = Math.max(0, Math.floor((j.created - lo) / size)); i < nb; i++) {
            const be = lo + (i + 1) * size;
            const at = Math.min(be, qEnd);
            if (lo + i * size >= qEnd) break;
            waitMax[i] = Math.max(waitMax[i], at - j.created);
          }
        }
      }
      spread(busySpans, busy, busyMax);
      spread(queueSpans, queued, queuedMax);
      const target = series[tier];
      const have = new Map(target.map((b) => [b.t, b]));
      for (let i = 0; i < nb; i++) {
        const t = lo + i * size;
        let b = have.get(t);
        if (!b) {
          b = emptyBucket(t);
          target.push(b);
        }
        if (b.n > 0) continue; // live samples win
        b.n = 1;
        b.busy = round(busy[i]);
        b.busyMax = busyMax[i];
        b.slots = slots ?? 0;
        b.queued = round(queued[i]);
        b.queuedMax = queuedMax[i];
        b.waitMax = waitMax[i];
      }
      target.sort((a, b) => a.t - b.t);
    }
  }
  for (const j of jobs) {
    if (j.completed === null || j.conclusion === null || j.conclusion === "skipped") continue;
    store.jobDone({
      id: j.id,
      runId: j.runId,
      repo: j.repo,
      workflow: j.workflow,
      name: j.name,
      pool: j.pool,
      image: j.image ?? null,
      runner: j.runner,
      created: j.created,
      started: j.started,
      completed: j.completed,
      conclusion: j.conclusion,
      url: j.url,
    }, now);
  }
  store.backfilledAt = now;
  store.dirty = true;
}
