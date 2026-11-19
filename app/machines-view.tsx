"use client";
// The Machines screen: one card per PHYSICAL machine (settings `integrations.machines`), its pools
// nested inside with the jobs on them and what each uses, live sparklines (CPU, memory, swap,
// network; hover for the value), disk bars, and a history per machine over 1 h / 24 h / 7 d drawn
// with the pool detail's charts. "Compare" puts every machine on one chart. A second tab holds the
// routing rules' form (app/routing-form.tsx) when the scheduler has a routing helper here.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "denext";
import { type ChartSeries, TimeChart } from "./charts.tsx";
import {
  alignSeries,
  COMPARE_METRICS,
  type CompareMetric,
  type Machine,
  type MachineJob,
  type MachinePool,
  type MachineRange,
  type MachineSample,
  type MachineSeries,
  type MachinesView as View,
  memText,
  rateText,
  type Trail,
} from "../lib/machines.ts";
import { type RoutingApi, RoutingForm } from "./routing-form.tsx";

/** What the screen needs from the backend. */
export interface MachinesApi {
  history(host: string, range: MachineRange): Promise<MachineSeries | { error: string }>;
}

export interface MachinesViewProps {
  readonly view: View | null;
  readonly now: number;
  readonly api: MachinesApi;
  /** The routing rules' form; `null`: no routing helper on this machine. */
  readonly routing: RoutingApi | null;
  readonly initialTab?: "machines" | "routing";
  readonly onBack: () => void;
}

type Span = "live" | MachineRange;
const SPANS: readonly { key: Span; label: string }[] = [
  { key: "live", label: "Live" },
  { key: "1h", label: "1 h" },
  { key: "24h", label: "24 h" },
  { key: "7d", label: "7 d" },
];
const CATS = ["c-cat1", "c-cat2", "c-cat3", "c-cat4", "c-cat5", "c-run", "c-ok"];
const r1 = (n: number): number => Math.round(n * 10) / 10;

/** A span of time in a few characters ("4m", "1h 12m"). */
export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** CPU as cores ("3.9 cores") from percent of one core. */
export function coresText(cpuPct: number): string {
  const c = cpuPct / 100;
  return `${c >= 10 ? Math.round(c) : r1(c)} core${c >= 0.95 && c < 1.05 ? "" : "s"}`;
}

const SW = 132, SH = 30;

/** A sparkline: the trail's last minutes, the newest value at its end; hover shows any point. */
export function Sparkline(
  props: {
    readonly label: string;
    readonly times: readonly number[];
    readonly values: readonly number[];
    /** A fixed top (percentages: 100); else the trail's own peak. */
    readonly max?: number;
    readonly color: string;
    readonly format: (v: number) => string;
  },
) {
  const { values, times } = props;
  const [hover, setHover] = useState<number | null>(null);
  const n = values.length;
  if (n < 2) {
    return (
      <svg
        class="spark"
        viewBox={`0 0 ${SW} ${SH}`}
        role="img"
        aria-label={`${props.label}: no trail yet`}
      />
    );
  }
  const top = Math.max(props.max ?? 0, ...values, 1e-9);
  const x = (i: number) => (i / (n - 1)) * (SW - 2) + 1;
  const y = (v: number) => SH - 2 - (Math.min(v, top) / top) * (SH - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(
    "",
  );
  const at = hover === null ? n - 1 : hover;
  const move = (e: MouseEvent) => {
    const el = e.currentTarget as SVGSVGElement;
    const box = el.getBoundingClientRect();
    if (box.width <= 0) return;
    setHover(
      Math.max(0, Math.min(n - 1, Math.round(((e.clientX - box.left) / box.width) * (n - 1)))),
    );
  };
  const when = new Date(times[at]);
  const clock = `${String(when.getHours()).padStart(2, "0")}:${
    String(when.getMinutes()).padStart(2, "0")
  }:${String(when.getSeconds()).padStart(2, "0")}`;
  return (
    <span class="spark-wrap">
      <svg
        class={`spark ${props.color}`}
        viewBox={`0 0 ${SW} ${SH}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${props.label}, the last ${ago(times[n - 1] - times[0])}: now ${
          props.format(values[n - 1])
        }`}
        onMouseMove={(e) => move(e as unknown as MouseEvent)}
        onMouseLeave={() => setHover(null)}
      >
        <path
          class="spark-area"
          d={`${line}L${x(n - 1).toFixed(1)},${SH - 1}L${x(0).toFixed(1)},${SH - 1}Z`}
        />
        <path class="spark-line" d={line} />
        {hover !== null ? <line class="spark-cross" x1={x(at)} x2={x(at)} y1={0} y2={SH} /> : null}
        <circle class="spark-dot" cx={x(at)} cy={y(values[at])} r={2} />
      </svg>
      {hover !== null ? <span class="spark-tip">{props.format(values[at])} · {clock}</span> : null}
    </span>
  );
}

function Metric(
  props: { label: string; value: string; sub?: string; children?: ReactNode; warn?: boolean },
) {
  return (
    <div class={`m-metric${props.warn ? " is-warn" : ""}`}>
      <div class="m-metric-head">
        <span class="m-metric-label">{props.label}</span>
        <span class="m-metric-value">{props.value}</span>
      </div>
      {props.children}
      {props.sub ? <div class="m-metric-sub muted">{props.sub}</div> : null}
    </div>
  );
}

function Cores({ cores }: { cores: readonly number[] }) {
  if (cores.length === 0) return null;
  return (
    <div
      class="m-cores"
      role="img"
      aria-label={`Per core: ${cores.map((c) => `${Math.round(c)}%`).join(", ")}`}
    >
      {cores.map((c, i) => (
        <span key={i} class="m-core" title={`core ${i + 1}: ${Math.round(c)}%`}>
          <span class="m-core-fill" style={{ height: `${Math.max(4, Math.min(100, c))}%` }} />
        </span>
      ))}
    </div>
  );
}

function Disks({ s }: { s: MachineSample }) {
  return (
    <div class="m-disks">
      {s.disk.map((d) => {
        const used = d.totalGb > 0 ? 100 * (d.totalGb - d.freeGb) / d.totalGb : 0;
        return (
          <div
            key={d.name}
            class="m-disk"
            title={`${d.mount}: ${Math.round(d.freeGb)} GB free of ${Math.round(d.totalGb)} GB`}
          >
            <span class="m-disk-name">{d.mount || d.name}</span>
            <span class={`m-bar${used > 90 ? " is-bad" : used > 80 ? " is-warn" : ""}`}>
              <span class="m-bar-fill" style={{ width: `${Math.min(100, used)}%` }} />
            </span>
            <span class="m-disk-free">{Math.round(d.freeGb)} GB free</span>
          </div>
        );
      })}
    </div>
  );
}

const STATE_CHIP: Record<string, string> = {
  healthy: "ok",
  degraded: "busy",
  blocked: "blocked",
  paused: "paused",
  down: "unhealthy",
};

function JobRow({ j, now }: { j: MachineJob; now: number }) {
  const name = j.job?.name ?? (j.job ? `job ${j.job.jobId}` : "no job yet");
  return (
    <li class="m-job">
      <span class="m-job-slot" title={j.runner ?? j.sandbox ?? ""}>#{j.slot}</span>
      <span class="m-job-name" title={j.job ? `${j.job.repo} · ${name}` : name}>
        {name}
        {j.job ? <span class="muted">{`\u00a0· ${j.job.repo.split("/").pop()}`}</span> : null}
      </span>
      <span class="m-job-phase muted">{j.phase}{j.since ? ` ${ago(now - j.since)}` : ""}</span>
      <span class="m-job-use">{j.cpuPct === null ? "–" : coresText(j.cpuPct)}</span>
      <span class="m-job-use">{j.rssMb === null ? "–" : memText(j.rssMb)}</span>
    </li>
  );
}

function PoolRow({ p, now }: { p: MachinePool; now: number }) {
  return (
    <div class="m-pool">
      <div class="m-pool-head">
        <span class="m-pool-name">{p.name}</span>
        <span class={`chip chip-${STATE_CHIP[p.state] ?? "unknown"}`} title={p.reason}>
          {p.state}
        </span>
        <span class="pips" aria-label={`${p.busy} of ${p.slots} slots busy`}>
          {Array.from(
            { length: Math.min(p.slots, 12) },
            (_, i) => <span key={i} class={`pip${i < p.busy ? " pip-on" : ""}`} />,
          )}
        </span>
        <span
          class="m-pool-use muted"
          title="What this pool's VM or containers use on the machine right now"
        >
          {p.use
            ? `${coresText(p.use.cpuPct)} · ${memText(p.use.rssMb)}`
            : p.busy
            ? "usage unknown"
            : "idle"}
        </span>
      </div>
      {p.jobs.length
        ? (
          <ul class="m-jobs">
            {p.jobs.map((j) => <JobRow key={`${j.pool}-${j.slot}`} j={j} now={now} />)}
          </ul>
        )
        : null}
    </div>
  );
}

/** A machine's history as charts. */
export function MachineCharts({ s, pools }: { s: MachineSeries; pools: readonly MachinePool[] }) {
  const gb = (v: number) => r1(v / 1024);
  const totalGb = gb(s.memTotalMb);
  const poolNames = pools.map((p) => p.name).filter((n) => s.pools[n]);
  const diskNames = Object.keys(s.disk);
  const mbps = (v: number) => Math.round(v / 1e4) / 100;
  return (
    <div class="charts">
      <TimeChart
        title="CPU"
        subtitle="Average and peak of each step, percent of all cores"
        unit="%"
        times={s.t}
        stepMs={s.stepMs}
        yMax={100}
        series={[
          { key: "cpu", label: "average", color: "c-run", kind: "area", values: s.cpu },
          {
            key: "max",
            label: "peak",
            color: "c-ref",
            kind: "line",
            values: s.cpuMax,
            dashed: true,
          },
        ]}
        empty="No samples in this range yet."
      />
      <TimeChart
        title="Memory"
        subtitle={`Used, of ${totalGb} GB`}
        unit=" GB"
        times={s.t}
        stepMs={s.stepMs}
        yMax={totalGb > 0 ? totalGb : undefined}
        series={[{
          key: "mem",
          label: "used",
          color: "c-cat2",
          kind: "area",
          values: s.memUsedMb.map(gb),
        }]}
        empty="No samples in this range yet."
      />
      <TimeChart
        title="Swap"
        subtitle="Used"
        unit=" GB"
        times={s.t}
        stepMs={s.stepMs}
        series={[{
          key: "swap",
          label: "used",
          color: "c-cat4",
          kind: "area",
          values: s.swapUsedMb.map(gb),
        }]}
        empty="No samples in this range yet."
      />
      <TimeChart
        title="Network"
        subtitle="Received and sent"
        unit=" MB/s"
        times={s.t}
        stepMs={s.stepMs}
        series={[
          {
            key: "rx",
            label: "received",
            color: "c-cat1",
            kind: "line",
            values: s.rxBps.map(mbps),
          },
          { key: "tx", label: "sent", color: "c-cat3", kind: "line", values: s.txBps.map(mbps) },
        ]}
        empty="No samples in this range yet."
      />
      {diskNames.length
        ? (
          <TimeChart
            title="Disk"
            subtitle="Free space per volume (the least in each step)"
            unit=" GB"
            times={s.t}
            stepMs={s.stepMs}
            series={diskNames.map((n, i): ChartSeries => ({
              key: n,
              label: n,
              color: CATS[i % CATS.length],
              kind: "line",
              values: s.disk[n],
            }))}
            empty="No samples in this range yet."
          />
        )
        : null}
      {poolNames.length
        ? (
          <TimeChart
            title="Pools"
            subtitle="CPU each pool's VMs and containers used, in cores"
            unit=" cores"
            times={s.t}
            stepMs={s.stepMs}
            series={poolNames.map((n, i): ChartSeries => ({
              key: n,
              label: n,
              color: CATS[i % CATS.length],
              kind: "stack",
              values: s.pools[n].cpuPct.map((v) => r1(v / 100)),
            }))}
            empty="No samples in this range yet."
          />
        )
        : null}
    </div>
  );
}

function MachineCard(
  props: {
    m: Machine;
    trail: Trail | undefined;
    now: number;
    span: Span;
    history: MachineSeries | { error: string } | null | undefined;
  },
) {
  const { m, trail, now } = props;
  const s = m.online ? m.latest : null;
  const stale = m.lastAt === null ? "no samples yet" : `last sample ${ago(now - m.lastAt)} ago`;
  const info = m.info;
  const boxes = s ? [...s.sandboxes].sort((a, b) => b.cpuPct - a.cpuPct) : [];
  const net = trail ? trail.rx.map((v, i) => v + (trail.tx[i] ?? 0)) : [];
  const temp = s && s.temps.length ? Math.max(...s.temps.map((t) => t.c)) : null;
  return (
    <section class={`m-card${m.online ? "" : " is-offline"}`} aria-label={m.name}>
      <header class="m-head">
        <h2 class="m-name">{m.name}</h2>
        <span
          class={`chip chip-${m.online ? "ok" : "unhealthy"}`}
          title={m.source
            ? `Samples come from the machine's ${m.source === "agent" ? "own agent" : "ssh bridge"}`
            : ""}
        >
          {m.online ? "live" : "offline"}
        </span>
        <span
          class="muted small m-info"
          title={info
            ? `${info.host} · ${info.arch}${info.bootAt ? ` · up ${ago(now - info.bootAt)}` : ""}`
            : ""}
        >
          {info ? `${info.cpuModel || info.arch} · ${info.os}` : ""}
          {s ? ` · ${s.cpu.cores.length} cores · ${memText(s.mem.totalMb)}` : ""}
        </span>
      </header>
      {s
        ? (
          <>
            <div class="m-metrics">
              <Metric
                label="CPU"
                value={`${Math.round(s.cpu.pct)}%`}
                sub={s.cpu.load
                  ? `load ${s.cpu.load.map((x) => x.toFixed(1)).join(" ")}`
                  : undefined}
                warn={s.cpu.pct > 95}
              >
                <Sparkline
                  label="CPU"
                  times={trail?.t ?? []}
                  values={trail?.cpu ?? []}
                  max={100}
                  color="c-run"
                  format={(v) => `${Math.round(v)}%`}
                />
              </Metric>
              <Metric
                label="Memory"
                value={`${memText(s.mem.usedMb)}`}
                sub={`of ${memText(s.mem.totalMb)}${
                  s.mem.pressure !== null ? ` · pressure ${Math.round(s.mem.pressure)}%` : ""
                }`}
                warn={s.mem.totalMb > 0 && s.mem.usedMb / s.mem.totalMb > 0.93}
              >
                <Sparkline
                  label="Memory"
                  times={trail?.t ?? []}
                  values={trail?.mem ?? []}
                  max={100}
                  color="c-cat2"
                  format={(v) => `${Math.round(v)}%`}
                />
              </Metric>
              <Metric
                label="Swap"
                value={memText(s.swap.usedMb)}
                sub={s.swap.totalMb ? `of ${memText(s.swap.totalMb)}` : "none configured"}
              >
                <Sparkline
                  label="Swap"
                  times={trail?.t ?? []}
                  values={trail?.swap ?? []}
                  max={s.swap.totalMb || undefined}
                  color="c-cat4"
                  format={(v) => memText(v)}
                />
              </Metric>
              <Metric
                label="Network"
                value={`↓ ${rateText(s.net.rxBps)}`}
                sub={`↑ ${rateText(s.net.txBps)}`}
              >
                <Sparkline
                  label="Network"
                  times={trail?.t ?? []}
                  values={net}
                  color="c-cat1"
                  format={(v) => rateText(v)}
                />
              </Metric>
            </div>
            <Cores cores={s.cpu.cores} />
            <Disks s={s} />
            {temp !== null || s.gpu
              ? (
                <p class="m-extra muted small">
                  {temp !== null
                    ? (
                      <span title={s.temps.map((t) => `${t.name} ${Math.round(t.c)}°C`).join(", ")}>
                        {Math.round(temp)}°C
                      </span>
                    )
                    : null}
                  {temp !== null && s.gpu ? " · " : ""}
                  {s.gpu ? `GPU ${Math.round(s.gpu.pct)}%` : ""}
                </p>
              )
              : null}
          </>
        )
        : <p class="m-offline muted">No live stats: {stale}.</p>}
      <div class="m-pools">{m.pools.map((p) => <PoolRow key={p.name} p={p} now={now} />)}</div>
      {boxes.length
        ? (
          <details class="m-boxes">
            <summary>
              {boxes.length} VM{boxes.length === 1 ? "" : "s"}{" "}
              / container{boxes.length === 1 ? "" : "s"} / runner process trees
            </summary>
            <ul>
              {boxes.slice(0, 40).map((b) => (
                <li key={`${b.kind}-${b.name}`}>
                  <span class="m-box-kind muted">{b.kind}</span>
                  <span class="m-box-name" title={b.name}>{b.name}</span>
                  <span class="m-job-use">{coresText(b.cpuPct)}</span>
                  <span class="m-job-use">{memText(b.rssMb)}</span>
                </li>
              ))}
            </ul>
          </details>
        )
        : null}
      {props.span !== "live"
        ? (
          <div class="m-history">
            {props.history === undefined || props.history === null
              ? <p class="muted" aria-busy="true">Loading the history…</p>
              : "error" in props.history
              ? <p class="m-error" role="alert">{props.history.error}</p>
              : <MachineCharts s={props.history} pools={m.pools} />}
          </div>
        )
        : null}
    </section>
  );
}

/** Every machine on one chart. */
function Compare(
  props: {
    all: readonly MachineSeries[];
    names: Readonly<Record<string, string>>;
    metric: CompareMetric;
  },
) {
  const meta = COMPARE_METRICS.find((m) => m.key === props.metric)!;
  const a = alignSeries(props.all, props.metric);
  return (
    <div class="charts m-compare">
      <TimeChart
        title={`${meta.label}, every machine`}
        subtitle={props.metric === "net"
          ? "Received plus sent"
          : props.metric === "mem"
          ? "Used, percent of each machine's memory"
          : props.metric === "swap"
          ? "Used"
          : "Percent of all cores"}
        unit={meta.unit}
        times={a.times}
        stepMs={a.stepMs}
        yMax={props.metric === "cpu" || props.metric === "mem" ? 100 : undefined}
        series={props.all.map((s, i): ChartSeries => ({
          key: s.host,
          label: props.names[s.host] ?? s.host,
          color: CATS[i % CATS.length],
          kind: "line",
          values: a.values[s.host] ?? [],
        }))}
        empty="No samples in this range yet."
      />
    </div>
  );
}

export function MachinesView(props: MachinesViewProps) {
  const { view, now, api, onBack } = props;
  const [tab, setTab] = useState<"machines" | "routing">(
    props.routing && props.initialTab === "routing" ? "routing" : "machines",
  );
  const [span, setSpan] = useState<Span>("live");
  const [compare, setCompare] = useState(false);
  const [metric, setMetric] = useState<CompareMetric>("cpu");
  const [histories, setHistories] = useState<
    Record<string, MachineSeries | { error: string } | null>
  >({});
  const heading = useRef<HTMLHeadingElement | null>(null);
  const ids = (view?.machines ?? []).map((m) => m.id).join(",");

  useEffect(() => {
    if (heading.current && typeof heading.current.focus === "function") heading.current.focus();
  }, []);
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    e.preventDefault();
    onBack();
  }, [onBack]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);

  // The history of every machine for the chosen range: on a range change, then every minute.
  const wanted = useRef("");
  useEffect(() => {
    if (span === "live" || !ids) return;
    const key = `${span}:${ids}`;
    wanted.current = key;
    const load = () => {
      for (const host of ids.split(",")) {
        void api.history(host, span).then((s) => {
          if (wanted.current === key) setHistories((h) => ({ ...h, [`${span}:${host}`]: s }));
        }).catch(() => {
          if (wanted.current === key) {
            setHistories((h) => ({
              ...h,
              [`${span}:${host}`]: { error: "The history couldn't be read." },
            }));
          }
        });
      }
    };
    load();
    const t = setInterval(load, span === "1h" ? 30_000 : 120_000);
    return () => clearInterval(t);
  }, [span, ids, api]);

  const machines = view?.machines ?? [];
  const names = Object.fromEntries(machines.map((m) => [m.id, m.name]));
  const loaded = span === "live"
    ? []
    : machines.map((m) => histories[`${span}:${m.id}`]).filter((s): s is MachineSeries =>
      !!s && !("error" in s)
    );
  const running = machines.reduce((n, m) => n + m.pools.reduce((k, p) => k + p.jobs.length, 0), 0);
  return (
    <div class="detail machines" onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)}>
      <header class="detail-top">
        <button type="button" class="btn" onClick={onBack} aria-label="Back to the dashboard">
          ← Back
        </button>
        <div class="detail-title">
          <h1 class="detail-name" ref={heading} tabIndex={-1}>Machines</h1>
          {view?.configured
            ? (
              <span class={`chip chip-${view.connected ? "ok" : "blocked"}`} title={view.error}>
                {view.connected ? "live" : "reconnecting"}
              </span>
            )
            : null}
          {view && !view.connected && view.error
            ? <span class="muted small detail-reason" title={view.error}>{view.error}</span>
            : null}
        </div>
        <dl class="detail-facts">
          <div>
            <dt>Machines</dt>
            <dd>{machines.filter((m) => m.online).length} of {machines.length} live</dd>
          </div>
          <div>
            <dt>Jobs</dt>
            <dd>{running}</dd>
          </div>
        </dl>
      </header>
      {props.routing
        ? (
          <nav class="tabs" role="tablist" aria-label="Machines">
            {(["machines", "routing"] as const).map((t) => (
              <button
                key={t}
                type="button"
                role="tab"
                aria-selected={tab === t}
                class={`tab${tab === t ? " is-active" : ""}`}
                onClick={() => setTab(t)}
              >
                {t === "machines" ? "Machines" : "Routing"}
              </button>
            ))}
          </nav>
        )
        : null}
      {tab === "routing" && props.routing
        ? (
          <div class="detail-body">
            <RoutingForm api={props.routing} />
          </div>
        )
        : (
          <div class="detail-body">
            {!view
              ? <p class="muted" aria-busy="true">Loading the machines…</p>
              : !view.configured
              ? (
                <p class="muted">
                  No machines service is set up (the settings' <code>integrations.machines</code>).
                </p>
              )
              : (
                <>
                  <div class="detail-bar">
                    <div class="range" role="group" aria-label="Range">
                      {SPANS.map((sp) => (
                        <button
                          key={sp.key}
                          type="button"
                          class={`seg${span === sp.key ? " is-on" : ""}`}
                          aria-pressed={span === sp.key}
                          onClick={() => setSpan(sp.key)}
                        >
                          {sp.label}
                        </button>
                      ))}
                    </div>
                    <label class="m-compare-toggle">
                      <input
                        type="checkbox"
                        checked={compare}
                        disabled={span === "live"}
                        onChange={(e) => setCompare((e.target as HTMLInputElement).checked)}
                      />
                      Compare machines
                    </label>
                    {compare && span !== "live"
                      ? (
                        <div class="range" role="group" aria-label="Metric">
                          {COMPARE_METRICS.map((mm) => (
                            <button
                              key={mm.key}
                              type="button"
                              class={`seg${metric === mm.key ? " is-on" : ""}`}
                              aria-pressed={metric === mm.key}
                              onClick={() => setMetric(mm.key)}
                            >
                              {mm.label}
                            </button>
                          ))}
                        </div>
                      )
                      : null}
                    <span class="muted small">
                      {span === "live"
                        ? "Sampled every 5 to 10 s; the lines show the last 15 min."
                        : "History from the machines service."}
                    </span>
                  </div>
                  {compare && span !== "live"
                    ? <Compare all={loaded} names={names} metric={metric} />
                    : null}
                  {machines.length === 0
                    ? <p class="muted">The machines service lists no machine yet.</p>
                    : null}
                  <div class="m-grid">
                    {machines.map((m) => (
                      <MachineCard
                        key={m.id}
                        m={m}
                        trail={view.trails[m.id]}
                        now={now}
                        span={span}
                        history={span === "live" ? undefined : histories[`${span}:${m.id}`]}
                      />
                    ))}
                  </div>
                </>
              )}
          </div>
        )}
    </div>
  );
}
