// The event log's diffing over successive observations: seeding without a flood, queued →
// started → finished (failed step, annotation), cancel bursts as one line, STALLED / QUEUED-LONG
// timers and their repeat, run completion, pool health and alerts, restart restore, the bounds.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  diffObservation,
  EventLog,
  isProblem,
  LOG_LIMIT,
  newTracker,
  QUEUE_LONG_MS,
  REPEAT_MS,
  RESEED_MS,
  restoreTracker,
  STALL_MS,
} from "../lib/events.ts";
import type { GhJob, GhJobList, GhRun, GhRunList } from "../lib/github-types.ts";
import { parsePoolHealth } from "../lib/health.ts";
import type { Observation } from "../lib/poller.ts";
import { fixture, NOW } from "./helpers.ts";

const RUN: GhRun = fixture<GhRunList>("denext-runs-in_progress.json").workflow_runs[0];
const unavailable = parsePoolHealth(null, NOW);

function obs(
  now: number,
  runs: { run?: Partial<GhRun>; jobs: GhJob[] }[],
  extra: Partial<Observation> = {},
): Observation {
  return {
    now,
    runs: runs.map((r) => ({ repo: "Brainwires/denext", run: { ...RUN, ...r.run }, jobs: r.jobs })),
    health: unavailable,
    annotations: new Map(),
    ...extra,
  };
}

const job = (id: number, over: Partial<GhJob> = {}): GhJob => ({
  id,
  run_id: RUN.id,
  name: `job-${id}`,
  status: "queued",
  labels: ["self-hosted", "denext-linux-x64"],
  runner_name: null,
  created_at: new Date(NOW - 60_000).toISOString(),
  started_at: null,
  html_url: `https://github.com/Brainwires/denext/actions/runs/${RUN.id}/job/${id}`,
  ...over,
});

Deno.test("events: the first observation records state and emits nothing", () => {
  const t = newTracker();
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs;
  assertEquals(diffObservation(t, obs(NOW, [{ jobs: [...jobs] }])), []);
  assert(t.seeded);
  assertEquals(Object.keys(t.jobs).length, jobs.length);
  // Nothing changed: still nothing.
  assertEquals(diffObservation(t, obs(NOW + 15_000, [{ jobs: [...jobs] }])), []);
});

Deno.test("events: queued → started → finished, with the failed step and annotation", () => {
  const t = newTracker();
  diffObservation(t, obs(NOW, [{ jobs: [] }]));
  let ev = diffObservation(t, obs(NOW + 1000, [{ jobs: [job(1)] }]));
  assertEquals(ev.map((e) => [e.kind, e.sev, e.text]), [[
    "queued",
    "info",
    "queued for linux-x64",
  ]]);
  assertEquals(ev[0].job, "job-1");
  assertEquals(ev[0].workflow, "CI");
  assertEquals(ev[0].branch, "train/4.17");
  assertStringIncludes(ev[0].url!, "/job/1");
  ev = diffObservation(
    t,
    obs(NOW + 2000, [{
      jobs: [job(1, {
        status: "in_progress",
        runner_name: "denext-linux-x64-2-17944",
        started_at: new Date(NOW + 2000).toISOString(),
      })],
    }]),
  );
  assertEquals(ev.map((e) => e.text), ["started on linux-x64 on denext-linux-x64-2-17944"]);
  const failed = job(1, {
    status: "completed",
    conclusion: "failure",
    runner_name: "denext-linux-x64-2-17944",
    steps: [
      { name: "Set up job", status: "completed", conclusion: "success" },
      { name: "Run tests", status: "completed", conclusion: "failure" },
      { name: "Post", status: "completed", conclusion: "skipped" },
    ],
  });
  ev = diffObservation(
    t,
    obs(NOW + 3000, [{ jobs: [failed] }], {
      annotations: new Map([[1, "Process completed with exit code 1."]]),
    }),
  );
  assertEquals(ev.length, 1);
  assertEquals(ev[0].sev, "bad");
  assertEquals(
    ev[0].text,
    'finished: failure at step "Run tests" (Process completed with exit code 1.)',
  );
  assert(isProblem(ev[0]));
});

Deno.test("events: a burst of cancelled jobs in one run is one line; the run's own line folds in", () => {
  const t = newTracker();
  const jobs = Array.from(
    { length: 14 },
    (_, i) =>
      job(100 + i, {
        status: "in_progress",
        runner_name: "denext-linux-x64-1-1",
        started_at: new Date(NOW).toISOString(),
      }),
  );
  diffObservation(t, obs(NOW, [{ jobs }]));
  const ev = diffObservation(
    t,
    obs(NOW + 15_000, [{
      run: { status: "completed", conclusion: "cancelled" },
      jobs: jobs.map((j) => ({ ...j, status: "completed", conclusion: "cancelled" })),
    }]),
  );
  assertEquals(ev.map((e) => [e.kind, e.sev, e.text]), [
    ["run-cancelled", "muted", `run ${RUN.id} cancelled (14 jobs)`],
  ]);
  assertEquals(ev[0].job, null);
});

Deno.test("events: one cancelled job is its own line; a run completing gets its conclusion", () => {
  const t = newTracker();
  diffObservation(
    t,
    obs(NOW, [{ jobs: [job(1, { status: "in_progress" }), job(2, { status: "in_progress" })] }]),
  );
  let ev = diffObservation(
    t,
    obs(NOW + 1000, [{
      jobs: [
        job(1, { status: "completed", conclusion: "cancelled" }),
        job(2, { status: "in_progress" }),
      ],
    }]),
  );
  assertEquals(ev.map((e) => e.text), ["finished: cancelled"]);
  ev = diffObservation(
    t,
    obs(NOW + 2000, [{
      run: { status: "completed", conclusion: "success" },
      jobs: [
        job(1, { status: "completed", conclusion: "cancelled" }),
        job(2, { status: "completed", conclusion: "success" }),
      ],
    }]),
  );
  assertEquals(ev.map((e) => [e.kind, e.sev, e.text]), [
    ["finished", "ok", "finished: success"],
    ["run-completed", "ok", `run ${RUN.id} completed: success`],
  ]);
  // The finished run is forgotten after it leaves the observation.
  diffObservation(t, obs(NOW + 3000, []));
  assertEquals(Object.keys(t.jobs).length, 0);
  assertEquals(Object.keys(t.runs).length, 0);
});

Deno.test("events: STALLED past 75 min and QUEUED-LONG past 25 min, once, then every 30 min", () => {
  const t = newTracker();
  const started = NOW - STALL_MS + 60_000; // stalls one minute from now
  const running = job(1, {
    status: "in_progress",
    runner_name: "denext-mac-arm-1-1",
    labels: ["self-hosted", "denext-macos-arm64"],
    started_at: new Date(started).toISOString(),
  });
  const waiting = job(2, { created_at: new Date(NOW - QUEUE_LONG_MS + 60_000).toISOString() });
  diffObservation(t, obs(NOW, [{ jobs: [running, waiting] }]));
  let ev = diffObservation(t, obs(NOW + 2 * 60_000, [{ jobs: [running, waiting] }]));
  assertEquals(ev.map((e) => [e.kind, e.sev]), [["stalled", "warn"], ["queued-long", "warn"]]);
  assertStringIncludes(ev[0].text, "STALLED: running 76 min on mac-arm");
  assertStringIncludes(ev[1].text, "QUEUED-LONG: 26 min with no runner (linux-x64)");
  // Not again within 30 minutes…
  assertEquals(diffObservation(t, obs(NOW + 20 * 60_000, [{ jobs: [running, waiting] }])), []);
  // …then again.
  ev = diffObservation(t, obs(NOW + 2 * 60_000 + REPEAT_MS, [{ jobs: [running, waiting] }]));
  assertEquals(ev.map((e) => e.kind), ["stalled", "queued-long"]);
  // A queued job with a runner assigned is not QUEUED-LONG.
  const t2 = newTracker();
  const assigned = { ...waiting, id: 3, runner_name: "denext-linux-x64-1-1" };
  diffObservation(t2, obs(NOW, [{ jobs: [assigned] }]));
  assertEquals(diffObservation(t2, obs(NOW + 5 * 60_000, [{ jobs: [assigned] }])), []);
});

Deno.test("events: a job already late at the seed gets its first warning a period later", () => {
  const t = newTracker();
  const old = job(1, { created_at: new Date(NOW - 3 * 3600_000).toISOString() });
  diffObservation(t, obs(NOW, [{ jobs: [old] }]));
  assertEquals(diffObservation(t, obs(NOW + 60_000, [{ jobs: [old] }])), []);
  assertEquals(diffObservation(t, obs(NOW + REPEAT_MS, [{ jobs: [old] }])).map((e) => e.kind), [
    "queued-long",
  ]);
});

Deno.test("events: pool health changes and new alerts", () => {
  const health = (ok: boolean, paused: boolean, alerts: unknown[] = []) =>
    parsePoolHealth(
      JSON.stringify({
        v: 1,
        checked_at: NOW / 1000,
        pools: {
          "denext-windows-x64": {
            ok,
            reason: ok ? "" : "guest unreachable",
            since: 1,
            slots: 1,
            busy: 0,
            paused,
          },
        },
        alerts,
      }),
      NOW,
    );
  const t = newTracker();
  const a1 = { at: NOW / 1000 - 600, pool: "win-x64", msg: "old alert" };
  assertEquals(diffObservation(t, obs(NOW, [], { health: health(true, false, [a1]) })), []);
  let ev = diffObservation(t, obs(NOW + 1000, [], { health: health(false, false, [a1]) }));
  assertEquals(ev.map((e) => [e.kind, e.sev, e.workflow, e.text]), [
    ["pool-health", "bad", "pool win-x64", "win-x64 unhealthy: guest unreachable"],
  ]);
  const a2 = { at: NOW / 1000, pool: "win-x64", msg: "RECOVERED: guest reachable" };
  ev = diffObservation(t, obs(NOW + 2000, [], { health: health(true, true, [a1, a2]) }));
  assertEquals(ev.map((e) => [e.sev, e.text]), [
    ["ok", "win-x64 healthy again"],
    ["warn", "win-x64 paused"],
    ["ok", "RECOVERED: guest reachable"],
  ]);
  // Unavailable or stale health is no change.
  assertEquals(diffObservation(t, obs(NOW + 3000, [])), []);
});

Deno.test("events: restart restore continues the diff; stale state re-seeds without a flood", () => {
  const t = newTracker();
  diffObservation(t, obs(NOW, [{ jobs: [job(1, { status: "in_progress" })] }]));
  const saved = JSON.parse(JSON.stringify(t));
  // Restarted 5 minutes later: the job finished meanwhile, and that is reported.
  const fresh = restoreTracker(saved, NOW + 5 * 60_000);
  assert(fresh.seeded);
  const ev = diffObservation(
    fresh,
    obs(NOW + 5 * 60_000, [{ jobs: [job(1, { status: "completed", conclusion: "success" })] }]),
  );
  assertEquals(ev.map((e) => e.text), ["finished: success"]);
  // Restarted the next day: re-seeded, nothing emitted for what happened while it was off.
  const stale = restoreTracker(saved, NOW + RESEED_MS + 60_000);
  assertEquals(stale.seeded, false);
  assertEquals(
    diffObservation(
      stale,
      obs(NOW + RESEED_MS + 60_000, [{
        jobs: [job(1, { status: "completed", conclusion: "success" }), job(2)],
      }]),
    ),
    [],
  );
  // Garbage gives a fresh tracker.
  assertEquals(restoreTracker("nope", NOW).seeded, false);
  assertEquals(restoreTracker({ v: 2 }, NOW).seeded, false);
});

Deno.test("event log: numbering, bound, after(), and restore", () => {
  const log = new EventLog();
  const line = (i: number) => ({
    at: NOW + i,
    sev: "info" as const,
    kind: "queued" as const,
    repo: "Brainwires/denext",
    workflow: "CI",
    job: `j${i}`,
    text: "queued",
    url: null,
  });
  log.append(Array.from({ length: LOG_LIMIT + 50 }, (_, i) => line(i)));
  assertEquals(log.size, LOG_LIMIT);
  assertEquals(log.lastSeq, LOG_LIMIT + 50);
  assertEquals(log.after(LOG_LIMIT + 48).map((e) => e.seq), [LOG_LIMIT + 49, LOG_LIMIT + 50]);
  // A page holding a sequence from a newer log (another launch) gets everything.
  assertEquals(log.after(99_999).length, LOG_LIMIT);
  const back = EventLog.from(JSON.parse(JSON.stringify(log.toJSON())));
  assertEquals(back.size, LOG_LIMIT);
  assertEquals(back.append([line(1)])[0].seq, LOG_LIMIT + 51);
  assertEquals(EventLog.from({ events: "x" }).size, 0);
  assertEquals(EventLog.from(null).lastSeq, 0);
});

Deno.test("service: the log seeds silently, records a finished run, and survives a restart", async () => {
  const { createFleetService } = await import("../lib/service.ts");
  const { fakeFetch, standardRoutes, ciRunId } = await import("./helpers.ts");
  const routes = standardRoutes();
  const { fetch } = fakeFetch(routes);
  let t = NOW;
  let stored: unknown = null;
  const mk = () =>
    createFleetService({
      ghToken: () => Promise.resolve("gho_" + "b".repeat(36)),
      secrets: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      fetch,
      now: () => t,
      notify: () => {},
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      loadLog: () => Promise.resolve(stored),
      saveLog: (d) => Promise.resolve(void (stored = JSON.parse(JSON.stringify(d)))),
      setTimeout: () => 0,
      clearTimeout: () => {},
    });
  const svc = mk();
  await svc.start();
  assertEquals(svc.events(0).events, [], "the first poll emits nothing");
  // The CI run finishes.
  const jobs = fixture<GhJobList>("denext-ci-jobs.json").jobs.map((j) =>
    j.status === "completed"
      ? j
      : { ...j, status: "completed", conclusion: "success", completed_at: "2026-11-11T17:40:00Z" }
  );
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: { total_count: 0, workflow_runs: [] },
  };
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}/jobs?per_page=100`] = {
    body: { total_count: jobs.length, jobs },
  };
  routes[`/repos/Brainwires/denext/actions/runs/${ciRunId()}`] = {
    body: { ...RUN, status: "completed", conclusion: "failure" },
  };
  t += 60_000;
  await svc.refresh();
  const texts = svc.events(0).events.map((e) => e.text);
  assert(texts.includes(`run ${ciRunId()} completed: failure`), texts.join("\n"));
  assert(texts.includes("finished: success"));
  assertEquals(svc.snapshot().eventSeq, svc.events(0).lastSeq);
  await svc.logAction({
    sev: "info",
    kind: "action",
    repo: "Brainwires/denext",
    workflow: "CI",
    job: null,
    text: "test action",
    url: null,
  });
  const n = svc.events(0).events.length;
  assertEquals(svc.events(0).events.at(-1)?.user, true);
  svc.stop();
  // Restart: the log comes back.
  const again = mk();
  t += 60_000;
  await again.start();
  assertEquals(again.events(0).events.length, n);
  assertEquals(again.events(n - 1).events.map((e) => e.text), ["test action"]);
  again.stop();
});
