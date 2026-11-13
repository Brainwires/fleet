// The tray-resident app, driven from the app's process (desktop.ts), never from a page: with no
// window open there is no page to answer the tray. An accessory app (no menu bar) for its whole
// life, its window open or not; while it is open denext's Dock helper (desktop.app.dock
// "while-window-open") shows the Dock icon. An app that was ever regular gets a tile in the Dock's
// recent apps once its running Dock tile goes away (on quit, or on switching back to accessory),
// and macOS has no opt-out. The window comes to the front through its focus(), which activates the
// app without changing the policy. Closing the window destroys it (Fleet stays in the tray), and
// opening makes a fresh one. A click on the icon
// opens / closes the window; the menu opens / closes it, shows the summary, opens the Settings view,
// pauses notifications, toggles start at login, polls now and quits.
//
// No Deno or DOM APIs: it works over slices of denext's DesktopRuntime, so the tests use fakes.

import type { Snapshot } from "./model.ts";
import { trayText } from "./snapshot.ts";

/** The menu's item ids. */
export const MENU = {
  toggle: "toggle",
  summary: "summary",
  settings: "settings",
  pause: "pause-notifications",
  login: "start-at-login",
  refresh: "refresh",
  quit: "quit",
} as const;

/** What the menu shows. */
export interface MenuState {
  readonly windowVisible: boolean;
  /** "N running · M queued", or a sign-in hint. */
  readonly summary: string;
  readonly notificationsPaused: boolean;
  /** `null` where start at login is unavailable (no runtime support). */
  readonly startAtLogin: boolean | null;
}

/** A tray menu entry (denext's AppMenuItem shape). */
export type TrayMenuItem =
  | { id: string; label: string; disabled?: boolean; checked?: boolean }
  | { separator: true };

/** The tray menu for a state. */
export function trayMenu(s: MenuState): TrayMenuItem[] {
  return [
    { id: MENU.toggle, label: s.windowVisible ? "Close Fleet" : "Open Fleet" },
    { id: MENU.summary, label: s.summary, disabled: true },
    { separator: true },
    { id: MENU.settings, label: "Settings…" },
    { id: MENU.pause, label: "Pause notifications", checked: s.notificationsPaused },
    ...(s.startAtLogin === null
      ? []
      : [{ id: MENU.login, label: "Start at login", checked: s.startAtLogin }]),
    { id: MENU.refresh, label: "Refresh now" },
    { separator: true },
    { id: MENU.quit, label: "Quit Fleet" },
  ];
}

/** The menu before the first snapshot (also the config's). */
export const INITIAL_MENU: TrayMenuItem[] = trayMenu({
  windowVisible: false,
  summary: "Starting…",
  notificationsPaused: false,
  startAtLogin: null,
});

/** The tray summary line for a snapshot. */
export function summaryLine(snap: Snapshot): string {
  if (snap.setupComplete === false) return "Set up Fleet";
  if (snap.auth === "needs-token" || snap.auth === "invalid") return "Sign in to GitHub";
  if (snap.auth === "pending") return "Starting…";
  return `${snap.summary.running} running · ${snap.summary.queued} queued`;
}

/**
 * The key of Fleet's one window (`desktop.window.key` for the launch's main window, and
 * `windows.open({ key })` for every window opened after it closed): `windows.byKey` finds whichever
 * is open, and they share one saved frame (the window store's `windows.json`).
 */
export const WINDOW_KEY = "fleet";

/** Fleet's window, as `DesktopRuntime.windows.byKey` / `.open` hand it. */
export interface FleetWindow {
  readonly id: string;
  readonly visible: boolean;
  show(): void;
  focus(): void;
  /** Close it for good (the app stays: `desktop.app.keepAlive`). */
  close(): void;
  onClosed(handler: () => void): () => void;
}

/** The slice of `DesktopRuntime` the window manager uses. */
export interface WindowHost {
  /** The open Fleet window, if any (`windows.byKey(WINDOW_KEY)`). */
  find(): FleetWindow | undefined;
  /** Open a fresh Fleet window (`windows.open({ key: WINDOW_KEY, … })`); throws when it can't. */
  open(): FleetWindow;
  /**
   * Set the macOS activation policy (`DesktopRuntime.setActivationPolicy`) so the Dock icon
   * follows the window. Fleet passes none (denext's Dock helper shows the icon, and Fleet stays
   * accessory); without it the policy is never touched.
   */
  setActivationPolicy?(policy: "regular" | "accessory"): boolean;
}

/** What the window manager tells the app. */
export interface WindowHooks {
  /** A window opened, came to the front or closed (the tray menu follows). */
  onChange?(): void;
  /** Fleet's window closed: none is open now (the page stops reading; the backend polls hidden). */
  onClosed?(): void;
}

/**
 * Open / close Fleet's window. With `host.setActivationPolicy` the Dock icon follows it: "regular"
 * just before a window opens or comes to the front, "accessory" once the last one closed. Without
 * it the policy is never touched (Fleet stays accessory, so it never lands in the Dock's recent
 * apps). show() brings the window up with its focus(), which on macOS activates the app ignoring
 * other apps. Closing destroys the window; the next open is a fresh window whose page rebuilds its
 * state from the backend.
 */
export interface WindowManager {
  /** Open a window, or bring the open one to the front (never a second). */
  show(): void;
  /** Close the open window, if any. */
  close(): void;
  /** Close when showing, else show. */
  toggle(): void;
  /** Close the launch's window if it is still hidden (Fleet started in the tray). */
  closeHidden(): void;
  readonly visible: boolean;
}

/** The window manager. */
export function createWindowManager(host: WindowHost, hooks: WindowHooks = {}): WindowManager {
  /** The ids of the windows whose close is followed. */
  const watched = new Set<string>();
  const changed = () => hooks.onChange?.();
  const watch = (w: FleetWindow) => {
    if (watched.has(w.id)) return;
    watched.add(w.id);
    w.onClosed(() => {
      watched.delete(w.id);
      // The last one gone: no Dock icon while only the tray runs.
      if (!host.find()) host.setActivationPolicy?.("accessory");
      hooks.onClosed?.();
      changed();
    });
  };
  const m: WindowManager = {
    show() {
      // Regular first where the Dock icon follows the window: a Dock icon, and the app comes to
      // the front. Elsewhere focus() brings the window up and makes it key on its own.
      host.setActivationPolicy?.("regular");
      let w = host.find();
      if (!w) {
        try {
          w = host.open();
        } catch (err) {
          host.setActivationPolicy?.("accessory");
          throw err;
        }
      }
      watch(w);
      w.show();
      w.focus();
      changed();
    },
    close() {
      const w = host.find();
      if (!w) return;
      watch(w);
      w.close();
    },
    toggle() {
      if (m.visible) m.close();
      else m.show();
    },
    closeHidden() {
      const w = host.find();
      if (w && !w.visible) m.close();
    },
    get visible() {
      return host.find()?.visible === true;
    },
  };
  return m;
}

/** The slice of the backend tray handle Fleet drives. */
export interface FleetTray {
  update(options: {
    tooltip?: string;
    icon?: Uint8Array;
    iconDark?: Uint8Array | null;
    menu?: readonly unknown[];
  }): void;
  onClick(handler: () => void): () => void;
  onMenuItem(handler: (id: string) => void): () => void;
}

/** The tray's looks per status (lib/icons.ts `trayIcons`, chosen per OS). */
export interface TrayIcons {
  readonly normal: { readonly icon: Uint8Array; readonly iconDark: Uint8Array | null };
  readonly alert: { readonly icon: Uint8Array; readonly iconDark: Uint8Array | null };
}

/** What the tray asks of the app. */
export interface TrayActions {
  refresh(): Promise<void>;
  /** Open the window on the Settings view. */
  openSettings(): void;
  setNotificationsPaused(paused: boolean): Promise<void>;
  /** Turn start at login on / off; resolves the state after (`null`: unavailable). */
  setStartAtLogin(on: boolean): Promise<boolean | null>;
  quit(): void;
}

/** Whether the tray should be red. */
export function trayAlert(snap: Snapshot): boolean {
  return snap.summary.severity === "alert";
}

/** A running tray driver. */
export interface TrayDriver {
  /** Follow a snapshot (tooltip, icon, menu). */
  update(snap: Snapshot): void;
  /** Rebuild the menu now (the window was opened or closed elsewhere). */
  refreshMenu(): void;
  /** The start-at-login state the menu shows. */
  startAtLogin: boolean | null;
  stop(): void;
}

/** Drive the tray. */
export function driveTray(
  tray: FleetTray,
  icons: TrayIcons,
  windows: WindowManager,
  actions: TrayActions,
  onError: (err: unknown) => void = () => {},
): TrayDriver {
  let last: Snapshot | null = null;
  let lastTip = "";
  let lastAlert: boolean | null = null;
  let lastMenu = "";
  const menuNow = () =>
    trayMenu({
      windowVisible: windows.visible,
      summary: last ? summaryLine(last) : "Starting…",
      notificationsPaused: last?.notificationsPaused ?? false,
      startAtLogin: driver.startAtLogin,
    });
  const push = (opts: Parameters<FleetTray["update"]>[0]) => {
    try {
      tray.update(opts);
    } catch (err) {
      onError(err);
    }
  };
  const syncMenu = () => {
    const menu = menuNow();
    const key = JSON.stringify(menu);
    // Only when it changed: a menu replaced while open closes on some platforms.
    if (key !== lastMenu) {
      lastMenu = key;
      push({ menu });
    }
  };
  /** Open / close the window; a window that can't open is reported, the tray carries on. */
  const toggle = () => {
    try {
      windows.toggle();
    } catch (err) {
      onError(err);
    }
  };
  const offs = [
    tray.onClick(() => {
      toggle();
      syncMenu();
    }),
    tray.onMenuItem((id) => {
      if (id === MENU.toggle) toggle();
      else if (id === MENU.refresh) void actions.refresh().catch(onError);
      else if (id === MENU.settings) {
        try {
          actions.openSettings();
        } catch (err) {
          onError(err);
        }
      } else if (id === MENU.pause) {
        void actions.setNotificationsPaused(!(last?.notificationsPaused ?? false)).catch(onError);
      } else if (id === MENU.login) {
        void actions.setStartAtLogin(!(driver.startAtLogin ?? false)).then((on) => {
          driver.startAtLogin = on;
          syncMenu();
        }).catch(onError);
      } else if (id === MENU.quit) actions.quit();
      syncMenu();
    }),
  ];
  const driver: TrayDriver = {
    startAtLogin: null,
    update(snap) {
      last = snap;
      const tip = snap.setupComplete === false
        ? "Fleet: set up"
        : snap.auth === "needs-token" || snap.auth === "invalid"
        ? "Fleet: sign in to GitHub"
        : trayText(snap.summary);
      const alert = trayAlert(snap);
      if (alert !== lastAlert) {
        const look = alert ? icons.alert : icons.normal;
        push({ tooltip: tip, icon: look.icon, iconDark: look.iconDark });
      } else if (tip !== lastTip) {
        push({ tooltip: tip });
      }
      lastTip = tip;
      lastAlert = alert;
      syncMenu();
    },
    refreshMenu: syncMenu,
    stop() {
      for (const off of offs) off();
    },
  };
  return driver;
}

/** The OS's start-at-login switch (`Deno.desktop.launchAtLogin`), as the backend uses it. */
export interface LoginItemApi {
  get(): Promise<string>;
  set(enabled: boolean): Promise<string>;
}

/**
 * The runtime's state as the menu's checkmark: `enabled` (and `requires-approval`, on until the
 * user allows it in System Settings › Login Items) is on, `disabled` off, `not-supported` none.
 */
export function loginOn(state: string): boolean | null {
  if (state === "enabled" || state === "requires-approval") return true;
  if (state === "disabled") return false;
  return null;
}

/**
 * Start at login is opt-in (settings `startAtLogin`, set in the wizard, the Settings view or the
 * tray): nothing turns it on by itself. The OS's state now, for the menu's checkmark.
 *
 * @returns The state, or `null` without the API.
 */
export async function readLoginItem(api: LoginItemApi | undefined): Promise<boolean | null> {
  if (!api) return null;
  try {
    return loginOn(await api.get());
  } catch {
    return null;
  }
}

/** Turn start at login on / off; the state after, or `null` without the API (or on a failure). */
export async function setLoginItem(
  api: LoginItemApi | undefined,
  on: boolean,
): Promise<boolean | null> {
  if (!api) return null;
  try {
    return loginOn(await api.set(on));
  } catch {
    return null;
  }
}
