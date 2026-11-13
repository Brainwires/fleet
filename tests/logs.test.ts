// Logs: redaction (JIT configs, GitHub tokens, credentials, token-shaped strings), ANSI, the
// launcher log and scheduler line parsing, bounded reads (tail / after / before, never the whole
// file), the file-name guard, the job log download (redirect without the token, allowed hosts, the
// cap) and the fetcher's budget, cache and refusals. Fake tokens are built at runtime. No network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { NOW } from "./helpers.ts";
import { ansiRuns, MAX_LINE, REDACTED, redactLine, redactText, stripAnsi } from "../lib/redact.ts";
import {
  alertLineFor,
  indexJobDone,
  launcherLog,
  lineTime,
  logGroups,
  parseJobDone,
  parseLauncherName,
  parseLauncherStarted,
  parseLauncherText,
  schedulerLineFor,
} from "../lib/runner-logs.ts";
import {
  launcherForJob,
  launcherPath,
  listLauncherLogs,
  poolLogLines,
  readAfter,
  readBefore,
  readTail,
  runnerLogView,
} from "../lib/deno-logs.ts";
import { createGitHubClient, LOG_HOSTS } from "../lib/github.ts";
import { createJobLogs, JOB_LOGS_PER_HOUR } from "../lib/logs.ts";

// Fake secrets, assembled so no token-shaped literal sits in the source.
const GHP = "gh" + "p_" + "Ab3".repeat(12);
const GHS = "gh" + "s_" + "Zq9".repeat(12);
const PAT = "github" + "_pat_" + "11AAAA".repeat(6) + "_" + "xY7".repeat(10);
const JIT = "eyJk" + "ZXZlbG9wZXIiOiJ0ZXN0IiwicnVubmVyIjoiYWNtZSJ9".repeat(4) + "Q==";
const JWT = "eyJ" + "hbGciOiJIUzI1NiJ9" + ".eyJ" + "zdWIiOiIxMjM0NTY3ODkwIn0" + ".Sfl" +
  "KxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";

Deno.test("redact: --jitconfig values, both forms, and a JIT config in JSON or env", () => {
  for (
    const line of [
      `./run.sh --jitconfig ${JIT}`,
      `./run.sh --jitconfig=${JIT} --once`,
      `run.cmd --jitconfig "${JIT}"`,
      `{"encoded_jit_config":"${JIT}","runner":{"id":3}}`,
      `ACTIONS_RUNNER_INPUT_JITCONFIG=${JIT}`,
      `jitconfig: ${JIT}`,
    ]
  ) {
    const out = redactLine(line);
    assertFalse(out.includes(JIT.slice(4, 30)), `leaked: ${out}`);
    assertStringIncludes(out, REDACTED);
  }
  assertEquals(
    redactLine("./run.sh --jitconfig=abc --once"),
    `./run.sh --jitconfig=${REDACTED} --once`,
  );
});

Deno.test("redact: GitHub tokens, bearer / basic credentials, JWTs, URL credentials, signatures", () => {
  const cases = [
    `token is ${GHP} ok`,
    `GITHUB_TOKEN=${GHS}`,
    `using ${PAT}`,
    `Authorization: Bearer ${GHS}`,
    `Authorization: basic dXNlcjpwYXNzd29yZDEyMw==`,
    `header: token ${"a1B2c3D4".repeat(5)}`,
    `jwt ${JWT}`,
    `git clone https://x-access-token:${GHS}@github.com/acme/web.git`,
    `GET https://example.blob.core.windows.net/x/job-logs.txt?sv=2021&sig=AbC%2Bdef123&se=2026`,
    `"password": "hunter2-long-enough"`,
    `client_secret=s3cr3t-value-here`,
  ];
  for (const c of cases) {
    const out = redactLine(c);
    assertStringIncludes(out, REDACTED, c);
    for (
      const secret of [GHP, GHS, PAT, JWT, "dXNlcjpwYXNzd29yZDEyMw", "hunter2", "s3cr3t", "AbC%2B"]
    ) {
      assertFalse(out.includes(secret), `${c} → ${out}`);
    }
  }
  // URL credentials keep the host; a SAS URL keeps its path.
  assertStringIncludes(redactLine(`https://u:${GHS}@github.com/a`), "@github.com/a");
});

Deno.test("redact: a token-shaped string goes; SHAs, paths, names and numbers stay", () => {
  const blob = "Qm9" + "vdC1zdHJhcC10b2tlbi1mb3ItdGhlLXJ1bm5lcg" + "9x";
  assertEquals(redactLine(`value ${blob} end`), `value ${REDACTED} end`);
  const keep = [
    "commit 9fceb02d0ae598e95dc970b74767f19372d61af8 merged",
    "sha256:2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae",
    "log /Users/me/Library/Logs/acme-runners/jobs/linux-x64-2204-1-1794551784.log",
    "SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk",
    "runner acme-mac-arm-1-1794552008 ran job 131734238900",
    "2026-11-13T06:40:15.1234567Z Running job: cross-package (macos-to-windows)",
    "tokens: 12 jobs, passwords: none",
  ];
  for (const k of keep) assertEquals(redactLine(k), k);
  // A huge line is cut, and what is shown is still redacted.
  const long = redactLine(`${"x ".repeat(MAX_LINE)} ${GHP}`);
  assert(long.length < MAX_LINE + 40);
  assertFalse(redactText(`a\n${GHP}\nb`).includes(GHP));
});

Deno.test("ansi: colours become runs, escapes are stripped", () => {
  const runs = ansiRuns("\x1b[31mfail\x1b[0m ok \x1b[1;92mpass\x1b[0m");
  assertEquals(runs, [
    { text: "fail", color: "red", bold: false },
    { text: " ok ", color: "", bold: false },
    { text: "pass", color: "bright-green", bold: true },
  ]);
  assertEquals(stripAnsi("\x1b[2K\x1b[1Gdone\x07"), "done");
});

// ---- launcher logs and scheduler lines ----

const LAUNCHER = [
  "ACME_DISK_BEFORE_GB=92",
  "2026-11-13 00:39:29 mac-arm: job start: slot 1, clone ci-1 of base",
  "2026-11-13 06:40:15Z: Running job: cross-package (macos-to-windows)",
  "2026-11-13 06:41:30Z: Job cross-package (macos-to-windows) completed with result: Succeeded",
  "2026-11-13 00:41:36 mac-arm: job finished rc=0 after 127s",
  "2026-11-13 00:41:39 mac-arm: free disk on the host: 92 GB before, 91 GB after",
  "ACME_DISK_AFTER_GB=91",
  "ACME_RUNNER_RESULT rc=0",
].join("\n");

const SCHED = [
  "2026-11-13 00:39:20 scheduler: pool mac-arm slot 1: launcher started (pid 4) for acme/web run 43 job 131 (queued 2026-11-13T06:34:42Z); log /logs/jobs/mac-arm-1-1794551969.log",
  "2026-11-13 00:41:35 scheduler: job done pool=mac-arm slot=1 repo=acme/web run=43 job=131 result=rc=0 duration=170s disk_before=92G disk_after=91G log=/logs/jobs/mac-arm-1-1794551969.log",
  "2026-11-13 00:41:37 scheduler: pool mac-arm slot 1: acme-mac-arm-1-1794552008 ran job 131 build of acme/web",
  "2026-11-13 00:42:00 scheduler: pool mac-arm-big: 0 vetted -> idle",
  "2026-11-13 00:42:01 services: mac-arm/1: postgres up",
].join("\n");

Deno.test("runner logs: a launcher log's name and what its text says", () => {
  assertEquals(parseLauncherName("linux-x64-2204-3-1794551929.log"), {
    pool: "linux-x64-2204",
    slot: 3,
    epoch: 1794551929,
  });
  assertEquals(parseLauncherName("../etc/passwd"), null);
  assertEquals(parseLauncherText(LAUNCHER), {
    rc: 0,
    durationMs: 127_000,
    diskBeforeGb: 92,
    diskAfterGb: 91,
    jobName: "cross-package (macos-to-windows)",
    jobResult: "Succeeded",
  });
  assertEquals(parseLauncherText("nothing yet").rc, null);
});

Deno.test("runner logs: job done / launcher started / ran job lines index the logs by file", () => {
  const done = parseJobDone(SCHED.split("\n")[1])!;
  assertEquals([
    done.pool,
    done.slot,
    done.repo,
    done.runId,
    done.jobId,
    done.rc,
    done.durationMs,
    done.file,
  ], [
    "mac-arm",
    1,
    "acme/web",
    43,
    131,
    0,
    170_000,
    "mac-arm-1-1794551969.log",
  ]);
  assertEquals(parseLauncherStarted(SCHED.split("\n")[0])?.jobId, 131);
  const idx = indexJobDone(SCHED.split("\n"));
  const e = idx.get("mac-arm-1-1794551969.log")!;
  assertEquals([e.rc, e.runner], [0, "acme-mac-arm-1-1794552008"]);
  const entry = launcherLog("mac-arm-1-1794551969.log", { modifiedAt: 1, size: 2 }, LAUNCHER, e)!;
  assertEquals([entry.jobId, entry.repo, entry.slot, entry.startedAt], [
    131,
    "acme/web",
    1,
    1794551969000,
  ]);
});

Deno.test("runner logs: a pool's scheduler and alert lines, by whole pool name", () => {
  const lines = SCHED.split("\n");
  assertEquals(lines.filter((l) => schedulerLineFor(l, "mac-arm")).length, 4);
  assertEquals(lines.filter((l) => schedulerLineFor(l, "mac-arm-big")).length, 1);
  assert(alertLineFor("2026-11-12T20:29:04-0600 mac-arm RECOVERED: ok", "mac-arm"));
  assertFalse(alertLineFor("2026-11-12T20:29:04-0600 mac-arm-big 1 job(s) queued", "mac-arm"));
  assertEquals(lineTime("2026-11-13T06:40:15Z: x"), Date.parse("2026-11-13T06:40:15Z"));
  assertEquals(lineTime("2026-11-12T20:29:04-0600 x"), Date.parse("2026-11-12T20:29:04-06:00"));
});

Deno.test("job logs: ##[group] sections", () => {
  const lines = [
    "2026-11-13T06:40:15.1Z ##[group]Run actions/checkout@v4",
    "2026-11-13T06:40:15.2Z with: x",
    "2026-11-13T06:40:15.3Z ##[endgroup]",
    "2026-11-13T06:40:16.0Z plain",
    "2026-11-13T06:40:17.0Z ##[group]Unclosed",
    "2026-11-13T06:40:18.0Z inside",
  ];
  assertEquals(logGroups(lines), [
    { title: "Run actions/checkout@v4", start: 0, end: 2 },
    { title: "Unclosed", start: 4, end: 5 },
  ]);
});

// ---- bounded reads on real files ----

async function tempLogs(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "fleet-logs-" });
  await Deno.mkdir(`${dir}/jobs`);
  await Deno.writeTextFile(`${dir}/jobs/mac-arm-1-1794551969.log`, LAUNCHER + "\n");
  await Deno.writeTextFile(`${dir}/jobs/mac-arm-2-1794552371.log`, `start ${GHP}\nrunning\n`);
  await Deno.writeTextFile(`${dir}/jobs/linux-x64-1-1794552000.log`, "linux\n");
  await Deno.writeTextFile(`${dir}/scheduler.log`, SCHED + "\n");
  await Deno.writeTextFile(
    `${dir}/alerts.log`,
    "2026-11-12T20:29:04-0600 mac-arm 1 job(s) queued\n2026-11-12T20:30:04-0600 linux-x64 x\n",
  );
  return dir;
}

Deno.test("reads: tail / after / before stay inside their window, whole redacted lines only", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fleet-tail-" });
  try {
    const path = `${dir}/big.log`;
    // 3 MB of numbered lines with a token in the middle.
    const lines = Array.from({ length: 60_000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    lines[59_990] = `secret ${GHP}`;
    await Deno.writeTextFile(path, lines.join("\n") + "\n");
    const size = (await Deno.stat(path)).size;
    const tail = await readTail(path, 64 * 1024);
    assert(tail.truncated);
    assert(tail.lines.length < 64 * 1024 / 40, "only the window was read");
    assert(tail.lines[0].startsWith("line "), "no partial first line");
    assertEquals(tail.lines.at(-1), lines.at(-1));
    assertEquals(tail.end, size);
    assert(tail.lines.some((l) => l.includes(REDACTED)));
    assertFalse(tail.lines.some((l) => l.includes(GHP)));
    // Paging back from the window's start: the lines just before it.
    const before = await readBefore(path, tail.start, 8 * 1024);
    assertEquals(
      Number(before.lines.at(-1)!.split(" ")[1]) + 1,
      Number(tail.lines[0].split(" ")[1]),
    );
    // A live file: only the new complete lines after the offset.
    await Deno.writeTextFile(path, "new 1\nnew 2\npartial", { append: true });
    const after = await readAfter(path, tail.end);
    assertEquals(after.lines, ["new 1", "new 2"]);
    assertEquals(after.end, tail.end + "new 1\nnew 2\n".length);
    // A truncated file starts over.
    await Deno.writeTextFile(path, "fresh\n");
    assertEquals((await readAfter(path, after.end)).lines, ["fresh"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reads: only a pool's own launcher logs inside jobs/, no paths, no symlinks out", async () => {
  const dir = await tempLogs();
  try {
    assert(await launcherPath(dir, "mac-arm", "mac-arm-1-1794551969.log"));
    assertEquals(await launcherPath(dir, "linux-x64", "mac-arm-1-1794551969.log"), null);
    assertEquals(await launcherPath(dir, "mac-arm", "../scheduler.log"), null);
    assertEquals(await launcherPath(dir, "mac-arm", "jobs/mac-arm-1-1794551969.log"), null);
    const outside = await Deno.makeTempFile();
    await Deno.symlink(outside, `${dir}/jobs/mac-arm-9-1794550000.log`);
    assertEquals(await launcherPath(dir, "mac-arm", "mac-arm-9-1794550000.log"), null);
    await Deno.remove(outside);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("reads: a pool's launcher logs, its scheduler / alert lines, a job's log, the viewer", async () => {
  const dir = await tempLogs();
  try {
    const list = await listLauncherLogs(dir, "mac-arm");
    assertEquals(list.map((l) => l.file), ["mac-arm-2-1794552371.log", "mac-arm-1-1794551969.log"]);
    assertEquals([list[1].rc, list[1].jobId, list[1].runner], [
      0,
      131,
      "acme-mac-arm-1-1794552008",
    ]);
    assertEquals((await poolLogLines(dir, "mac-arm", "scheduler")).lines.length, 4);
    assertEquals((await poolLogLines(dir, "mac-arm", "alerts")).lines.length, 1);
    assertEquals(await launcherForJob(dir, 131), {
      pool: "mac-arm",
      file: "mac-arm-1-1794551969.log",
    });
    assertEquals(await launcherForJob(dir, 999), null);
    const live = await runnerLogView(dir, "mac-arm", "mac-arm-2-1794552371.log");
    assert(live?.live, "changed just now, no result yet");
    assertFalse(live!.lines.join("\n").includes(GHP));
    const done = await runnerLogView(dir, "mac-arm", "mac-arm-1-1794551969.log");
    assertFalse(done!.live, "it has its result line");
    assertEquals(await runnerLogView(dir, "linux-x64", "mac-arm-1-1794551969.log"), null);
    assertEquals(await listLauncherLogs(`${dir}/missing`, "mac-arm"), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---- GitHub job logs ----

function logFetch(
  opts: { location?: string; body?: string; status?: number; remaining?: number } = {},
) {
  const seen: { url: string; auth: string | null; redirect?: string }[] = [];
  const f = (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const h = new Headers(init?.headers);
    seen.push({ url, auth: h.get("authorization"), redirect: init?.redirect });
    if (url.startsWith("https://api.github.com/")) {
      return Promise.resolve(
        new Response(null, {
          status: opts.status ?? 302,
          headers: {
            location: opts.location ??
              `https://${LOG_HOSTS[3]}/actions-results/x/job-logs.txt?sig=abc`,
            "x-ratelimit-remaining": String(opts.remaining ?? 4000),
            "x-ratelimit-limit": "5000",
            "x-ratelimit-reset": String(Math.floor(NOW / 1000) + 3600),
          },
        }),
      );
    }
    return Promise.resolve(new Response(opts.body ?? "a\nb\n"));
  };
  return { fetch: f as typeof fetch, seen };
}

Deno.test("job log download: the redirect is followed without the token, to allowed hosts only", async () => {
  const ok = logFetch({
    body: `2026-11-13T00:00:00Z ##[group]Run x\nkey ${GHP}\n2026-11-13T00:00:01Z ##[endgroup]\n`,
  });
  const c = createGitHubClient({ token: "t".repeat(40), fetch: ok.fetch, now: () => NOW });
  const r = await c.downloadLog("/repos/acme/web/actions/jobs/5/logs");
  assertStringIncludes(r.text, "##[group]Run x");
  assertEquals(ok.seen[0].redirect, "manual");
  assert(ok.seen[0].auth?.startsWith("Bearer "), "the API call is authenticated");
  assertEquals(ok.seen[1].auth, null, "the signed URL gets no token");
  assertEquals(c.rate()?.remaining, 4000);
  // Elsewhere: refused before any fetch there.
  const evil = logFetch({ location: "https://attacker.example/x" });
  const c2 = createGitHubClient({ token: "t".repeat(40), fetch: evil.fetch, now: () => NOW });
  let err = "";
  await c2.downloadLog("/repos/acme/web/actions/jobs/5/logs").catch((e) => (err = e.message));
  assertStringIncludes(err, "host");
  assertEquals(evil.seen.length, 1);
  // Not a job log path: refused outright.
  await c2.downloadLog("/repos/acme/web/actions/runs/5/logs").catch((e) => (err = e.message));
  assertStringIncludes(err, "refusing");
  // A long log keeps its end.
  const big = logFetch({ body: Array.from({ length: 5000 }, (_, i) => `row ${i}`).join("\n") });
  const c3 = createGitHubClient({ token: "t".repeat(40), fetch: big.fetch, now: () => NOW });
  const t = await c3.downloadLog("/repos/acme/web/actions/jobs/5/logs", { maxBytes: 2048 });
  assert(t.truncated);
  assert(t.text.length <= 2048);
  assert(t.text.endsWith("row 4999"));
  assert(t.text.startsWith("row "), "the partial first line is dropped");
});

Deno.test("job logs: redacted, grouped, cached; refused when unwatched, public or low on budget", async () => {
  const f = logFetch({
    body: `2026-11-13T00:00:00Z ##[group]Step\nuse ${GHS}\n2026-11-13T00:00:01Z ##[endgroup]\n`,
  });
  const client = createGitHubClient({ token: "t".repeat(40), fetch: f.fetch, now: () => NOW });
  const logs = createJobLogs({ github: () => ({ client, canWrite: true }), now: () => NOW });
  // The fixture settings watch the org in tests/fixture-settings.ts.
  const repo = "Brainwires/denext";
  const v = await logs.get(repo, 77, "CI · build", true);
  assert(!("error" in v));
  assertEquals(v.kind, "github");
  assertFalse(v.lines.join("\n").includes(GHS));
  assertEquals(v.groups?.[0].title, "Step");
  await logs.get(repo, 77, "CI · build", true);
  assertEquals(f.seen.length, 2, "the second view came from the cache");
  const no = await logs.get("someone/else", 78, "x", true);
  assert("error" in no);
  const pub = createJobLogs({ github: () => ({ client, canWrite: false }) });
  assert("error" in (await pub.get(repo, 79, "x", true)));
  // Low budget: refused without a request.
  const low = logFetch({ remaining: 900 });
  const lc = createGitHubClient({ token: "t".repeat(40), fetch: low.fetch, now: () => NOW });
  await lc.downloadLog("/repos/acme/web/actions/jobs/1/logs");
  const lowLogs = createJobLogs({ github: () => ({ client: lc, canWrite: true }) });
  const r = await lowLogs.get(repo, 80, "x", true);
  assert("error" in r && r.error.includes("budget"));
  assertEquals(low.seen.length, 2);
  // At most JOB_LOGS_PER_HOUR downloads an hour.
  const many = createJobLogs({ github: () => ({ client, canWrite: true }), now: () => NOW });
  for (let i = 0; i < JOB_LOGS_PER_HOUR; i++) await many.get(repo, 1000 + i, "x", false);
  const capped = await many.get(repo, 5000, "x", false);
  assert("error" in capped && capped.error.includes("last hour"));
});
