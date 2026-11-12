// The webhook receiver with a TEST secret (never the real one): signature, size, type and route
// refusals before any parse, de-duplication, ping, and the payloads reaching the same state and
// event log as polling; the reconciliation timer.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { pollPlan, RECONCILE_MS, VISIBLE_MS } from "../lib/budget.ts";
import {
  createHookHandler,
  type HookDelivery,
  HOOKS_STALE_MS,
  hooksState,
  MAX_BODY,
  safeEqual,
  signBody,
} from "../lib/hooks.ts";
import { createFleetService } from "../lib/service.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const SECRET = "test-secret-not-the-real-one";
const URL_ = "http://127.0.0.1:8789/github/hooks";

async function post(
  handler: (r: Request) => Promise<Response>,
  body: string | Uint8Array,
  opts: {
    event?: string;
    id?: string;
    sig?: string | null;
    type?: string;
    url?: string;
    method?: string;
  } = {},
): Promise<Response> {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const headers = new Headers({ "content-type": opts.type ?? "application/json" });
  const sig = opts.sig === undefined ? await signBody(SECRET, bytes) : opts.sig;
  if (sig !== null) headers.set("x-hub-signature-256", sig);
  headers.set("x-github-event", opts.event ?? "workflow_job");
  headers.set("x-github-delivery", opts.id ?? crypto.randomUUID());
  return handler(
    new Request(opts.url ?? URL_, {
      method: opts.method ?? "POST",
      headers,
      body: opts.method === "GET" ? undefined : bytes as BodyInit,
    }),
  );
}

function setup() {
  const delivered: HookDelivery[] = [];
  const rejects: string[] = [];
  const verified: string[] = [];
  const handler = createHookHandler({
    secret: SECRET,
    onDelivery: (d) => delivered.push(d),
    onVerified: (e) => verified.push(e),
    onReject: (w) => rejects.push(w),
    now: () => NOW,
    defer: (fn) => fn(),
  });
  return { handler, delivered, rejects, verified };
}

const JOB = {
  action: "queued",
  repository: { full_name: "Brainwires/denext" },
  workflow_job: {
    id: 9001,
    run_id: 777,
    name: "check",
    status: "queued",
    labels: ["self-hosted", "denext-linux-x64"],
    runner_name: null,
    created_at: "2026-11-11T17:29:00Z",
    started_at: null,
    workflow_name: "CI",
    head_branch: "development",
    head_sha: "abcdef0123456789",
    html_url: "https://github.com/Brainwires/denext/actions/runs/777/job/9001",
  },
};

Deno.test("hooks: a valid signature is accepted and queued", async () => {
  const { handler, delivered, verified } = setup();
  const r = await post(handler, JSON.stringify(JOB), { id: "d1" });
  assertEquals(r.status, 202);
  assertEquals(delivered.length, 1);
  assertEquals(delivered[0].id, "d1");
  assertEquals(delivered[0].event, "workflow_job");
  assertEquals((delivered[0].payload.workflow_job as { id: number }).id, 9001);
  assertEquals(verified, ["workflow_job"]);
});

Deno.test("hooks: bad or missing signature → 401, nothing parsed", async () => {
  const { handler, delivered, rejects, verified } = setup();
  // Not JSON: a 400 would mean it was parsed; a 401 means the signature came first.
  for (
    const sig of [
      null,
      "sha256=" + "0".repeat(64),
      "sha1=abc",
      await signBody("other", new TextEncoder().encode("{not json")),
    ]
  ) {
    const r = await post(handler, "{not json", { sig });
    assertEquals(r.status, 401);
    assertEquals(await r.text(), "rejected signature");
  }
  assertEquals(delivered.length, 0);
  assertEquals(verified.length, 0);
  assertEquals(rejects, ["signature", "signature", "signature", "signature"]);
});

Deno.test("hooks: oversize → 413, by Content-Length unread, or when the stream passes the cap", async () => {
  const { handler, rejects } = setup();
  const big = new Uint8Array(MAX_BODY + 1).fill(0x20);
  assertEquals((await post(handler, big)).status, 413);
  // Chunked, no Content-Length: cut off at the cap.
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent > MAX_BODY) return c.close();
      sent += 64 * 1024;
      c.enqueue(new Uint8Array(64 * 1024));
    },
  });
  const r = await handler(
    new Request(URL_, {
      method: "POST",
      headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=x" },
      body: stream,
      // @ts-ignore: Deno needs duplex for a streamed request body
      duplex: "half",
    }),
  );
  assertEquals(r.status, 413);
  assertEquals(rejects, ["size", "size"]);
});

Deno.test("hooks: wrong path or method → 404; not JSON content-type → 415", async () => {
  const { handler, delivered } = setup();
  assertEquals((await post(handler, "{}", { url: "http://127.0.0.1:8789/" })).status, 404);
  assertEquals(
    (await post(handler, "{}", { url: "http://127.0.0.1:8789/github/hooks/x" })).status,
    404,
  );
  assertEquals((await post(handler, "{}", { method: "GET" })).status, 404);
  assertEquals((await post(handler, "{}", { method: "PUT" })).status, 404);
  assertEquals((await post(handler, "{}", { type: "text/plain" })).status, 415);
  assertEquals(
    (await post(handler, "{}", { type: "application/json; charset=utf-8" })).status,
    202,
  );
  assertEquals(delivered.length, 1);
});

Deno.test("hooks: a duplicate delivery is acknowledged and ignored; ping → 200; others ignored", async () => {
  const { handler, delivered, verified } = setup();
  assertEquals((await post(handler, JSON.stringify(JOB), { id: "same" })).status, 202);
  const again = await post(handler, JSON.stringify(JOB), { id: "same" });
  assertEquals([again.status, await again.text()], [202, "duplicate"]);
  assertEquals(delivered.length, 1);
  const ping = await post(handler, JSON.stringify({ zen: "x", hook_id: 1 }), { event: "ping" });
  assertEquals(ping.status, 200);
  const other = await post(handler, JSON.stringify({}), { event: "push" });
  assertEquals([other.status, await other.text()], [202, "ignored"]);
  assertEquals(delivered.length, 1);
  assertEquals(verified, ["workflow_job", "workflow_job", "ping", "push"]);
  // Verified but not JSON: 400, nothing queued.
  assertEquals((await post(handler, "[1,", { id: "bad" })).status, 400);
});

Deno.test("hooks: constant-time compare and the state badge", () => {
  assert(safeEqual("abc", "abc"));
  assertFalse(safeEqual("abc", "abd"));
  assertFalse(safeEqual("abc", "abcd"));
  assertEquals(hooksState(false, NOW, NOW), "off");
  assertEquals(hooksState(true, null, NOW), "stale");
  assertEquals(hooksState(true, NOW - 60_000, NOW), "live");
  assertEquals(hooksState(true, NOW - HOOKS_STALE_MS - 1, NOW), "stale");
});

Deno.test("hooks: reconciliation — 5 min while live; normal when quiet with runs active", () => {
  const base = { rate: null, visible: true, publicOnly: false, spentLastHour: 0, now: NOW };
  assertEquals(pollPlan({ ...base, hooks: "live", activeRuns: 3 }).intervalMs, RECONCILE_MS);
  assertEquals(pollPlan({ ...base, hooks: "stale", activeRuns: 3 }).intervalMs, VISIBLE_MS);
  assertEquals(pollPlan({ ...base, hooks: "stale", activeRuns: 0 }).intervalMs, RECONCILE_MS);
  assertEquals(pollPlan({ ...base, hooks: "off", activeRuns: 0 }).intervalMs, VISIBLE_MS);
});

Deno.test("hooks: deliveries feed the state and the event log; the timer follows", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const pending: number[] = [];
  let t = NOW;
  const svc = createFleetService({
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
    setTimeout: (_f, ms) => pending.push(ms),
    clearTimeout: () => {},
  });
  await svc.start(); // seeds the log
  svc.setHooksEnabled(true);
  svc.visibility(true);
  assertEquals(svc.snapshot().hooks.state, "stale");
  const queued = svc.snapshot().summary.queued;
  t += 5000;
  const d = (id: string, job: Record<string, unknown>): HookDelivery => ({
    id,
    event: "workflow_job",
    receivedAt: t,
    payload: { ...JOB, workflow_job: { ...JOB.workflow_job, ...job } },
  });
  await svc.applyHook(d("a", {}));
  assertEquals(svc.snapshot().summary.queued, queued + 1);
  assertEquals(svc.snapshot().hooks.state, "live");
  // Live with runs active: next poll at the 10-minute missed-delivery guard at the latest.
  assert(pending.at(-1)! <= HOOKS_STALE_MS && pending.at(-1)! > VISIBLE_MS);
  t += 1000;
  await svc.applyHook(
    d("b", {
      status: "in_progress",
      runner_name: "denext-linux-x64-1-5",
      started_at: "2026-11-11T17:30:06Z",
    }),
  );
  const texts = svc.events(0).events.map((e) => `${e.job}: ${e.text}`);
  assertEquals(texts, [
    "check: queued for linux-x64",
    "check: started on linux-x64 on denext-linux-x64-1-5",
  ]);
  // A payload that isn't the expected shape changes nothing.
  await svc.applyHook({
    id: "c",
    event: "workflow_job",
    receivedAt: t,
    payload: { repository: { full_name: "x/y" }, workflow_job: { id: "nope" } },
  });
  await svc.applyHook({
    id: "e",
    event: "workflow_run",
    receivedAt: t,
    payload: { repository: { full_name: "Brainwires/denext; rm -rf /" }, workflow_run: {} },
  });
  assertEquals(svc.events(0).events.length, 2);
  svc.stop();
});

Deno.test("spool: complete lines become deliveries; partial lines wait; dedupe; rotation", async () => {
  const { readSpool, spoolLine } = await import("../lib/hooks.ts");
  const line = (id: string) =>
    JSON.stringify({
      received_at: "2026-11-11T17:30:00Z",
      delivery: id,
      event: "workflow_job",
      payload: JOB,
    }) + "\n";
  let file = new TextEncoder().encode(line("a") + line("b").slice(0, 20));
  const cursor = { offset: 0, partial: "", seen: new Set<string>() };
  const read = () => readSpool(cursor, file.length, (from) => file.subarray(from));
  assertEquals(read().map((d) => d.id), ["a"]);
  file = new TextEncoder().encode(line("a") + line("b") + line("a") + "garbage\n");
  assertEquals(read().map((d) => d.id), ["b"], "the rest of b, a again deduped, garbage skipped");
  assertEquals(read(), []);
  // Rotated: the file is shorter than the offset, so it is read from the start.
  file = new TextEncoder().encode(line("c"));
  assertEquals(read().map((d) => d.id), ["c"]);
  assertEquals(spoolLine('{"delivery":"x","event":"push","payload":{}}'), null);
  assertEquals(spoolLine("{"), null);
  assertEquals(spoolLine(line("z"))?.receivedAt, Date.parse("2026-11-11T17:30:00Z"));
});
