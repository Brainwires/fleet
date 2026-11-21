// Entry for `deno desktop`: serves the static export in `out/`, runs the `fleet` extension (the
// GitHub poller, desktop/fleet.ts) in this process, and drives the tray from here (lib/tray-driver.ts),
// so the tray keeps its count, menu and notifications with no window open. Fleet lives in the tray:
// the launch's window starts hidden and is shown on the first launch or when Fleet needs a token,
// else closed; the close button closes the window for good (`desktop.app.keepAlive` keeps the app
// up with none: denext's src/desktop/app-windows.ts `applyKeepAlive` turns the runtime's
// `quitOnLastWindowClosed` off, and window-registry.ts `closed` ends the app only without it), and
// the tray, a reopen, a second launch or a notification click opens a fresh one. Only the tray's
// Quit quits: any other quit (the Dock's Quit, Cmd+Q, `osascript … quit`) closes the window and
// leaves Fleet in the tray (lib/quit-guard.ts); the OS's session end always quits. On macOS Fleet
// stays accessory, and denext's Dock helper shows a Dock icon while the window is open
// (desktop.app.dock "while-window-open" in denext.config.ts).
// The window also shows until the first-run wizard is done, and the tray's Settings… opens it on the
// Settings view. Start at login is opt-in: set only when the settings change it.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { cancelUpdateRun, fleetService, onUpdatesTray, showUpdatesPanel } from "./desktop/fleet.ts";
import { trayIcons } from "./lib/icons.ts";
import type { Snapshot } from "./lib/model.ts";
import { onNotificationClick } from "./lib/deno-host.ts";
import { createQuitGuard } from "./lib/quit-guard.ts";
import {
  createWindowManager,
  driveTray,
  type FleetWindow,
  type LoginItemApi,
  readLoginItem,
  setLoginItem,
  type TrayDriver,
  WINDOW_KEY,
  type WindowManager,
} from "./lib/tray-driver.ts";
import type { FleetService } from "./lib/service.ts";

/** A reopened window's size before it has a saved frame, and its smallest (desktop.window's). */
const WINDOW_SIZE = { width: 1320, height: 860 } as const;
const MIN_SIZE = { width: 860, height: 560 } as const;

/** What runtime events reach before it exists: the window manager, the backend service. */
const late: { windows?: WindowManager; service?: FleetService; hasTray?: boolean } = {};
/** Open Fleet's window (or bring it up) from a runtime event; a failure is logged. */
const openWindow = () => {
  try {
    late.windows?.show();
  } catch (err) {
    console.error("fleet: window:", err instanceof Error ? err.message : "error");
  }
};

/** Which quits quit: the tray's Quit and the session end; any other closes to the tray. */
const quitGuard = createQuitGuard({
  closeWindows: () => late.windows?.close(),
  hasTray: () => late.hasTray === true,
  later: (fn) => void setTimeout(fn, 0),
});
// Each quit's reason (`"session-end"` for logout / restart / shut down), for the guard. Added before
// runDesktop, so it runs before denext's own `beforequit` listener asks the guards.
(Deno as unknown as {
  desktop?: { addEventListener?(type: string, fn: (e: Event) => void): void };
}).desktop?.addEventListener?.("beforequit", (e) => {
  quitGuard.noteQuitEvent((e as Event & { reason?: unknown }).reason);
});

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
  // A reopen (a Dock click, or Fleet opened again from Finder or Launchpad while it runs) and a
  // second launch (singleInstance): Fleet's window, through the manager (close tracking), so the
  // runtime opens nothing itself.
  onDockReopen: () => (openWindow(), undefined),
  onSecondInstance: () => (openWindow(), undefined),
});

/** The runtime's own pieces, feature-detected (newer denext / runtime versions). */
const runtime = app as typeof app & { quit?: () => Promise<boolean> };
const desktopApi = (Deno as unknown as {
  desktop?: { launchAtLogin?: LoginItemApi; quit?: () => void };
}).desktop;

/** Fleet's own quit (the tray's Quit; closing the window with no tray): the guard lets it go. */
const quit = () => {
  quitGuard.beginIntendedQuit();
  if (runtime.quit) {
    void runtime.quit().then((quitting) => {
      if (!quitting) quitGuard.endIntendedQuit();
    }, () => quitGuard.endIntendedQuit());
  } else desktopApi?.quit?.();
};
late.hasTray = app.tray != null;
app.onBeforeQuit(() => quitGuard.guard());

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
// A click on a Fleet Notifier notification (lib/notifier.ts) runs `open -b <Fleet's id> --args
// --show-window`: a running Fleet gets a reopen (onDockReopen), a stopped one starts with the flag.
if (Deno.args.includes("--show-window")) openWindow();

const fleet = await fleetService();
late.service = fleet;

// Start at login follows the settings, applied only when they change it (never at launch). The
// tray's own toggle sets the OS first, then records it (`fromTray`): not set twice.
let fromTray = false;
fleet.onSettings((next, previous) => {
  if (fromTray || next.startAtLogin === previous.startAtLogin) return;
  void setLoginItem(desktopApi?.launchAtLogin, next.startAtLogin).then((on) => {
    if (tray) {
      tray.startAtLogin = on;
      tray.refreshMenu();
    }
  });
});

if (app.tray) {
  // Per OS: a macOS template (black + alpha; status by shape), Windows / Linux colour art.
  const icons = await trayIcons(Deno.build.os);
  tray = driveTray(app.tray, icons, manager, {
    refresh: () => fleet.refresh(),
    openSettings: () => {
      fleet.requestSettings();
      openWindow();
    },
    setNotificationsPaused: (p) => fleet.setNotificationsPaused(p),
    openUpdates: () => {
      openWindow();
      showUpdatesPanel();
    },
    cancelUpdate: (runId) => cancelUpdateRun(runId),
    setStartAtLogin: async (on) => {
      const state = await setLoginItem(desktopApi?.launchAtLogin, on);
      // Kept in the settings, so the Settings view agrees (the change itself is already made).
      if (state !== null && fleet.settings().startAtLogin !== state) {
        fromTray = true;
        try {
          await fleet.saveSettings({ ...fleet.settings(), startAtLogin: state });
        } finally {
          fromTray = false;
        }
      }
      return state;
    },
    quit,
  }, (err) => console.error("fleet: tray:", err instanceof Error ? err.name : "error"));
  fleet.onChange((snap) => tray!.update(snap));
  tray.update(fleet.snapshot());
  // Machine updates: one menu line while a machine needs updates or a run is in flight.
  onUpdatesTray((u) => tray!.setUpdates(u));
} else {
  // No tray host (stock GNOME without the AppIndicator extension): the window is the only way in.
  openWindow();
}

// Once the token lookup is done: show the window while Fleet isn't set up (the first-run wizard) or
// needs a token, else close the launch's hidden window (nothing stays hidden: Fleet runs in the tray
// alone). The menu's start-at-login checkmark is the OS's state.
let decided = false;
const decide = async (snap: Snapshot) => {
  if (decided || snap.auth === "pending") return;
  decided = true;
  const prefs = fleet.prefs();
  if (snap.setupComplete === false || snap.auth === "needs-token" || snap.auth === "invalid") {
    openWindow();
  } else if (tray) manager.closeHidden();
  if (!prefs.launched) await fleet.setPrefs({ launched: true });
  const login = await readLoginItem(desktopApi?.launchAtLogin);
  if (tray) {
    tray.startAtLogin = login;
    tray.refreshMenu();
  }
};
fleet.onChange((snap) => void decide(snap));
void decide(fleet.snapshot());
