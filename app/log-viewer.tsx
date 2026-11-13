"use client";
// The log viewer: a redacted log's lines (the backend redacted them; this never sees a secret),
// monospace, virtualized (only the rows in view are in the DOM, so a 60,000-line log stays light),
// ANSI colours as classes, `##[group]` sections folding, search with next / previous, copy, and
// follow (auto-scroll) for a live log.

import { useEffect, useMemo, useRef, useState } from "denext";
import { ansiRuns, stripAnsi } from "../lib/redact.ts";
import type { LogView } from "../lib/logs.ts";

/** One row's height (px): fixed, so the window is arithmetic. */
export const ROW_PX = 18;
/** Rows rendered past the visible window on each side. */
const OVERSCAN = 30;
/** Rows rendered when the viewport's height isn't known yet (a test DOM, the first frame). */
const FIRST_ROWS = 120;

/** The viewer's props. */
export interface LogViewerProps {
  readonly view: LogView;
  readonly onClose: () => void;
  /** Load the lines before the first one (a truncated runner log). */
  readonly onEarlier?: () => void;
  /** Follow a live log: new lines scroll into view. */
  readonly follow?: boolean;
  readonly onFollow?: (on: boolean) => void;
}

/** The line indices shown with `collapsed` groups folded (a group's header line stays). */
export function visibleLines(view: LogView, collapsed: ReadonlySet<number>): number[] {
  const out: number[] = [];
  const groups = view.groups ?? [];
  let g = 0;
  for (let i = 0; i < view.lines.length; i++) {
    while (g < groups.length && groups[g].end < i) g++;
    const grp = groups[g];
    if (grp && collapsed.has(grp.start) && i > grp.start && i <= grp.end) continue;
    out.push(i);
  }
  return out;
}

/** The indices (into `rows`) of the rows whose text contains `query` (case-insensitive). */
export function searchRows(
  view: LogView,
  rows: readonly number[],
  query: string,
): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  rows.forEach((li, r) => {
    if (stripAnsi(view.lines[li]).toLowerCase().includes(q)) out.push(r);
  });
  return out;
}

/** A line's text with `query` marked. */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim().toLowerCase();
  if (!q) return <>{text}</>;
  const parts: (string | { m: string })[] = [];
  let at = 0;
  const lower = text.toLowerCase();
  for (let i = lower.indexOf(q); i >= 0; i = lower.indexOf(q, i + q.length)) {
    if (i > at) parts.push(text.slice(at, i));
    parts.push({ m: text.slice(i, i + q.length) });
    at = i + q.length;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts.map((p, i) => (typeof p === "string" ? p : <mark key={i}>{p.m}</mark>))}</>;
}

/** GitHub's timestamp prefix and its `##[…]` command words, for a calmer display. */
const GH_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z /;

/** The viewer. */
export function LogViewer(props: LogViewerProps) {
  const { view } = props;
  const box = useRef<HTMLDivElement | null>(null);
  const [scroll, setScroll] = useState(0);
  const [height, setHeight] = useState(0);
  const [query, setQuery] = useState("");
  const [hit, setHit] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  const [copied, setCopied] = useState(false);
  const groupStarts = useMemo(
    () => new Map((view.groups ?? []).map((g) => [g.start, g])),
    [view.groups],
  );
  const rows = useMemo(() => visibleLines(view, collapsed), [view, collapsed]);
  const matches = useMemo(() => searchRows(view, rows, query), [view, rows, query]);

  // Follow: stay at the bottom as lines arrive.
  useEffect(() => {
    const el = box.current;
    if (!props.follow || !el) return;
    el.scrollTop = el.scrollHeight;
  }, [props.follow, view.lines.length]);

  useEffect(() => {
    const el = box.current;
    if (el) setHeight(el.clientHeight || 0);
  }, []);

  const jump = (k: number) => {
    if (matches.length === 0) return;
    const i = ((k % matches.length) + matches.length) % matches.length;
    setHit(i);
    const el = box.current;
    if (el) el.scrollTop = Math.max(0, matches[i] * ROW_PX - (el.clientHeight || 0) / 2);
    props.onFollow?.(false);
  };

  const first = height > 0 ? Math.max(0, Math.floor(scroll / ROW_PX) - OVERSCAN) : 0;
  const last = height > 0
    ? Math.min(rows.length, Math.ceil((scroll + height) / ROW_PX) + OVERSCAN)
    : Math.min(rows.length, FIRST_ROWS);
  const current = matches.length ? matches[Math.min(hit, matches.length - 1)] : -1;

  const copy = async () => {
    const text = view.lines.map(stripAnsi).join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <section class="logview" aria-label={`Log: ${view.title}`}>
      <header class="logview-head">
        <h3 class="logview-title" title={view.title}>{view.title}</h3>
        <span class="muted small num">
          {rows.length.toLocaleString("en-US")} lines{view.live ? " · live" : ""}
        </span>
        <div class="logview-tools">
          <input
            type="search"
            class="logview-search"
            placeholder="Search"
            aria-label="Search the log"
            value={query}
            onInput={(e) => {
              setQuery((e.target as HTMLInputElement).value);
              setHit(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                jump(e.shiftKey ? hit - 1 : hit + 1);
              } else if (e.key === "Escape" && query) {
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
          <span class="muted small num" aria-live="polite">
            {query.trim() ? `${matches.length ? hit + 1 : 0}/${matches.length}` : ""}
          </span>
          <button
            type="button"
            class="ctl"
            onClick={() => jump(hit - 1)}
            disabled={!matches.length}
          >
            Previous
          </button>
          <button
            type="button"
            class="ctl"
            onClick={() => jump(hit + 1)}
            disabled={!matches.length}
          >
            Next
          </button>
          {view.groups && view.groups.length
            ? (
              <>
                <button
                  type="button"
                  class="ctl"
                  onClick={() => setCollapsed(new Set(view.groups!.map((g) => g.start)))}
                >
                  Fold all
                </button>
                <button type="button" class="ctl" onClick={() => setCollapsed(new Set())}>
                  Unfold all
                </button>
              </>
            )
            : null}
          {view.live && props.onFollow
            ? (
              <label class="ctl-check">
                <input
                  type="checkbox"
                  checked={props.follow === true}
                  onChange={(e) => props.onFollow!((e.target as HTMLInputElement).checked)}
                />{" "}
                Follow
              </label>
            )
            : null}
          <button type="button" class="ctl" onClick={() => void copy()}>
            {copied ? "Copied" : "Copy"}
          </button>
          <button type="button" class="ctl" onClick={props.onClose}>Close</button>
        </div>
      </header>
      {view.note || view.truncated
        ? (
          <p class="logview-note muted small">
            {view.note ?? "Showing the end of the log."}
            {view.truncated && props.onEarlier
              ? (
                <button type="button" class="link-btn" onClick={props.onEarlier}>
                  Load earlier lines
                </button>
              )
              : null}
          </p>
        )
        : null}
      <div
        class="logview-body"
        ref={box}
        tabIndex={0}
        role="log"
        aria-label="Log lines"
        onScroll={(e) => {
          const el = e.target as HTMLDivElement;
          setScroll(el.scrollTop);
          if (el.clientHeight !== height) setHeight(el.clientHeight);
          if (props.follow && el.scrollHeight - el.scrollTop - el.clientHeight > ROW_PX * 3) {
            props.onFollow?.(false);
          }
        }}
      >
        {rows.length === 0
          ? <p class="muted logview-empty">The log is empty.</p>
          : (
            <div class="logview-space" style={{ height: `${rows.length * ROW_PX}px` }}>
              {rows.slice(first, last).map((li, k) => {
                const r = first + k;
                const g = groupStarts.get(li);
                const raw = view.lines[li];
                const shown = view.kind === "github" ? raw.replace(GH_STAMP, "") : raw;
                return (
                  <div
                    key={li}
                    class={`logline${r === current ? " is-current" : ""}${g ? " is-group" : ""}`}
                    style={{ top: `${r * ROW_PX}px` }}
                  >
                    <span class="logline-no num" aria-hidden="true">{li + 1}</span>
                    {g
                      ? (
                        <button
                          type="button"
                          class="fold"
                          aria-expanded={!collapsed.has(li)}
                          onClick={() => {
                            const next = new Set(collapsed);
                            if (next.has(li)) next.delete(li);
                            else next.add(li);
                            setCollapsed(next);
                          }}
                        >
                          {collapsed.has(li) ? "▸" : "▾"} {g.title}
                        </button>
                      )
                      : (
                        <span class="logline-text">
                          {ansiRuns(shown).map((run, i) => (
                            <span
                              key={i}
                              class={`${run.color ? `ansi-${run.color}` : ""}${
                                run.bold ? " ansi-bold" : ""
                              }`}
                            >
                              <Highlight text={run.text} query={query} />
                            </span>
                          ))}
                        </span>
                      )}
                  </div>
                );
              })}
            </div>
          )}
      </div>
    </section>
  );
}
