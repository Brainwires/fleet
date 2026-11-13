// fleet-stream (mcp/fleet-stream.ts): arguments, one line per event from a real 127.0.0.1 stream,
// reconnecting with since_seq after a drop (nothing missed, nothing twice), the exit codes (2: no
// token file or a bad filter, 3: the token refused, 0 otherwise), waiting out a Fleet that isn't
// running, and the script itself under exactly --allow-read=<data dir> --allow-net=127.0.0.1.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import type { FleetEvent } from "../lib/events.ts";
import { createStream } from "../lib/stream.ts";
import { listenStream, writeStreamState } from "../lib/deno-stream.ts";
import { STREAM_TOKEN_FILE } from "../lib/agent-files.ts";
import { type CliIo, parseCliArgs, runStreamCli, streamUrl } from "../mcp/fleet-stream.ts";
import type { WireStatus } from "../lib/stream-format.ts";
import { NOW } from "./helpers.ts";

const TOKEN = "k".repeat(43);

const ev = (seq: number, over: Partial<FleetEvent> = {}): FleetEvent => ({
  seq,
  at: NOW + seq * 1000,
  sev: "info",
  kind: "started",
  repo: "Brainwires/denext",
  workflow: "CI",
  job: `job-${seq}`,
  text: "started on linux-x64",
  url: null,
  ...over,
});

const STATUS: WireStatus = {
  type: "status",
  at: new Date(NOW).toISOString(),
  running: 0,
  queued: 0,
  severity: "ok",
  reasons: [],
  pools: [],
  hooks: "off",
  auth: "gh",
  poll_ok: true,
  last_seq: 0,
};

async function dataDir(token = TOKEN): Promise<string> {
  const dir = await Deno.makeTempDir();
  await Deno.writeTextFile(`${dir}/${STREAM_TOKEN_FILE}`, token + "\n", { mode: 0o600 });
  return dir;
}

function io(signal?: AbortSignal) {
  const out: string[] = [];
  const err: string[] = [];
  const waiters: (() => void)[] = [];
  const io: CliIo = {
    out: (l) => {
      out.push(l);
      waiters.splice(0).forEach((w) => w());
    },
    err: (l) => err.push(l),
    sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
    fetch,
    signal,
  };
  const until = async (pred: () => boolean, what: string) => {
    const deadline = Date.now() + 4000;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out: ${what}; out=${out.join(" | ")}`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 25);
      });
    }
  };
  return { io, out, err, until };
}

Deno.test("args: filters, cursor, flags; usage errors", () => {
  const o = parseCliArgs(
    ["--data-dir", "/d", "--kinds=problems", "--repo", "denext", "--since-seq", "5", "--no-status"],
    null,
  );
  assert(typeof o !== "string");
  assertEquals([o.dataDir, o.kinds, o.repo, o.sinceSeq, o.status, o.json], [
    "/d",
    "problems",
    "denext",
    5,
    false,
    false,
  ]);
  assertEquals(
    streamUrl(o, 8790, 9),
    "http://127.0.0.1:8790/events?kinds=problems&repo=denext&since_seq=9",
  );
  const h = parseCliArgs(["--json"], "/Users/x");
  assert(
    typeof h !== "string" &&
      h.dataDir === "/Users/x/Library/Application Support/dev.brainwires.fleet",
  );
  assertStringIncludes(parseCliArgs(["--bogus"], "/h") as string, "unknown argument");
  assertStringIncludes(parseCliArgs(["--since-seq", "x"], "/h") as string, "whole number");
  assertStringIncludes(parseCliArgs([], null) as string, "usage:");
});

Deno.test("cli: one line per event; after a drop it reconnects with since_seq and misses nothing", async () => {
  const journal: FleetEvent[] = [];
  const asked: number[] = [];
  const s = createStream({
    token: TOKEN,
    replay: (since) => {
      asked.push(since);
      return Promise.resolve(journal.filter((e) => e.seq > since));
    },
    lastSeq: () => journal.at(-1)?.seq ?? 0,
    status: () => STATUS,
    heartbeatMs: 60_000,
    maxClients: 4,
  });
  const l = listenStream(s, 0)!;
  const dir = await dataDir();
  await writeStreamState(dir, { port: l.port, pid: 1, started_at: "x" });
  const ac = new AbortController();
  const t = io(ac.signal);
  const publish = (...events: FleetEvent[]) => {
    journal.push(...events);
    s.publish(events);
  };
  try {
    const o = parseCliArgs(["--data-dir", dir, "--no-status"], null);
    assert(typeof o !== "string");
    const run = runStreamCli(o, t.io);
    await t.until(() => s.clientCount === 1, "connected");
    publish(ev(1), ev(2));
    await t.until(() => t.out.length === 2, "two lines");
    // The connection drops; events logged meanwhile come back through the replay.
    s.disconnectAll();
    publish(ev(3));
    await t.until(() => t.out.length === 3, "the replayed line");
    publish(ev(4));
    await t.until(() => t.out.length === 4, "a live line after the reconnect");
    assertEquals(t.out.map((line) => line.split(" ")[0]), ["#1", "#2", "#3", "#4"]);
    assertStringIncludes(t.out[0], "Brainwires/denext · CI / job-1: started on linux-x64");
    assertEquals(asked, [2], "the reconnect asked for what came after the last line printed");
    assert(t.err.some((e) => e.includes("connected")));
    ac.abort();
    assertEquals(await run, 0);
  } finally {
    await l.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli: --json prints the messages; status lines unless --no-status", async () => {
  const s = createStream({
    token: TOKEN,
    replay: () => Promise.resolve([]),
    lastSeq: () => 0,
    status: () => STATUS,
    heartbeatMs: 60_000,
    maxClients: 4,
  });
  const l = listenStream(s, 0)!;
  const dir = await dataDir();
  const ac = new AbortController();
  const t = io(ac.signal);
  try {
    const o = parseCliArgs(["--data-dir", dir, "--json", "--port", String(l.port)], null);
    assert(typeof o !== "string");
    const run = runStreamCli(o, t.io);
    await t.until(() => t.out.length === 1, "the first status");
    assertEquals(JSON.parse(t.out[0]).type, "status");
    s.publish([ev(1, { sev: "bad", kind: "finished" })]);
    await t.until(() => t.out.length === 2, "the event");
    assertEquals(JSON.parse(t.out[1]).seq, 1);
    ac.abort();
    assertEquals(await run, 0);
  } finally {
    await l.stop();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli: exits 3 when the token is refused, 2 without a token file or for a bad filter", async () => {
  const s = createStream({
    token: TOKEN,
    replay: () => Promise.resolve([]),
    lastSeq: () => 0,
    status: () => STATUS,
    heartbeatMs: 60_000,
    maxClients: 4,
  });
  const l = listenStream(s, 0)!;
  const wrong = await dataDir("w".repeat(43));
  const none = await Deno.makeTempDir();
  const good = await dataDir();
  try {
    const t = io();
    const o = parseCliArgs(["--data-dir", wrong, "--port", String(l.port)], null);
    assert(typeof o !== "string");
    assertEquals(await runStreamCli(o, t.io), 3);
    assert(t.err.some((e) => e.includes("refused the token")));

    const t2 = io();
    const o2 = parseCliArgs(["--data-dir", none, "--port", String(l.port)], null);
    assert(typeof o2 !== "string");
    assertEquals(await runStreamCli(o2, t2.io), 2);
    assert(t2.err.some((e) => e.includes(STREAM_TOKEN_FILE)));

    const t3 = io();
    const o3 = parseCliArgs(["--data-dir", good, "--port", String(l.port), "--kinds", "x"], null);
    assert(typeof o3 !== "string");
    assertEquals(await runStreamCli(o3, t3.io), 2);
    assert(t3.err.some((e) => e.includes("unknown kind")));
  } finally {
    await l.stop();
    for (const d of [wrong, none, good]) await Deno.remove(d, { recursive: true });
  }
});

Deno.test("cli: Fleet not running is waited out (a note, retries, exit 0 when stopped)", async () => {
  // A port with nothing listening: take one, then free it.
  const probe = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (probe.addr as Deno.NetAddr).port;
  probe.close();
  const dir = await dataDir();
  const ac = new AbortController();
  const t = io(ac.signal);
  try {
    const o = parseCliArgs(["--data-dir", dir, "--port", String(port)], null);
    assert(typeof o !== "string");
    const run = runStreamCli(o, t.io);
    const deadline = Date.now() + 3000;
    while (!t.err.some((e) => e.includes("isn't reachable")) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 20));
    }
    assert(t.err.some((e) => e.includes("isn't reachable")), t.err.join("\n"));
    assertEquals(t.err.length, 1, "the same note is said once");
    ac.abort();
    assertEquals(await run, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("cli script: runs with only --allow-read=<data dir> --allow-net=127.0.0.1", async () => {
  const s = createStream({
    token: TOKEN,
    replay: () => Promise.resolve([]),
    lastSeq: () => 0,
    status: () => STATUS,
    heartbeatMs: 60_000,
    maxClients: 4,
  });
  const l = listenStream(s, 0)!;
  const dir = await dataDir();
  await writeStreamState(dir, { port: l.port, pid: 1, started_at: "x" });
  const script = new URL("../mcp/fleet-stream.ts", import.meta.url).pathname;
  const child = new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "--no-config",
      "--no-prompt",
      `--allow-read=${dir}`,
      "--allow-net=127.0.0.1",
      script,
      "--data-dir",
      dir,
      "--kinds",
      "problems",
      "--no-status",
    ],
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    env: { NO_COLOR: "1" },
  }).spawn();
  try {
    const deadline = Date.now() + 20_000;
    while (s.clientCount === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assertEquals(s.clientCount, 1, "the script connected");
    s.publish([ev(1), ev(2, { sev: "bad", kind: "finished", text: "finished: failure" })]);
    const reader = child.stdout.pipeThrough(new TextDecoderStream()).getReader();
    let text = "";
    while (!text.includes("\n") && Date.now() < deadline) {
      const r = await reader.read();
      if (r.done) break;
      text += r.value;
    }
    assertEquals(text.split("\n")[0].split(" ")[0], "#2", "only the problem, one line");
    reader.releaseLock();
  } finally {
    child.kill("SIGTERM");
    const out = await child.output().catch(() => null);
    const err = out ? new TextDecoder().decode(out.stderr) : "";
    assert(!/NotCapable|PermissionDenied|Requires .* access/.test(err), err);
    await l.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
