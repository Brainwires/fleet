// The status line and the empty lanes say how current the data is (lib/status-line.ts): live while
// webhooks are live, "updated" from the later of the last poll and the last delivery, and a muted
// "behind" only when a poll is overdue or webhooks went quiet while jobs are active.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { FleetView } from "../app/fleet-view.tsx";
import { createGitHubClient } from "../lib/github.ts";
import type { Snapshot } from "../lib/model.ts";
import { Poller } from "../lib/poller.ts";
import { intervalText, POLL_GRACE_MS, sourceLine, statusFreshness } from "../lib/status-line.ts";
import { RECONCILE_MS } from "../lib/budget.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

type Parts = Pick<Snapshot, "poll" | "hooks" | "summary">;

const MIN = 60_000;

function parts(o: {
  lastSuccessAt?: number | null;
  intervalMs?: number;
  ok?: boolean;
  hooks?: Snapshot["hooks"]["state"];
  lastDeliveryAt?: number | null;
  active?: number;
}): Parts {
  return {
    poll: {
      ok: o.ok ?? true,
      message: "",
      lastSuccessAt: o.lastSuccessAt === undefined ? NOW - 4 * MIN : o.lastSuccessAt,
      intervalMs: o.intervalMs ?? RECONCILE_MS,
      backoffUntil: null,
      slow: null,
    },
    hooks: { state: o.hooks ?? "live", lastDeliveryAt: o.lastDeliveryAt ?? null },
    summary: { running: o.active ?? 0, queued: 0, severity: "ok", reasons: [] },
  };
}

Deno.test("freshness: hooks live is live, the updated time is the later of poll and delivery", () => {
  const f = statusFreshness(parts({ lastDeliveryAt: NOW - 30_000 }), NOW);
  assertEquals(f.state, "live");
  assertEquals(f.updatedAt, NOW - 30_000);
  // A reconcile after the last delivery advances it too.
  const g = statusFreshness(
    parts({ hooks: "stale", lastSuccessAt: NOW - 20_000, lastDeliveryAt: NOW - 40 * MIN }),
    NOW,
  );
  assertEquals(g.updatedAt, NOW - 20_000);
});

Deno.test("freshness: hooks quiet with nothing active is current, not behind", () => {
  const f = statusFreshness(parts({ hooks: "stale", lastDeliveryAt: NOW - 40 * MIN }), NOW);
  assertEquals(f.state, "current");
  assert(f.hooksQuiet);
  // …quiet hooks while jobs run are behind until the gap poll reconciles after the last delivery
  // (a queue that isn't moving sends nothing)…
  const g = statusFreshness(
    parts({
      hooks: "stale",
      lastDeliveryAt: NOW - 14 * MIN,
      lastSuccessAt: NOW - 12 * MIN,
      active: 2,
    }),
    NOW,
  );
  assertEquals(g.state, "behind");
  assertFalse(g.hooksQuiet);
  // …and current once it has (the poll ran after the gap began).
  const h = statusFreshness(
    parts({
      hooks: "stale",
      lastDeliveryAt: NOW - 40 * MIN,
      lastSuccessAt: NOW - 4 * MIN,
      active: 2,
    }),
    NOW,
  );
  assertEquals(h.state, "current");
});

Deno.test("source: live from the watch and webhooks, the safety poll secondary; else the poll rate", () => {
  const p = (o: { hooks?: Snapshot["hooks"]["state"]; watch?: boolean; intervalMs?: number }) => ({
    ...parts({ hooks: o.hooks ?? "live", intervalMs: o.intervalMs }),
    ...(o.watch === undefined ? {} : { watch: { on: o.watch, lastChangeAt: null } }),
  });
  const both = sourceLine(p({ watch: true }));
  assertEquals([both.live, both.text, both.sources, both.poll], [
    true,
    "live · watch + webhooks",
    "watch + webhooks",
    "safety poll 15 min",
  ]);
  assertStringIncludes(both.title, "runner scheduler's state files");
  assertStringIncludes(both.title, "every 15 min as a safety net");
  assertStringIncludes(both.title, "quiet for 5 min");
  // Quiet webhooks are still the source (they are on).
  assertEquals(sourceLine(p({ hooks: "stale" })).text, "live · webhooks");
  // The watch alone: GitHub is still polled at the normal rate, and says so.
  const watch = sourceLine(p({ hooks: "off", watch: true, intervalMs: 15_000 }));
  assertEquals([watch.text, watch.poll], ["live · watch", "GitHub poll 15 s"]);
  // Polling only: the rate, as before ("every 300s" read as the only source).
  const poll = sourceLine(p({ hooks: "off", watch: false, intervalMs: 60_000 }));
  assertEquals([poll.live, poll.text, poll.poll], [false, "every 60 s", ""]);
  assertEquals(intervalText(300_000), "5 min");
  assertEquals(intervalText(15_000), "15 s");
});

Deno.test("freshness: an overdue or failing poll is behind; no poll yet is pending", () => {
  const due = 2 * RECONCILE_MS + POLL_GRACE_MS;
  assertEquals(
    statusFreshness(parts({ lastSuccessAt: NOW - due + 1000, lastDeliveryAt: NOW }), NOW).state,
    "live",
  );
  assertEquals(
    statusFreshness(parts({ lastSuccessAt: NOW - due - 1000, lastDeliveryAt: NOW }), NOW).state,
    "behind",
  );
  assertEquals(statusFreshness(parts({ hooks: "off", ok: false }), NOW).state, "behind");
  assertEquals(statusFreshness(parts({ lastSuccessAt: null }), NOW).state, "pending");
  // Polling only, on time: current, from the last poll.
  const off = statusFreshness(
    parts({ hooks: "off", lastSuccessAt: NOW - 10_000, intervalMs: 15_000, lastDeliveryAt: NOW }),
    NOW,
  );
  assertEquals(off, { state: "current", updatedAt: NOW - 10_000, hooksQuiet: false });
});

// ---- the view ----

async function idle(p: Parts): Promise<Snapshot> {
  const { fetch } = fakeFetch(standardRoutes());
  const poller = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await poller.poll();
  const s = poller.snapshot();
  return {
    ...s,
    ...p,
    running: [],
    queued: [],
    summary: { ...s.summary, ...p.summary, running: 0, queued: 0 },
  };
}

function byClass(root: TestElement, cls: string): TestElement[] {
  const out: TestElement[] = [];
  const walk = (el: TestElement) => {
    for (const c of el.children) {
      if ((c.getAttribute("class") ?? "").split(/\s+/).includes(cls)) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

const view = (snapshot: Snapshot) => (
  <FleetView snapshot={snapshot} now={NOW} onOpen={() => {}} onRefresh={() => {}} events={[]} />
);

Deno.test("view: an idle org with live webhooks reads live, not 'updated 4m ago'", async () => {
  const screen = await render(view(await idle(parts({ lastDeliveryAt: NOW - 2 * MIN }))));
  const text = screen.container.textContent ?? "";
  assertStringIncludes(text, "live · last event 2m ago");
  // The source beside it: the webhooks, the safety poll's interval secondary (not "every 900s").
  assertStringIncludes(text, "via webhooks · safety poll 15 min");
  assertFalse(/every \d+s/.test(text), text);
  assertFalse(text.includes("updated 4m ago"));
  const empties = byClass(screen.container, "empty-live").map((e) => e.textContent);
  assert(empties.includes("Nothing running."), `live empties: ${empties.join(" | ")}`);
  assert(empties.includes("Nothing queued."));
  assertEquals(byClass(screen.container, "status-stale").length, 0);
  // The live label replaces the webhook badge; its tooltip carries the details.
  assertFalse(text.includes("hooks:"), "no webhook badge beside the live label");
  assertEquals(byClass(screen.container, "hooks").length, 0);
  const live = byClass(screen.container, "status-live");
  assertEquals(live.length, 1);
  const title = live[0].getAttribute("title") ?? "";
  assertStringIncludes(title, "last delivery at");
  assertStringIncludes(title, "(2m ago)");
  assertStringIncludes(title, "last poll 4m ago");
});

Deno.test("view: via the standalone receiver, the live label's tooltip says so", async () => {
  const s = await idle(parts({ lastDeliveryAt: NOW - 30_000 }));
  const screen = await render(view({ ...s, hooks: { ...s.hooks, via: "spool" } }));
  const live = byClass(screen.container, "status-live");
  assertStringIncludes(live[0].getAttribute("title") ?? "", "via the standalone receiver");
  assertFalse((screen.container.textContent ?? "").includes("(via receiver)"));
});

Deno.test("view: the webhook badge shows whenever the live label doesn't", async () => {
  // Hooks live but the reconcile poll overdue: behind, so the badge stays.
  const behind = await render(
    view(await idle(parts({ lastDeliveryAt: NOW - MIN, lastSuccessAt: NOW - 40 * MIN }))),
  );
  assertStringIncludes(behind.container.textContent ?? "", "hooks: live");
  assertEquals(byClass(behind.container, "status-live").length, 0);
  // Off: the badge says so.
  const off = await render(view(await idle(parts({ hooks: "off", lastSuccessAt: NOW - 5000 }))));
  assertStringIncludes(off.container.textContent ?? "", "hooks: off");
});

Deno.test("view: quiet webhooks with nothing running are muted 'quiet', not an amber 'stale'", async () => {
  const screen = await render(
    view(await idle(parts({ hooks: "stale", lastDeliveryAt: NOW - 40 * MIN }))),
  );
  const text = screen.container.textContent ?? "";
  assertStringIncludes(text, "updated 4m ago");
  assertStringIncludes(text, "hooks: quiet (last delivery 40 min ago)");
  assertEquals(byClass(screen.container, "hooks-stale").length, 0);
  assertEquals(byClass(screen.container, "status-stale").length, 0);
  assertEquals(byClass(screen.container, "empty-live").length, 0);
});

Deno.test("view: an overdue poll is muted 'behind' in the status line and the empty lanes", async () => {
  const screen = await render(
    view(await idle(parts({ hooks: "off", lastSuccessAt: NOW - 20 * MIN, intervalMs: 15_000 }))),
  );
  const stale = byClass(screen.container, "status-stale");
  assertEquals(stale.length, 1);
  assertStringIncludes(stale[0].textContent ?? "", "updated 20m ago");
  const empties = byClass(screen.container, "empty-stale").map((e) => e.textContent);
  assert(empties.includes("Nothing running."));
});
