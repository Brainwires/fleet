// The back-fill from the webhook spool (what happened while Fleet was closed) and the spool's
// "last delivery" at startup, over a fixture spool (tests/fixtures/hooks-spool.jsonl): the gap
// filled at real times, ordering, the window and cap, no duplicates on a second start, the journal
// in order with increasing seq, and no notifications.

import { assert, assertEquals } from "@std/assert";
import { BACKFILL_MAX, backfillEvents, dropLogged } from "../lib/backfill.ts";
import { lastSpoolDeliveryAt, readSpoolSince, tailSpool } from "../lib/deno-hooks.ts";
import { EventLog, type FleetEvent, mergeEvents, type NewEvent } from "../lib/events.ts";
import { type HookDelivery, HOOKS_STALE_MS, hooksState } from "../lib/hooks.ts";
import { createFleetService } from "../lib/service.ts";
import { NOW } from "./helpers.ts";

const at = (iso: string) => Date.parse(iso);
const FIXTURE = new URL("./fixtures/hooks-spool.jsonl", import.meta.url);

/** A temp hooks dir holding the fixture as `events.jsonl`. */
async function spoolDir(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "fleet-spool-" });
  await Deno.copyFile(FIXTURE, `${dir}/events.jsonl`);
  return dir;
}

/** The log as it was when Fleet quit: one line at 14:00. */
const BEFORE: FleetEvent = {
  seq: 7,
  at: at("2026-11-11T14:00:00Z"),
  sev: "info",
  kind: "queued",
  repo: "Brainwires/denext",
  workflow: "CI",
  job: "earlier",
  job_id: 4000,
  run_id: 500,
  text: "queued for linux-x64",
  url: null,
};

const job = (id: number, run: number, status: string, extra: Record<string, unknown> = {}) => ({
  id,
  run_id: run,
  name: `job ${id}`,
  status,
  labels: ["self-hosted", "denext-linux-x64"],
  created_at: "2026-11-11T15:00:00Z",
  workflow_name: "CI",
  head_branch: "development",
  html_url: `https://github.com/Brainwires/denext/actions/runs/${run}/job/${id}`,
  ...extra,
});
const delivery = (id: string, t: number, workflowJob: Record<string, unknown>): HookDelivery => ({
  id,
  event: "workflow_job",
  receivedAt: t,
  payload: { repository: { full_name: "Brainwires/denext" }, workflow_job: workflowJob },
});

Deno.test("spool: the fixture reads after a time, deduped by delivery id, oldest first", async () => {
  const dir = await spoolDir();
  try {
    const all = await readSpoolSince(-Infinity, dir);
    assertEquals(all.map((d) => d.id), ["d0", "d1", "d2", "d3", "d4", "d5"]);
    const later = await readSpoolSince(at("2026-11-11T14:00:00Z"), dir);
    assertEquals(later.map((d) => d.id), ["d1", "d2", "d3", "d4", "d5"]);
    // The rotated file is read first.
    await Deno.rename(`${dir}/events.jsonl`, `${dir}/events.jsonl.1`);
    await Deno.writeTextFile(`${dir}/events.jsonl`, "");
    assertEquals((await readSpoolSince(-Infinity, dir)).length, 6);
    assertEquals(await readSpoolSince(0, `${dir}/missing`), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("spool: the newest delivery is the 'last delivery' a tail starts with (not 'no delivery yet')", async () => {
  const dir = await spoolDir();
  try {
    // The last lines are a push event and garbage: the newest workflow delivery is d5 at 16:00.
    assertEquals(await lastSpoolDeliveryAt(dir), at("2026-11-11T16:00:00Z"));
    const tail = await tailSpool(() => {}, dir, 60_000);
    assert(tail);
    tail.stop();
    assertEquals(tail.lastDeliveryAt, at("2026-11-11T16:00:00Z"));
    // Five minutes later the badge is live, not "stale (no delivery yet)".
    assertEquals(hooksState(true, tail.lastDeliveryAt, tail.lastDeliveryAt! + 5 * 60_000), "live");
    assertEquals(
      hooksState(true, tail.lastDeliveryAt, tail.lastDeliveryAt! + HOOKS_STALE_MS + 1),
      "stale",
    );
    // Only the rotated file has deliveries (just rotated): it is read.
    await Deno.rename(`${dir}/events.jsonl`, `${dir}/events.jsonl.1`);
    await Deno.writeTextFile(`${dir}/events.jsonl`, "");
    assertEquals(await lastSpoolDeliveryAt(dir), at("2026-11-11T16:00:00Z"));
    // A line longer than one read window (256 KB) is still found.
    const big = JSON.stringify({
      received_at: "2026-11-11T17:00:00.000Z",
      delivery: "big",
      event: "workflow_job",
      payload: { pad: "x".repeat(600_000), workflow_job: {} },
    });
    await Deno.writeTextFile(`${dir}/events.jsonl`, big + "\nhalf a li");
    assertEquals(await lastSpoolDeliveryAt(dir), at("2026-11-11T17:00:00Z"));
    assertEquals(await lastSpoolDeliveryAt(`${dir}/missing`), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill: the gap is filled at real times, marked, oldest first", async () => {
  const dir = await spoolDir();
  try {
    const ds = await readSpoolSince(-Infinity, dir);
    const lines = backfillEvents(ds, [BEFORE], { since: BEFORE.at, now: NOW });
    assertEquals(lines.map((e) => [new Date(e.at).toISOString().slice(11, 19), e.job, e.text]), [
      ["15:00:00", "build", "queued for linux-x64"],
      ["15:01:00", "build", "started on linux-x64 on denext-linux-x64-1-2"],
      ["15:20:00", "build", 'finished: failure at step "Run tests"'],
      ["15:20:30", null, "run 600 completed: failure"],
      ["16:00:00", "lint", "queued for linux-x64"],
    ]);
    assert(lines.every((e) => e.backfill === true));
    assertEquals(lines[2].sev, "bad");
    assertEquals(lines[2].job_id, 5001);
    assertEquals(lines[3].run_id, 600);
    // Nothing at or before the log's last line (d0 at 13:00 is older than it).
    assert(lines.every((e) => e.at > BEFORE.at));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("backfill: de-duplicated against the log; the window and the cap; cancels grouped", () => {
  const t0 = NOW - 60 * 60_000;
  const ds = [
    delivery("a", t0, job(1, 10, "queued")),
    delivery("b", t0 + 1000, job(1, 10, "in_progress", { runner_name: "denext-linux-x64-1-1" })),
    delivery("b2", t0 + 1500, job(1, 10, "in_progress", { runner_name: "denext-linux-x64-1-1" })),
    delivery("c", t0 + 2000, job(2, 11, "completed", { conclusion: "skipped" })),
  ];
  // The log already has job 1's start (the live path logged it): only its queued line is new.
  const held: FleetEvent[] = [{ ...BEFORE, at: t0 - 1, kind: "started", job_id: 1, seq: 3 }];
  const lines = backfillEvents(ds, held, { since: null, now: NOW });
  assertEquals(lines.map((e) => `${e.job_id}:${e.kind}`), ["1:queued"]);
  // A skipped job never seen queued gets no line (as live); a redelivery is one line.

  // The window: 24 h at most, even with an empty log.
  const old = backfillEvents([delivery("o", NOW - 25 * 3600_000, job(3, 12, "queued"))], [], {
    since: null,
    now: NOW,
  });
  assertEquals(old, []);

  // The cap: the newest BACKFILL_MAX lines.
  const many = Array.from(
    { length: BACKFILL_MAX + 40 },
    (_, i) => delivery(`m${i}`, t0 + i, job(100 + i, 20, "queued")),
  );
  const capped = backfillEvents(many, [], { since: null, now: NOW });
  assertEquals(capped.length, BACKFILL_MAX);
  assertEquals(capped[0].job_id, 140);
  assertEquals(capped.at(-1)!.job_id, 100 + BACKFILL_MAX + 39);

  // Two cancelled jobs of one run: one line, and the run's own cancelled completion folds in.
  const cancels: HookDelivery[] = [
    delivery("x1", t0, job(201, 30, "completed", { conclusion: "cancelled" })),
    delivery("x2", t0 + 10, job(202, 30, "completed", { conclusion: "cancelled" })),
    {
      id: "x3",
      event: "workflow_run",
      receivedAt: t0 + 20,
      payload: {
        repository: { full_name: "Brainwires/denext" },
        workflow_run: {
          id: 30,
          name: "CI",
          head_sha: "abc",
          event: "push",
          status: "completed",
          conclusion: "cancelled",
          html_url: "https://github.com/Brainwires/denext/actions/runs/30",
          created_at: "2026-11-11T15:00:00Z",
        },
      },
    },
  ];
  const c = backfillEvents(cancels, [], { since: null, now: NOW });
  assertEquals(c.map((e) => e.text), ["run 30 cancelled (2 jobs)"]);
  assertEquals(c[0].at, t0 + 10);
});

Deno.test("backfill: the live diff doesn't log a back-filled job line again", () => {
  const held = [{ ...BEFORE, kind: "started" as const, job_id: 9 }];
  const fresh: NewEvent[] = [
    { ...BEFORE, kind: "started", job_id: 9 },
    { ...BEFORE, kind: "finished", job_id: 9, text: "finished: success" },
    { ...BEFORE, kind: "stalled", job_id: 9, text: "STALLED" },
  ];
  assertEquals(dropLogged(fresh, held).map((e) => e.kind), ["finished", "stalled"]);
});

Deno.test("event log: inserted lines take new seqs and land by time; the page merges the same way", () => {
  const log = new EventLog([BEFORE, { ...BEFORE, seq: 8, at: at("2026-11-11T17:00:00Z") }], 8);
  const added = log.insert([{ ...BEFORE, at: at("2026-11-11T15:00:00Z"), backfill: true }]);
  assertEquals(added.map((e) => e.seq), [9]);
  assertEquals(log.after(0).map((e) => e.seq), [7, 9, 8]);
  assertEquals(log.after(8).map((e) => e.seq), [9]);
  assertEquals(mergeEvents([BEFORE, { ...BEFORE, seq: 8, at: NOW }], added).map((e) => e.seq), [
    7,
    9,
    8,
  ]);
});

Deno.test("service: startup back-fills the gap once, journals it in order, never notifies", async () => {
  const dir = await spoolDir();
  try {
    let stored: unknown = { log: { seq: 7, events: [BEFORE] }, tracker: null };
    const journal: FleetEvent[] = [];
    const notified: unknown[] = [];
    const mk = () =>
      createFleetService({
        // No token: no polling, so whatever is logged comes from the back-fill.
        ghToken: () => Promise.resolve(null),
        secrets: {
          get: () => Promise.resolve(null),
          set: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        },
        now: () => NOW,
        notify: (n) => void notified.push(n),
        load: () => Promise.resolve(null),
        save: () => Promise.resolve(),
        loadLog: () => Promise.resolve(stored),
        saveLog: (d) => Promise.resolve(void (stored = JSON.parse(JSON.stringify(d)))),
        appendJournal: (events) => Promise.resolve(void journal.push(...events)),
        journalLastSeq: () => Promise.resolve(journal.at(-1)?.seq ?? 7),
        readSpool: (since) => readSpoolSince(since, dir),
        setTimeout: () => 0,
        clearTimeout: () => {},
      });
    const svc = mk();
    await svc.start();
    const events = svc.events(0).events;
    assertEquals(events.length, 6);
    assertEquals(events[0].seq, 7);
    assert(events.slice(1).every((e) => e.backfill));
    // By time in the log, with increasing seqs in the journal.
    assertEquals(events.map((e) => e.at), [...events.map((e) => e.at)].sort((a, b) => a - b));
    assertEquals(journal.map((e) => e.seq), [8, 9, 10, 11, 12]);
    assertEquals(journal.map((e) => e.at), [...journal.map((e) => e.at)].sort((a, b) => a - b));
    assertEquals(svc.snapshot().eventSeq, 12);
    // The spool found later (the hooks start): nothing new.
    assertEquals(await svc.backfill(), 0);
    svc.stop();

    // A second start: the log comes back with the lines once, no duplicates.
    const again = mk();
    await again.start();
    assertEquals(again.events(0).events.length, 6);
    assertEquals(journal.length, 5);
    again.stop();

    // A failed default-branch job came in while closed: in the log, never a notification.
    assertEquals(notified, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
