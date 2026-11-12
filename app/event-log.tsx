"use client";
// The event log pane: one line per event, newest at the bottom, following new lines unless the user
// scrolled up. Each line: local time, a severity mark (colour AND glyph), repo, workflow / job, the
// text, and a link to github.com. Filters: severity (all / problems), repo, text search.

import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "denext";
import { type FleetEvent, isProblem } from "../lib/events.ts";
import { shortRepo, shortRunner } from "../lib/format.ts";

/** A severity's glyph and label (never colour alone). */
export const SEV_MARK: Record<FleetEvent["sev"], { glyph: string; label: string }> = {
  ok: { glyph: "✓", label: "ok" },
  bad: { glyph: "✕", label: "problem" },
  warn: { glyph: "▲", label: "warning" },
  info: { glyph: "•", label: "info" },
  muted: { glyph: "⊘", label: "cancelled or skipped" },
};

const pad = (n: number) => String(n).padStart(2, "0");
/** `14:05:09`, local. */
export function logTime(at: number): string {
  const d = new Date(at);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * A line's text for the log's narrow column: a job start (`started on <pool> on <runner>`, as the
 * events record it) reads `started · <pool>` with the runner apart, so the view trims the runner
 * alone (full name as a tooltip); GitHub-hosted reads `GitHub`. Any other text is kept as is.
 */
export function eventText(text: string): { text: string; runner: string | null } {
  const m = /^started on (\S+)(?: on (.+))?$/.exec(text);
  if (!m) return { text, runner: null };
  const pool = m[1] === "GitHub-hosted" ? "GitHub" : m[1];
  return { text: `started · ${pool}`, runner: m[2] ?? null };
}

/** The filters. */
export interface LogFilter {
  readonly severity: "all" | "problems";
  readonly repo: string;
  readonly query: string;
}

/** The events a filter keeps. */
export function filterEvents(events: readonly FleetEvent[], f: LogFilter): FleetEvent[] {
  const q = f.query.trim().toLowerCase();
  return events.filter((e) =>
    (f.severity === "all" || isProblem(e)) &&
    (f.repo === "" || e.repo === f.repo) &&
    (q === "" ||
      `${e.repo} ${e.workflow} ${e.job ?? ""} ${e.text} ${e.branch ?? ""}`.toLowerCase()
        .includes(q))
  );
}

/** The pane's props. */
export interface EventLogProps {
  readonly events: readonly FleetEvent[];
  readonly onOpen: (url: string) => void;
}

/** Within this many px of the bottom counts as "at the bottom" (follow new lines). */
const STICK_PX = 24;

/**
 * The pane, memoized: the window's 1 s clock re-renders the lanes, never these (up to 2,000) lines;
 * it re-renders only when the events, the link handler or its own filters change.
 */
export const EventLog = memo(function EventLog({ events, onOpen }: EventLogProps) {
  const [severity, setSeverity] = useState<LogFilter["severity"]>("all");
  const [repo, setRepo] = useState("");
  const [query, setQuery] = useState("");
  const list = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const shown = useMemo(
    () => filterEvents(events, { severity, repo, query }),
    [events, severity, repo, query],
  );
  const repos = useMemo(
    () => [...new Set(events.map((e) => e.repo).filter((r) => r))].sort(),
    [events],
  );
  const lastSeq = shown.at(-1)?.seq ?? 0;

  // Follow new lines while at the bottom.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && stick.current && typeof el.scrollHeight === "number") el.scrollTop = el.scrollHeight;
  }, [lastSeq, severity, repo, query]);
  useEffect(() => {
    stick.current = true;
  }, [severity, repo, query]);

  return (
    <section class="log" aria-label="Event log">
      <header class="log-head">
        <h2 class="lane-title">
          Event log <span class="num lane-count">{shown.length}</span>
        </h2>
        <div class="log-filters">
          <div class="seg" role="group" aria-label="Severity">
            <button
              type="button"
              class={`seg-btn${severity === "all" ? " is-on" : ""}`}
              aria-pressed={severity === "all"}
              onClick={() => setSeverity("all")}
            >
              All
            </button>
            <button
              type="button"
              class={`seg-btn${severity === "problems" ? " is-on" : ""}`}
              aria-pressed={severity === "problems"}
              onClick={() => setSeverity("problems")}
            >
              Problems
            </button>
          </div>
          {
            /* Uncontrolled: denext/testing's render() crashes on a select with `value` or
              `defaultValue` (initSelect iterates `options`, which its test DOM lacks). */
          }
          <select
            class="log-select"
            aria-label="Repository"
            onChange={(e) => setRepo((e.target as HTMLSelectElement).value)}
          >
            <option value="">All repos</option>
            {repos.map((r) => <option key={r} value={r}>{shortRepo(r)}</option>)}
          </select>
          <input
            class="log-search"
            type="search"
            aria-label="Search the log"
            placeholder="Search"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
        </div>
      </header>
      <div
        class="log-lines"
        ref={list}
        role="log"
        aria-live="polite"
        onScroll={() => {
          const el = list.current;
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX;
        }}
      >
        {shown.length === 0
          ? (
            <p class="empty">
              {events.length === 0
                ? "No events yet: the first poll records the current state; changes appear here."
                : "No events match."}
            </p>
          )
          : shown.map((e) => <EventLine key={e.seq} e={e} onOpen={onOpen} />)}
      </div>
    </section>
  );
});

function EventLine({ e, onOpen }: { e: FleetEvent; onOpen: (url: string) => void }) {
  const mark = SEV_MARK[e.sev];
  const where = e.job ? `${e.workflow} / ${e.job}` : e.workflow;
  const shown = e.kind === "started" ? eventText(e.text) : { text: e.text, runner: null };
  const short = shown.runner === null ? null : shortRunner(shown.runner);
  return (
    <div class={`ev ev-${e.sev}${e.user ? " ev-user" : ""}${e.backfill ? " ev-past" : ""}`}>
      <span class="num ev-time">{logTime(e.at)}</span>
      <span class={`ev-mark mark-${e.sev}`} role="img" aria-label={mark.label} title={mark.label}>
        {mark.glyph}
      </span>
      <span class="ev-repo">{e.repo ? shortRepo(e.repo) : "fleet"}</span>
      <span class="ev-where" title={where}>{where}</span>
      <span class="ev-text" title={e.text}>
        {e.user ? <span class="ev-you">you</span> : null}
        {e.backfill
          ? (
            <span
              class="ev-backfill"
              role="img"
              aria-label="while Fleet was closed"
              title="while Fleet was closed (from the webhook spool)"
            >
              ↺
            </span>
          )
          : null}
        {shown.text}
        {short === null ? null : (
          <>
            {short.startsWith("#") ? " " : " · "}
            <span class="ev-runner" title={shown.runner!}>{short}</span>
          </>
        )}
      </span>
      {e.url
        ? (
          <a
            class="ev-link"
            href={e.url}
            onClick={(ev) => {
              ev.preventDefault();
              onOpen(e.url!);
            }}
          >
            open ↗
          </a>
        )
        : <span />}
    </div>
  );
}
