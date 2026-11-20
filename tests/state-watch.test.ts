// The scheduler-file watch (lib/state-watch.ts): bursts coalesce into one refresh (and a burst
// that never goes quiet still refreshes by its ceiling), events are matched by base name so a
// rename-replace write (a temp file renamed over the old one: a new inode) is still heard, a
// folder that can't be watched is retried, and a real folder watch survives several rename-replace
// writes. No GUI, no network: fake timers and watches, plus one real temp folder.

import { assert, assertEquals, assertFalse } from "@std/assert";
import {
  baseName,
  createDebouncer,
  type FolderWatch,
  HEALTH_PUBLISHED_FILE,
  matchedNames,
  POOL_STATE_FILE,
  schedulerTargets,
  type Timers,
  type WatchEvent,
  watchState,
} from "../lib/state-watch.ts";

/** Timers on a hand-moved clock. */
function fakeTimers(start = 0) {
  let t = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const api: Timers & { advance(ms: number): void; readonly size: number } = {
    now: () => t,
    setTimeout: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { at: t + ms, fn });
      return id;
    },
    clearTimeout: (id) => void timers.delete(id),
    advance(ms: number) {
      const target = t + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void }] | undefined;
        for (const e of timers) if (e[1].at <= target && (!due || e[1].at < due[1].at)) due = e;
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = target;
    },
    get size() {
      return timers.size;
    },
  };
  return api;
}

/** A folder watch the test feeds by hand; `end()` ends it as a removed folder would. */
function fakeWatch(): FolderWatch & { push(ev: WatchEvent): void; end(): void; closed: boolean } {
  const queue: WatchEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const w = {
    closed: false,
    push(ev: WatchEvent) {
      queue.push(ev);
      wake?.();
    },
    end() {
      done = true;
      wake?.();
    },
    close() {
      w.closed = true;
      done = true;
      wake?.();
    },
    async *[Symbol.asyncIterator](): AsyncIterator<WatchEvent> {
      while (true) {
        while (queue.length) yield queue.shift()!;
        if (done) return;
        await new Promise<void>((r) => (wake = () => r()));
        wake = null;
      }
    },
  };
  return w;
}

/** Let the watch loops consume what was pushed. */
const drain = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
};

Deno.test("debounce: a burst becomes one call after it goes quiet, with every name in it", () => {
  const timers = fakeTimers();
  const calls: string[][] = [];
  const d = createDebouncer((names) => calls.push([...names].sort()), {
    waitMs: 300,
    maxWaitMs: 1000,
    timers,
  });
  d.trigger(["health.json"]);
  timers.advance(100);
  d.trigger(["pool-state.json"]);
  timers.advance(100);
  d.trigger(["health.json"]);
  assert(d.pending);
  timers.advance(299);
  assertEquals(calls, [], "still inside the quiet time");
  timers.advance(1);
  assertEquals(calls, [["health.json", "pool-state.json"]]);
  assertFalse(d.pending);
  // The next burst starts afresh.
  d.trigger(["health-published"]);
  timers.advance(300);
  assertEquals(calls.at(-1), ["health-published"]);
  assertEquals(calls.length, 2);
});

Deno.test("debounce: a burst that never goes quiet still flushes by its ceiling", () => {
  const timers = fakeTimers();
  const at: number[] = [];
  const d = createDebouncer(() => at.push(timers.now()), { waitMs: 300, maxWaitMs: 1000, timers });
  // A write every 200 ms for 2.5 s: the quiet time never passes.
  for (let i = 0; i < 13; i++) {
    d.trigger(["health.json"]);
    timers.advance(200);
  }
  assertEquals(at.slice(0, 2), [1000, 2000], "one refresh per second at the latest");
  // flush() runs a pending burst now; cancel() drops one.
  assertEquals(at.length, 2, "the last burst is still pending");
  d.trigger();
  d.flush();
  assertEquals(at.length, 3);
  d.trigger();
  d.cancel();
  timers.advance(5000);
  assertEquals(at.length, 3);
  assertEquals(timers.size, 0, "no timer left behind");
});

Deno.test("matching: by base name; a rename-replace write is heard by its destination", () => {
  const t = { dir: "/r", names: ["health.json", POOL_STATE_FILE], prefixes: ["paused-"] };
  assertEquals(baseName("/r/health.json"), "health.json");
  assertEquals(baseName("C:\\r\\health.json"), "health.json");
  // The scheduler's atomic write: the temp file, then a rename onto the real name.
  assertEquals(matchedNames({ kind: "create", paths: ["/r/.health.json.tmp.123"] }, t), []);
  assertEquals(matchedNames({ kind: "modify", paths: ["/r/.health.json.tmp.123"] }, t), []);
  assertEquals(
    matchedNames({ kind: "rename", paths: ["/r/.health.json.tmp.123", "/r/health.json"] }, t),
    ["health.json"],
  );
  // FSEvents may report the destination alone, as "any" or "create".
  assertEquals(matchedNames({ kind: "any", paths: ["/r/health.json"] }, t), ["health.json"]);
  assertEquals(matchedNames({ kind: "create", paths: ["/r/pool-state.json"] }, t), [
    "pool-state.json",
  ]);
  // Prefixes: a pause file, but not the bare prefix.
  assertEquals(matchedNames({ kind: "create", paths: ["/r/paused-win-x64"] }, t), [
    "paused-win-x64",
  ]);
  assertEquals(matchedNames({ kind: "create", paths: ["/r/paused-"] }, t), []);
  // Unrelated churn in the folder, and reads, count for nothing.
  assertEquals(matchedNames({ kind: "modify", paths: ["/r/lock-linux-x64-1"] }, t), []);
  assertEquals(matchedNames({ kind: "access", paths: ["/r/health.json"] }, t), []);
  // A name is reported once.
  assertEquals(
    matchedNames({ kind: "rename", paths: ["/r/health.json", "/r/health.json"] }, t),
    ["health.json"],
  );
});

Deno.test("targets: the health file's folder (three names) and the paused folder", () => {
  assertEquals(schedulerTargets({ healthFile: null, pausedDir: "/r" }), []);
  assertEquals(schedulerTargets({ healthFile: "/home/u/.runners/state.json", pausedDir: null }), [
    {
      dir: "/home/u/.runners",
      names: ["state.json", POOL_STATE_FILE, HEALTH_PUBLISHED_FILE],
    },
  ]);
  assertEquals(
    schedulerTargets({ healthFile: "/r/health.json", pausedDir: "/r" })[1],
    { dir: "/r", prefixes: ["paused-"] },
  );
});

Deno.test("watch: events become one debounced change; unrelated files are ignored; stop closes", async () => {
  const timers = fakeTimers();
  const watches = new Map<string, ReturnType<typeof fakeWatch>>();
  const changes: string[][] = [];
  const watching: number[] = [];
  const w = watchState({
    targets: [
      { dir: "/r", names: ["health.json", POOL_STATE_FILE] },
      { dir: "/r", prefixes: ["paused-"] },
    ],
    onChange: (names) => changes.push([...names].sort()),
    onWatching: (n) => watching.push(n),
    timers,
    watch: (dir) => {
      const f = fakeWatch();
      watches.set(dir, f);
      return f;
    },
  });
  assertEquals(watches.size, 1, "targets on one folder share a watch");
  assertEquals(w.watching, 1);
  const f = watches.get("/r")!;
  f.push({ kind: "modify", paths: ["/r/lock-linux-x64-1"] });
  f.push({ kind: "rename", paths: ["/r/.tmp.1", "/r/health.json"] });
  f.push({ kind: "rename", paths: ["/r/.tmp.2", "/r/pool-state.json"] });
  f.push({ kind: "create", paths: ["/r/paused-mac-arm"] });
  await drain();
  assertEquals(changes, []);
  timers.advance(300);
  assertEquals(changes, [["health.json", "paused-mac-arm", "pool-state.json"]]);
  // Only unrelated churn: nothing.
  f.push({ kind: "modify", paths: ["/r/scheduler.log"] });
  await drain();
  timers.advance(5000);
  assertEquals(changes.length, 1);
  w.stop();
  assert(f.closed);
  assertEquals(w.watching, 0);
  assertEquals(watching, [1, 0]);
  assertEquals(timers.size, 0, "no timer left behind");
});

Deno.test("watch: a folder that can't be watched is retried, and a re-armed watch reports a change", async () => {
  const timers = fakeTimers();
  let fail = true;
  const opened: { w: ReturnType<typeof fakeWatch> | null } = { w: null };
  const changes: number[] = [];
  const w = watchState({
    targets: [{ dir: "/missing", names: ["health.json"] }],
    onChange: () => changes.push(timers.now()),
    retryMs: 30_000,
    timers,
    watch: () => {
      if (fail) throw new Deno.errors.NotFound("no such folder");
      opened.w = fakeWatch();
      return opened.w;
    },
  });
  assertEquals(w.watching, 0);
  timers.advance(30_000);
  assertEquals(w.watching, 0, "still missing");
  fail = false;
  timers.advance(30_000);
  assertEquals(w.watching, 1);
  timers.advance(300);
  assertEquals(changes.length, 1, "anything may have changed while it was down");
  // The folder goes away (the watch ends): retried again.
  opened.w!.end();
  await drain();
  assertEquals(w.watching, 0);
  timers.advance(30_000);
  assertEquals(w.watching, 1);
  w.stop();
  assertEquals(timers.size, 0);
});

Deno.test("watch: a real folder hears every rename-replace write, not only the first", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fleet-watch-" });
  const changes: string[][] = [];
  let notify: (() => void) | null = null;
  const next = (ms: number) =>
    new Promise<boolean>((resolve) => {
      const t = setTimeout(() => {
        notify = null;
        resolve(false);
      }, ms);
      notify = () => {
        clearTimeout(t);
        notify = null;
        resolve(true);
      };
    });
  /** The scheduler's way: write a temp file, rename it over the real one (a new inode). */
  const replace = async (name: string, text: string) => {
    const tmp = `${dir}/.${name}.tmp-${crypto.randomUUID()}`;
    await Deno.writeTextFile(tmp, text);
    await Deno.rename(tmp, `${dir}/${name}`);
  };
  await replace("health.json", '{"checked_at_epoch":1}');
  // The write above is history before the watch starts (FSEvents' latency could still report it).
  await new Promise((r) => setTimeout(r, 300));
  const w = watchState({
    targets: [{ dir, names: ["health.json", POOL_STATE_FILE] }],
    onChange: (names) => {
      changes.push([...names]);
      notify?.();
    },
    debounceMs: 50,
    maxWaitMs: 200,
  });
  try {
    assertEquals(w.watching, 1);
    // Unrelated writes in the folder wake nothing.
    await Deno.writeTextFile(`${dir}/scheduler.log`, "tick\n");
    assertFalse(await next(600), `an unrelated file woke it: ${JSON.stringify(changes)}`);
    changes.length = 0;
    for (let i = 2; i <= 4; i++) {
      const heard = next(5000);
      await replace("health.json", `{"checked_at_epoch":${i}}`);
      assert(await heard, `rename-replace write ${i} was not heard`);
      assert(changes.at(-1)!.includes("health.json"), JSON.stringify(changes));
      // Let the burst's trailing events settle before the next write.
      await new Promise((r) => setTimeout(r, 250));
    }
    const heard = next(5000);
    await replace(POOL_STATE_FILE, '{"checked_at":1,"pools":{}}');
    assert(await heard, "pool-state.json was not heard");
  } finally {
    w.stop();
    await Deno.remove(dir, { recursive: true });
  }
});
