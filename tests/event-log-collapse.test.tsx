// The event log pane collapses to its header row: only "Event log N" shows (no filters, no lines),
// and it remembers the choice in page storage, reading open when storage is empty or unavailable.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render } from "denext/testing";
import { EventLog, readCollapsed } from "../app/event-log.tsx";
import type { FleetEvent } from "../lib/events.ts";

const event = (seq: number): FleetEvent =>
  ({
    seq,
    at: Date.UTC(2026, 10, 13, 14, 0, seq),
    sev: "ok",
    kind: "finished",
    repo: "Brainwires/deno",
    workflow: "denext tests",
    job: `job ${seq}`,
    text: "finished: success",
    url: null,
  }) as unknown as FleetEvent;

function withStorage(store: Map<string, string>, fn: () => Promise<void>): Promise<void> {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
    },
  });
  return fn().finally(() => {
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  });
}

Deno.test("event log: collapsing leaves only the header's title and count, and is remembered", async () => {
  const store = new Map<string, string>();
  await withStorage(store, async () => {
    const screen = await render(
      <EventLog events={[event(1), event(2), event(3)]} onOpen={() => {}} />,
    );
    const toggle = screen.getByRole("button", { name: /Event log/ });
    assertEquals(toggle.getAttribute("aria-expanded"), "true");
    assert(screen.queryByRole("log"), "the lines show while open");
    assert(screen.queryByRole("searchbox"), "the filters show while open");

    await screen.fireEvent.click(toggle);
    assertEquals(toggle.getAttribute("aria-expanded"), "false");
    assertFalse(Boolean(screen.queryByRole("log")), "no lines when collapsed");
    assertFalse(Boolean(screen.queryByRole("searchbox")), "no search when collapsed");
    assertFalse(Boolean(screen.queryByRole("group", { name: "Severity" })), "no severity filter");
    assertStringIncludes(toggle.textContent ?? "", "Event log");
    assertStringIncludes(toggle.textContent ?? "", "3");
    assertEquals(store.get("fleet.eventLog.collapsed"), "1");
    assert(readCollapsed(), "a new window reads it collapsed");

    await screen.fireEvent.click(toggle);
    assertEquals(toggle.getAttribute("aria-expanded"), "true");
    assert(screen.queryByRole("log"), "the lines are back");
    assertEquals(store.get("fleet.eventLog.collapsed"), "0");
  });
});

Deno.test("event log: storage that throws reads as open", () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    get() {
      throw new Error("blocked");
    },
  });
  try {
    assertFalse(readCollapsed());
  } finally {
    if (prev) Object.defineProperty(globalThis, "localStorage", prev);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
