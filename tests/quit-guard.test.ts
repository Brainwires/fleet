// Which quits quit Fleet (lib/quit-guard.ts): the tray's own Quit and the OS's session end go
// through; any other quit (the Dock's Quit, Cmd+Q, `osascript … quit`) closes the window on a later
// task and is refused, so Fleet stays in the tray. Without a tray every quit goes through.

import "./fixture-settings.ts";

import { assertEquals } from "@std/assert";
import { createQuitGuard } from "../lib/quit-guard.ts";

function setup(opts: { tray?: boolean } = {}) {
  const log: string[] = [];
  const queued: (() => void)[] = [];
  const g = createQuitGuard({
    closeWindows: () => log.push("close"),
    hasTray: () => opts.tray ?? true,
    later: (fn) => void queued.push(fn),
  });
  const flush = () => {
    for (const fn of queued.splice(0)) fn();
  };
  return { g, log, flush, queued };
}

Deno.test("quit guard: an external quit closes the window on a later task and is refused", async () => {
  const { g, log, flush, queued } = setup();
  for (const reason of [undefined, "quit", "app-quit"]) {
    g.noteQuitEvent(reason);
    assertEquals(await g.guard(), false, `reason ${reason}`);
    assertEquals(g.last, "close-to-tray");
    // Not in the beforequit's task: the close would count as the quit's.
    assertEquals(log, []);
    assertEquals(queued.length, 1);
    flush();
    assertEquals(log, ["close"]);
    log.length = 0;
  }
});

Deno.test("quit guard: Fleet's own quit goes through; refused elsewhere, guarding resumes", async () => {
  const { g, log, queued } = setup();
  g.beginIntendedQuit();
  assertEquals(await g.guard(), true);
  assertEquals(g.last, "quit");
  assertEquals([log, queued.length], [[], 0]);
  // The quit didn't happen (a page held it): the next external quit closes to the tray again.
  g.endIntendedQuit();
  assertEquals(await g.guard(), false);
});

Deno.test("quit guard: the OS's session end always quits", async () => {
  const { g, queued } = setup();
  g.noteQuitEvent("session-end");
  assertEquals(await g.guard(), true);
  assertEquals(queued.length, 0);
  // The reason is per quit: the next plain quit is guarded again.
  g.noteQuitEvent("quit");
  assertEquals(await g.guard(), false);
  // Without a reason noted since, a stale session end does not carry over.
  g.noteQuitEvent("session-end");
  await g.guard();
  assertEquals(await g.guard(), false);
});

Deno.test("quit guard: a reason noted after the guard was called (same dispatch) still counts", async () => {
  const { g } = setup();
  const answer = g.guard();
  // denext's beforequit listener asked the guard before Fleet's listener saw the event.
  g.noteQuitEvent("session-end");
  assertEquals(await answer, true);
});

Deno.test("quit guard: without a tray every quit goes through", async () => {
  const { g, queued } = setup({ tray: false });
  assertEquals(await g.guard(), true);
  assertEquals(queued.length, 0);
});
