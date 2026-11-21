// Maintenance windows: local wall-clock times in an IANA zone, DST included, to instants; the next
// window; and the scheduler's 60 s tick decision. Pure (Intl only, no Deno API).
//
// - A window opens at its local start time on each listed day and lasts `windowMinutes` of real
//   time. On a spring-forward day a start inside the gap moves forward by the gap (02:30 → 03:30);
//   on a fall-back day an ambiguous start takes the first occurrence. Each local day has one window.
// - The tick: a window opens → the ten-minute notice → the run. The run starts only inside the
//   window with enough of it left (the drain cap, when the machine has pools, plus 90 min), never
//   catches up a window that has ended, and skips when nothing is pending and no reboot is due.
//   Every skip is recorded by the caller; three "busy" outcomes in a row raise a notice.

import type { UpdateSchedule } from "./model.ts";
import { WINDOW_MARGIN_MINUTES } from "./config.ts";

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
/** The notice goes out this long before a scheduled run starts. */
export const NOTICE_MS = 10 * MIN;
/** Three deferred-busy windows in a row raise a notice. */
export const BUSY_STREAK_ALERT = 3;

/** A wall-clock reading in a zone. */
export interface LocalParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 = Sunday. */
  readonly weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
    });
    formatters.set(tz, f);
  }
  return f;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Whether `tz` is a zone Intl knows. */
export function validTimeZone(tz: string): boolean {
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

function parts(t: number, tz: string): LocalParts & { second: number } {
  const m: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(t))) m[p.type] = p.value;
  return {
    year: Number(m.year),
    month: Number(m.month),
    day: Number(m.day),
    hour: Number(m.hour) % 24,
    minute: Number(m.minute),
    second: Number(m.second),
    weekday: WEEKDAYS.indexOf(m.weekday),
  };
}

/** The wall clock at `t` in `tz`. */
export function localParts(t: number, tz: string): LocalParts {
  const { second: _s, ...rest } = parts(t, tz);
  return rest;
}

/** The zone's offset from UTC at `t` (ms; Chicago in winter is -6 h). */
export function zoneOffset(t: number, tz: string): number {
  const p = parts(t, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - (t - (((t % 1000) + 1000) % 1000));
}

/**
 * The instant a local wall-clock time names in `tz`: an ambiguous time (fall back) is its first
 * occurrence, a missing one (spring forward) moves forward by the gap.
 */
export function zonedTime(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  tz: string,
): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const before = zoneOffset(wall - DAY, tz);
  const after = zoneOffset(wall + DAY, tz);
  const candidates = [...new Set([wall - before, wall - after])].filter((t) => {
    const p = parts(t, tz);
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall;
  });
  if (candidates.length > 0) return Math.min(...candidates);
  return wall - before; // in the gap: the offset before it, which lands past the gap
}

/** A window: `[start, end)` in ms. */
export interface Window {
  readonly start: number;
  readonly end: number;
}

/** The schedule's window on a local date, or `null` when that day isn't listed. */
export function windowOn(
  s: UpdateSchedule,
  tz: string,
  year: number,
  month: number,
  day: number,
): Window | null {
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  if (!s.days.includes(weekday)) return null;
  const [hh, mm] = s.start.split(":").map(Number);
  const start = zonedTime(year, month, day, hh, mm, tz);
  return { start, end: start + s.windowMinutes * MIN };
}

/** Local dates from `offset` days around `t`'s local date. */
function localDate(t: number, tz: string, offsetDays: number): [number, number, number] {
  const p = localParts(t, tz);
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + offsetDays));
  return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
}

/** The window open at `now`, or `null`. */
export function currentWindow(s: UpdateSchedule, tz: string, now: number): Window | null {
  // A window can run past midnight (up to 24 h long), so yesterday's may still be open.
  for (const off of [0, -1]) {
    const w = windowOn(s, tz, ...localDate(now, tz, off));
    if (w && w.start <= now && now < w.end) return w;
  }
  return null;
}

/** The window open now or the next to open (within eight days), or `null` for no days. */
export function nextWindow(s: UpdateSchedule, tz: string, now: number): Window | null {
  const open = currentWindow(s, tz, now);
  if (open) return open;
  for (let off = 0; off <= 8; off++) {
    const w = windowOn(s, tz, ...localDate(now, tz, off));
    if (w && w.start > now) return w;
  }
  return null;
}

/** How much of a window a run needs (ms): the drain cap when there are pools, plus the margin. */
export function windowNeeded(drainCapMinutes: number, hasPools: boolean): number {
  return ((hasPools ? drainCapMinutes : 0) + WINDOW_MARGIN_MINUTES) * MIN;
}

/** What the scheduler knows when it ticks for one schedule. */
export interface TickInput {
  readonly schedule: UpdateSchedule;
  readonly tz: string;
  readonly now: number;
  /** The machine has pools (a drain counts against the window). */
  readonly hasPools: boolean;
  /** Something is pending or a reboot is due. */
  readonly due: boolean;
  /** The window this schedule last started or skipped (its start), so a window is handled once. */
  readonly handledWindow: number | null;
  /** The notice sent for a window: that window's start and when it went out. */
  readonly notice: { readonly window: number; readonly at: number } | null;
}

/** Why a window was skipped. */
export type SkipReason = "not-enough-window" | "nothing-due";

/** The tick's decision. */
export type TickDecision =
  | { readonly kind: "idle" }
  | { readonly kind: "notice"; readonly window: Window; readonly runAt: number }
  | { readonly kind: "start"; readonly window: Window }
  | { readonly kind: "skip"; readonly window: Window; readonly reason: SkipReason };

/** One scheduler tick for one schedule. */
export function scheduleTick(i: TickInput): TickDecision {
  if (!i.schedule.enabled) return { kind: "idle" };
  const w = currentWindow(i.schedule, i.tz, i.now);
  if (!w || i.handledWindow === w.start) return { kind: "idle" };
  const needed = windowNeeded(i.schedule.drainCapMinutes, i.hasPools);
  const noticed = i.notice !== null && i.notice.window === w.start;
  const runAt = noticed ? i.notice!.at + NOTICE_MS : i.now + NOTICE_MS;
  if (w.end - Math.max(runAt, i.now) < needed) {
    return { kind: "skip", window: w, reason: "not-enough-window" };
  }
  if (!i.due) return { kind: "skip", window: w, reason: "nothing-due" };
  if (!noticed) return { kind: "notice", window: w, runAt };
  if (i.now < runAt) return { kind: "idle" };
  return { kind: "start", window: w };
}

/** The trailing run of `deferred-busy` outcomes among a schedule's recorded windows. */
export function busyStreak(outcomes: readonly string[]): number {
  let n = 0;
  for (let i = outcomes.length - 1; i >= 0 && outcomes[i] === "deferred-busy"; i--) n++;
  return n;
}
