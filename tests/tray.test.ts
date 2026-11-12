// The tray-resident behaviour with fakes: the close guard's reasons, the window manager (Dock icon
// follows the window), the menu and its wiring (toggle, summary, pause, start at login, quit), the
// tooltip and red icon, and start at login defaulting on once.

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { Snapshot } from "../lib/model.ts";
import { trayText } from "../lib/snapshot.ts";
import {
  allowClose,
  createWindowManager,
  driveTray,
  ensureLoginDefault,
  INITIAL_MENU,
  loginOn,
  MENU,
  summaryLine,
  trayMenu,
} from "../lib/tray-driver.ts";
import { NOW } from "./helpers.ts";

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    at: NOW,
    auth: "gh",
    poll: {
      ok: true,
      message: "",
      lastSuccessAt: NOW,
      intervalMs: 15_000,
      backoffUntil: null,
      slow: null,
    },
    rate: null,
    health: { state: "ok", checkedAt: NOW, message: "" },
    pools: [],
    running: [],
    queued: [],
    finished: [],
    alerts: [],
    summary: { running: 2, queued: 1, severity: "ok", reasons: [] },
    repos: [],
    eventSeq: 0,
    notificationsPaused: false,
    hooks: { state: "off", lastDeliveryAt: null },
    ...over,
  };
}

function fakeApp() {
  const log: string[] = [];
  const win = {
    visible: false,
    show() {
      this.visible = true;
      log.push("show");
    },
    hide() {
      this.visible = false;
      log.push("hide");
    },
    focus() {
      log.push("focus");
    },
  };
  const host = {
    main: () => win,
    setActivationPolicy: (p: "regular" | "accessory") => (log.push(`policy:${p}`), true),
  };
  return { win, host, log };
}

function fakeTray() {
  const updates: Record<string, unknown>[] = [];
  let click = () => {};
  let item = (_id: string) => {};
  return {
    updates,
    click: () => click(),
    choose: (id: string) => item(id),
    tray: {
      update: (o: Record<string, unknown>) => void updates.push(o),
      onClick: (h: () => void) => ((click = h), () => {}),
      onMenuItem: (h: (id: string) => void) => ((item = h), () => {}),
    },
  };
}

const ICONS = {
  normal: { icon: new Uint8Array([1]), iconDark: new Uint8Array([2]) },
  alert: { icon: new Uint8Array([3]), iconDark: null },
};

Deno.test("close guard: the close button hides, a real quit goes through", () => {
  assertEquals(allowClose("close"), false);
  assertEquals(allowClose("quit"), true);
  assertEquals(allowClose("anything else"), false);
});

Deno.test("window manager: regular while shown, accessory while hidden; toggle", () => {
  const { host, log, win } = fakeApp();
  let changes = 0;
  const w = createWindowManager(host, () => changes++);
  w.toggle();
  assert(win.visible);
  assertEquals(log, ["policy:regular", "show", "focus"]);
  w.toggle();
  assertFalse(win.visible);
  assertEquals(log.slice(3), ["hide", "policy:accessory"]);
  assertEquals(changes, 2);
});

Deno.test("tray menu: show/hide, the summary as a disabled item, toggles, quit", () => {
  const m = trayMenu({
    windowVisible: false,
    summary: "2 running · 1 queued",
    notificationsPaused: true,
    startAtLogin: true,
  });
  assertEquals(m, [
    { id: MENU.toggle, label: "Show Fleet" },
    { id: MENU.summary, label: "2 running · 1 queued", disabled: true },
    { separator: true },
    { id: MENU.pause, label: "Pause notifications", checked: true },
    { id: MENU.login, label: "Start at login", checked: true },
    { id: MENU.refresh, label: "Refresh now" },
    { separator: true },
    { id: MENU.quit, label: "Quit Fleet" },
  ]);
  assertEquals(
    trayMenu({ windowVisible: true, summary: "x", notificationsPaused: false, startAtLogin: null })
      .map((i) => "id" in i ? i.id : "-"),
    [MENU.toggle, MENU.summary, "-", MENU.pause, MENU.refresh, "-", MENU.quit],
  );
  assertEquals(
    (trayMenu({
      windowVisible: true,
      summary: "x",
      notificationsPaused: false,
      startAtLogin: null,
    })[0] as { label: string }).label,
    "Hide Fleet",
  );
  assertEquals(INITIAL_MENU[1], { id: MENU.summary, label: "Starting…", disabled: true });
  assertEquals(summaryLine(snap({ auth: "needs-token" })), "Sign in to GitHub");
  assertEquals(summaryLine(snap()), "2 running · 1 queued");
});

Deno.test("tray: click toggles the window; menu items reach their actions; the menu follows", async () => {
  const { host, win } = fakeApp();
  const t = fakeTray();
  const calls: string[] = [];
  let paused = false;
  const w = createWindowManager(host);
  const d = driveTray(t.tray, ICONS, w, {
    refresh: () => Promise.resolve(void calls.push("refresh")),
    setNotificationsPaused: (p) => {
      calls.push(`pause:${p}`);
      paused = p;
      return Promise.resolve();
    },
    setStartAtLogin: (on) => Promise.resolve((calls.push(`login:${on}`), on)),
    quit: () => calls.push("quit"),
  });
  d.startAtLogin = false;
  d.update(snap());
  const menuOf = () =>
    t.updates.filter((u) => u.menu).at(-1)!.menu as {
      id?: string;
      label?: string;
      checked?: boolean;
    }[];
  assertEquals(menuOf()[0].label, "Show Fleet");
  assertEquals(menuOf()[1].label, "2 running · 1 queued");
  t.click();
  assert(win.visible);
  assertEquals(menuOf()[0].label, "Hide Fleet");
  t.choose(MENU.toggle);
  assertFalse(win.visible);
  t.choose(MENU.refresh);
  t.choose(MENU.pause);
  t.choose(MENU.login);
  await new Promise((r) => setTimeout(r, 0));
  assertEquals(menuOf().find((i) => i.id === MENU.login)?.checked, true);
  d.update(snap({ notificationsPaused: paused }));
  assertEquals(menuOf().find((i) => i.id === MENU.pause)?.checked, true);
  t.choose(MENU.quit);
  assertEquals(calls, ["refresh", "pause:true", "login:true", "quit"]);
  // Choosing the disabled summary does nothing.
  t.choose(MENU.summary);
  assertEquals(calls.length, 4);
});

Deno.test("tray: tooltip text, red icon on alert, no update when nothing changed", () => {
  const { host } = fakeApp();
  const t = fakeTray();
  const d = driveTray(t.tray, ICONS, createWindowManager(host), {
    refresh: () => Promise.resolve(),
    setNotificationsPaused: () => Promise.resolve(),
    setStartAtLogin: () => Promise.resolve(null),
    quit: () => {},
  });
  const ok = snap();
  d.update(ok);
  const first = t.updates.find((u) => u.tooltip);
  assertEquals(first?.tooltip, "2 running · 1 queued");
  assertEquals(first?.icon, ICONS.normal.icon);
  assertEquals(first?.iconDark, ICONS.normal.iconDark);
  const n = t.updates.length;
  d.update(ok);
  assertEquals(t.updates.length, n, "no update when nothing changed");
  d.update(
    snap({ summary: { running: 2, queued: 1, severity: "alert", reasons: ["win-x64 unhealthy"] } }),
  );
  const red = t.updates.find((u) => u.icon === ICONS.alert.icon);
  assertEquals(red?.tooltip, "2 running · 1 queued\nwin-x64 unhealthy");
  d.update(snap({ auth: "needs-token" }));
  assert(t.updates.some((u) => u.tooltip === "Fleet: sign in to GitHub"));
  assertEquals(
    trayText({ running: 0, queued: 0, severity: "ok", reasons: [] }),
    "0 running · 0 queued",
  );
});

Deno.test("start at login: on at the first run, never forced again; states", async () => {
  const calls: string[] = [];
  let state = "disabled";
  const api = {
    get: () => Promise.resolve(state),
    set: (on: boolean) =>
      Promise.resolve((calls.push(`set:${on}`), state = on ? "enabled" : "disabled")),
  };
  let defaulted = false;
  assertEquals(
    await ensureLoginDefault(api, defaulted, () => Promise.resolve(void (defaulted = true))),
    true,
  );
  assertEquals(calls, ["set:true"]);
  assert(defaulted);
  // The user turned it off: a later launch respects that.
  state = "disabled";
  assertEquals(await ensureLoginDefault(api, defaulted, () => Promise.resolve()), false);
  assertEquals(calls, ["set:true"]);
  assertEquals(await ensureLoginDefault(undefined, false, () => Promise.resolve()), null);
  assertEquals(loginOn("requires-approval"), true);
  assertEquals(loginOn("not-supported"), null);
});

Deno.test("tray art: the macOS template is black + alpha only, 36 px; Windows has colour", async () => {
  const { macTrayPixels, trayIcons, winTrayPixels } = await import("../lib/icons.ts");
  for (const status of ["normal", "alert"] as const) {
    const px = macTrayPixels(status);
    assertEquals(px.length, 36 * 36 * 4);
    let opaque = 0;
    for (let i = 0; i < px.length; i += 4) {
      assertEquals([px[i], px[i + 1], px[i + 2]], [0, 0, 0], `pixel ${i / 4} of ${status}`);
      if (px[i + 3] > 0) opaque++;
    }
    assert(opaque > 100, "something is drawn");
  }
  // Status is shape on macOS: the alert glyph differs from the normal one.
  assertFalse(macTrayPixels("normal").every((v, i) => v === macTrayPixels("alert")[i]));
  const mac = await trayIcons("darwin");
  assertEquals(mac.normal.iconDark, null);
  const win = await trayIcons("windows");
  assert(win.normal.iconDark !== null);
  const light = winTrayPixels("light", "normal");
  let coloured = false;
  for (let i = 0; i < light.length; i += 4) {
    if (light[i + 3] > 200 && (light[i] !== light[i + 1] || light[i + 1] !== light[i + 2])) {
      coloured = true;
    }
  }
  assert(coloured, "the Windows art has a colour pip");
});
