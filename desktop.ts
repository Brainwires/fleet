// Entry for `deno desktop`: serves the static export in `out/`, runs the `fleet` extension (the
// GitHub poller, desktop/fleet.ts) in this process, and drives the tray from here (lib/tray-driver.ts),
// so the tray keeps its count, menu and notifications with no window open. Fleet lives in the tray:
// the launch's window starts hidden and is shown on the first launch or when Fleet needs a token,
// else closed; the close button closes the window for good (`desktop.app.keepAlive` keeps the app
// up with none: denext's src/desktop/app-windows.ts `applyKeepAlive` turns the runtime's
// `quitOnLastWindowClosed` off, and window-registry.ts `closed` ends the app only without it), and
// the tray, the Dock, a second launch or a notification click opens a fresh one. Only Quit quits.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { fleetService } from "./desktop/fleet.ts";
import { trayIcons } from "./lib/icons.ts";
import type { Snapshot } from "./lib/model.ts";
import { onNotificationClick } from "./lib/deno-host.ts";
import {
  createWindowManager,
  driveTray,
  ensureLoginDefault,
  type FleetWindow,
  type LoginItemApi,
  loginOn,
  type TrayDriver,
  WINDOW_KEY,
  type WindowManager,
} from "./lib/tray-driver.ts";
import type { FleetService } from "./lib/service.ts";

/** A reopened window's size before it has a saved frame, and its smallest (desktop.window's). */
const WINDOW_SIZE = { width: 1320, height: 860 } as const;
const MIN_SIZE = { width: 860, height: 560 } as const;

/** What runtime events reach before it exists: the window manager, the backend service. */
const late: { windows?: WindowManager; service?: FleetService } = {};
/** Open Fleet's window (or bring it up) from a runtime event; a failure is logged. */
const openWindow = () => {
  try {
    late.windows?.show();
  } catch (err) {
    console.error("fleet: window:", err instanceof Error ? err.message : "error");
  }
};

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  // A Dock click with no window showing, and a second launch (singleInstance): Fleet's window,
  // through the manager (Dock icon, close tracking), so the runtime opens nothing itself.
  onDockReopen: () => (openWindow(), undefined),
  onSecondInstance: () => (openWindow(), undefined),
});

/** The runtime's own pieces, feature-detected (newer denext / runtime versions). */
const runtime = app as typeof app & { quit?: () => Promise<boolean> };
const desktopApi = (Deno as unknown as {
  desktop?: { launchAtLogin?: LoginItemApi; quit?: () => void };
}).desktop;

const quit = () => {
  if (runtime.quit) void runtime.quit();
  else desktopApi?.quit?.();
};

let tray: TrayDriver | undefined;
const manager = createWindowManager({
  find: () => app.windows.byKey(WINDOW_KEY),
  open: () => {
    const w = app.windows.open({
      url: "/",
      key: WINDOW_KEY,
      title: "Fleet",
      defaultWidth: WINDOW_SIZE.width,
      defaultHeight: WINDOW_SIZE.height,
    });
    // desktop.minSize is the launch window's only: the same floor for a reopened one.
    const native = w.window as { setMinimumSize?(width: number, height: number): void } | null;
    try {
      native?.setMinimumSize?.(MIN_SIZE.width, MIN_SIZE.height);
    } catch { /* a runtime without it */ }
    return w satisfies FleetWindow;
  },
  setActivationPolicy: (p) => app.setActivationPolicy(p),
}, {
  onChange: () => tray?.refreshMenu(),
  // No page reads now: the backend polls at the hidden rate until a window opens again. With no
  // tray (no tray host) nothing could open one again: closing the window quits.
  onClosed: () => {
    late.service?.visibility(false);
    if (!app.tray) quit();
  },
});
late.windows = manager;
// A click on one of Fleet's notifications (the one that launched it too) opens the window.
onNotificationClick(openWindow);

const fleet = await fleetService();
late.service = fleet;

if (app.tray) {
  // Per OS: a macOS template (black + alpha; status by shape), Windows / Linux colour art.
  const icons = await trayIcons(Deno.build.os);
  tray = driveTray(app.tray, icons, manager, {
    refresh: () => fleet.refresh(),
    setNotificationsPaused: (p) => fleet.setNotificationsPaused(p),
    setStartAtLogin: async (on) => {
      const api = desktopApi?.launchAtLogin;
      return api ? loginOn(await api.set(on)) : null;
    },
    quit,
  }, (err) => console.error("fleet: tray:", err instanceof Error ? err.name : "error"));
  fleet.onChange((snap) => tray!.update(snap));
  tray.update(fleet.snapshot());
} else {
  // No tray host (stock GNOME without the AppIndicator extension): the window is the only way in.
  openWindow();
}

// Once the token lookup is done: show the window on the first launch or when a token is needed,
// else close the launch's hidden window (nothing stays hidden: Fleet runs in the tray alone), and
// turn start at login on the first time (the user wants Fleet always running).
let decided = false;
const decide = async (snap: Snapshot) => {
  if (decided || snap.auth === "pending") return;
  decided = true;
  const prefs = fleet.prefs();
  if (!prefs.launched || snap.auth === "needs-token" || snap.auth === "invalid") openWindow();
  else if (tray) manager.closeHidden();
  if (!prefs.launched) await fleet.setPrefs({ launched: true });
  const login = await ensureLoginDefault(
    desktopApi?.launchAtLogin,
    prefs.loginDefaulted === true,
    () => fleet.setPrefs({ loginDefaulted: true }),
  );
  if (tray) {
    tray.startAtLogin = login;
    tray.refreshMenu();
  }
};
fleet.onChange((snap) => void decide(snap));
void decide(fleet.snapshot());
