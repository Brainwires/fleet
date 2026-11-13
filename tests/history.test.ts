// The usage history: bucketing into the two tiers, the sample throttle, finished jobs once each,
// percentiles, utilization and a shared machine's combined view, retention (rotation), the file's
// round trip, its bounds, the first-run back-fill from the journal and the spool, the service
// wiring (sampled on polls, saved, back-filled once) and the pool detail's data. No network.

import { assert, assertAlmostEquals, assertEquals, assertFalse } from "@std/assert";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";
import { ORG_SETTINGS, withSettings } from "./fixture-settings.ts";
import {
  backfillHistory,
  COARSE_KEEP_MS,
  COARSE_MS,
  durationBin,
  FINE_KEEP_MS,
  FINE_MS,
  HistoryStore,
  histPercentile,
  imageKey,
  type JobRecord,
  JOBS_PER_POOL,
  MAX_IMAGES,
  percentile,
  poolHistory,
} from "../lib/history.ts";
import {
  backfillIntervals,
  intervalsFromJournal,
  intervalsFromSpool,
  jobRecord,
  poolSamples,
} from "../lib/history-sources.ts";
import type { FleetEvent } from "../lib/events.ts";
import type { HookDelivery } from "../lib/hooks.ts";
import { createFleetService } from "../lib/service.ts";
import { poolDetail, poolEvents, sharedHost } from "../lib/pool-detail.ts";
import type { FleetSettings } from "../lib/settings.ts";
import type { PoolCard } from "../lib/model.ts";

/** A minute boundary near the fixtures' now. */
const T0 = Math.floor(NOW / COARSE_MS) * COARSE_MS;
const MIN = 60_000;

function rec(id: number, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    runId: 1,
    repo: "acme/web",
    workflow: "CI",
    name: `job ${id}`,
    pool: "mac-arm",
    runner: `acme-mac-arm-1-${id}`,
    created: T0 - 10 * MIN,
    started: T0 - 8 * MIN,
    completed: T0 - 3 * MIN,
    conclusion: "success",
    url: `https://github.com/acme/web/actions/runs/1/job/${id}`,
    ...over,
  };
}

Deno.test("history: a sample lands in a 1-minute and a 15-minute bucket; close samples are dropped", () => {
  const h = new HistoryStore();
  h.sample(T0 + 5_000, [{ key: "p", busy: 1, slots: 2, queued: 3, waitMs: 60_000 }]);
  h.sample(T0 + 9_000, [{ key: "p", busy: 2, slots: 2, queued: 0, waitMs: 0 }]); // < 10 s: dropped
  h.sample(T0 + 20_000, [{ key: "p", busy: 2, slots: 2, queued: 1, waitMs: 30_000 }]);
  h.sample(T0 + FINE_MS + 1, [{ key: "p", busy: 0, slots: 2, queued: 0, waitMs: 0 }]);
  const s = h.series("p")!;
  assertEquals(s.fine.map((b) => [b.t, b.n, b.busy, b.queuedMax, b.waitMax]), [
    [T0, 2, 3, 3, 60_000],
    [T0 + FINE_MS, 1, 0, 0, 0],
  ]);
  assertEquals(s.coarse.map((b) => [b.t, b.n, b.busy, b.slots]), [[T0, 3, 3, 2]]);
  // The 1 h view: averages per minute, utilization against the slots.
  const view = poolHistory(h, "p", "1h", T0 + FINE_MS + 1);
  assertEquals(view.points.length, 60);
  const at = view.points.find((p) => p.t === T0)!;
  assertEquals([at.busy, at.slots, at.utilization, at.queued], [1.5, 2, 0.75, 2]);
  assertEquals(view.points.at(-1)!.busy, 0);
  // Never sampled: a gap, not a zero.
  assertEquals(view.points[0].busy, null);
  assertAlmostEquals(view.totals.utilization!, 0.375, 1e-9);
  assertEquals(view.totals.busyShare, view.totals.utilization);
  assertAlmostEquals(view.totals.idleShare!, 0.625, 1e-9);
});

Deno.test("history: a finished job counts once: its start, its end, its duration and minutes", () => {
  const h = new HistoryStore();
  assert(h.jobDone(rec(1), T0));
  assertFalse(h.jobDone(rec(1), T0), "the same job again is ignored");
  h.jobDone(rec(2, { conclusion: "failure", started: T0 - 4 * MIN, completed: T0 - 2 * MIN }), T0);
  h.jobDone(rec(3, { conclusion: "cancelled", started: null }), T0);
  h.jobDone(rec(4, { conclusion: "neutral" }), T0);
  const v = poolHistory(h, "mac-arm", "1h", T0);
  assertEquals(
    [v.totals.started, v.totals.ok, v.totals.failed, v.totals.cancelled, v.totals.other],
    [3, 1, 1, 1, 1],
  );
  // 5 min + 2 min + 5 min, each rounded up to whole minutes.
  assertEquals(v.totals.minutes, 12);
  // Queue waits: 2 min (jobs 1 and 4), 6 min (job 2).
  assertEquals(v.totals.avgWaitMs, Math.round((2 + 6 + 2) * MIN / 3));
  assertEquals(v.histogram.counts[durationBin(5 * MIN)], 2);
  assertEquals(v.histogram.counts[durationBin(2 * MIN)], 1);
  // The recent jobs, newest first.
  assertEquals(h.jobs(["mac-arm"]).map((j) => j.id), [2, 1, 3, 4]);
});

Deno.test("history: percentiles from the histogram stay within a bin of the exact values", () => {
  const durations = [40, 50, 70, 90, 100, 150, 200, 260, 400, 1300].map((s) => s * 1000);
  const counts = new Array(17).fill(0);
  for (const d of durations) counts[durationBin(d)]++;
  for (const q of [0.5, 0.9]) {
    const exact = percentile(durations, q)!;
    const est = histPercentile(counts, q)!;
    const bin = durationBin(exact);
    assert(Math.abs(durationBin(est) - bin) <= 1, `q${q}: ${est} vs ${exact}`);
  }
  assertEquals(histPercentile(new Array(17).fill(0), 0.5), null);
  assertEquals(percentile([], 0.5), null);
  assertEquals(percentile([3, 1, 2], 0.5), 2);
});

Deno.test("history: a shared machine adds its pools' busy slots, capacity and queues", () => {
  const h = new HistoryStore();
  h.sample(T0, [
    { key: "a", busy: 1, slots: 2, queued: 1, waitMs: 120_000 },
    { key: "b", busy: 3, slots: 3, queued: 2, waitMs: 60_000 },
  ]);
  h.jobDone(rec(10, { pool: "a" }), T0);
  h.jobDone(rec(11, { pool: "b", conclusion: "failure" }), T0);
  const c = poolHistory(h, ["a", "b"], "1h", T0);
  const p = c.points.find((x) => x.t === T0)!;
  assertEquals([p.busy, p.slots, p.queued, p.waitMax], [4, 5, 3, 120_000]);
  assertEquals(p.utilization, 0.8);
  assertEquals([c.totals.ok, c.totals.failed], [1, 1]);
  assertEquals(c.key, "a+b");
});

Deno.test("history: retention drops old buckets (24 h fine, 30 d coarse) and old jobs", () => {
  const h = new HistoryStore();
  const old = T0 - FINE_KEEP_MS - 2 * FINE_MS;
  h.sample(old, [{ key: "p", busy: 1, slots: 1, queued: 0, waitMs: 0 }]);
  h.sample(T0, [{ key: "p", busy: 1, slots: 1, queued: 0, waitMs: 0 }]);
  h.jobDone(rec(1, { completed: T0 - COARSE_KEEP_MS + MIN, started: null }), T0);
  h.prune(T0);
  const s = h.series("p")!;
  assertEquals(s.fine.map((b) => b.t), [T0]);
  assertEquals(s.coarse.length, 2, "the coarse tier keeps a day-old bucket");
  h.prune(T0 + COARSE_KEEP_MS + COARSE_MS);
  assertEquals(h.keys(), [], "everything past 30 days is gone");
  assertEquals(h.jobs(["mac-arm"]), []);
  // Data far in the past or the future is never bucketed.
  h.sample(T0 - COARSE_KEEP_MS - COARSE_MS, [{
    key: "q",
    busy: 1,
    slots: 1,
    queued: 0,
    waitMs: 0,
  }]);
  assertEquals(h.series("q")!.coarse.length, 1);
  assertEquals(h.series("q")!.fine.length, 1);
});

Deno.test("history: the file round-trips; garbage and a newer version give an empty store", () => {
  const h = new HistoryStore();
  h.sample(T0, [{ key: "p", busy: 2, slots: 4, queued: 1, waitMs: 5000, paused: true }]);
  h.jobDone(rec(7), T0);
  h.backfilledAt = T0;
  const doc = JSON.parse(JSON.stringify(h.toJSON(T0)));
  assertFalse(h.dirty);
  // Zero fields are left out of the file.
  assertEquals(Object.keys(doc.series.p.fine[0]).includes("unhealthy"), false);
  const back = HistoryStore.from(doc);
  assertEquals(back.backfilledAt, T0);
  assertEquals(poolHistory(back, "p", "1h", T0), poolHistory(h, "p", "1h", T0));
  assertEquals(back.jobs(["mac-arm"]).map((j) => j.id), [7]);
  assertFalse(back.jobDone(rec(7), T0), "a job read back is known");
  for (
    const bad of [null, "x", { v: 2, series: {} }, { v: 1, series: { p: { fine: [{ t: 7 }] } } }]
  ) {
    const st = HistoryStore.from(bad);
    assertEquals(st.series("p")?.fine.length ?? 0, 0);
    assertEquals(st.backfilledAt, null);
  }
  // A job URL that isn't GitHub's is dropped.
  const evil = HistoryStore.from({
    v: 1,
    series: {},
    jobs: { x: [{ ...rec(9), pool: "x", url: "javascript:alert(1)" }] },
  });
  assertEquals(evil.job(9)?.url, null);
});

Deno.test("history: bounded: image series and job records per pool", () => {
  const h = new HistoryStore();
  for (let i = 0; i < MAX_IMAGES + 5; i++) {
    h.sample(T0 + i * 11_000, [{
      key: imageKey(`img-${i}`),
      busy: 1,
      slots: null,
      queued: 0,
      waitMs: 0,
    }]);
  }
  assertEquals(h.keys().filter((k) => k.startsWith("github:")).length, MAX_IMAGES);
  assert(h.series(imageKey(`img-${MAX_IMAGES + 4}`)), "the newest stays");
  assertFalse(h.series(imageKey("img-0")), "the least recently sampled goes");
  for (let i = 0; i < JOBS_PER_POOL + 20; i++) h.jobDone(rec(1000 + i, { completed: T0 - i }), T0);
  assertEquals(h.jobs(["mac-arm"], 10_000).length, JOBS_PER_POOL);
});

Deno.test("history: GitHub-hosted jobs count in github and in their image's series", () => {
  const h = new HistoryStore();
  h.jobDone(rec(1, { pool: "github", image: "ubuntu-24.04", runner: "GitHub Actions 1" }), T0);
  assertEquals(poolHistory(h, "github", "24h", T0).totals.ok, 1);
  assertEquals(poolHistory(h, imageKey("ubuntu-24.04"), "24h", T0).totals.minutes, 5);
  // Samples: an image with a running job, and a held image with none drops to zero.
  const samples = poolSamples(
    [],
    [{
      id: 1,
      name: "j",
      url: null,
      lane: "running",
      target: "github",
      pool: "github",
      runner: null,
      image: "macos-15",
      since: T0,
      usualMs: null,
    }],
    [],
    T0,
    [imageKey("ubuntu-24.04")],
  );
  assertEquals(samples.map((s) => [s.key, s.busy]), [
    [imageKey("macos-15"), 1],
    [imageKey("ubuntu-24.04"), 0],
  ]);
});

// ---- back-fill ----

const ev = (seq: number, at: number, kind: FleetEvent["kind"], text: string, job_id: number) =>
  ({
    seq,
    at,
    sev: "info",
    kind,
    repo: "acme/web",
    workflow: "CI",
    job: `job ${job_id}`,
    text,
    url: null,
    job_id,
    run_id: 5,
  }) as FleetEvent;

function delivery(id: number, job: Record<string, unknown>, at: number): HookDelivery {
  return {
    id: `d-${id}-${at}`,
    event: "workflow_job",
    receivedAt: at,
    payload: {
      repository: { full_name: "acme/web" },
      workflow_job: { run_id: 5, name: `job ${id}`, workflow_name: "CI", id, ...job },
    },
  };
}

Deno.test("back-fill: the journal's queued / started / finished lines make intervals", () => {
  const j = intervalsFromJournal([
    ev(1, T0 - 30 * MIN, "queued", "queued for mac-arm", 1),
    ev(2, T0 - 25 * MIN, "started", "started on mac-arm on acme-mac-arm-1-99", 1),
    ev(3, T0 - 5 * MIN, "finished", "finished: success", 1),
    ev(4, T0 - 4 * MIN, "started", "started on GitHub-hosted on GitHub Actions 7", 2),
    ev(5, T0 - 3 * MIN, "alert", "ignored", 9),
  ]);
  const one = j.get(1)!;
  assertEquals(
    [one.pool, one.runner, one.created, one.started, one.completed, one.conclusion],
    ["mac-arm", "acme-mac-arm-1-99", T0 - 30 * MIN, T0 - 25 * MIN, T0 - 5 * MIN, "success"],
  );
  assertEquals(j.get(2)!.pool, "github");
  assertFalse(j.has(9));
});

Deno.test("back-fill: the spool's newest delivery per job wins, with GitHub's own times", () => {
  const iso = (t: number) => new Date(t).toISOString();
  const s = intervalsFromSpool([
    delivery(
      3,
      { status: "queued", labels: ["ubuntu-24.04"], created_at: iso(T0 - 20 * MIN) },
      T0 - 20 * MIN,
    ),
    delivery(3, {
      status: "completed",
      conclusion: "failure",
      labels: ["ubuntu-24.04"],
      runner_name: "GitHub Actions 5",
      runner_group_name: "GitHub Actions",
      created_at: iso(T0 - 20 * MIN),
      started_at: iso(T0 - 18 * MIN),
      completed_at: iso(T0 - 8 * MIN),
      html_url: "https://github.com/acme/web/actions/runs/5/job/3",
    }, T0 - 8 * MIN),
  ]);
  const j = s.get(3)!;
  assertEquals([j.pool, j.image, j.conclusion, j.started, j.completed], [
    "github",
    "ubuntu-24.04",
    "failure",
    T0 - 18 * MIN,
    T0 - 8 * MIN,
  ]);
});

Deno.test("back-fill: busy slots and queues over time, counts and records, filled from the first job", () => {
  const journal = [
    ev(1, T0 - 60 * MIN, "queued", "queued for mac-arm", 1),
    ev(2, T0 - 50 * MIN, "started", "started on mac-arm on r1", 1),
    ev(3, T0 - 20 * MIN, "finished", "finished: success", 1),
    ev(4, T0 - 50 * MIN, "queued", "queued for mac-arm", 2),
    ev(5, T0 - 40 * MIN, "started", "started on mac-arm on r2", 2),
    ev(6, T0 - 30 * MIN, "finished", "finished: failure", 2),
    // Queued long ago, never seen again: dropped.
    ev(7, T0 - 20 * 3600_000, "queued", "queued for mac-arm", 3),
  ];
  const intervals = backfillIntervals(journal, [], T0);
  assertEquals(intervals.map((i) => i.id).sort(), [1, 2]);
  const h = new HistoryStore();
  backfillHistory(h, intervals, (p) => (p === "mac-arm" ? 2 : null), T0);
  assertEquals(h.backfilledAt, T0);
  const v = poolHistory(h, "mac-arm", "1h", T0);
  const at = (t: number) => v.points.find((p) => p.t === t)!;
  assertEquals(at(T0 - 45 * MIN).busy, 1, "one job running");
  assertEquals(at(T0 - 35 * MIN).busy, 2, "both running");
  assertEquals(at(T0 - 35 * MIN).utilization, 1);
  assertEquals(at(T0 - 55 * MIN).queued, 1, "the first one queued");
  assertEquals(at(T0 - 45 * MIN).waitMax, 6 * MIN, "the second one's wait at the bucket's end");
  assertEquals(at(T0 - 10 * MIN).busy, 0, "idle buckets are zero, not gaps");
  assertEquals([v.totals.ok, v.totals.failed], [1, 1]);
  assertEquals(h.jobs(["mac-arm"]).length, 2);
  // Live samples win over back-filled ones; a second back-fill doesn't double the counts.
  backfillHistory(h, intervals, () => 2, T0);
  assertEquals(poolHistory(h, "mac-arm", "1h", T0).totals.ok, 1);
});

// ---- the service and the detail ----

const noSecrets = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
};

Deno.test("service: polls sample the history; it is saved, and back-filled only on the first run", async () => {
  const saved: unknown[] = [];
  let timers = 0;
  const journal: FleetEvent[] = [
    ev(1, NOW - 40 * MIN, "queued", "queued for mac-arm", 1),
    ev(2, NOW - 35 * MIN, "started", "started on mac-arm on r1", 1),
    ev(3, NOW - 10 * MIN, "finished", "finished: success", 1),
  ];
  const mk = (stored: unknown) =>
    createFleetService({
      ghToken: () => Promise.resolve("x".repeat(40)),
      secrets: noSecrets,
      fetch: fakeFetch(standardRoutes()).fetch,
      now: () => NOW,
      notify: () => {},
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      loadHistory: () => Promise.resolve(stored),
      saveHistory: (d) => Promise.resolve(void saved.push(JSON.parse(JSON.stringify(d)))),
      readJournal: () => Promise.resolve(journal),
      setTimeout: () => ++timers,
      clearTimeout: () => {},
    });
  const svc = mk(null);
  await svc.start();
  await svc.historyReady();
  assertEquals(saved.length, 1, "the back-fill is saved at once");
  const d = svc.poolDetail("mac-arm", "1h");
  assert(d.jobs.some((j) => j.id === 1), "the journal's job is back-filled");
  assert(d.backfilledAt !== null);
  // The poll sampled every card.
  const s = svc.history().series("mac-arm")!;
  assert(s.fine.some((b) => b.n > 0));
  assert(svc.history().series("github"), "GitHub-hosted is sampled too");
  // The fixture CI run's completed jobs were recorded from the poll.
  assert(svc.history().allJobs().length > 1);
  await svc.flushHistory();
  assertEquals(saved.length, 2);
  await svc.flushHistory();
  assertEquals(saved.length, 2, "nothing changed: no write");
  svc.stop();

  // The next start reads it back and doesn't back-fill again.
  let read = 0;
  const again = createFleetService({
    ghToken: () => Promise.resolve(null),
    secrets: noSecrets,
    now: () => NOW,
    notify: () => {},
    load: () => Promise.resolve(null),
    save: () => Promise.resolve(),
    loadHistory: () => Promise.resolve(saved.at(-1)),
    readJournal: () => Promise.resolve(void read++ as never),
    setTimeout: () => 0,
    clearTimeout: () => {},
  });
  await again.start();
  await again.historyReady();
  assertEquals(read, 0);
  assertEquals(again.poolDetail("mac-arm", "1h").jobs[0].id, 1);
  again.stop();
});

Deno.test("detail: a shared machine (settings host), labels, events, and the github images", async () => {
  const doc = JSON.parse(JSON.stringify(ORG_SETTINGS)) as {
    integrations: { runnerScheduler: { pools: { id: string; host?: string }[] } };
  };
  for (const p of doc.integrations.runnerScheduler.pools) {
    if (p.id === "linux-x64" || p.id === "linux-x64-docker") p.host = "box";
  }
  await withSettings(doc as unknown as FleetSettings, () => {
    assertEquals(sharedHost("linux-x64"), {
      host: "box",
      pools: ["linux-x64", "linux-x64-docker"],
    });
    assertEquals(sharedHost("mac-arm"), null);
    const h = new HistoryStore();
    h.sample(T0, [
      { key: "linux-x64", busy: 2, slots: 3, queued: 0, waitMs: 0 },
      { key: "linux-x64-docker", busy: 1, slots: 1, queued: 0, waitMs: 0 },
      { key: imageKey("ubuntu-24.04"), busy: 2, slots: null, queued: 0, waitMs: 0 },
    ]);
    h.jobDone(rec(5, { pool: "github", image: "ubuntu-24.04" }), T0);
    const card: PoolCard = {
      id: "linux-x64",
      title: "linux-x64",
      label: "acme-linux-x64",
      slots: 3,
      busy: 2,
      running: 2,
      queued: 0,
      state: "ok",
      reason: "",
      since: null,
      oldestQueuedSince: null,
    };
    const snapshot = { pools: [card] } as never;
    const events = [
      ev(1, T0, "started", "started on linux-x64 on r", 77),
      ev(2, T0, "started", "started on linux-x64-docker on r", 78),
      {
        ...ev(3, T0, "pool-health", "linux-x64 paused", 0),
        job_id: undefined,
        workflow: "pool linux-x64",
      },
    ];
    const d = poolDetail({ store: h, snapshot, events, pool: "linux-x64", range: "1h", now: T0 });
    assertEquals(d.host, "box");
    assertEquals(d.combined!.points.find((p) => p.t === T0)!.busy, 3);
    assertEquals(d.combined!.points.find((p) => p.t === T0)!.slots, 4);
    assertEquals(d.labels, ["denext-linux-x64"], "the pool list's label");
    assertEquals(d.events.map((e) => e.seq), [3, 1], "its own lines only, newest first");
    assertEquals(d.runnerLogs, false, "no logsDir in these settings");
    const g = poolDetail({ store: h, snapshot, events, pool: "github", range: "24h", now: T0 });
    assertEquals(g.images.map((i) => i.image), ["ubuntu-24.04"]);
    assertEquals(g.combined, null);
  });
  // poolEvents on its own: the GitHub-hosted pool by its log name.
  assertEquals(
    poolEvents([ev(1, T0, "queued", "queued for GitHub-hosted", 3)], "github", new Set()).length,
    1,
  );
});

Deno.test("history sources: a completed job's record; skipped and unfinished jobs give none", () => {
  const job = {
    id: 9,
    run_id: 2,
    name: "build",
    status: "completed",
    conclusion: "success",
    created_at: new Date(T0 - 9 * MIN).toISOString(),
    started_at: new Date(T0 - 8 * MIN).toISOString(),
    completed_at: new Date(T0 - MIN).toISOString(),
    labels: ["ubuntu-24.04"],
    runner_name: "GitHub Actions 3",
    html_url: "https://github.com/acme/web/actions/runs/2/job/9",
  };
  const r = jobRecord("acme/web", { name: "CI" }, job, "github")!;
  assertEquals([r.workflow, r.image, r.runner, r.started, r.completed], [
    "CI",
    "ubuntu-24.04",
    "GitHub Actions 3",
    T0 - 8 * MIN,
    T0 - MIN,
  ]);
  assertEquals(jobRecord("acme/web", { name: "CI" }, { ...job, conclusion: "skipped" }, "x"), null);
  assertEquals(jobRecord("acme/web", { name: "CI" }, { ...job, status: "in_progress" }, "x"), null);
});

Deno.test("settings: a pool's host and the scheduler's logsDir validate; bad values are refused", async () => {
  const { validateSettings, DEFAULT_SETTINGS } = await import("../lib/settings.ts");
  const doc = (sched: unknown) => ({
    ...DEFAULT_SETTINGS,
    integrations: { runnerScheduler: sched },
  });
  const ok = validateSettings(doc({
    pools: [{ id: "a", label: "l", host: "box" }],
    logsDir: "~/Library/Logs/acme",
  }));
  assert(ok.ok);
  if (ok.ok) {
    assertEquals(ok.settings.integrations.runnerScheduler!.pools[0].host, "box");
    assertEquals(ok.settings.integrations.runnerScheduler!.logsDir, "~/Library/Logs/acme");
  }
  assertFalse(validateSettings(doc({ pools: [], logsDir: "relative/dir" })).ok);
  assertFalse(validateSettings(doc({ pools: [{ id: "a", label: "l", host: "a b" }] })).ok);
  const none = validateSettings(doc({ pools: [] }));
  assert(none.ok && none.settings.integrations.runnerScheduler!.logsDir === "");
});
