"use client";
// Hand-rolled SVG charts for the pool detail screen: one time chart (areas, lines, stacked bars on
// one y scale), a histogram, and their shared parts (nice ticks, time labels, the hover / focus
// tooltip with each bucket's exact values, a legend, a data table). No chart library. Colours are
// CSS classes over the theme tokens (public/styles.css), so both themes follow; semantic colours
// only for good / warning / critical.

import { type ReactNode, useState } from "denext";

/** One series of a time chart. */
export interface ChartSeries {
  readonly key: string;
  readonly label: string;
  /** A colour class (`c-run`, `c-ok`, `c-bad`, `c-muted`, `c-cat1` … `c-cat5`, `c-ref`). */
  readonly color: string;
  /**
   * `area`: a filled area from 0; `line`: a 2 px line; `bar`: stacked bars (bars stack in series
   * order); `stack`: stacked areas (in series order).
   */
  readonly kind: "area" | "line" | "bar" | "stack";
  readonly values: readonly (number | null)[];
  readonly dashed?: boolean;
  /** Left out of the tooltip and the table (a reference line already named in the title). */
  readonly quiet?: boolean;
}

/** A time chart's props. */
export interface TimeChartProps {
  readonly title: string;
  /** One line under the title: what is measured, and the unit. */
  readonly subtitle?: string;
  /** The y axis's unit, after each tick (`%`, ` jobs`, ` min`). */
  readonly unit: string;
  /** Point start times (ms). */
  readonly times: readonly number[];
  readonly stepMs: number;
  readonly series: readonly ChartSeries[];
  /** A fixed top (utilization: 100); else from the data. */
  readonly yMax?: number;
  /** A tick / value's text (default: the number with the unit). */
  readonly format?: (v: number) => string;
  /** Shown when there is nothing to plot. */
  readonly empty?: string;
}

const W = 640;
const H = 190;
const PAD = { l: 48, r: 14, t: 10, b: 26 };
const PW = W - PAD.l - PAD.r;
const PH = H - PAD.t - PAD.b;

/** "Nice" tick values from 0 to at least `max` (about four steps). */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0)) return [0, 1];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const top = Math.ceil(max / step) * step;
  const out: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A time label for an axis tick or a tooltip, by the chart's step. */
export function timeLabel(t: number, stepMs: number, full = false): string {
  const d = new Date(t);
  const hm = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  if (stepMs >= 3600_000) {
    const day = `${DAYS[d.getDay()]} ${d.getDate()}`;
    return full ? `${day} ${hm}` : stepMs >= 6 * 3600_000 ? day : `${day} ${pad2(d.getHours())}h`;
  }
  return full && stepMs >= 15 * 60_000 ? `${DAYS[d.getDay()]} ${hm}` : hm;
}

/** Whether any series has a value worth plotting. */
export function hasData(series: readonly ChartSeries[]): boolean {
  return series.some((s) => !s.quiet && s.values.some((v) => v !== null && v > 0));
}

/** The stacked tops of `bar` / `stack` series, by point. */
function stackTops(series: readonly ChartSeries[], n: number): number[] {
  const tops = new Array(n).fill(0);
  for (const s of series) {
    if (s.kind !== "bar" && s.kind !== "stack") continue;
    for (let i = 0; i < n; i++) tops[i] += s.values[i] ?? 0;
  }
  return tops;
}

/** A path through the points, broken where a value is missing. */
function linePath(xs: readonly number[], ys: readonly (number | null)[]): string {
  let d = "";
  let pen = false;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i];
    if (y === null) {
      pen = false;
      continue;
    }
    d += `${pen ? "L" : "M"}${xs[i].toFixed(1)},${y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

/** An area between `lo` and `hi` (screen y), broken where `hi` is missing. */
function areaPath(
  xs: readonly number[],
  hi: readonly (number | null)[],
  lo: readonly number[],
): string {
  let d = "";
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const top = run.map((i) => `${xs[i].toFixed(1)},${hi[i]!.toFixed(1)}`);
    const bottom = [...run].reverse().map((i) => `${xs[i].toFixed(1)},${lo[i].toFixed(1)}`);
    d += `M${top.join("L")}L${bottom.join("L")}Z`;
    run = [];
  };
  for (let i = 0; i < xs.length; i++) {
    if (hi[i] === null) flush();
    else run.push(i);
  }
  flush();
  return d;
}

/** The legend: a swatch and a label per series (identity never by colour alone). */
export function Legend({ series }: { series: readonly ChartSeries[] }) {
  const shown = series.filter((s) => !s.quiet || s.kind === "line");
  if (shown.length < 2) return null;
  return (
    <ul class="legend" aria-label="Legend">
      {shown.map((s) => (
        <li key={s.key}>
          <span
            class={`swatch ${s.color} swatch-${s.kind}${s.dashed ? " swatch-dashed" : ""}`}
            aria-hidden="true"
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}

/** A time chart: one y scale, labelled axes, a faint grid, the latest point marked. */
export function TimeChart(props: TimeChartProps) {
  const { times, series, stepMs, unit } = props;
  const n = times.length;
  const [hover, setHover] = useState<number | null>(null);
  const fmt = props.format ?? ((v: number) => `${round(v)}${unit}`);
  const titleId = `chart-${props.title.replace(/\W+/g, "-").toLowerCase()}`;
  const data = hasData(series);
  const tops = stackTops(series, n);
  const peak = Math.max(
    0,
    ...tops,
    ...series.filter((s) => s.kind === "area" || s.kind === "line").flatMap((s) =>
      s.values.map((v) => v ?? 0)
    ),
  );
  const ticks = niceTicks(props.yMax ?? (peak > 0 ? peak : 1));
  const top = props.yMax ?? ticks[ticks.length - 1];
  const x = (i: number) => PAD.l + (n <= 1 ? PW / 2 : (i + 0.5) * (PW / n));
  const y = (v: number) => PAD.t + PH - (Math.min(v, top) / top) * PH;
  const xs = times.map((_, i) => x(i));
  const bw = Math.max(1, PW / Math.max(n, 1) - 2);
  // Time ticks: about six, on point boundaries.
  const every = Math.max(1, Math.ceil(n / 6));
  const xTicks = times.map((t, i) => ({ t, i })).filter(({ i }) => i % every === 0);

  const shapes: ReactNode[] = [];
  const base = new Array(n).fill(0);
  for (const s of series) {
    if (s.kind === "bar") {
      s.values.forEach((v, i) => {
        if (!v) return;
        const y0 = y(base[i]);
        const y1 = y(base[i] + v);
        base[i] += v;
        shapes.push(
          <rect
            key={`${s.key}-${i}`}
            class={`bar ${s.color}`}
            x={xs[i] - bw / 2}
            y={y1}
            width={bw}
            height={Math.max(0.5, y0 - y1 - (y0 - y1 > 3 ? 1 : 0))}
          />,
        );
      });
    } else if (s.kind === "stack") {
      const lo = base.map((b) => y(b));
      const hi = s.values.map((v, i) => (v === null ? null : y(base[i] + v)));
      s.values.forEach((v, i) => (base[i] += v ?? 0));
      shapes.push(<path key={s.key} class={`area ${s.color}`} d={areaPath(xs, hi, lo)} />);
    } else if (s.kind === "area") {
      const hi = s.values.map((v) => (v === null ? null : y(v)));
      shapes.push(
        <path
          key={`${s.key}-a`}
          class={`area ${s.color}`}
          d={areaPath(xs, hi, xs.map(() => y(0)))}
        />,
        <path key={`${s.key}-l`} class={`line ${s.color}`} d={linePath(xs, hi)} />,
      );
    } else {
      shapes.push(
        <path
          key={s.key}
          class={`line ${s.color}${s.dashed ? " line-dashed" : ""}`}
          d={linePath(xs, s.values.map((v) => (v === null ? null : y(v))))}
        />,
      );
    }
  }
  // The latest point of the first area / line series, emphasized.
  const lead = series.find((s) => !s.quiet && (s.kind === "area" || s.kind === "line"));
  let latest: ReactNode = null;
  if (lead) {
    for (let i = n - 1; i >= 0; i--) {
      const v = lead.values[i];
      if (v === null) continue;
      latest = <circle class={`latest ${lead.color}`} cx={xs[i]} cy={y(v)} r={4} />;
      break;
    }
  }

  const tipSeries = series.filter((s) => !s.quiet);
  const move = (i: number) => setHover(Math.max(0, Math.min(n - 1, i)));
  return (
    <figure class="chart" aria-labelledby={titleId}>
      <figcaption>
        <h3 class="chart-title" id={titleId}>{props.title}</h3>
        {props.subtitle ? <p class="chart-sub muted">{props.subtitle}</p> : null}
      </figcaption>
      <Legend series={series} />
      {!data
        ? <p class="chart-empty muted">{props.empty ?? "No data for this range yet."}</p>
        : (
          <div class="chart-plot">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`${props.title}: ${n} points, ${timeLabel(times[0], stepMs, true)} to ${
                timeLabel(times[n - 1], stepMs, true)
              }`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") move((hover ?? n) - 1);
                else if (e.key === "ArrowRight") move((hover ?? -1) + 1);
                else if (e.key === "Home") move(0);
                else if (e.key === "End") move(n - 1);
                else if (e.key === "Escape") setHover(null);
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onFocus={() => setHover((h) => h ?? n - 1)}
              onBlur={() => setHover(null)}
              onMouseLeave={() => setHover(null)}
            >
              <g class="grid">
                {ticks.map((v) => <line key={v} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />)}
              </g>
              <g class="axis axis-y">
                {ticks.map((v) => (
                  <text key={v} x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{fmt(v)}</text>
                ))}
              </g>
              <g class="axis axis-x">
                <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
                {xTicks.map(({ t, i }) => (
                  <text key={t} x={xs[i]} y={H - 8} textAnchor="middle">
                    {timeLabel(t, stepMs)}
                  </text>
                ))}
              </g>
              <g class="marks">{shapes}</g>
              {latest}
              {hover !== null
                ? <line class="crosshair" x1={xs[hover]} x2={xs[hover]} y1={PAD.t} y2={y(0)} />
                : null}
              {times.map((t, i) => (
                <rect
                  key={t}
                  class="hit"
                  x={PAD.l + i * (PW / n)}
                  y={PAD.t}
                  width={PW / n}
                  height={PH}
                  onMouseEnter={() => setHover(i)}
                />
              ))}
            </svg>
            {hover !== null
              ? (
                <div
                  class={`tooltip${xs[hover] > W * 0.6 ? " tooltip-left" : ""}`}
                  role="status"
                  style={{ left: `${(xs[hover] / W) * 100}%` }}
                >
                  <div class="tooltip-time num">
                    {timeLabel(times[hover], stepMs, true)}–{timeLabel(
                      times[hover] + stepMs,
                      stepMs,
                      true,
                    )}
                  </div>
                  {tipSeries.map((s) => (
                    <div class="tooltip-row" key={s.key}>
                      <span class={`swatch ${s.color} swatch-${s.kind}`} aria-hidden="true" />
                      <span class="tooltip-label">{s.label}</span>
                      <span class="num">
                        {s.values[hover] === null ? "no data" : fmt(s.values[hover]!)}
                      </span>
                    </div>
                  ))}
                </div>
              )
              : null}
          </div>
        )}
      {data ? <DataTable times={times} stepMs={stepMs} series={tipSeries} format={fmt} /> : null}
    </figure>
  );
}

const round = (v: number) => (Math.abs(v) >= 10 ? Math.round(v) : Math.round(v * 10) / 10);

/** The chart's numbers as a table (collapsed): the accessible, exact view. */
function DataTable(
  { times, stepMs, series, format }: {
    times: readonly number[];
    stepMs: number;
    series: readonly ChartSeries[];
    format: (v: number) => string;
  },
) {
  const [open, setOpen] = useState(false);
  return (
    <div class="chart-table">
      <button type="button" class="link-btn" aria-expanded={open} onClick={() => setOpen(!open)}>
        {open ? "Hide the data table" : "Show as a table"}
      </button>
      {open
        ? (
          <div class="table-scroll">
            <table class="data">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  {series.map((s) => <th scope="col" key={s.key}>{s.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {times.map((t, i) => (
                  <tr key={t}>
                    <th scope="row" class="num">{timeLabel(t, stepMs, true)}</th>
                    {series.map((s) => (
                      <td key={s.key} class="num">
                        {s.values[i] === null ? "–" : format(s.values[i]!)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
        : null}
    </div>
  );
}

/** A histogram's props: bins with labels and counts. */
export interface HistogramProps {
  readonly title: string;
  readonly subtitle?: string;
  readonly bins: readonly { readonly label: string; readonly count: number }[];
  /** Bins to mark (the median's and the p90's), by index. */
  readonly marks?: readonly { readonly bin: number; readonly label: string }[];
  readonly empty?: string;
}

/** A histogram: one bar per bin (count of jobs), labelled axes, hover / focus values. */
export function Histogram(props: HistogramProps) {
  const { bins } = props;
  const [hover, setHover] = useState<number | null>(null);
  const titleId = `chart-${props.title.replace(/\W+/g, "-").toLowerCase()}`;
  const total = bins.reduce((a, b) => a + b.count, 0);
  const ticks = niceTicks(Math.max(1, ...bins.map((b) => b.count)));
  const top = ticks[ticks.length - 1];
  const n = bins.length;
  const x = (i: number) => PAD.l + i * (PW / n);
  const y = (v: number) => PAD.t + PH - (v / top) * PH;
  const bw = PW / n - 2;
  return (
    <figure class="chart" aria-labelledby={titleId}>
      <figcaption>
        <h3 class="chart-title" id={titleId}>{props.title}</h3>
        {props.subtitle ? <p class="chart-sub muted">{props.subtitle}</p> : null}
      </figcaption>
      {total === 0
        ? <p class="chart-empty muted">{props.empty ?? "No finished jobs in this range."}</p>
        : (
          <div class="chart-plot">
            <svg
              viewBox={`0 0 ${W} ${H}`}
              role="img"
              aria-label={`${props.title}: ${total} jobs in ${n} duration bins`}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "ArrowLeft") setHover(Math.max(0, (hover ?? n) - 1));
                else if (e.key === "ArrowRight") setHover(Math.min(n - 1, (hover ?? -1) + 1));
                else if (e.key === "Escape") setHover(null);
                else return;
                e.preventDefault();
                e.stopPropagation();
              }}
              onFocus={() => setHover((h) => h ?? 0)}
              onBlur={() => setHover(null)}
              onMouseLeave={() => setHover(null)}
            >
              <g class="grid">
                {ticks.map((v) => <line key={v} x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} />)}
              </g>
              <g class="axis axis-y">
                {ticks.map((v) => (
                  <text key={v} x={PAD.l - 6} y={y(v) + 4} textAnchor="end">{v}</text>
                ))}
              </g>
              <g class="axis axis-x">
                <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} />
                {bins.map((b, i) =>
                  i % 2 === 0
                    ? (
                      <text key={b.label} x={x(i) + PW / n / 2} y={H - 8} textAnchor="middle">
                        {b.label}
                      </text>
                    )
                    : null
                )}
              </g>
              <g class="marks">
                {bins.map((b, i) =>
                  b.count > 0
                    ? (
                      <rect
                        key={b.label}
                        class={`bar c-run${hover === i ? " is-hover" : ""}`}
                        x={x(i) + 1}
                        y={y(b.count)}
                        width={bw}
                        height={y(0) - y(b.count)}
                      />
                    )
                    : null
                )}
              </g>
              {(props.marks ?? []).map((m) => (
                <g key={m.label} class="hist-mark">
                  <line
                    x1={x(m.bin) + PW / n / 2}
                    x2={x(m.bin) + PW / n / 2}
                    y1={PAD.t}
                    y2={y(0)}
                  />
                  <text x={x(m.bin) + PW / n / 2 + 4} y={PAD.t + 10}>{m.label}</text>
                </g>
              ))}
              {bins.map((b, i) => (
                <rect
                  key={`hit-${b.label}`}
                  class="hit"
                  x={x(i)}
                  y={PAD.t}
                  width={PW / n}
                  height={PH}
                  onMouseEnter={() => setHover(i)}
                />
              ))}
            </svg>
            {hover !== null
              ? (
                <div
                  class={`tooltip${x(hover) > W * 0.6 ? " tooltip-left" : ""}`}
                  role="status"
                  style={{ left: `${((x(hover) + PW / n / 2) / W) * 100}%` }}
                >
                  <div class="tooltip-time">{bins[hover].label}</div>
                  <div class="tooltip-row">
                    <span class="tooltip-label">jobs</span>
                    <span class="num">{bins[hover].count}</span>
                  </div>
                  <div class="tooltip-row">
                    <span class="tooltip-label">share</span>
                    <span class="num">{Math.round((bins[hover].count / total) * 100)}%</span>
                  </div>
                </div>
              )
              : null}
          </div>
        )}
    </figure>
  );
}
