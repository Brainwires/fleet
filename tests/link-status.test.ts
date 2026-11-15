// A GitHub link's run / job status from Fleet's snapshot (lib/link-status.ts), behind the in-app
// panel's reopen rule: live while queued or running, done once finished, unknown otherwise.

import { assertEquals } from "@std/assert";
import { linkStatus } from "../lib/link-status.ts";
import type { FinishedJob, RepoGroup, Snapshot } from "../lib/model.ts";

const BASE = "https://github.com/Brainwires/denext/actions/runs";

const group = (runId: number, jobIds: number[]) =>
  ({
    repo: "Brainwires/denext",
    runs: [{ id: runId, url: `${BASE}/${runId}`, jobs: jobIds.map((id) => ({ id })) }],
  }) as unknown as RepoGroup;

const finished = (runId: number, id: number) => ({ runId, id }) as unknown as FinishedJob;

const SNAP = {
  running: [group(1, [11, 12])],
  queued: [group(2, [21])],
  finished: [finished(3, 31), finished(1, 10)],
} as unknown as Pick<Snapshot, "running" | "queued" | "finished">;

Deno.test("link status: a run or job in progress is live (running and queued lanes)", () => {
  assertEquals(linkStatus(SNAP, `${BASE}/1`), "live");
  assertEquals(linkStatus(SNAP, `${BASE}/1/job/12`), "live");
  assertEquals(linkStatus(SNAP, `${BASE}/2/job/21`), "live");
  assertEquals(linkStatus(SNAP, `${BASE}/1/job/12#step:4:120`), "live", "a step hash is the job");
  assertEquals(linkStatus(SNAP, `${BASE}/2?pr=7`), "live");
});

Deno.test("link status: a finished run or job is done", () => {
  assertEquals(linkStatus(SNAP, `${BASE}/3`), "done");
  assertEquals(linkStatus(SNAP, `${BASE}/3/job/31`), "done");
  assertEquals(linkStatus(SNAP, `${BASE}/1/job/10`), "done", "a finished job of a live run");
});

Deno.test("link status: other pages and runs Fleet doesn't know are unknown", () => {
  assertEquals(linkStatus(SNAP, `${BASE}/99`), null);
  assertEquals(linkStatus(SNAP, `${BASE}/1/job/99`), null);
  assertEquals(linkStatus(SNAP, "https://github.com/Brainwires/denext/pull/7"), null);
  assertEquals(linkStatus(null, `${BASE}/1`), null);
});
