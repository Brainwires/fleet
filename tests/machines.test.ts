// The machines integration: the service's documents parsed defensively, the live stream's frames
// and state (newest reading, trails), a reconnect with `since`, history and the comparison's shared
// time axis, the agents' machines.json and fleet_machines, the settings and the internal build's
// grants. No network: the stream runs against a fake fetch.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  agentMachines,
  alignSeries,
  MachinesState,
  type MachinesView,
  memText,
  parseMachinesDoc,
  parseSample,
  parseSeries,
  rateText,
  sseFrames,
  TRAIL_MAX,
} from "../lib/machines.ts";
import { readToken, startMachinesStream } from "../lib/deno-machines.ts";
import { DEFAULT_SETTINGS, validateSettings } from "../lib/settings.ts";
import { grantsFromConfig } from "../lib/build-grants.ts";
import { ArgError, machinesResult } from "../mcp/queries.ts";

const NOW = 1_800_000_000_000;
const sample = (t: number, cpu = 40) => ({
  t,
  cpu: { pct: cpu, cores: [cpu, cpu], load: [1, 1, 1] },
  mem: { totalMb: 16000, usedMb: 8000, availMb: 8000, pressure: 20 },
  swap: { usedMb: 100, totalMb: 2000 },
  disk: [{ name: "root", mount: "/", totalGb: 500, freeGb: 100 }],
  net: { rxBps: 1000, txBps: 2000 },
  temps: [{ name: "cpu", c: 60 }],
  gpu: null,
  sandboxes: [{ kind: "docker", name: "job-1", cpuPct: 250, rssMb: 900 }],
  pools: { "linux-a": { cpuPct: 250, rssMb: 900 } },
});
const doc = (t: number) => ({
  at: t,
  machines: [
    {
      id: "box",
      name: "The box",
      info: { os: "Linux", arch: "x86_64", cpuModel: "EPYC", host: "box", bootAt: t - 3600_000 },
      source: "bridge",
      lastAt: t,
      online: true,
      latest: sample(t),
      pools: [{
        name: "linux-a",
        label: "acme-linux",
        slots: 3,
        busy: 1,
        state: "healthy",
        reason: "",
        use: { cpuPct: 250, rssMb: 900 },
        jobs: [{
          pool: "linux-a",
          slot: 2,
          phase: "running",
          since: t - 60_000,
          job: { repo: "acme/web", runId: 5, jobId: 11, name: "integration" },
          runner: "r-linux-a-2-1",
          cpuPct: 250,
          rssMb: 900,
          sandbox: "job-1",
        }],
      }],
    },
    { id: "bad id!", name: "x" },
    "junk",
  ],
});

Deno.test("machines: the service's documents are bounded before they are kept", () => {
  const d = parseMachinesDoc(doc(NOW))!;
  assertEquals(d.machines.length, 1, "a machine without a usable id is dropped");
  const m = d.machines[0];
  assertEquals(
    [m.name, m.online, m.pools[0].jobs[0].job?.name, m.latest?.pools["linux-a"].cpuPct],
    [
      "The box",
      true,
      "integration",
      250,
    ],
  );
  assertEquals(parseMachinesDoc({ machines: "no" }), null);
  const s = parseSample({
    ...sample(1),
    cpu: { pct: 1e9, cores: Array(1000).fill(50), load: "x" },
    sandboxes: [{ kind: "vm", name: "a\u0000b\nc", cpuPct: -5, rssMb: 1 }],
  })!;
  assertEquals([
    s.cpu.pct,
    s.cpu.cores.length,
    s.cpu.load,
    s.sandboxes[0].name,
    s.sandboxes[0].cpuPct,
  ], [
    100,
    256,
    null,
    "a b c",
    0,
  ]);
  assertEquals(parseSample({ t: 1 }), null);
  assertEquals(
    [rateText(900), rateText(45_000), rateText(1_250_000), memText(512), memText(14643)],
    [
      "900 B/s",
      "45 kB/s",
      "1.3 MB/s",
      "512 MB",
      "14.3 GB",
    ],
  );
});

Deno.test("machines: stream frames, the newest reading per machine, a bounded trail", () => {
  const { frames, rest } = sseFrames(
    `event: machines\ndata: ${
      JSON.stringify(doc(NOW))
    }\n\n: keep-alive\n\nevent: samples\r\ndata: {"host":"box",\r\n` +
      `data: "samples":[${
        JSON.stringify(sample(NOW + 5000, 70))
      }]}\r\n\r\nevent: samples\ndata: {"ho`,
  );
  assertEquals(frames.map((f) => f.event), ["machines", "samples"]);
  assertEquals(rest, 'event: samples\ndata: {"ho');
  const st = new MachinesState();
  assert(st.apply(frames[0], NOW));
  assert(st.apply(frames[1], NOW + 5000));
  assertFalse(st.apply(frames[1], NOW + 5000), "a batch seen before changes nothing");
  assertFalse(st.apply({ event: "samples", data: "{not json" }, NOW));
  assertFalse(st.apply({ event: "samples", data: '{"host":"../x","samples":[]}' }, NOW));
  const v = st.view(true);
  assertEquals([v.machines[0].latest?.cpu.pct, v.machines[0].lastAt, st.newest()], [
    70,
    NOW + 5000,
    NOW + 5000,
  ]);
  assertEquals(v.trails.box.cpu, [40, 70]);
  assertEquals(v.trails.box.mem, [50, 50], "memory as percent of the total");
  // An older sample never replaces a newer one; the trail stays bounded.
  st.apply({
    event: "samples",
    data: JSON.stringify({ host: "box", samples: [sample(NOW - 1000, 5)] }),
  }, NOW);
  assertEquals(st.view(true).machines[0].latest?.cpu.pct, 70);
  // …but it takes its place in the trail (a reconnect's replay fills the sparkline's past),
  assertEquals(st.view(true).trails.box.cpu, [5, 40, 70]);
  // unless it is older than the trail's span.
  st.apply({
    event: "samples",
    data: JSON.stringify({ host: "box", samples: [sample(NOW - 3600_000, 9)] }),
  }, NOW);
  assertEquals(st.view(true).trails.box.cpu, [5, 40, 70]);
  for (let i = 2; i < TRAIL_MAX + 50; i++) {
    st.apply({
      event: "samples",
      data: JSON.stringify({ host: "box", samples: [sample(NOW + i * 5000, i % 100)] }),
    }, NOW);
  }
  const t = st.view(true).trails.box;
  assert(t.t.length <= TRAIL_MAX && t.t.length === t.cpu.length && t.t.length === t.rx.length);
  assert(t.t[t.t.length - 1] - t.t[0] <= 15 * 60_000, "the trail spans at most 15 minutes");
});

const series = (host: string, t0: number, n: number, step: number, cpu: number) => ({
  host,
  range: "1h",
  tier: "raw",
  stepMs: step,
  from: t0,
  to: t0 + n * step,
  t: Array.from({ length: n }, (_, i) => t0 + i * step),
  cpu: Array(n).fill(cpu),
  cpuMax: Array(n).fill(cpu + 5),
  load1: Array(n).fill(1),
  memUsedMb: Array(n).fill(8000),
  memTotalMb: 16000,
  pressure: Array(n).fill(null),
  swapUsedMb: Array(n).fill(1024),
  rxBps: Array(n).fill(1e6),
  txBps: Array(n).fill(1e6),
  tempMaxC: Array(n).fill(null),
  gpu: Array(n).fill(null),
  disk: { root: Array(n).fill(100) },
  pools: { "linux-a": { cpuPct: Array(n).fill(250), rssMb: Array(n).fill(900) } },
});

Deno.test("machines: a history as columns; machines compared on one time axis", () => {
  const a = parseSeries(series("a", NOW, 10, 60_000, 20))!;
  assertEquals([
    a.t.length,
    a.cpu[0],
    a.memTotalMb,
    a.disk.root.length,
    a.pools["linux-a"].cpuPct[0],
  ], [
    10,
    20,
    16000,
    10,
    250,
  ]);
  assertEquals(parseSeries({ host: "a" }), null);
  // A short column is padded, never read past its end.
  const ragged = parseSeries({ ...series("a", NOW, 5, 1000, 1), cpu: [1, 2] })!;
  assertEquals(ragged.cpu, [1, 2, 0, 0, 0]);
  // Two machines whose points don't line up: shared steps, gaps where one has no point.
  const b = parseSeries(series("b", NOW + 5 * 60_000, 10, 60_000, 80))!;
  const al = alignSeries([a, b], "cpu");
  assertEquals(al.stepMs, 60_000);
  assertEquals(al.times.length, 15);
  assertEquals([al.values.a[0], al.values.a[12], al.values.b[0], al.values.b[12]], [
    20,
    null,
    null,
    80,
  ]);
  assertEquals(alignSeries([a], "mem").values.a[0], 50);
  assertEquals(alignSeries([a], "swap").values.a[0], 1);
  assertEquals(alignSeries([a], "net").values.a[0], 2);
  assertEquals(alignSeries([], "cpu").times, []);
});

function streamBody(chunks: string[], hold: AbortSignal): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      hold.addEventListener("abort", () => {
        try {
          c.error(new DOMException("aborted", "AbortError"));
        } catch { /* closed */ }
      });
    },
  });
}

Deno.test("machines: the stream connects with the token from its file, reconnects with since, and says why it can't", async () => {
  const integration = { url: "http://127.0.0.1:3900", tokenFile: "~/svc/read.token" };
  const TOKEN = "t".repeat(40);
  const files: Record<string, string> = { "/home/jo/svc/read.token": `${TOKEN}\n` };
  const seen: { url: string; auth: string | null }[] = [];
  const views: MachinesView[] = [];
  let calls = 0;
  const fake: typeof fetch = (input, init) => {
    const url = String(input);
    seen.push({ url, auth: new Headers(init?.headers).get("authorization") });
    if (url.includes("/history")) {
      return Promise.resolve(Response.json(series("box", NOW, 3, 5000, 33)));
    }
    calls++;
    if (calls === 1) return Promise.resolve(new Response("no", { status: 401 }));
    const frame = (e: string, d: unknown) => `event: ${e}\ndata: ${JSON.stringify(d)}\n\n`;
    if (calls === 2) {
      // One document, one batch, then the service closes the stream.
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              const enc = new TextEncoder();
              c.enqueue(enc.encode(frame("machines", doc(NOW))));
              c.enqueue(
                enc.encode(frame("samples", { host: "box", samples: [sample(NOW + 5000, 77)] })),
              );
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      );
    }
    return Promise.resolve(
      new Response(streamBody([frame("machines", doc(NOW + 10_000))], init!.signal!)),
    );
  };
  const done = Promise.withResolvers<void>();
  const stream = startMachinesStream({
    integration: () => integration,
    home: () => "/home/jo",
    readFile: (p) => Promise.resolve(files[p] ?? null),
    fetch: fake,
    now: () => NOW + calls * 2000,
    sleep: () => new Promise((r) => setTimeout(r, 5)),
    onChange: (v) => {
      views.push(v);
      if (calls >= 3 && v.connected) done.resolve();
    },
  });
  await done.promise;
  assertEquals(seen[0], {
    // The first connection asks for the sparklines' span, so they start drawn.
    url: `http://127.0.0.1:3900/api/telemetry/stream?since=${NOW - 15 * 60_000}`,
    auth: `Bearer ${TOKEN}`,
  });
  assert(
    views.some((v) => !v.connected && v.error === "The machines service refused Fleet's token."),
  );
  assertEquals(
    seen[2].url,
    `http://127.0.0.1:3900/api/telemetry/stream?since=${NOW + 5000}`,
    "a reconnect asks for what it missed",
  );
  const v = stream.view();
  assertEquals([v.configured, v.connected, v.error, v.machines[0].latest?.t], [
    true,
    true,
    "",
    NOW + 10_000,
  ]);
  // History: the same token; bad arguments never reach the service.
  const h = await stream.history("box", "24h");
  assert(!("error" in h) && h.cpu[0] === 33);
  assertEquals(seen.at(-1)!.url, "http://127.0.0.1:3900/api/telemetry/history?host=box&range=24h");
  assert("error" in await stream.history("../etc", "24h"));
  assert("error" in await stream.history("box", "9y"));
  stream.stop();
  // The token is never in a message; a file that holds no token says so.
  const bad = await readToken({
    home: () => "/home/jo",
    readFile: () => Promise.resolve("hunter2"),
  }, integration);
  assert("error" in bad && !bad.error.includes("hunter2"));
  assert(
    "error" in await readToken({
      home: () => "/home/jo",
      readFile: () => Promise.resolve(null),
    }, integration),
  );
});

Deno.test("machines: machines.json for agents, and fleet_machines' answer and freshness", () => {
  const st = new MachinesState();
  st.apply({ event: "machines", data: JSON.stringify(doc(NOW)) }, NOW);
  st.connected = true;
  const file = agentMachines(st.view(true), NOW + 2000);
  const m = (file.machines as Record<string, unknown>[])[0];
  const stats = m.stats as Record<string, unknown>;
  assertEquals([
    m.id,
    m.online,
    stats.cpu_pct,
    stats.mem_used_mb,
    (stats.disk as { free_gb: number }[])[0].free_gb,
  ], ["box", true, 40, 8000, 100]);
  const job = ((m.pools as Record<string, unknown>[])[0].jobs as Record<string, unknown>[])[0];
  assertEquals([job.slot, job.job, job.repo, job.cpu_pct, job.rss_mb], [
    2,
    "integration",
    "acme/web",
    250,
    900,
  ]);
  assertFalse(JSON.stringify(file).includes("token"), "no credential is ever in the agents' file");
  const r = machinesResult(file, NOW + 5000, {});
  assertEquals([r.stale, r.warning, r.connected, r.machines.length], [false, null, true, 1]);
  assertEquals(
    machinesResult(file, NOW + 5000, { machine: "The box", detail: false }).machines.length,
    1,
  );
  const slim = machinesResult(file, NOW + 5000, { detail: false }).machines[0].stats as Record<
    string,
    unknown
  >;
  assertEquals(["per_core_pct" in slim, "sandboxes" in slim, slim.cpu_pct], [false, false, 40]);
  let threw = false;
  try {
    machinesResult(file, NOW, { machine: "nope" });
  } catch (e) {
    threw = e instanceof ArgError;
  }
  assert(threw);
  assertEquals(machinesResult(file, NOW + 5 * 60_000, {}).stale, true, "an old file is stale");
  const off = machinesResult(
    { ...file, connected: false, error: "The machines service can't be reached (is it running?)." },
    NOW + 5000,
    {},
  );
  assert(off.stale && off.warning!.includes("not connected"));
  assertEquals(machinesResult(null, NOW, {}).configured, false);
});

Deno.test("machines: the settings' integration and routing helper; the internal build's grants", () => {
  const base = { ...DEFAULT_SETTINGS, setupComplete: true };
  const withMachines = (machines: unknown, controls: Record<string, unknown> = {}) =>
    validateSettings({
      ...base,
      integrations: {
        runnerScheduler: {
          pools: [],
          runnerNamePrefix: "r-",
          labelPrefix: "acme-",
          localHealthFile: "",
          pausedDir: "",
          logsDir: "",
          controls: { pausePool: "~/ops/pause.sh", ...controls },
        },
        machines,
      },
    });
  const ok = withMachines({ url: "http://127.0.0.1:3900/", tokenFile: "~/svc/read.token" }, {
    routingHelper: "~/ops/routing.sh",
  });
  assert(ok.ok);
  assertEquals(ok.settings.integrations.machines, {
    url: "http://127.0.0.1:3900",
    tokenFile: "~/svc/read.token",
  });
  assertEquals(
    ok.settings.integrations.runnerScheduler?.controls?.routingHelper,
    "~/ops/routing.sh",
  );
  for (const url of ["ftp://x", "http://u:p@127.0.0.1:3900", "http://127.0.0.1:3900/api", "nope"]) {
    assertFalse(withMachines({ url, tokenFile: "~/t" }).ok, url);
  }
  assertFalse(withMachines({ url: "http://127.0.0.1:3900", tokenFile: "relative/path" }).ok);
  // Off by default, and absent from documents that never named it.
  assertEquals(
    validateSettings(base).ok &&
      "machines" in (validateSettings(base) as { settings: typeof base }).settings.integrations,
    false,
  );
  const grants = grantsFromConfig(ok.settings, "/home/jo");
  assertEquals(grants.net, ["127.0.0.1:3900"]);
  assert(
    grants.run.includes("/home/jo/ops/routing.sh") && grants.run.includes("/home/jo/ops/pause.sh"),
  );
  assertEquals(grantsFromConfig(base, "/home/jo"), { run: [], write: [], net: [] });
  const tls = withMachines({ url: "https://machines.example", tokenFile: "/etc/t" });
  assert(tls.ok && grantsFromConfig(tls.settings, null).net[0] === "machines.example:443");
});
