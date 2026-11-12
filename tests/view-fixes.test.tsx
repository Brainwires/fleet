// The window's fixes: muted text meets WCAG AA in both themes and motion respects
// prefers-reduced-motion; the event log doesn't re-render on the 1 s tick, and the tick stops while
// the window is hidden; a fork PR is marked in the lanes; job ages use GitHub's clock.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { FleetView } from "../app/fleet-view.tsx";
import { visibleClock } from "../app/visible-clock.ts";
import { createGitHubClient } from "../lib/github.ts";
import type { FleetEvent } from "../lib/events.ts";
import type { Snapshot } from "../lib/model.ts";
import { Poller } from "../lib/poller.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

// ---- contrast ----

function luminance(hex: string): number {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
/** A block's `--name: #hex` tokens. */
function tokens(block: string): Record<string, string> {
  return Object.fromEntries(
    [...block.matchAll(/(--[\w-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)].map((m) => [m[1], m[2]]),
  );
}

const CSS = Deno.readTextFileSync(new URL("../public/styles.css", import.meta.url));

Deno.test("styles: --text-3 is at least 4.5:1 on every background it sits on, in both themes", () => {
  const light = tokens(
    CSS.slice(CSS.indexOf(":root {"), CSS.indexOf("@media (prefers-color-scheme")),
  );
  const darkAt = CSS.indexOf("@media (prefers-color-scheme: dark)");
  const dark = { ...light, ...tokens(CSS.slice(darkAt, CSS.indexOf("}\n}", darkAt))) };
  for (const [theme, t] of [["light", light], ["dark", dark]] as const) {
    for (const bg of ["--bg", "--surface", "--surface-2"]) {
      const r = contrast(t["--text-3"], t[bg]);
      assert(r >= 4.5, `${theme} --text-3 on ${bg}: ${r.toFixed(2)}`);
    }
  }
});

Deno.test("styles: a prefers-reduced-motion rule turns animation and transitions off", () => {
  const at = CSS.indexOf("@media (prefers-reduced-motion: reduce)");
  assert(at !== -1);
  const block = CSS.slice(at, at + 400);
  assertStringIncludes(block, "transition-duration");
  assertStringIncludes(block, "animation-duration");
});

// ---- the view ----

function all(root: TestElement, cls: string): TestElement[] {
  const out: TestElement[] = [];
  const walk = (el: TestElement) => {
    for (const c of el.children) {
      if ((c.getAttribute("class") ?? "").split(/\s+/).includes(cls)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

async function snapshot(): Promise<Snapshot> {
  const { fetch } = fakeFetch(standardRoutes());
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  return p.snapshot();
}

const ev = (seq: number): FleetEvent => ({
  seq,
  at: NOW + seq,
  sev: "info",
  kind: "queued",
  repo: "Brainwires/denext",
  workflow: "CI",
  job: `job ${seq}`,
  text: "queued for linux-x64",
  url: null,
});

Deno.test("event log: the 1 s tick re-renders the lanes, not the log", async () => {
  const snap = await snapshot();
  const events = [ev(1), ev(2)];
  const open = () => {};
  const view = (now: number, list: FleetEvent[]) => (
    <FleetView snapshot={snap} now={now} onOpen={open} onRefresh={() => {}} events={list} />
  );
  const screen = await render(view(NOW, events));
  const lines = () => all(screen.container, "ev").length;
  const lane = () => all(screen.container, "lane")[0]?.textContent ?? "";
  assertEquals(lines(), 2);
  const before = lane();
  // Same list (by reference) with a line slipped in: a tick must not re-render the log.
  events.push(ev(3));
  await screen.rerender(view(NOW + 61_000, events));
  assert(lane() !== before, "the lanes ticked");
  assertEquals(lines(), 2, "the log did not re-render on the tick");
  // A new list (what the page sets when events arrive) does.
  await screen.rerender(view(NOW + 62_000, [...events]));
  assertEquals(lines(), 3);
  await screen.unmount();
});

Deno.test("clock: ticks each second only while visible; stops when hidden, resumes on show", () => {
  let visible = true;
  const ticks: number[] = [];
  const timers = new Map<number, () => void>();
  let next = 1;
  const clock = visibleClock((n) => ticks.push(n), {
    visible: () => visible,
    now: () => NOW,
    setInterval: (fn, ms) => {
      assertEquals(ms, 1000);
      timers.set(next, fn);
      return next++;
    },
    clearInterval: (id) => void timers.delete(id),
  });
  assert(clock.running);
  assertEquals(ticks.length, 1, "ticks at once on start");
  timers.forEach((f) => f());
  assertEquals(ticks.length, 2);
  visible = false;
  clock.update();
  assertFalse(clock.running);
  assertEquals(timers.size, 0, "no interval while hidden");
  visible = true;
  clock.update();
  assert(clock.running);
  assertEquals(timers.size, 1);
  clock.update(); // still visible: no second interval
  assertEquals(timers.size, 1);
  clock.stop();
  assertEquals(timers.size, 0);
  // Hidden at start: no interval at all.
  visible = false;
  const idle = visibleClock(() => {}, { visible: () => visible, setInterval: () => 1 });
  assertFalse(idle.running);
});

Deno.test("view: a fork PR's run shows 'fork PR from <owner>'", async () => {
  const snap = await snapshot();
  const [group, ...rest] = snap.running;
  const fork: Snapshot = {
    ...snap,
    running: [{ ...group, runs: group.runs.map((r) => ({ ...r, forkOwner: "evil" })) }, ...rest],
  };
  const screen = await render(
    <FleetView snapshot={fork} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  const chips = all(screen.container, "fork-chip");
  assert(chips.length > 0);
  assertEquals(chips[0].textContent, "fork PR from evil");
  await screen.unmount();
  const plain = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  assertEquals(all(plain.container, "fork-chip").length, 0);
  await plain.unmount();
});

Deno.test("view: job ages tick on GitHub's clock (the snapshot's offset)", async () => {
  const snap = await snapshot();
  const time = async (s: Snapshot) => {
    const screen = await render(
      <FleetView snapshot={s} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
    );
    const t = all(screen.container, "job-time")[0]?.textContent ?? "";
    await screen.unmount();
    return t;
  };
  const base = await time({ ...snap, clockOffsetMs: 0 });
  const ahead = await time({ ...snap, clockOffsetMs: 10 * 60_000 });
  assert(base !== ahead, `${base} vs ${ahead}`);
  const minutes = (t: string) => Number(/(\d+)m/.exec(t)?.[1] ?? NaN);
  assertEquals(minutes(ahead) - minutes(base), 10);
});
