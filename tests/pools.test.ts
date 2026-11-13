// The live pool list: pools that share a runs-on label (win-x64 and win-x64-brain on
// denext-windows-x64) get one card each with their own slots, busy and state; runner names attribute
// to the right host; the list is rebuilt from the data (a pool leaves and joins on the next poll);
// a label with one pool behaves as before. No network.

import "./fixture-settings.ts";

import { assertEquals } from "@std/assert";
import { classifyJob } from "../lib/classify.ts";
import type { GhJob, GhRunner } from "../lib/github-types.ts";
import { type HealthState, parsePoolHealth } from "../lib/health.ts";
import { mergeLocalHealth } from "../lib/local-health.ts";
import type { JobRow } from "../lib/model.ts";
import {
  currentPools,
  derivePools,
  indexRunners,
  poolFromLabels,
  poolFromRunnerName,
  seedPools,
  setPools,
} from "../lib/pools.ts";
import { poolCards } from "../lib/snapshot.ts";

const NOW = Date.parse("2026-11-12T14:30:00Z");
const SECS = NOW / 1000 - 60;

const WIN_LABEL = "denext-windows-x64";

/** A variable value: label-merged `pools`, and `hosts` when given. */
function variable(hosts?: Record<string, unknown>): HealthState {
  return parsePoolHealth(
    JSON.stringify({
      v: 1,
      checked_at: SECS,
      pools: {
        [WIN_LABEL]: { ok: true, reason: "", since: 1, slots: 2, busy: 1, paused: false },
        "denext-macos-x64": { ok: true, reason: "", since: 1, slots: 1, busy: 1, paused: false },
      },
      ...(hosts ? { hosts } : {}),
    }),
    NOW,
  );
}

const HOSTS = {
  "mac-x64": {
    label: "denext-macos-x64",
    ok: true,
    reason: "",
    since: 1,
    slots: 1,
    busy: 1,
    paused: false,
    runner_prefix: "denext-mac-x64-",
  },
  "win-x64": {
    label: WIN_LABEL,
    ok: true,
    reason: "",
    since: 1,
    slots: 1,
    busy: 1,
    paused: false,
    runner_prefix: "denext-win-x64-",
  },
  "win-x64-brain": {
    label: WIN_LABEL,
    ok: false,
    reason: "brain unreachable",
    since: 2,
    slots: 1,
    busy: 0,
    paused: false,
    runner_prefix: "denext-win-x64-brain-",
  },
};

const runner = (name: string, busy: boolean, labels: string[] = []): GhRunner => ({
  id: name.length,
  name,
  status: "online",
  busy,
  labels: labels.map((name) => ({ name })),
});

const row = (
  pool: string,
  lane: "running" | "queued",
  runnerName: string | null = null,
): JobRow => ({
  id: Math.random(),
  name: "job",
  url: null,
  lane,
  target: "pool",
  pool,
  runner: runnerName,
  since: NOW - 60_000,
  usualMs: null,
});

const docOf = (h: HealthState) => (h.state === "ok" || h.state === "stale" ? h.doc : null);

/** Run `fn` with the pool list from `h`, then restore the static list. */
function withPools<T>(h: HealthState, runners: GhRunner[] | null, fn: () => T): T {
  const defs = derivePools(docOf(h), runners);
  if (defs) setPools(defs);
  indexRunners(null);
  try {
    return fn();
  } finally {
    setPools(seedPools());
    indexRunners(null);
  }
}

Deno.test("pools: runner names attribute to the host, the longest prefix winning", () => {
  assertEquals(poolFromRunnerName("denext-win-x64-1-1794493083"), "win-x64");
  assertEquals(poolFromRunnerName("denext-win-x64-brain-1-1794493083"), "win-x64-brain");
  // A queued job's label names the FIRST pool on it.
  assertEquals(poolFromLabels(["self-hosted", WIN_LABEL]), "win-x64");
  // A running job: its runner's name wins over the shared label.
  const running = (runner_name: string): GhJob => ({
    id: 1,
    run_id: 2,
    name: "j",
    status: "in_progress",
    labels: [WIN_LABEL],
    runner_name,
    created_at: "2026-11-12T14:00:00Z",
    started_at: "2026-11-12T14:01:00Z",
  });
  assertEquals(classifyJob(running("denext-win-x64-brain-1-17944"))?.pool, "win-x64-brain");
  assertEquals(classifyJob(running("denext-win-x64-1-17944"))?.pool, "win-x64");
});

Deno.test("pools: two pools on one label → two cards with their own slots, busy and state", () => {
  const h = variable(HOSTS);
  const cards = withPools(h, null, () =>
    poolCards(
      [row("win-x64", "running", "denext-win-x64-1-1")],
      [row("win-x64", "queued")],
      h,
      [runner("denext-win-x64-1-1", true)],
    ));
  const win = cards.find((c) => c.id === "win-x64")!;
  const brain = cards.find((c) => c.id === "win-x64-brain")!;
  assertEquals(cards.map((c) => c.id), ["mac-x64", "win-x64", "win-x64-brain", "github"]);
  assertEquals([win.slots, win.busy, win.state, win.queued], [1, 1, "ok", 1]);
  assertEquals([brain.slots, brain.busy, brain.state, brain.reason], [
    1,
    0,
    "unhealthy",
    "brain unreachable",
  ]);
  assertEquals([brain.label, brain.queued], [WIN_LABEL, 0]);
});

Deno.test("pools: a shared label without per-host data never shows the merged numbers", () => {
  // An older watchdog: only the label-merged entry (slots 2, busy 1); brain's runner is busy.
  const h = variable();
  const runners = [runner("denext-win-x64-brain-1-9", true, ["self-hosted", WIN_LABEL])];
  const cards = withPools(
    h,
    runners,
    () => poolCards([row("win-x64-brain", "running", "denext-win-x64-brain-1-9")], [], h, runners),
  );
  const win = cards.find((c) => c.id === "win-x64")!;
  const brain = cards.find((c) => c.id === "win-x64-brain")!;
  assertEquals([win.slots, win.busy, win.state], [1, 0, "ok"]);
  assertEquals([brain.slots, brain.busy, brain.running, brain.state], [1, 1, 1, "ok"]);
  // A label with one pool: exactly as before (the variable's slots and busy).
  const mac = cards.find((c) => c.id === "mac-x64")!;
  assertEquals([mac.slots, mac.busy, mac.state], [1, 1, "ok"]);
});

Deno.test("pools: the list follows the data — a pool leaves, a new one joins", () => {
  const { "win-x64-brain": _gone, ...rest } = HOSTS;
  const before = derivePools(docOf(variable(HOSTS)), null)!.map((p) => p.id);
  assertEquals(before, ["mac-x64", "win-x64", "win-x64-brain"]);
  const fewer = derivePools(docOf(variable(rest)), null)!.map((p) => p.id);
  assertEquals(fewer, ["mac-x64", "win-x64"]);
  const more = derivePools(
    docOf(variable({
      ...HOSTS,
      "win-x64-other": { ...HOSTS["win-x64"], runner_prefix: "denext-win-x64-other-" },
    })),
    null,
  )!;
  assertEquals(more.at(-1), {
    id: "win-x64-other",
    label: WIN_LABEL,
    runnerPrefix: "denext-win-x64-other-",
    slots: 1,
  });
  // No data yet: keep the current list (the static one at first).
  assertEquals(derivePools(null, null), null);
  assertEquals(currentPools(), seedPools());
  // Once set, lookups follow it: a pool gone from the list is no runner's pool any more.
  withPools(variable(rest), null, () => {
    assertEquals(poolFromRunnerName("denext-win-x64-brain-1-17944"), "win-x64");
    assertEquals(poolFromRunnerName("denext-mac-arm-1-17944"), null);
  });
});

Deno.test("pools: an older variable's labels plus the registered runners' names", () => {
  const defs = derivePools(docOf(variable()), [
    runner("denext-win-x64-new-1-5", false, ["self-hosted", WIN_LABEL]),
    runner("GitHub Actions 7", true, ["ubuntu-latest"]),
  ])!;
  assertEquals(defs.map((d) => [d.id, d.label, d.slots]), [
    ["mac-x64", "denext-macos-x64", 1],
    ["win-x64", WIN_LABEL, 1],
    ["win-x64-brain", WIN_LABEL, 1],
    ["win-x64-new", WIN_LABEL, null],
  ]);
});

Deno.test("local health: the mini's health.json keys hosts by pool, merging a shared label", () => {
  const base = variable();
  const local = {
    checked_at_epoch: NOW / 1000,
    pools: {
      "win-x64": {
        healthy: true,
        reason: "ok",
        since_epoch: 10,
        label: WIN_LABEL,
        slots: 1,
        runner_prefix: "denext-win-x64-",
      },
      // No label from an older watchdog: the static list knows it.
      "win-x64-brain": { healthy: false, reason: "brain unreachable", since_epoch: 20 },
    },
  };
  const m = mergeLocalHealth(base, local, new Set(["win-x64-brain"]), NOW);
  const doc = docOf(m)!;
  assertEquals(Object.keys(doc.hosts), ["win-x64", "win-x64-brain"]);
  assertEquals(doc.hosts["win-x64"].ok, true);
  assertEquals(doc.hosts["win-x64-brain"].label, WIN_LABEL);
  assertEquals(doc.hosts["win-x64-brain"].runnerPrefix, "denext-win-x64-brain-");
  assertEquals([doc.hosts["win-x64-brain"].ok, doc.hosts["win-x64-brain"].paused], [false, true]);
  // The label entry: ok while any host is, slots and busy the variable's.
  assertEquals(doc.pools[WIN_LABEL].ok, true);
  assertEquals([doc.pools[WIN_LABEL].slots, doc.pools[WIN_LABEL].busy], [2, 1]);
  const cards = withPools(m, null, () => poolCards([], [], m, []));
  assertEquals(
    cards.filter((c) => c.label === WIN_LABEL).map((c) => [c.id, c.slots, c.state]),
    [["win-x64", 1, "ok"], ["win-x64-brain", 1, "unhealthy"]],
  );
});
