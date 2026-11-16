"use client";
// The main screen, from a Snapshot and the current time: the pool strip, the Running and Queued
// lanes (repo → run → job), and the side column (alerts, recently finished). Presentational: the
// data and the clock come in as props, links go out through `onOpen`, so the tests render it with
// fixture data.

import { type ReactNode, useState } from "denext";
import { jobWarning, poolIsFull } from "../lib/classify.ts";
import { RATE_LOW, RATE_SLOW, slowText } from "../lib/budget.ts";
import type { FleetEvent } from "../lib/events.ts";
import {
  formatAgo,
  formatClock,
  formatCount,
  formatDuration,
  shortRepo,
  shortRunner,
} from "../lib/format.ts";
import { EventLog } from "./event-log.tsx";
import { type ControlHandlers, PoolControls, RunControls } from "./controls.tsx";
import type { FinishedJob, JobRow, PoolCard, RepoGroup, RunGroup, Snapshot } from "../lib/model.ts";
import { type FreshState, statusFreshness } from "../lib/status-line.ts";

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
  /** Controls (cancel, re-run, dispatch; pools with the scheduler integration). Absent: none. */
  readonly controls?: ControlHandlers;
  /** The dispatch panel, when open (rendered above the lanes). */
  readonly dispatchPanel?: unknown;
  /** Open the Settings view (the header's Settings button). Absent: no button. */
  readonly onSettings?: () => void;
  /** Open a pool's detail screen (a click on its card, or its name). Absent: cards don't open. */
  readonly onPoolDetail?: (pool: string) => void;
}

/** The header's owner line: the watched owners (`a, b`), then `· Actions`. */
export function ownerLine(owners: readonly string[] | undefined): string {
  const list = owners ?? [];
  if (list.length === 0) return "GitHub Actions";
  const shown = list.length > 3
    ? `${list.slice(0, 3).join(", ")} +${list.length - 3}`
    : list.join(", ");
  return `${shown} · Actions`;
}

/** A link that leaves the app: an anchor (copyable, focusable) whose click goes to `onOpen`. */
function Out(
  props: {
    href: string | null;
    onOpen: (url: string) => void;
    class?: string;
    title?: string;
    children: ReactNode;
  },
) {
  if (!props.href) return <span class={props.class} title={props.title}>{props.children}</span>;
  const href = props.href;
  return (
    <a
      class={props.class}
      title={props.title}
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

/** A running job with the run it belongs to: one row of a pool's runner breakdown. */
export interface RunnerEntry {
  readonly job: JobRow;
  readonly repo: string;
  readonly workflow: string;
}

/** The Running lane's jobs by pool id, oldest first (a pool card's busy runners). */
export function runnersByPool(groups: readonly RepoGroup[]): Map<string, RunnerEntry[]> {
  const out = new Map<string, RunnerEntry[]>();
  for (const g of groups) {
    for (const r of g.runs) {
      for (const job of r.jobs) {
        const list = out.get(job.pool) ?? [];
        list.push({ job, repo: g.repo, workflow: r.workflow });
        out.set(job.pool, list);
      }
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.job.since - b.job.since);
  return out;
}

/**
 * One runner: its name (GitHub's as the image label and `#id`, trimmed with the full name as a
 * tooltip), its state, elapsed, and the job it runs (repo · workflow · job).
 */
function RunnerRow(
  { r, now, onOpen }: { r: RunnerEntry; now: number; onOpen: (u: string) => void },
) {
  const { job } = r;
  const warn = jobWarning(job, now);
  const id = job.runner ? shortRunner(job.runner) : null;
  const label = job.image ?? id ?? "assigning…";
  const where = job.hosting ?? `${shortRepo(r.repo)} · ${r.workflow} · ${job.name}`;
  return (
    <li class={`runner${warn ? " runner-warn" : ""}`}>
      <span class="runner-name" title={job.runner ?? label}>
        {label}
        {job.image && id ? <span class="runner-id">{id}</span> : null}
      </span>
      <span class="runner-state">
        {warn ? "over usual" : job.hosting !== undefined ? "hosting" : "running"}
      </span>
      <span class="runner-time num" title="elapsed">{formatDuration(now - job.since)}</span>
      <Out href={job.url} onOpen={onOpen} class="runner-job" title={where}>{where}</Out>
    </li>
  );
}

function RunnerList(
  { runners, now, onOpen, empty }: {
    runners: readonly RunnerEntry[];
    now: number;
    onOpen: (u: string) => void;
    empty: string;
  },
) {
  return runners.length === 0 ? <p class="runners-empty muted">{empty}</p> : (
    <ul class="runners">
      {runners.map((r) => <RunnerRow key={r.job.id} r={r} now={now} onOpen={onOpen} />)}
    </ul>
  );
}

/** Whether a click landed on one of the card's own controls (a button, link or field). */
function onControl(target: EventTarget | null): boolean {
  let el = target as { tagName?: string; parentElement?: unknown } | null;
  while (el && el.tagName) {
    if (/^(BUTTON|A|INPUT|SELECT|TEXTAREA|LABEL)$/.test(el.tagName)) return true;
    el = el.parentElement as typeof el;
  }
  return false;
}

function PoolCardView(
  { pool, now, onPool, runners, onOpen, onDetail }: {
    pool: PoolCard;
    now: number;
    onPool?: ControlHandlers["onPool"];
    runners: readonly RunnerEntry[];
    onOpen: (u: string) => void;
    onDetail?: () => void;
  },
) {
  const [open, setOpen] = useState(false);
  const github = pool.id === "github";
  const waited = pool.oldestQueuedSince === null ? null : now - pool.oldestQueuedSince;
  const lateQueue = waited !== null && waited > 15 * 60_000;
  const lateClass = lateQueue ? (poolIsFull(pool) ? " is-capacity" : " is-late") : "";
  const hostFull = poolIsFull(pool) && pool.busy < (pool.slots ?? 0);
  const load = pool.slots === null
    ? ""
    : `${pool.busy}/${pool.slots}${
      pool.host && pool.hostSlots !== undefined
        ? ` · host ${pool.hostBusy}/${pool.hostSlots}${hostFull ? " full" : ""}`
        : ""
    }`;
  // A self-hosted card stays compact; its busy runners open on demand (the card widens).
  const expanded = github || (open && runners.length > 0);
  const Tag = github ? "div" : "li";
  return (
    <Tag
      class={`pool pool-${pool.state}${github ? " pool-github" : ""}${
        expanded && !github ? " pool-open" : ""
      }${onDetail ? " pool-clickable" : ""}`}
      onClick={onDetail
        ? (e) => {
          if (!onControl(e.target)) onDetail();
        }
        : undefined}
    >
      <div class="pool-head">
        {onDetail
          ? (
            <button
              type="button"
              class="pool-name pool-link"
              title={`${pool.title}: usage history and logs`}
              aria-label={`${pool.title}: open the usage history and logs`}
              onClick={onDetail}
            >
              {pool.title}
            </button>
          )
          : <span class="pool-name" title={pool.title}>{pool.title}</span>}
        <span class={`chip chip-${pool.state}`}>{STATE_TEXT[pool.state]}</span>
      </div>
      <div class="pool-load">
        <Pips busy={pool.busy} slots={pool.slots} />
        {!github && runners.length > 0
          ? (
            <button
              type="button"
              class="pool-toggle num"
              aria-expanded={open}
              title={open ? "Hide the busy runners" : "Show the busy runners"}
              onClick={() => setOpen(!open)}
            >
              {load} <span aria-hidden="true">{open ? "▴" : "▾"}</span>
            </button>
          )
          : <span class="num">{load}</span>}
      </div>
      <div class={`pool-wait${lateClass}`}>
        {waited === null ? <span class="muted">nothing queued</span> : (
          <>
            <span class="num">{pool.queued}</span> queued · oldest{" "}
            <span class="num">{formatDuration(waited)}</span>
          </>
        )}
      </div>
      {pool.reason ? <div class="pool-reason" title={pool.reason}>{pool.reason}</div> : null}
      {expanded
        ? (
          <RunnerList
            runners={runners}
            now={now}
            onOpen={onOpen}
            empty="No GitHub-hosted jobs running."
          />
        )
        : null}
      {onPool && !github
        ? <PoolControls pool={pool.id} paused={pool.state === "paused"} onPool={onPool} />
        : null}
    </Tag>
  );
}

function JobLine({ job, now, onOpen }: { job: JobRow; now: number; onOpen: (u: string) => void }) {
  const warn = jobWarning(job, now);
  const age = Math.max(0, now - job.since);
  return (
    <li class={`job${warn ? ` job-${warn}` : ""}`}>
      <Out href={job.url} onOpen={onOpen} class="job-name" title={job.name}>{job.name}</Out>
      <span
        class={`chip chip-pool${job.target === "github" ? " chip-gh" : ""}`}
        title={job.image ?? job.pool}
      >
        {job.pool === "github" ? "GitHub" : job.pool}
        {job.helper ? " (GitHub helper)" : ""}
      </span>
      <span class="job-runner" title={job.hosting ?? job.runner ?? ""}>
        {job.hosting ?? (job.runner ? shortRunner(job.runner) : "")}
      </span>
      <span class="job-time num" title={job.lane === "running" ? "elapsed" : "waited"}>
        {formatDuration(age)}
        {job.usualMs !== null && job.lane === "running"
          ? <span class="usual">/ ~{formatDuration(job.usualMs)}</span>
          : null}
      </span>
      {warn
        ? (
          <span class="warn-tag">
            {warn === "queued-long"
              ? "queued > 15m"
              : warn === "queued-capacity"
              ? "waiting for a free slot (pool full)"
              : "over usual"}
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
        <Out href={run.url} onOpen={onOpen} class="run-name" title={run.workflow}>
          {run.workflow}
        </Out>
        <span class={`branch${run.defaultBranch ? " branch-default" : ""}`} title={run.branch}>
          {run.defaultBranch ? <span class="diamond" aria-label="default branch">◆</span> : null}
          {run.branch}
        </span>
        {run.forkOwner !== undefined
          ? (
            <span class="fork-chip" title={`fork PR from ${run.forkOwner}`}>
              fork PR from {run.forkOwner}
            </span>
          )
          : null}
        <span class="sha">{run.sha}</span>
        <span class="event">{run.event.replace(/_/g, " ")}</span>
        {run.ci
          ? (
            <span class="event ci-owner" title={`dispatched through ci by ${run.ci.owner}`}>
              {run.ci.owner}
              {run.ci.purpose ? ` · ${run.ci.purpose}` : ""}
            </span>
          )
          : null}
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

/** An empty lane's line: a live dot while webhooks are live, muted while the data is behind. */
function EmptyLane({ text, fresh }: { text: string; fresh?: FreshState }) {
  if (fresh === "live") {
    return (
      <p class="empty empty-live" title="Live: GitHub webhooks deliver changes as they happen.">
        <span class="live-dot" aria-hidden="true" />
        {text}
      </p>
    );
  }
  if (fresh === "behind") {
    return <p class="empty empty-stale" title="Fleet's data may be behind.">{text}</p>;
  }
  return <p class="empty">{text}</p>;
}

function LaneView(
  props: {
    title: string;
    groups: readonly RepoGroup[];
    now: number;
    onOpen: (u: string) => void;
    empty: string;
    /** How current the data is: an empty lane says it's live, or that it may be behind. */
    fresh?: FreshState;
    controls?: ControlHandlers;
    /** Empty: shrink to a narrow column so the other lane gets the width. */
    collapsible?: boolean;
  },
) {
  const count = props.groups.reduce((n, g) => n + g.runs.reduce((k, r) => k + r.jobs.length, 0), 0);
  const collapsed = props.collapsible === true && props.groups.length === 0;
  return (
    <section class={`lane${collapsed ? " lane-collapsed" : ""}`} aria-label={props.title}>
      <h2 class="lane-title">
        {props.title} <span class="num lane-count">{count}</span>
      </h2>
      {props.groups.length === 0
        ? <EmptyLane text={props.empty} fresh={props.fresh} />
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

/** An alert line: clamped to three lines, the full text as a tooltip; a click expands it. */
function AlertLine({ a }: { a: Snapshot["alerts"][number] }) {
  const [open, setOpen] = useState(false);
  return (
    <li class={`alert${open ? " is-open" : ""}`}>
      <span class="num alert-at">{formatClock(a.at)}</span>
      <span class="chip chip-pool alert-pool" title={a.pool}>{a.pool}</span>
      <button
        type="button"
        class="alert-msg"
        title={a.msg}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span class="alert-text">{a.msg}</span>
      </button>
    </li>
  );
}

/**
 * "hooks: live / stale (last delivery N min ago) / off"; "quiet" instead of "stale" when nothing is
 * running or queued (no delivery was due: not a fault).
 */
function HooksBadge(
  { hooks, now, quiet }: { hooks: Snapshot["hooks"]; now: number; quiet: boolean },
) {
  const via = hooks.via === "spool" ? " (via receiver)" : "";
  const last = hooks.lastDeliveryAt === null
    ? "no delivery yet"
    : `last delivery ${Math.floor((now - hooks.lastDeliveryAt) / 60_000)} min ago`;
  const text = hooks.state === "live"
    ? `hooks: live${via}`
    : hooks.state === "stale"
    ? `hooks: ${quiet ? "quiet" : "stale"} (${last})`
    : "hooks: off";
  const cls = hooks.state === "stale" && quiet ? "quiet" : hooks.state;
  return (
    <span class={`hooks hooks-${cls}`} title="GitHub webhooks (polling reconciles)">
      <span class="hooks-dot" aria-hidden="true" />
      {text}
    </span>
  );
}

/**
 * How current the data is: "live · last event 2m ago" while webhooks are live, else "updated 4m
 * ago" (the later of the last poll and the last delivery), muted when a poll is overdue or webhooks
 * went quiet with jobs active.
 */
function Freshness({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const f = statusFreshness(snapshot, now);
  const p = snapshot.poll;
  const polled = p.lastSuccessAt === null
    ? "no poll yet"
    : `last poll ${formatAgo(p.lastSuccessAt, now)}`;
  if (f.state === "pending" || f.updatedAt === null) return <span>polling…</span>;
  if (f.state === "live") {
    // The webhook badge is hidden while this shows: its details are here.
    const hooks = snapshot.hooks;
    const last = hooks.lastDeliveryAt ?? f.updatedAt;
    const via = hooks.via === "spool" ? " via the standalone receiver" : "";
    return (
      <span
        class="status-live"
        title={`GitHub webhooks: live${via}; last delivery at ${formatClock(last)} (${
          formatAgo(last, now)
        }). Polling reconciles (${polled}).`}
      >
        <span class="live-dot" aria-hidden="true" />
        live · last event {formatAgo(last, now)}
      </span>
    );
  }
  if (f.state === "behind") {
    return (
      <span class="status-stale" title={`Fleet's data may be behind (${polled}).`}>
        updated {formatAgo(f.updatedAt, now)}
      </span>
    );
  }
  return <span title={polled}>updated {formatAgo(f.updatedAt, now)}</span>;
}

/** The status line: last poll, back-off, rate limit. */
function StatusLine({ snapshot, now }: { snapshot: Snapshot; now: number }) {
  const p = snapshot.poll;
  const fresh = statusFreshness(snapshot, now);
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
        : <Freshness snapshot={snapshot} now={now} />}
      <span class="muted">every {Math.round(p.intervalMs / 1000)}s</span>
      {fresh.state === "live"
        ? null
        : <HooksBadge hooks={snapshot.hooks} now={now} quiet={fresh.hooksQuiet} />}
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

/** A stable empty list, so the memoized log isn't re-rendered by a fresh `[]` each tick. */
const NO_EVENTS: readonly FleetEvent[] = [];

/** The screen. */
export function FleetView(props: FleetViewProps) {
  const { snapshot: s, now: localNow, onOpen } = props;
  // Job, queue and "finished" ages are of GitHub's timestamps: aged on GitHub's clock. The status
  // line (last poll, back-off, last delivery) is this machine's.
  const now = localNow + (s.clockOffsetMs ?? 0);
  const sum = s.summary;
  const busy = runnersByPool(s.running);
  const github = s.pools.find((p) => p.id === "github");
  const hosts = s.pools.filter((p) => p.id !== "github");
  // The status line's clock is this machine's (poll and delivery times are local).
  const fresh = statusFreshness(s, localNow).state;
  return (
    <div class={`fleet sev-${sum.severity}`}>
      <div class="stripe" aria-hidden="true" />
      <header class="top">
        <div class="brand">
          <span class="wordmark">Fleet</span>
          <span class="org" title={(s.owners ?? []).join(", ")}>{ownerLine(s.owners)}</span>
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
          <StatusLine snapshot={s} now={localNow} />
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
          {props.onSettings
            ? (
              <button type="button" class="btn" onClick={props.onSettings}>
                Settings
              </button>
            )
            : null}
        </div>
      </header>

      <section class="pools-wrap" aria-label="Runner pools">
        <div class="pools-row">
          <ul class="pools">
            {hosts.map((p) => (
              <PoolCardView
                key={p.id}
                pool={p}
                now={now}
                onPool={props.controls?.onPool}
                runners={busy.get(p.id) ?? []}
                onOpen={onOpen}
                onDetail={props.onPoolDetail ? () => props.onPoolDetail!(p.id) : undefined}
              />
            ))}
          </ul>
          {github
            ? (
              <PoolCardView
                pool={github}
                now={now}
                runners={busy.get("github") ?? []}
                onOpen={onOpen}
                onDetail={props.onPoolDetail ? () => props.onPoolDetail!("github") : undefined}
              />
            )
            : null}
        </div>
        {props.controls?.onPool &&
            (props.controls.scheduler?.restart !== false ||
              props.controls.scheduler?.watchdog !== false)
          ? (
            <p class="pool-fleet">
              <span class="muted small">Runner scheduler (this machine):</span>
              {props.controls.scheduler?.restart !== false
                ? (
                  <button
                    type="button"
                    class="ctl"
                    onClick={() => props.controls!.onPool!({ kind: "restart-scheduler" })}
                  >
                    Restart scheduler
                  </button>
                )
                : null}
              {props.controls.scheduler?.watchdog !== false
                ? (
                  <button
                    type="button"
                    class="ctl"
                    onClick={() => props.controls!.onPool!({ kind: "watchdog-pass" })}
                  >
                    Run watchdog pass now
                  </button>
                )
                : null}
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
      <main class={`lanes${s.queued.length === 0 ? " lanes-q-empty" : ""}`}>
        <LaneView
          title="Running"
          groups={s.running}
          now={now}
          onOpen={onOpen}
          empty="Nothing running."
          fresh={fresh}
          controls={props.controls}
        />
        <LaneView
          title="Queued"
          groups={s.queued}
          now={now}
          onOpen={onOpen}
          empty="Nothing queued."
          fresh={fresh}
          controls={props.controls}
          collapsible
        />
        <aside class="side">
          <section>
            <h2 class="lane-title">Alerts</h2>
            {s.alerts.length === 0
              ? (
                <p class="empty">
                  {s.health.state === "ok" || s.health.state === "stale"
                    ? "No recent alerts."
                    : s.health.message
                    ? "No alerts (pool health unavailable)."
                    : "No alerts."}
                </p>
              )
              : (
                <ul class="alerts">
                  {s.alerts.map((a, i) => <AlertLine key={`${a.at}-${i}`} a={a} />)}
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
      <EventLog events={props.events ?? NO_EVENTS} onOpen={onOpen} />
    </div>
  );
}
