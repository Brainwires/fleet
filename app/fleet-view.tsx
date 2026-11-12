"use client";
// The main screen, from a Snapshot and the current time: the pool strip, the Running and Queued
// lanes (repo → run → job), and the side column (alerts, recently finished). Presentational: the
// data and the clock come in as props, links go out through `onOpen`, so the tests render it with
// fixture data.

import type { ReactNode } from "denext";
import { jobWarning } from "../lib/classify.ts";
import { RATE_LOW, RATE_SLOW, slowText } from "../lib/budget.ts";
import type { FleetEvent } from "../lib/events.ts";
import { formatAgo, formatClock, formatCount, formatDuration, shortRepo } from "../lib/format.ts";
import { EventLog } from "./event-log.tsx";
import { type ControlHandlers, PoolControls, RunControls } from "./controls.tsx";
import type { FinishedJob, JobRow, PoolCard, RepoGroup, RunGroup, Snapshot } from "../lib/model.ts";

/** The view's props. */
export interface FleetViewProps {
  readonly snapshot: Snapshot;
  readonly now: number;
  /** Open a github.com page in the system browser. */
  readonly onOpen: (url: string) => void;
  readonly onRefresh: () => void;
  readonly refreshing?: boolean;
  /** The event log, oldest first. */
  readonly events?: readonly FleetEvent[];
  /** Controls (cancel, re-run, dispatch; pools on the Mac mini). Absent: none shown. */
  readonly controls?: ControlHandlers;
  /** The dispatch panel, when open (rendered above the lanes). */
  readonly dispatchPanel?: unknown;
}

/** A link that leaves the app: an anchor (copyable, focusable) whose click goes to `onOpen`. */
function Out(
  props: {
    href: string | null;
    onOpen: (url: string) => void;
    class?: string;
    children: ReactNode;
  },
) {
  if (!props.href) return <span class={props.class}>{props.children}</span>;
  const href = props.href;
  return (
    <a
      class={props.class}
      href={href}
      onClick={(e) => {
        e.preventDefault();
        props.onOpen(href);
      }}
    >
      {props.children}
    </a>
  );
}

function Pips({ busy, slots }: { busy: number; slots: number | null }) {
  if (slots === null) {
    return <span class="pips pips-open" aria-label={`${busy} running`}>{busy} active</span>;
  }
  const n = Math.max(slots, busy);
  return (
    <span class="pips" role="img" aria-label={`${busy} of ${slots} slots busy`}>
      {Array.from(
        { length: n },
        (_, i) => (
          <span
            class={`pip${i < busy ? " pip-on" : ""}${i >= slots ? " pip-over" : ""}`}
          />
        ),
      )}
    </span>
  );
}

const STATE_TEXT: Record<PoolCard["state"], string> = {
  ok: "ok",
  paused: "paused",
  unhealthy: "unhealthy",
  unknown: "no health",
};

function PoolCardView(
  { pool, now, onPool }: { pool: PoolCard; now: number; onPool?: ControlHandlers["onPool"] },
) {
  const waited = pool.oldestQueuedSince === null ? null : now - pool.oldestQueuedSince;
  const lateQueue = waited !== null && waited > 15 * 60_000;
  return (
    <li class={`pool pool-${pool.state}${pool.id === "github" ? " pool-github" : ""}`}>
      <div class="pool-head">
        <span class="pool-name">{pool.title}</span>
        <span class={`chip chip-${pool.state}`}>{STATE_TEXT[pool.state]}</span>
      </div>
      <div class="pool-load">
        <Pips busy={pool.busy} slots={pool.slots} />
        <span class="num">
          {pool.slots === null ? "" : `${pool.busy}/${pool.slots}`}
        </span>
      </div>
      <div class={`pool-wait${lateQueue ? " is-late" : ""}`}>
        {waited === null ? <span class="muted">nothing queued</span> : (
          <>
            <span class="num">{pool.queued}</span> queued · oldest{" "}
            <span class="num">{formatDuration(waited)}</span>
          </>
        )}
      </div>
      {pool.reason ? <div class="pool-reason" title={pool.reason}>{pool.reason}</div> : null}
      {onPool && pool.id !== "github"
        ? <PoolControls pool={pool.id} paused={pool.state === "paused"} onPool={onPool} />
        : null}
    </li>
  );
}

function JobLine({ job, now, onOpen }: { job: JobRow; now: number; onOpen: (u: string) => void }) {
  const warn = jobWarning(job, now);
  const age = Math.max(0, now - job.since);
  return (
    <li class={`job${warn ? ` job-${warn}` : ""}`}>
      <Out href={job.url} onOpen={onOpen} class="job-name">{job.name}</Out>
      <span class={`chip chip-pool${job.target === "github" ? " chip-gh" : ""}`}>
        {job.pool === "github" ? "GitHub" : job.pool}
      </span>
      <span class="job-runner" title={job.runner ?? ""}>{job.runner ?? ""}</span>
      <span class="job-time num" title={job.lane === "running" ? "elapsed" : "waited"}>
        {formatDuration(age)}
        {job.usualMs !== null && job.lane === "running"
          ? <span class="usual">/ ~{formatDuration(job.usualMs)}</span>
          : null}
      </span>
      {warn
        ? (
          <span class="warn-tag">
            {warn === "queued-long" ? "queued > 15m" : "over usual"}
          </span>
        )
        : null}
    </li>
  );
}

function RunBlock(
  { run, now, onOpen, controls }: {
    run: RunGroup;
    now: number;
    onOpen: (u: string) => void;
    controls?: ControlHandlers;
  },
) {
  return (
    <section class={`run${run.defaultBranch ? " run-default" : ""}`}>
      <header class="run-head">
        <Out href={run.url} onOpen={onOpen} class="run-name">{run.workflow}</Out>
        <span class={`branch${run.defaultBranch ? " branch-default" : ""}`} title={run.branch}>
          {run.defaultBranch ? <span class="diamond" aria-label="default branch">◆</span> : null}
          {run.branch}
        </span>
        <span class="sha">{run.sha}</span>
        <span class="event">{run.event.replace(/_/g, " ")}</span>
        {controls ? <RunControls repo={run.repo} runId={run.id} c={controls} /> : null}
      </header>
      {run.pendingJobs ? <p class="run-pending">queued, no jobs yet</p> : (
        <ul class="jobs">
          {run.jobs.map((j) => <JobLine key={j.id} job={j} now={now} onOpen={onOpen} />)}
        </ul>
      )}
    </section>
  );
}

function LaneView(
  props: {
    title: string;
    groups: readonly RepoGroup[];
    now: number;
    onOpen: (u: string) => void;
    empty: string;
    controls?: ControlHandlers;
  },
) {
  const count = props.groups.reduce((n, g) => n + g.runs.reduce((k, r) => k + r.jobs.length, 0), 0);
  return (
    <section class="lane" aria-label={props.title}>
      <h2 class="lane-title">
        {props.title} <span class="num lane-count">{count}</span>
      </h2>
      {props.groups.length === 0
        ? <p class="empty">{props.empty}</p>
        : props.groups.map((g) => (
          <div class="repo" key={g.repo}>
            <h3 class="repo-name">{shortRepo(g.repo)}</h3>
            {g.runs.map((r) => (
              <RunBlock
                key={r.id}
                run={r}
                now={props.now}
                onOpen={props.onOpen}
                controls={props.controls}
              />
            ))}
          </div>
        ))}
    </section>
  );
}

const CONCLUSION: Record<string, { glyph: string; cls: string }> = {
  success: { glyph: "✓", cls: "ok" },
  failure: { glyph: "✕", cls: "bad" },
  timed_out: { glyph: "✕", cls: "bad" },
  startup_failure: { glyph: "✕", cls: "bad" },
  cancelled: { glyph: "⊘", cls: "dim" },
};

function FinishedLine(
  { f, now, onOpen, controls }: {
    f: FinishedJob;
    now: number;
    onOpen: (u: string) => void;
    controls?: ControlHandlers;
  },
) {
  const c = CONCLUSION[f.conclusion] ?? { glyph: "•", cls: "dim" };
  return (
    <li class={`done done-${c.cls}${f.defaultBranch ? " done-default" : ""}`}>
      <span class={`glyph glyph-${c.cls}`} aria-label={f.conclusion}>{c.glyph}</span>
      <Out href={f.url} onOpen={onOpen} class="done-name">{f.name}</Out>
      <span class="done-meta">
        {shortRepo(f.repo)} · {f.defaultBranch ? "◆ " : ""}
        {f.branch}
      </span>
      <span class="num done-when">
        {formatAgo(f.completedAt, now)}
        {controls && f.conclusion !== "success"
          ? (
            <button
              type="button"
              class="ctl"
              onClick={() =>
                controls.onControl({
                  kind: "rerun-job",
                  repo: f.repo,
                  runId: f.runId,
                  jobId: f.id,
                })}
            >
              Re-run
            </button>
          )
          : null}
      </span>
    </li>
  );
}

/** "hooks: live / stale (last delivery N min ago) / off". */
function HooksBadge({ hooks, now }: { hooks: Snapshot["hooks"]; now: number }) {
  const via = hooks.via === "spool" ? " (via receiver)" : "";
  const text = hooks.state === "live"
    ? `hooks: live${via}`
    : hooks.state === "stale"
    ? `hooks: stale (${
      hooks.lastDeliveryAt === null
        ? "no delivery yet"
        : `last delivery ${Math.floor((now - hooks.lastDeliveryAt) / 60_000)} min ago`
    })`
    : "hooks: off";
  return (
    <span class={`hooks hooks-${hooks.state}`} title="GitHub webhooks (polling reconciles)">
      <span class="hooks-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/** The status line: last poll, back-off, rate limit. */
function StatusLine({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const p = snapshot.poll;
  const rate = snapshot.rate;
  // Amber below 1,500 left (polling slowed), red below 800 (the runner scheduler's share at risk).
  const rateClass = rate === null
    ? ""
    : rate.limit > 1000 && rate.remaining < RATE_LOW
    ? " status-bad"
    : rate.limit > 1000 && rate.remaining < RATE_SLOW
    ? " status-warn"
    : "";
  return (
    <div class="status">
      {p.backoffUntil !== null
        ? (
          <span class="status-bad">
            backing off · retry in <span class="num">{formatDuration(p.backoffUntil - now)}</span>
          </span>
        )
        : !p.ok
        ? <span class="status-bad">poll failed: {p.message}</span>
        : (
          <span>
            {p.lastSuccessAt === null ? "polling…" : `updated ${formatAgo(p.lastSuccessAt, now)}`}
          </span>
        )}
      <span class="muted">every {Math.round(p.intervalMs / 1000)}s</span>
      <HooksBadge hooks={snapshot.hooks} now={now} />
      {rate
        ? (
          <span
            class={`rate${rateClass}`}
            title="GitHub API requests left this hour"
          >
            API <span class="num">{formatCount(rate.remaining)}</span>/
            <span class="num">{formatCount(rate.limit)}</span>
          </span>
        )
        : null}
    </div>
  );
}

/** The screen. */
export function FleetView(props: FleetViewProps) {
  const { snapshot: s, now, onOpen } = props;
  const sum = s.summary;
  return (
    <div class={`fleet sev-${sum.severity}`}>
      <div class="stripe" aria-hidden="true" />
      <header class="top">
        <div class="brand">
          <span class="wordmark">Fleet</span>
          <span class="org">Brainwires · Actions</span>
        </div>
        <div class="counts" aria-live="polite">
          <span class="count count-run">
            <span class="num">{sum.running}</span> running
          </span>
          <span class="count count-q">
            <span class="num">{sum.queued}</span> queued
          </span>
          {sum.reasons.length
            ? <span class={`reasons sev-text-${sum.severity}`}>{sum.reasons.join(" · ")}</span>
            : <span class="reasons muted">all clear</span>}
        </div>
        <div class="top-right">
          <StatusLine snapshot={s} now={now} />
          {s.auth === "public" ? <span class="chip chip-paused">public data only</span> : null}
          {props.controls?.onDispatch
            ? (
              <button type="button" class="btn" onClick={props.controls.onDispatch}>
                Dispatch…
              </button>
            )
            : null}
          <button
            type="button"
            class="btn"
            onClick={props.onRefresh}
            disabled={props.refreshing === true}
          >
            {props.refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
      </header>

      <section class="pools-wrap" aria-label="Runner pools">
        <ul class="pools">
          {s.pools.map((p) => (
            <PoolCardView key={p.id} pool={p} now={now} onPool={props.controls?.onPool} />
          ))}
        </ul>
        {props.controls?.onPool
          ? (
            <p class="pool-fleet">
              <span class="muted small">Runner scheduler (this machine):</span>
              <button
                type="button"
                class="ctl"
                onClick={() => props.controls!.onPool!({ kind: "restart-scheduler" })}
              >
                Restart scheduler
              </button>
              <button
                type="button"
                class="ctl"
                onClick={() => props.controls!.onPool!({ kind: "watchdog-pass" })}
              >
                Run watchdog pass now
              </button>
            </p>
          )
          : null}
        {s.health.message
          ? <p class={`health-note health-${s.health.state}`}>{s.health.message}</p>
          : null}
      </section>

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
      {props.dispatchPanel as never}
      {s.poll.slow
        ? (
          <p class={`banner banner-${s.poll.slow === "budget" ? "warn" : "bad"}`} role="status">
            {slowText(s.poll.slow)}
          </p>
        )
        : null}
      <main class="lanes">
        <LaneView
          title="Running"
          groups={s.running}
          now={now}
          onOpen={onOpen}
          empty="Nothing running."
          controls={props.controls}
        />
        <LaneView
          title="Queued"
          groups={s.queued}
          now={now}
          onOpen={onOpen}
          empty="Nothing queued."
          controls={props.controls}
        />
        <aside class="side">
          <section>
            <h2 class="lane-title">Alerts</h2>
            {s.alerts.length === 0
              ? (
                <p class="empty">
                  {s.health.state === "ok" || s.health.state === "stale"
                    ? "No recent alerts."
                    : "No alerts (pool health unavailable)."}
                </p>
              )
              : (
                <ul class="alerts">
                  {s.alerts.map((a, i) => (
                    <li key={`${a.at}-${i}`} class="alert">
                      <span class="num alert-at">{formatClock(a.at)}</span>
                      <span class="chip chip-pool">{a.pool}</span>
                      <span class="alert-msg">{a.msg}</span>
                    </li>
                  ))}
                </ul>
              )}
          </section>
          <section>
            <h2 class="lane-title">
              Finished <span class="muted small">last 30 min</span>
            </h2>
            {s.finished.length === 0
              ? <p class="empty">Nothing finished in the last 30 minutes.</p>
              : (
                <ul class="finished">
                  {s.finished.map((f) => (
                    <FinishedLine
                      key={f.id}
                      f={f}
                      now={now}
                      onOpen={onOpen}
                      controls={props.controls}
                    />
                  ))}
                </ul>
              )}
          </section>
        </aside>
      </main>
      <EventLog events={props.events ?? []} onOpen={onOpen} />
    </div>
  );
}
