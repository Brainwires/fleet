// The tray-resident behaviour with fakes: the window manager (a closed window is gone, a fresh one
// opens, the activation policy untouched unless the Dock icon follows the window, then "regular"
// while it is open and "accessory" once closed), the menu and its wiring (open / close, summary, pause, start at
// login, quit), the tooltip and red icon, and start at login defaulting on once.

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { Snapshot } from "../lib/model.ts";
import { trayText } from "../lib/snapshot.ts";
import {
  createWindowManager,
  driveTray,
  INITIAL_MENU,
  loginOn,
  MENU,
  readLoginItem,
  setLoginItem,
  summaryLine,
  trayMenu,
  WINDOW_KEY,
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

/**
 * The runtime's windows as the window manager sees them: `byKey(WINDOW_KEY)` finds the open one
 * (`launch` starts with the launch's hidden main window), `open` makes a fresh one, `close` runs
 * its close handlers and drops it (as the registry does), and every call is logged. With `follow`
 * it has a `setActivationPolicy` (the Dock icon follows the window: installed outside
 * /Applications); without it the manager has none to call (Fleet stays accessory).
 */
function fakeApp(opts: { launch?: boolean; openFails?: boolean; follow?: boolean } = {}) {
  const log: string[] = [];
  let n = 0;
  type Win = ReturnType<typeof makeWin>;
  let open: Win | undefined;
  function makeWin(id: string, visible: boolean) {
    const handlers = new Set<() => void>();
    const w = {
      id,
      key: WINDOW_KEY,
      visible,
      show() {
        w.visible = true;
        log.push(`show:${id}`);
      },
      focus() {
        log.push(`focus:${id}`);
      },
      close() {
        log.push(`close:${id}`);
        if (open === w) open = undefined;
        for (const h of [...handlers]) h();
        handlers.clear();
      },
      onClosed(h: () => void) {
        handlers.add(h);
        return () => handlers.delete(h);
      },
      handlers,
    };
    return w;
  }
  if (opts.launch) open = makeWin("main", false);
  const host = {
    find: () => open,
    open: () => {
      if (opts.openFails) throw new Error("too many windows");
      const w = makeWin(`window-${++n}`, true);
      log.push(`open:${w.id}`);
      open = w;
      return w;
    },
    ...(opts.follow ? { setActivationPolicy: (p: string) => (log.push(`policy:${p}`), true) } : {}),
  };
  return { host, log, current: () => open };
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

Deno.test("window manager: a fresh window opens and comes to the front; never the activation policy", () => {
  const { host, log, current } = fakeApp();
  let changes = 0;
  let closes = 0;
  const w = createWindowManager(host, { onChange: () => changes++, onClosed: () => closes++ });
  assertFalse(w.visible);
  w.show();
  assert(w.visible);
  assertEquals(log, ["open:window-1", "show:window-1", "focus:window-1"]);
  // The close button (or close()) destroys it: the runtime's close handlers run.
  log.length = 0;
  current()!.close();
  assertFalse(w.visible);
  assertEquals(current(), undefined);
  assertEquals(log, ["close:window-1"]);
  assertEquals(closes, 1);
  // Reopening is a fresh window, with its own close tracking.
  log.length = 0;
  w.show();
  assertEquals(log, ["open:window-2", "show:window-2", "focus:window-2"]);
  w.close();
  assertEquals(log.slice(3), ["close:window-2"]);
  assertEquals(closes, 2);
  assertEquals(changes, 4);
});

Deno.test("window manager: a repeated open focuses the open window, never a second", () => {
  const { host, log, current } = fakeApp();
  const w = createWindowManager(host);
  w.show();
  w.show();
  w.show();
  assertEquals(log.filter((l) => l.startsWith("open:")), ["open:window-1"]);
  assertEquals(log.slice(3), [
    "show:window-1",
    "focus:window-1",
    "show:window-1",
    "focus:window-1",
  ]);
  // One close handler, however often it was shown.
  assertEquals(current()!.handlers.size, 1);
});

Deno.test("window manager: the launch's hidden window is shown, or closed when Fleet stays in the tray", () => {
  // Shown (first launch, token needed): the main window itself, no second one.
  {
    const { host, log } = fakeApp({ launch: true });
    const w = createWindowManager(host);
    w.show();
    assertEquals(log, ["show:main", "focus:main"]);
    // closeHidden leaves a showing window alone.
    w.closeHidden();
    assertEquals(log.length, 2);
    w.toggle();
    assertEquals(log.slice(2), ["close:main"]);
  }
  // Not shown: closed, so no hidden window lingers; the next open is fresh.
  {
    const { host, log, current } = fakeApp({ launch: true });
    const w = createWindowManager(host);
    w.closeHidden();
    assertEquals(current(), undefined);
    assertEquals(log, ["close:main"]);
    w.toggle();
    assertEquals(log.slice(1), ["open:window-1", "show:window-1", "focus:window-1"]);
    // Nothing open: close and closeHidden do nothing.
    current()!.close();
    log.length = 0;
    w.close();
    w.closeHidden();
    assertEquals(log, []);
  }
});

Deno.test("window manager: a window that can't open throws, the policy untouched", () => {
  const { host, log } = fakeApp({ openFails: true });
  const w = createWindowManager(host);
  let threw = false;
  try {
    w.show();
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(log, []);
});

Deno.test("window manager: outside /Applications the Dock icon follows the window", () => {
  const { host, log, current } = fakeApp({ follow: true });
  let closes = 0;
  const w = createWindowManager(host, { onClosed: () => closes++ });
  // Regular before the window opens, so it comes up with a Dock icon and Cmd-Tab.
  w.show();
  assertEquals(log, ["policy:regular", "open:window-1", "show:window-1", "focus:window-1"]);
  // Bringing the open one up again keeps it regular.
  log.length = 0;
  w.show();
  assertEquals(log, ["policy:regular", "show:window-1", "focus:window-1"]);
  // The window closed (its close button, Cmd+W, a quit closed to the tray): accessory again.
  log.length = 0;
  current()!.close();
  assertEquals(log, ["close:window-1", "policy:accessory"]);
  assertEquals(closes, 1);
  // The launch's hidden window closed at startup: accessory (it already is; harmless).
  const launch = fakeApp({ launch: true, follow: true });
  createWindowManager(launch.host).closeHidden();
  assertEquals(launch.log, ["close:main", "policy:accessory"]);
});

Deno.test("window manager: outside /Applications a window that can't open goes back to accessory", () => {
  const { host, log } = fakeApp({ follow: true, openFails: true });
  const w = createWindowManager(host);
  let threw = false;
  try {
    w.show();
  } catch {
    threw = true;
  }
  assert(threw);
  assertEquals(log, ["policy:regular", "policy:accessory"]);
});

Deno.test("tray menu: open/close, the summary as a disabled item, toggles, quit", () => {
  const m = trayMenu({
    windowVisible: false,
    summary: "2 running · 1 queued",
    notificationsPaused: true,
    startAtLogin: true,
  });
  assertEquals(m, [
    { id: MENU.toggle, label: "Open Fleet" },
    { id: MENU.summary, label: "2 running · 1 queued", disabled: true },
    { separator: true },
    { id: MENU.settings, label: "Settings…" },
    { id: MENU.pause, label: "Pause notifications", checked: true },
    { id: MENU.login, label: "Start at login", checked: true },
    { id: MENU.refresh, label: "Refresh now" },
    { separator: true },
    { id: MENU.quit, label: "Quit Fleet" },
  ]);
  assertEquals(
    trayMenu({ windowVisible: true, summary: "x", notificationsPaused: false, startAtLogin: null })
      .map((i) => "id" in i ? i.id : "-"),
    [MENU.toggle, MENU.summary, "-", MENU.settings, MENU.pause, MENU.refresh, "-", MENU.quit],
  );
  assertEquals(
    (trayMenu({
      windowVisible: true,
      summary: "x",
      notificationsPaused: false,
      startAtLogin: null,
    })[0] as { label: string }).label,
    "Close Fleet",
  );
  assertEquals(INITIAL_MENU[1], { id: MENU.summary, label: "Starting…", disabled: true });
  assertEquals(summaryLine(snap({ auth: "needs-token" })), "Sign in to GitHub");
  assertEquals(summaryLine(snap()), "2 running · 1 queued");
});

Deno.test("tray: click opens / closes the window; menu items reach their actions; the menu follows", async () => {
  const { host, current } = fakeApp();
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
    openSettings: () => void calls.push("settings"),
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
  assertEquals(menuOf()[0].label, "Open Fleet");
  assertEquals(menuOf()[1].label, "2 running · 1 queued");
  t.click();
  assert(current()?.visible);
  assertEquals(menuOf()[0].label, "Close Fleet");
  t.choose(MENU.toggle);
  assertEquals(current(), undefined, "closed, not hidden");
  assertEquals(menuOf()[0].label, "Open Fleet");
  // The window closed by its own close button: the menu follows through the manager's onChange.
  t.choose(MENU.toggle);
  assertEquals(menuOf()[0].label, "Close Fleet");
  current()!.close();
  d.refreshMenu();
  assertEquals(menuOf()[0].label, "Open Fleet");
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
    openSettings: () => {},
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

Deno.test("start at login: opt-in; never turned on by itself; states", async () => {
  const calls: string[] = [];
  let state = "disabled";
  const api = {
    get: () => Promise.resolve((calls.push("get"), state)),
    set: (on: boolean) =>
      Promise.resolve((calls.push(`set:${on}`), state = on ? "enabled" : "disabled")),
  };
  // Reading it (every launch) never sets it.
  assertEquals(await readLoginItem(api), false);
  assertEquals(calls, ["get"]);
  // Only an explicit choice does.
  assertEquals(await setLoginItem(api, true), true);
  assertEquals(calls, ["get", "set:true"]);
  assertEquals(await readLoginItem(undefined), null);
  assertEquals(await setLoginItem(undefined, true), null);
  const broken = {
    get: () => Promise.reject(new Error("x")),
    set: () => Promise.reject(new Error("x")),
  };
  assertEquals(await readLoginItem(broken), null);
  assertEquals(await setLoginItem(broken, false), null);
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

Deno.test("tray: a window that can't open is reported, the tray carries on", () => {
  const { host } = fakeApp({ openFails: true });
  const t = fakeTray();
  const errors: unknown[] = [];
  const calls: string[] = [];
  driveTray(t.tray, ICONS, createWindowManager(host), {
    refresh: () => Promise.resolve(void calls.push("refresh")),
    setNotificationsPaused: () => Promise.resolve(),
    setStartAtLogin: () => Promise.resolve(null),
    openSettings: () => {},
    quit: () => {},
  }, (err) => errors.push(err));
  t.click();
  t.choose(MENU.toggle);
  assertEquals(errors.length, 2);
  t.choose(MENU.refresh);
  assertEquals(calls, ["refresh"]);
});

Deno.test("notification clicks: only Fleet's own notifications open the window", async () => {
  const { isFleetNotificationClick, NOTIFICATION_TAG_PREFIX } = await import(
    "../lib/deno-host.ts"
  );
  assertEquals(NOTIFICATION_TAG_PREFIX, "fleet-");
  assert(isFleetNotificationClick({ tag: "fleet-pool:mac-arm" }));
  assertFalse(isFleetNotificationClick({ tag: "denext-web-1" }));
  assertFalse(isFleetNotificationClick({ tag: 3 }));
  assertFalse(isFleetNotificationClick({}));
  assertFalse(isFleetNotificationClick(null));
});
