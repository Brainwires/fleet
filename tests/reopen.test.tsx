// A window closed to the tray and opened again is a fresh page (desktop.ts: a close destroys the
// window; the tray, the Dock and a second launch open a new one). These tests run the real page
// (app/fleet-app.tsx) and the real denext bridge client against a fake desktop runtime: the
// backend's `fleet` methods over `POST /_denext/desktop/rpc` and its event stream over
// `GET /_denext/desktop/events`. The stream replays nothing to a new connection (the strictest
// case: denext's `retain: false` events, or a replay buffer that has moved on), so the page has
// to ask for the current state itself.

import { assert, assertFalse } from "@std/assert";
import { render, type RenderResult } from "denext/testing";
import { FleetApp } from "../app/fleet-app.tsx";
import { createGitHubClient } from "../lib/github.ts";
import type { Snapshot } from "../lib/model.ts";
import { Poller } from "../lib/poller.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

/** The fixtures' snapshot: jobs running. */
async function busySnapshot(): Promise<Snapshot> {
  const { fetch } = fakeFetch(standardRoutes());
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  return p.snapshot();
}

/** The same org with nothing running or queued, a later poll. */
function idleSnapshot(s: Snapshot, at: number): Snapshot {
  return {
    ...s,
    at,
    poll: { ...s.poll, lastSuccessAt: at },
    running: [],
    queued: [],
    summary: { ...s.summary, running: 0, queued: 0 },
  };
}

/** A fake page environment (`document`, the window's focus events) and desktop runtime. */
function fakeDesktop(initial: Snapshot) {
  const g = globalThis as unknown as Record<string, unknown>;
  const saved = { fetch: g.fetch, document: g.document, __denext: g.__denext };
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible" as DocumentVisibilityState,
    hasFocus: (): boolean => true,
  });
  let snap = initial;
  const calls: string[] = [];
  let sink: ReadableStreamDefaultController<Uint8Array> | null = null;
  let nextId = 0;
  const enc = new TextEncoder();
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
  const answer = (method: string): unknown => {
    switch (method) {
      case "snapshot":
      case "refresh":
        return snap;
      case "events":
        return { events: [], lastSeq: snap.eventSeq };
      case "capabilities":
        return { pools: false };
      default:
        return null;
    }
  };
  g.__denext = { desktop: true, token: "test-token" };
  g.document = doc;
  g.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const path = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.pathname
      : input.url;
    if (path.endsWith("/_denext/desktop/rpc")) {
      const { method } = JSON.parse(String(init?.body));
      calls.push(method);
      return Promise.resolve(json({ ok: true, data: answer(method) }));
    }
    if (path.endsWith("/_denext/desktop/events")) {
      // A new connection: no replay, only what is emitted from now on.
      const body = new ReadableStream<Uint8Array>({
        start(c) {
          sink = c;
          init?.signal?.addEventListener("abort", () => {
            if (sink === c) sink = null;
            try {
              c.error(new DOMException("aborted", "AbortError"));
            } catch { /* closed */ }
          }, { once: true });
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "content-type": "text/event-stream" } }),
      );
    }
    return Promise.reject(new TypeError(`unexpected fetch ${path}`));
  };
  return {
    doc,
    calls,
    /** The backend's state changes (and, when a page listens, it emits `changed`). */
    set(next: Snapshot) {
      snap = next;
      const frame = `id: ${++nextId}\ndata: ${
        JSON.stringify({ cap: "fleet", event: "changed", data: null })
      }\n\n`;
      sink?.enqueue(enc.encode(frame));
    },
    /** The state changes with no event reaching the page (a dropped stream, a missed replay). */
    quietly(next: Snapshot) {
      snap = next;
    },
    get subscribed() {
      return sink !== null;
    },
    restore() {
      g.fetch = saved.fetch;
      g.document = saved.document;
      g.__denext = saved.__denext;
    },
  };
}

/** Let the page's bridge calls and renders settle. */
async function settle(screen: RenderResult, rounds = 6): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await screen.act(() => new Promise((r) => setTimeout(r, 0)));
  }
}

const text = (screen: RenderResult) => screen.container.textContent ?? "";

Deno.test("reopen: a new window shows the state that changed while none was open, then follows it", async () => {
  const busy = await busySnapshot();
  const rt = fakeDesktop(busy);
  try {
    // The first window: the busy state.
    const first = await render(<FleetApp />);
    await settle(first);
    assertFalse(text(first).includes("Nothing running."), "first window: jobs running");
    assert(rt.subscribed, "first window: listening to the backend's changes");

    // Closed to the tray: the page is gone (no listener left).
    await first.unmount();
    assertFalse(rt.subscribed);

    // While no window is open, CI goes idle. Nothing is listening, nothing is retained.
    rt.set(idleSnapshot(busy, NOW + 120_000));

    // Reopened: a fresh page asks for the current state at once.
    rt.calls.length = 0;
    const second = await render(<FleetApp />);
    await settle(second);
    assert(rt.calls.includes("snapshot"), `asked for the state: ${rt.calls.join(", ")}`);
    assert(text(second).includes("Nothing running."), "the reopened window shows the idle state");
    assert(text(second).includes("Nothing queued."), "…an idle org says so");
    assert(/updated (just now|\d+[smhd] ago)/.test(text(second)), "…with the last poll's time");
    assert(rt.subscribed, "the reopened window listens to the backend's changes");

    // …and keeps following it.
    rt.set({ ...busy, at: NOW + 180_000 });
    await settle(second);
    assertFalse(text(second).includes("Nothing running."), "a later change reaches the page");

    await second.unmount();
  } finally {
    rt.restore();
  }
});

Deno.test("reopen: a change right after the first read reaches the page (it listens from mount)", async () => {
  const busy = await busySnapshot();
  const rt = fakeDesktop(busy);
  try {
    const screen = await render(<FleetApp />);
    await settle(screen);
    assert(rt.calls.includes("snapshot"));
    assert(rt.subscribed);
    rt.set(idleSnapshot(busy, NOW + 60_000));
    await settle(screen);
    assert(text(screen).includes("Nothing running."));
    await screen.unmount();
  } finally {
    rt.restore();
  }
});

Deno.test("reopen: a window shown again (hidden, not destroyed) reads the state when it shows", async () => {
  const busy = await busySnapshot();
  const rt = fakeDesktop(busy);
  try {
    const screen = await render(<FleetApp />);
    await settle(screen);
    // Hidden: the page stops reading (no 5 s poll, no clock), and misses no listener.
    rt.doc.visibilityState = "hidden";
    rt.doc.hasFocus = () => false;
    rt.doc.dispatchEvent(new Event("visibilitychange"));
    await settle(screen);

    // The state changes while it's hidden and the change event is lost (a stream that dropped).
    rt.quietly(idleSnapshot(busy, NOW + 90_000));

    // Shown again: visibilitychange reads.
    rt.calls.length = 0;
    rt.doc.visibilityState = "visible";
    rt.doc.hasFocus = () => true;
    rt.doc.dispatchEvent(new Event("visibilitychange"));
    await settle(screen);
    assert(rt.calls.includes("snapshot"), "visibilitychange to visible reads the state");
    assert(text(screen).includes("Nothing running."));
    await screen.unmount();
  } finally {
    rt.restore();
  }
});

Deno.test("reopen: Refresh asks the backend to poll and shows its answer", async () => {
  const busy = await busySnapshot();
  const rt = fakeDesktop(busy);
  try {
    const screen = await render(<FleetApp />);
    await settle(screen);
    rt.calls.length = 0;
    // The backend's next poll finds CI idle; no change event (the page sees it only via Refresh).
    rt.quietly(idleSnapshot(busy, NOW + 30_000));
    const button = screen.getAllByRole("button").find((b) =>
      /refresh/i.test(b.textContent ?? "") || /refresh/i.test(b.getAttribute("aria-label") ?? "")
    );
    assert(button, "a Refresh button");
    await screen.fireEvent.click(button);
    await settle(screen);
    assert(rt.calls.includes("refresh"), `called refresh: ${rt.calls.join(", ")}`);
    assert(text(screen).includes("Nothing running."));
    await screen.unmount();
  } finally {
    rt.restore();
  }
});

for (const type of ["focus", "pageshow"] as const) {
  Deno.test(`reopen: a window's ${type} reads the state, even before visibility flips`, async () => {
    const busy = await busySnapshot();
    const rt = fakeDesktop(busy);
    try {
      const screen = await render(<FleetApp />);
      await settle(screen);
      rt.doc.visibilityState = "hidden";
      rt.doc.hasFocus = () => false;
      rt.doc.dispatchEvent(new Event("visibilitychange"));
      await settle(screen);
      rt.quietly(idleSnapshot(busy, NOW + 90_000));

      // Brought to the front: the engine hasn't fired visibilitychange (yet).
      rt.calls.length = 0;
      rt.doc.hasFocus = () => true;
      globalThis.dispatchEvent(new Event(type));
      await settle(screen);
      assert(rt.calls.includes("snapshot"), `${type} reads the state: ${rt.calls.join(", ")}`);
      assert(text(screen).includes("Nothing running."));
      await screen.unmount();
    } finally {
      rt.restore();
    }
  });
}

Deno.test("reopen: a focus while the window stays hidden and unfocused reads nothing", async () => {
  const busy = await busySnapshot();
  const rt = fakeDesktop(busy);
  try {
    const screen = await render(<FleetApp />);
    await settle(screen);
    rt.doc.visibilityState = "hidden";
    rt.doc.hasFocus = () => false;
    rt.doc.dispatchEvent(new Event("visibilitychange"));
    await settle(screen);
    rt.calls.length = 0;
    globalThis.dispatchEvent(new Event("focus"));
    await settle(screen);
    assert(!rt.calls.includes("snapshot"), `no read: ${rt.calls.join(", ")}`);
    await screen.unmount();
  } finally {
    rt.restore();
  }
});
