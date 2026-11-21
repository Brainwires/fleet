// Machine-update notices and the tray's line: a warn cause posts once while it lasts, a bad one on
// entering and weekly after, a cleared cause that comes back posts again, the toggle marks keys
// seen without posting (turning it on replays nothing), the update keys survive the 48 h prune of
// the other notices while their cause lasts, run outcomes and window notices post once each; and
// the tray gains one menu line (plus Cancel update while it can) and the attention icon for bad.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  pendingNotifications,
  SEEN_TTL_MS,
  type SeenKeys,
  UPDATE_KEY,
  updateEventNotification,
  updateNotifications,
} from "../lib/notify.ts";
import { buildUpdatesView, type UpdatesMachineView } from "../lib/updates/view.ts";
import { emptyStatus, type MachineStatus, withCheck } from "../lib/updates/model.ts";
import { driveTray, MENU, trayMenu, type TrayMenuItem } from "../lib/tray-driver.ts";
import { CONFIG, D, H, NOW, statuses } from "./updates-fixtures.ts";
import type { Snapshot } from "../lib/model.ts";

const machinesAt = (now: number, st: Record<string, MachineStatus> = statuses()) =>
  buildUpdatesView({
    config: CONFIG,
    statuses: st,
    run: null,
    audit: [],
    schedules: [],
    requests: [],
    tz: "UTC",
    now,
    engine: { ok: true },
  }).machines;

const keys = (ns: { key: string }[]) => ns.map((n) => n.key).sort();

Deno.test("notify updates: warn once per machine and cause, bad on entering and weekly", () => {
  const seen: SeenKeys = new Map();
  // Checks stay fresh: re-stamp each status's check time to the clock under test.
  const fresh = (now: number) =>
    Object.fromEntries(
      Object.entries(statuses()).map((
        [id, s],
      ) => [id, { ...s, checkedAt: now - H, host: s.host && { ...s.host, indexAt: now - H } }]),
    );
  const first = updateNotifications(machinesAt(NOW, fresh(NOW)), seen, NOW, true);
  assertEquals(keys(first), [
    "upd:files-1:security-old",
    "upd:here:security-pending",
    "upd:mail-1:reboot-required",
  ]);
  assertStringIncludes(first.find((n) => n.key.includes("files-1"))!.title, "still pending");
  assertStringIncludes(first.find((n) => n.key.includes("mail-1"))!.title, "restart pending");
  // The same causes an hour later: nothing.
  assertEquals(updateNotifications(machinesAt(NOW + H, fresh(NOW + H)), seen, NOW + H, true), []);
  // Three days later: the warn keys are kept (the cause lasts), the bad one not yet due again.
  assertEquals(
    updateNotifications(machinesAt(NOW + 3 * D, fresh(NOW + 3 * D)), seen, NOW + 3 * D, true),
    [],
  );
  // A week after the first: the bad security cause repeats; two machines enter bad (posted).
  const week = updateNotifications(
    machinesAt(NOW + 7 * D, fresh(NOW + 7 * D)),
    seen,
    NOW + 7 * D,
    true,
  );
  assertEquals(keys(week), [
    "upd:files-1:security-old",
    "upd:here:security-old",
    "upd:mail-1:reboot-old",
  ]);
  // The warn causes they left are never reposted while the bad ones last.
  assertEquals(
    updateNotifications(machinesAt(NOW + 8 * D, fresh(NOW + 8 * D)), seen, NOW + 8 * D, true),
    [],
  );
});

Deno.test("notify updates: a cause that clears and returns posts again (after the 48 h memory)", () => {
  const seen: SeenKeys = new Map();
  const m = (security: number): UpdatesMachineView[] => {
    const s = withCheck(emptyStatus("runner-1"), {
      pending: { total: security, security, names: [], securityNames: [] },
      reboot: { required: false, since: null, packages: [] },
      indexAt: null,
    }, NOW);
    return machinesAt(NOW, { "runner-1": s }).filter((x) => x.id === "runner-1");
  };
  assertEquals(updateNotifications(m(2), seen, NOW, true).length, 1);
  assertEquals(updateNotifications(m(0), seen, NOW + H, true).length, 0);
  // Still remembered within 48 h: a flap doesn't repost.
  assertEquals(updateNotifications(m(2), seen, NOW + 2 * H, true).length, 0);
  // Cleared for longer than 48 h after it was posted: forgotten, so it posts again.
  updateNotifications(m(0), seen, NOW + SEEN_TTL_MS + 3 * H, true);
  assertEquals(updateNotifications(m(2), seen, NOW + SEEN_TTL_MS + 4 * H, true).length, 1);
});

Deno.test("notify updates: the toggle off marks keys seen without posting; on later replays nothing", () => {
  const seen: SeenKeys = new Map();
  assertEquals(updateNotifications(machinesAt(NOW), seen, NOW, false), []);
  assert([...seen.keys()].some((k) => k.startsWith(UPDATE_KEY)));
  assertEquals(updateNotifications(machinesAt(NOW + 60_000), seen, NOW + 60_000, true), []);
  const ev = {
    kind: "outcome" as const,
    runId: "r1",
    machine: "mail-1",
    action: "install" as const,
    outcome: "reboot-pending",
  };
  assertEquals(updateEventNotification(ev, seen, NOW, false), null);
  assertEquals(updateEventNotification(ev, seen, NOW, true), null, "marked seen while off");
});

Deno.test("notify updates: the 48 h prune of other notices keeps update keys whose cause lasts", () => {
  const seen: SeenKeys = new Map([[`${UPDATE_KEY}mail-1:reboot-required`, NOW - 5 * D], [
    "fail:1",
    NOW - 5 * D,
  ]]);
  const snap = {
    at: NOW,
    health: { state: "unknown" },
    pools: [],
    queued: [],
    finished: [],
  } as unknown as Snapshot;
  pendingNotifications(snap, seen, NOW, {
    poolUnhealthy: true,
    queuedLong: true,
    protectedFailure: true,
    updates: true,
  });
  assert(seen.has(`${UPDATE_KEY}mail-1:reboot-required`));
  assert(!seen.has("fail:1"));
});

Deno.test("notify updates: run outcomes, the ten-minute notice and the busy streak post once each", () => {
  const seen: SeenKeys = new Map();
  const out = updateEventNotification(
    {
      kind: "outcome",
      runId: "r1",
      machine: "runner-1",
      action: "install",
      outcome: "reboot-pending",
    },
    seen,
    NOW,
    true,
  )!;
  assertEquals(out.key, "upd-run:r1");
  assertStringIncludes(out.body, "restart is pending");
  const soon = updateEventNotification(
    {
      kind: "restart-soon",
      scheduleId: "s1",
      machine: "mail-1",
      window: NOW,
      runAt: NOW + 600_000,
    },
    seen,
    NOW,
    true,
  )!;
  assertEquals(soon.title, "mail-1 restarts in 10 minutes");
  assertEquals(
    updateEventNotification(
      { kind: "restart-soon", scheduleId: "s1", machine: "mail-1", window: NOW, runAt: 0 },
      seen,
      NOW + 1,
      true,
    ),
    null,
  );
  const busy = updateEventNotification(
    { kind: "busy-streak", scheduleId: "s1", machine: "runner-1", window: NOW, count: 3 },
    seen,
    NOW,
    true,
  )!;
  assertStringIncludes(busy.title, "3 restart windows skipped");
  assertEquals(
    updateEventNotification(
      { kind: "skip", scheduleId: "s1", machine: "x", window: NOW, reason: "nothing-due" },
      seen,
      NOW,
      true,
    ),
    null,
    "a skip is logged, not notified",
  );
});

// ---- the tray ----

Deno.test("tray: one updates line, Cancel update while cancellable, the attention icon for bad", () => {
  const base = {
    windowVisible: false,
    summary: "1 running · 0 queued",
    notificationsPaused: false,
    startAtLogin: null,
  };
  const ids = (m: TrayMenuItem[]) => m.map((i) => ("id" in i ? i.id : "-"));
  assertEquals(ids(trayMenu(base)).includes(MENU.updates), false);
  const withLine = trayMenu({
    ...base,
    updates: { line: "2 machines need updates", cancellable: false },
  });
  assertEquals(withLine[2], { id: MENU.updates, label: "2 machines need updates" });
  assertEquals(ids(withLine).includes(MENU.cancelUpdate), false);
  assert(
    ids(trayMenu({ ...base, updates: { line: "Updating x: draining", cancellable: true } }))
      .includes(MENU.cancelUpdate),
  );

  const pushes: Record<string, unknown>[] = [];
  let menuHandler: (id: string) => void = () => {};
  const icon = (n: number) => ({ icon: new Uint8Array([n]), iconDark: null });
  const cancelled: string[] = [];
  const opened: number[] = [];
  const d = driveTray(
    {
      update: (o) => pushes.push(o),
      onClick: () => () => {},
      onMenuItem: (h) => {
        menuHandler = h;
        return () => {};
      },
    },
    { normal: icon(1), alert: icon(2) },
    { visible: false, toggle: () => {}, closeHidden: () => {} } as never,
    {
      refresh: () => Promise.resolve(),
      openSettings: () => {},
      setNotificationsPaused: () => Promise.resolve(),
      setStartAtLogin: () => Promise.resolve(null),
      openUpdates: () => opened.push(1),
      cancelUpdate: (id) => cancelled.push(id),
      quit: () => {},
    },
  );
  const snap = {
    setupComplete: true,
    auth: "gh",
    notificationsPaused: false,
    summary: { running: 1, queued: 0, severity: "ok", reasons: [] },
  } as unknown as Snapshot;
  d.update(snap);
  const before = pushes.length;
  d.setUpdates({ line: "Updating runner-2: draining", bad: true, cancellable: "run-1" });
  const after = pushes.slice(before);
  const look = after.find((p) => p.icon);
  assert(look, "the icon changes");
  assertEquals((look!.icon as Uint8Array)[0], 2, "attention icon for a bad machine");
  assertStringIncludes(String(look!.tooltip), "Updating runner-2: draining");
  menuHandler(MENU.cancelUpdate);
  menuHandler(MENU.updates);
  assertEquals(cancelled, ["run-1"]);
  assertEquals(opened, [1]);
  d.setUpdates(null);
  assertEquals((pushes.at(-2)?.icon as Uint8Array | undefined)?.[0] ?? 1, 1);
});
