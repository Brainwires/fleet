"use client";
// A pool's detail screen (or the GitHub-hosted one): its header (labels, slots, health, machine,
// busy / queued now, the pause controls), then two tabs. Usage: the range picker, a summary row and
// the charts (utilization, queue, throughput, duration; for GitHub-hosted, usage by image and
// minutes), the recent jobs and the recent events. Logs: the runner scheduler's launcher logs and
// its lines about the pool (when configured), and any recent job's GitHub log, in the log viewer.
// Presentational over props, like the main view: the data and the loaders come in.

import { useCallback, useEffect, useRef, useState } from "denext";
import { type ChartSeries, Histogram, TimeChart } from "./charts.tsx";
import { LogViewer } from "./log-viewer.tsx";
import { type ControlHandlers, PoolControls } from "./controls.tsx";
import { eventText } from "./event-log.tsx";
import {
  binSpan,
  durationBin,
  HISTORY_RANGES,
  type HistoryRange,
  type JobRecord,
  type PoolHistory,
} from "../lib/history.ts";
import type { PoolDetail } from "../lib/pool-detail.ts";
import type { LogError, LogView } from "../lib/logs.ts";
import type { LauncherLog } from "../lib/runner-logs.ts";
import { formatAgo, formatClock, formatDuration, shortRepo, shortRunner } from "../lib/format.ts";

/** What the Logs tab loads (the backend's methods). */
export interface LogsApi {
  runnerLogList(pool: string): Promise<{ configured: boolean; logs: LauncherLog[] }>;
  poolLogLines(
    pool: string,
  ): Promise<{ configured: boolean; scheduler: string[]; alerts: string[] }>;
  runnerLog(
    pool: string,
    file: string,
    opts?: { after?: number; before?: number },
  ): Promise<LogView | LogError>;
  runnerLogForJob(jobId: number): Promise<LogView | LogError>;
  jobLog(repo: string, jobId: number): Promise<LogView | LogError>;
}

/** The screen's props. */
export interface PoolDetailProps {
  readonly pool: string;
  readonly detail: PoolDetail | null;
  readonly range: HistoryRange;
  readonly onRange: (r: HistoryRange) => void;
  readonly onBack: () => void;
  readonly onOpen: (url: string) => void;
  /** Now on GitHub's clock (job ages). */
  readonly now: number;
  readonly controls?: ControlHandlers;
  readonly logs?: LogsApi;
  /** The tab to open on (a restored screen; tests). */
  readonly initialTab?: "usage" | "logs";
  /** Hears the tab (on mount and on every change), so a screen can be restored on it. */
  readonly onTab?: (tab: "usage" | "logs") => void;
  readonly error?: string;
}

const RANGE_TEXT: Record<HistoryRange, string> = {
  "1h": "1 h",
  "24h": "24 h",
  "7d": "7 d",
  "30d": "30 d",
};
const STEP_TEXT = (ms: number) =>
  ms >= 3600_000 ? `${ms / 3600_000} h` : ms >= 60_000 ? `${ms / 60_000} min` : `${ms / 1000} s`;
const STATE_TEXT = { ok: "ok", paused: "paused", unhealthy: "unhealthy", unknown: "no health" };

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const mins = (ms: number) => ms / 60_000;
const fmtMin = (v: number) => (v >= 10 ? `${Math.round(v)}m` : `${Math.round(v * 10) / 10}m`);
const isErr = (v: LogView | LogError): v is LogError => "error" in v;

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div class="stat" title={hint}>
      <span class="stat-value num">{value}</span>
      <span class="stat-label">{label}</span>
    </div>
  );
}

/** Self-hosted capacity: busy slots (area) against the slots (dashed line). */
function utilizationSeries(h: PoolHistory): ChartSeries[] {
  return [
    {
      key: "busy",
      label: "busy slots (average)",
      color: "c-run",
      kind: "area",
      values: h.points.map((p) => p.busy),
    },
    {
      key: "slots",
      label: "capacity (slots)",
      color: "c-ref",
      kind: "line",
      dashed: true,
      values: h.points.map((p) => p.slots),
    },
  ];
}

const CAT = ["c-cat1", "c-cat2", "c-cat3", "c-cat4", "c-cat5"];

/** GitHub-hosted: running jobs stacked by image (the busiest five, then "other"). */
function imageSeries(d: PoolDetail): ChartSeries[] {
  const h = d.history;
  const out: ChartSeries[] = d.images.map((img, i) => ({
    key: img.image,
    label: img.image,
    color: CAT[i % CAT.length],
    kind: "stack" as const,
    values: img.history.points.map((p) => p.busy),
  }));
  const other = h.points.map((p, i) => {
    if (p.busy === null) return null;
    const named = d.images.reduce((a, img) => a + (img.history.points[i]?.busy ?? 0), 0);
    return Math.max(0, Math.round((p.busy - named) * 1000) / 1000);
  });
  if (other.some((v) => v !== null && v > 0) || out.length === 0) {
    out.push({
      key: "other",
      label: out.length ? "other images" : "running jobs",
      color: "c-ref",
      kind: "stack",
      values: other,
    });
  }
  return out;
}

function throughputSeries(h: PoolHistory): ChartSeries[] {
  return [
    {
      key: "ok",
      label: "succeeded",
      color: "c-ok",
      kind: "bar",
      values: h.points.map((p) => p.ok),
    },
    {
      key: "failed",
      label: "failed",
      color: "c-bad",
      kind: "bar",
      values: h.points.map((p) => p.failed),
    },
    {
      key: "cancelled",
      label: "cancelled",
      color: "c-muted",
      kind: "bar",
      values: h.points.map((p) => p.cancelled),
    },
    {
      key: "other",
      label: "other (skipped, neutral…)",
      color: "c-ref",
      kind: "bar",
      values: h.points.map((p) => p.other),
    },
  ];
}

/** The histogram's bins, labelled by their spans. */
function histBins(h: PoolHistory) {
  const label = (i: number) => {
    const [lo, hi] = binSpan(i);
    const f = (
      ms: number,
    ) => (ms >= 3600_000
      ? `${ms / 3600_000}h`
      : ms >= 60_000
      ? `${ms / 60_000}m`
      : `${ms / 1000}s`);
    return i === h.histogram.counts.length - 1 ? `≥${f(lo)}` : lo === 0 ? `<${f(hi)}` : f(lo);
  };
  return h.histogram.counts.map((count, i) => ({ label: label(i), count }));
}

/** The Usage tab's charts for one history. */
function UsageCharts({ d }: { d: PoolDetail }) {
  const h = d.history;
  const times = h.points.map((p) => p.t);
  const github = d.pool === "github";
  const step = STEP_TEXT(h.stepMs);
  const t = h.totals;
  return (
    <div class="charts">
      {github
        ? (
          <TimeChart
            title="Running jobs by image"
            subtitle={`Average jobs running per ${step}, stacked by runs-on image`}
            unit=""
            times={times}
            stepMs={h.stepMs}
            series={imageSeries(d)}
            empty="No GitHub-hosted jobs ran in this range."
          />
        )
        : (
          <TimeChart
            title="Utilization"
            subtitle={`Busy slots (average per ${step}) against capacity · ${
              pct(t.utilization)
            } of slot time busy`}
            unit=""
            times={times}
            stepMs={h.stepMs}
            series={utilizationSeries(h)}
            format={(v) => `${Math.round(v * 10) / 10}`}
            empty="No samples for this range yet: Fleet records them while it runs."
          />
        )}
      {d.combined && d.shared
        ? (
          <TimeChart
            title={`Machine ${d.shared.host}: combined`}
            subtitle={`${d.shared.pools.join(" + ")} share this machine: busy slots added up · ${
              pct(d.combined.totals.utilization)
            } busy`}
            unit=""
            times={d.combined.points.map((p) => p.t)}
            stepMs={d.combined.stepMs}
            series={utilizationSeries(d.combined)}
            format={(v) => `${Math.round(v * 10) / 10}`}
          />
        )
        : null}
      <TimeChart
        title="Queue length"
        subtitle={`Jobs waiting for a runner (average per ${step})`}
        unit=""
        times={times}
        stepMs={h.stepMs}
        series={[{
          key: "queued",
          label: "queued jobs",
          color: "c-cat4",
          kind: "area",
          values: h.points.map((p) => p.queued),
        }]}
        format={(v) => `${Math.round(v * 10) / 10}`}
        empty="Nothing waited in this range."
      />
      <TimeChart
        title="Oldest wait"
        subtitle={`The longest a queued job had waited, per ${step} (minutes)`}
        unit="m"
        times={times}
        stepMs={h.stepMs}
        series={[{
          key: "wait",
          label: "oldest wait",
          color: "c-cat4",
          kind: "line",
          values: h.points.map((p) => (p.waitMax === null ? null : mins(p.waitMax))),
        }]}
        format={fmtMin}
        empty="Nothing waited in this range."
      />
      <TimeChart
        title="Throughput"
        subtitle={`Jobs finished per ${step}, by conclusion`}
        unit=""
        times={times}
        stepMs={h.stepMs}
        series={throughputSeries(h)}
        format={(v) => `${Math.round(v)}`}
        empty="No jobs finished in this range."
      />
      <TimeChart
        title="Job duration"
        subtitle={`Median and p90 of the jobs finished per ${step} (minutes)`}
        unit="m"
        times={times}
        stepMs={h.stepMs}
        series={[
          {
            key: "p50",
            label: "median",
            color: "c-run",
            kind: "line",
            values: h.points.map((p) => (p.p50 === null ? null : mins(p.p50))),
          },
          {
            key: "p90",
            label: "p90",
            color: "c-cat2",
            kind: "line",
            dashed: true,
            values: h.points.map((p) => (p.p90 === null ? null : mins(p.p90))),
          },
        ]}
        format={fmtMin}
        empty="No jobs finished in this range."
      />
      <Histogram
        title="Duration distribution"
        subtitle={`Jobs finished in the last ${RANGE_TEXT[d.range]}, by length`}
        bins={histBins(h)}
        marks={[
          ...(t.p50 !== null
            ? [{ bin: durationBin(t.p50), label: `median ${formatDuration(t.p50)}` }]
            : []),
          ...(t.p90 !== null
            ? [{ bin: durationBin(t.p90), label: `p90 ${formatDuration(t.p90)}` }]
            : []),
        ]}
      />
      {github
        ? (
          <TimeChart
            title="Minutes used"
            subtitle={`Minutes of the jobs finished per ${step}, each job rounded up to a whole minute (as billed)`}
            unit=""
            times={times}
            stepMs={h.stepMs}
            series={[{
              key: "minutes",
              label: "minutes",
              color: "c-run",
              kind: "bar",
              values: h.points.map((p) => p.minutes),
            }]}
            format={(v) => `${Math.round(v)}`}
            empty="No GitHub-hosted minutes in this range."
          />
        )
        : null}
    </div>
  );
}

const CONCLUSION: Record<string, { glyph: string; cls: string }> = {
  success: { glyph: "✓", cls: "ok" },
  failure: { glyph: "✕", cls: "bad" },
  timed_out: { glyph: "✕", cls: "bad" },
  startup_failure: { glyph: "✕", cls: "bad" },
  cancelled: { glyph: "⊘", cls: "dim" },
};

function JobsTable(
  { jobs, onOpen, onLog, onRunnerLog }: {
    jobs: readonly JobRecord[];
    onOpen: (u: string) => void;
    onLog?: (j: JobRecord) => void;
    onRunnerLog?: (j: JobRecord) => void;
  },
) {
  if (jobs.length === 0) return <p class="empty">No finished jobs recorded for this pool yet.</p>;
  return (
    <div class="table-scroll">
      <table class="data jobs-table">
        <thead>
          <tr>
            <th scope="col">Finished</th>
            <th scope="col">Repo · workflow · job</th>
            <th scope="col">Runner</th>
            <th scope="col" class="num-col">Duration</th>
            <th scope="col">Result</th>
            <th scope="col">
              <span class="visually-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((j) => {
            const c = CONCLUSION[j.conclusion] ?? { glyph: "•", cls: "dim" };
            const what = `${shortRepo(j.repo)} · ${j.workflow} · ${j.name}`;
            return (
              <tr key={j.id}>
                <td class="num" title={new Date(j.completed).toLocaleString()}>
                  {formatClock(j.completed)}
                </td>
                <td class="cell-clip" title={what}>
                  {j.url
                    ? (
                      <a
                        href={j.url}
                        onClick={(e) => {
                          e.preventDefault();
                          onOpen(j.url!);
                        }}
                      >
                        {what}
                      </a>
                    )
                    : what}
                </td>
                <td class="cell-clip" title={j.runner ?? ""}>
                  {j.image ? `${j.image} ` : ""}
                  {j.runner ? shortRunner(j.runner) : "–"}
                </td>
                <td class="num num-col">
                  {j.started !== null ? formatDuration(j.completed - j.started) : "–"}
                </td>
                <td>
                  <span class={`glyph glyph-${c.cls}`} aria-hidden="true">{c.glyph}</span>{" "}
                  {j.conclusion.replace(/_/g, " ")}
                </td>
                <td class="cell-actions">
                  {onLog
                    ? <button type="button" class="ctl" onClick={() => onLog(j)}>View log</button>
                    : null}
                  {onRunnerLog
                    ? (
                      <button type="button" class="ctl" onClick={() => onRunnerLog(j)}>
                        Runner log
                      </button>
                    )
                    : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EventsList({ d, onOpen }: { d: PoolDetail; onOpen: (u: string) => void }) {
  if (d.events.length === 0) return <p class="empty">No recent events for this pool.</p>;
  return (
    <ul class="detail-events">
      {d.events.map((e) => (
        <li key={e.seq} class={`devent sev-${e.sev}`}>
          <span class="num muted">{formatClock(e.at)}</span>
          <span class="devent-text" title={e.text}>
            {e.repo ? `${shortRepo(e.repo)} · ` : ""}
            {e.job ? `${e.job}: ` : ""}
            {eventText(e.text).text}
            {eventText(e.text).runner ? ` · ${eventText(e.text).runner}` : ""}
          </span>
          {e.url
            ? (
              <a
                class="devent-link"
                href={e.url}
                onClick={(ev) => {
                  ev.preventDefault();
                  onOpen(e.url!);
                }}
              >
                open
              </a>
            )
            : null}
        </li>
      ))}
    </ul>
  );
}

/** The Logs tab. */
function LogsTab(
  { pool, d, logs, jobs, opened, setOpened }: {
    pool: string;
    d: PoolDetail | null;
    logs?: LogsApi;
    jobs: readonly JobRecord[];
    opened: LogView | LogError | "loading" | null;
    setOpened: (v: LogView | LogError | "loading" | null) => void;
  },
) {
  const runner = d?.runnerLogs === true && !!logs;
  const [list, setList] = useState<LauncherLog[] | null>(null);
  const [lines, setLines] = useState<{ scheduler: string[]; alerts: string[] } | null>(null);
  const [follow, setFollow] = useState(true);
  const openedRef = useRef(opened);
  openedRef.current = opened;

  useEffect(() => {
    if (!runner || !logs) return;
    let live = true;
    const loadList = () =>
      void logs.runnerLogList(pool).then((r) => live && setList(r.logs)).catch(() => {});
    const loadLines = () =>
      void logs.poolLogLines(pool).then((r) => live && setLines(r)).catch(() => {});
    loadList();
    loadLines();
    // While the tab shows: the scheduler / watchdog lines every 5 s, the log list every 30 s.
    const a = setInterval(loadLines, 5000);
    const b = setInterval(loadList, 30_000);
    return () => {
      live = false;
      clearInterval(a);
      clearInterval(b);
    };
  }, [runner, logs, pool]);

  // A live launcher log: append its new lines every 2 s.
  useEffect(() => {
    if (!logs || !opened || opened === "loading" || isErr(opened)) return;
    if (opened.kind !== "runner" || !opened.live || !opened.file) return;
    const id = setInterval(() => {
      const cur = openedRef.current;
      if (!cur || cur === "loading" || isErr(cur) || cur.kind !== "runner") return;
      void logs.runnerLog(pool, cur.file!, { after: cur.end }).then((r) => {
        if (isErr(r) || openedRef.current !== cur) return;
        setOpened({
          ...cur,
          lines: [...cur.lines, ...r.lines].slice(-60_000),
          end: r.end,
          size: r.size,
          live: r.live,
        });
      }).catch(() => {});
    }, 2000);
    return () => clearInterval(id);
  }, [logs, pool, opened !== null && opened !== "loading" && !isErr(opened) && opened.live]);

  const open = (p: Promise<LogView | LogError>) => {
    setOpened("loading");
    setFollow(true);
    void p.then(setOpened).catch(() => setOpened({ error: "The log couldn't be read." }));
  };

  if (opened) {
    if (opened === "loading") {
      return <p class="loading-inline" aria-busy="true">Loading the log…</p>;
    }
    if (isErr(opened)) {
      return (
        <div class="logs-error">
          <p class="banner banner-warn" role="status">{opened.error}</p>
          <button type="button" class="btn" onClick={() => setOpened(null)}>
            Back to the logs
          </button>
        </div>
      );
    }
    const cur = opened;
    return (
      <LogViewer
        view={cur}
        onClose={() => setOpened(null)}
        follow={follow}
        onFollow={setFollow}
        onEarlier={cur.kind === "runner" && cur.file && logs
          ? () =>
            void logs.runnerLog(pool, cur.file!, { before: cur.start }).then((r) => {
              if (isErr(r)) return;
              setOpened({
                ...cur,
                lines: [...r.lines, ...cur.lines].slice(0, 60_000),
                start: r.start,
                truncated: r.truncated,
              });
            })
          : undefined}
      />
    );
  }

  return (
    <div class="logs-tab">
      {runner
        ? (
          <>
            <section class="detail-section">
              <h2 class="lane-title">
                Runner logs{" "}
                <span class="muted small">this machine's launcher logs, newest first</span>
              </h2>
              {list === null
                ? <p class="loading-inline" aria-busy="true">Reading the logs…</p>
                : list.length === 0
                ? <p class="empty">No launcher logs for this pool.</p>
                : (
                  <div class="table-scroll">
                    <table class="data runner-logs">
                      <thead>
                        <tr>
                          <th scope="col">Started</th>
                          <th scope="col" class="num-col">Slot</th>
                          <th scope="col">Runner</th>
                          <th scope="col">Job</th>
                          <th scope="col">Result</th>
                          <th scope="col" class="num-col">Duration</th>
                          <th scope="col" class="num-col">Disk before → after</th>
                          <th scope="col">
                            <span class="visually-hidden">Open</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {list.map((l) => (
                          <tr key={l.file}>
                            <td class="num" title={new Date(l.startedAt).toLocaleString()}>
                              {formatClock(l.startedAt)}
                            </td>
                            <td class="num num-col">{l.slot}</td>
                            <td class="cell-clip" title={l.runner ?? l.file}>{l.runner ?? "–"}</td>
                            <td class="cell-clip" title={l.jobName ?? ""}>
                              {l.jobName ?? "–"}
                              {l.repo && l.runId
                                ? (
                                  <span class="muted small">
                                    · {shortRepo(l.repo)} run {l.runId}
                                  </span>
                                )
                                : null}
                            </td>
                            <td>
                              {l.rc === null
                                ? <span class="muted">{l.jobResult ?? "running / unknown"}</span>
                                : (
                                  <span class={l.rc === 0 ? "text-ok" : "text-bad"}>
                                    <span aria-hidden="true">{l.rc === 0 ? "✓ " : "✕ "}</span>rc={l
                                      .rc}
                                  </span>
                                )}
                            </td>
                            <td class="num num-col">
                              {l.durationMs !== null ? formatDuration(l.durationMs) : "–"}
                            </td>
                            <td class="num num-col">
                              {l.diskBeforeGb !== null ? `${l.diskBeforeGb} GB` : "–"} →{" "}
                              {l.diskAfterGb !== null ? `${l.diskAfterGb} GB` : "–"}
                            </td>
                            <td class="cell-actions">
                              <button
                                type="button"
                                class="ctl"
                                onClick={() => open(logs!.runnerLog(pool, l.file))}
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
            </section>
            <section class="detail-section">
              <h2 class="lane-title">
                Scheduler <span class="muted small">its lines about {pool} · live</span>
              </h2>
              <LinesBox
                lines={lines?.scheduler ?? null}
                empty="No scheduler lines about this pool."
              />
            </section>
            <section class="detail-section">
              <h2 class="lane-title">
                Watchdog alerts <span class="muted small">live</span>
              </h2>
              <LinesBox lines={lines?.alerts ?? null} empty="No alerts about this pool." />
            </section>
          </>
        )
        : (
          <p class="muted small logs-note">
            {d?.pool === "github"
              ? "GitHub-hosted runners keep no logs on this machine: each job's log is on GitHub."
              : "Runner logs need the runner scheduler integration's logsDir setting; GitHub's job logs work without it."}
          </p>
        )}
      <section class="detail-section">
        <h2 class="lane-title">
          GitHub job logs{" "}
          <span class="muted small">fetched on demand, from the shared API budget</span>
        </h2>
        <JobsTable
          jobs={jobs.slice(0, 25)}
          onOpen={() => {}}
          onLog={logs ? (j) => open(logs.jobLog(j.repo, j.id)) : undefined}
          onRunnerLog={runner && logs ? (j) => open(logs.runnerLogForJob(j.id)) : undefined}
        />
      </section>
    </div>
  );
}

/** A short list of log lines, newest at the bottom (already redacted). */
function LinesBox({ lines, empty }: { lines: readonly string[] | null; empty: string }) {
  const ref = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [lines?.length]);
  if (lines === null) return <p class="loading-inline" aria-busy="true">Reading…</p>;
  if (lines.length === 0) return <p class="empty">{empty}</p>;
  return <pre class="lines-box" ref={ref} tabIndex={0}>{lines.join("\n")}</pre>;
}

/** The screen. */
export function PoolDetailView(props: PoolDetailProps) {
  const { detail: d, onBack } = props;
  const [tab, setTab] = useState<"usage" | "logs">(props.initialTab ?? "usage");
  const { onTab } = props;
  useEffect(() => onTab?.(tab), [tab, onTab]);
  const [opened, setOpened] = useState<LogView | LogError | "loading" | null>(null);
  const heading = useRef<HTMLHeadingElement | null>(null);

  // Esc goes back (unless a log is open: then it closes the log first).
  const onKey = useCallback((e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
    e.preventDefault();
    if (opened) setOpened(null);
    else onBack();
  }, [opened, onBack]);
  useEffect(() => {
    if (typeof document === "undefined") return;
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onKey]);
  useEffect(() => {
    if (heading.current && typeof heading.current.focus === "function") heading.current.focus();
  }, []);

  const card = d?.card ?? null;
  const github = props.pool === "github";
  const title = d?.title ?? (github ? "GitHub-hosted" : props.pool);
  const t = d?.history.totals;
  const viewLog = (j: JobRecord) => {
    if (!props.logs) return;
    setTab("logs");
    setOpened("loading");
    void props.logs.jobLog(j.repo, j.id).then(setOpened).catch(() =>
      setOpened({ error: "The log couldn't be fetched." })
    );
  };
  const waited = card?.oldestQueuedSince != null ? props.now - card.oldestQueuedSince : null;

  return (
    <div
      class={`detail pool-${card?.state ?? "unknown"}`}
      onKeyDown={(e) => onKey(e as unknown as KeyboardEvent)}
    >
      <header class="detail-top">
        <button type="button" class="btn" onClick={onBack} aria-label="Back to the dashboard">
          ← Back
        </button>
        <div class="detail-title">
          <h1 class="detail-name" ref={heading} tabIndex={-1}>{title}</h1>
          {card ? <span class={`chip chip-${card.state}`}>{STATE_TEXT[card.state]}</span> : null}
          {card?.reason
            ? <span class="muted small detail-reason" title={card.reason}>{card.reason}</span>
            : null}
        </div>
        <dl class="detail-facts">
          {!github
            ? (
              <div>
                <dt>labels</dt>
                <dd>{d?.labels.length ? d.labels.join(", ") : "–"}</dd>
              </div>
            )
            : null}
          {!github
            ? (
              <div>
                <dt>slots</dt>
                <dd class="num">{card?.slots ?? "–"}</dd>
              </div>
            )
            : null}
          {d?.host
            ? (
              <div>
                <dt>machine</dt>
                <dd>
                  {d.host}
                  {d.shared
                    ? ` (shared with ${d.shared.pools.filter((p) => p !== props.pool).join(", ")})`
                    : ""}
                </dd>
              </div>
            )
            : null}
          <div>
            <dt>busy</dt>
            <dd class="num">
              {card ? (card.slots !== null ? `${card.busy}/${card.slots}` : card.busy) : "–"}
            </dd>
          </div>
          <div>
            <dt>queued</dt>
            <dd class="num">
              {card ? card.queued : "–"}
              {waited !== null
                ? <span class="muted">· oldest {formatDuration(waited)}</span>
                : null}
            </dd>
          </div>
        </dl>
        {props.controls?.onPool && !github
          ? (
            <PoolControls
              pool={props.pool}
              paused={card?.state === "paused"}
              onPool={props.controls.onPool}
            />
          )
          : null}
      </header>
      {props.controls?.message
        ? (
          <p
            class={`banner ${props.controls.message.ok ? "banner-ok" : "banner-warn"}`}
            role="status"
          >
            {props.controls.message.text}
          </p>
        )
        : null}
      {props.error ? <p class="banner banner-warn" role="status">{props.error}</p> : null}

      <div class="tabs" role="tablist" aria-label="Pool detail">
        {(["usage", "logs"] as const).map((k) => (
          <button
            key={k}
            type="button"
            role="tab"
            id={`tab-${k}`}
            class={`tab${tab === k ? " is-active" : ""}`}
            aria-selected={tab === k}
            aria-controls={`panel-${k}`}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                setTab(k === "usage" ? "logs" : "usage");
              }
            }}
          >
            {k === "usage" ? "Usage" : "Logs"}
          </button>
        ))}
      </div>

      {tab === "usage"
        ? (
          <main class="detail-body" role="tabpanel" id="panel-usage" aria-labelledby="tab-usage">
            <div class="detail-bar">
              <div class="range" role="group" aria-label="Range">
                {HISTORY_RANGES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    class={`seg${props.range === r ? " is-on" : ""}`}
                    aria-pressed={props.range === r}
                    onClick={() => props.onRange(r)}
                  >
                    {RANGE_TEXT[r]}
                  </button>
                ))}
              </div>
              {d?.backfilledAt
                ? (
                  <span class="muted small">
                    history before {formatAgo(d.backfilledAt, Date.now())}{" "}
                    rebuilt from the event journal and webhook spool
                  </span>
                )
                : null}
            </div>
            {!d ? <p class="loading-inline" aria-busy="true">Loading the history…</p> : (
              <>
                <div class="stats" aria-label="Summary">
                  {!github
                    ? (
                      <Stat
                        label="slot time busy"
                        value={pct(t!.utilization)}
                        hint="Average busy slots over capacity, over the sampled time"
                      />
                    )
                    : (
                      <Stat
                        label="minutes used"
                        value={String(t!.minutes)}
                        hint="Each job rounded up to a whole minute"
                      />
                    )}
                  <Stat label="jobs finished" value={String(t!.finished)} />
                  <Stat
                    label="failed / cancelled"
                    value={`${t!.failed} / ${t!.cancelled}`}
                  />
                  <Stat
                    label="median · p90"
                    value={`${t!.p50 !== null ? formatDuration(t!.p50) : "–"} · ${
                      t!.p90 !== null ? formatDuration(t!.p90) : "–"
                    }`}
                  />
                  <Stat
                    label="longest wait"
                    value={t!.maxWaitMs ? formatDuration(t!.maxWaitMs) : "–"}
                  />
                  <Stat
                    label="avg queue wait"
                    value={t!.avgWaitMs !== null ? formatDuration(t!.avgWaitMs) : "–"}
                  />
                </div>
                <UsageCharts d={d} />
                <section class="detail-section">
                  <h2 class="lane-title">Recent jobs</h2>
                  <JobsTable
                    jobs={d.jobs}
                    onOpen={props.onOpen}
                    onLog={props.logs ? viewLog : undefined}
                  />
                </section>
                <section class="detail-section">
                  <h2 class="lane-title">Recent events</h2>
                  <EventsList d={d} onOpen={props.onOpen} />
                </section>
              </>
            )}
          </main>
        )
        : (
          <main class="detail-body" role="tabpanel" id="panel-logs" aria-labelledby="tab-logs">
            <LogsTab
              pool={props.pool}
              d={d}
              logs={props.logs}
              jobs={d?.jobs ?? []}
              opened={opened}
              setOpened={setOpened}
            />
          </main>
        )}
    </div>
  );
}
