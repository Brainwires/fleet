// The tray-resident app, driven from the app's process (desktop.ts), never from a page: a hidden
// window's page may be suspended (macOS), so it couldn't answer the tray. Like examples/hangar in
// denext: an accessory app (no Dock icon) while only the tray runs, a regular one while the window
// shows; a click on the icon toggles the window; the menu shows/hides it, shows the summary,
// pauses notifications, toggles start at login, polls now and quits.
//
// No Deno or DOM APIs: it works over slices of denext's DesktopRuntime, so the tests use fakes.

import type { Snapshot } from "./model.ts";
import { trayText } from "./snapshot.ts";

/** The menu's item ids. */
export const MENU = {
  toggle: "toggle",
  summary: "summary",
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
    { id: MENU.toggle, label: s.windowVisible ? "Hide Fleet" : "Show Fleet" },
    { id: MENU.summary, label: s.summary, disabled: true },
    { separator: true },
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
  if (snap.auth === "needs-token" || snap.auth === "invalid") return "Sign in to GitHub";
  if (snap.auth === "pending") return "Starting…";
  return `${snap.summary.running} running · ${snap.summary.queued} queued`;
}

/** The main window, as `DesktopRuntime.windows.get("main")` hands it. */
export interface FleetWindow {
  readonly visible: boolean;
  show(): void;
  hide(): void;
  focus(): void;
}

/** The slice of `DesktopRuntime` the window manager uses. */
export interface WindowHost {
  main(): FleetWindow | undefined;
  setActivationPolicy(policy: "regular" | "accessory"): boolean;
}

/** Show / hide the main window, with the Dock icon following it (macOS). */
export interface WindowManager {
  show(): void;
  hide(): void;
  toggle(): void;
  readonly visible: boolean;
}

/** The window manager. */
export function createWindowManager(
  host: WindowHost,
  onChange: () => void = () => {},
): WindowManager {
  const m = {
    show() {
      const w = host.main();
      if (!w) return;
      // Regular first: a Dock icon, and the app comes to the front.
      host.setActivationPolicy("regular");
      w.show();
      w.focus();
      onChange();
    },
    hide() {
      host.main()?.hide();
      host.setActivationPolicy("accessory");
      onChange();
    },
    toggle() {
      if (m.visible) m.hide();
      else m.show();
    },
    get visible() {
      return host.main()?.visible === true;
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
  /** Rebuild the menu now (the window was shown or hidden elsewhere). */
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
  const offs = [
    tray.onClick(() => {
      windows.toggle();
      syncMenu();
    }),
    tray.onMenuItem((id) => {
      if (id === MENU.toggle) windows.toggle();
      else if (id === MENU.refresh) void actions.refresh().catch(onError);
      else if (id === MENU.pause) {
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
      const tip = snap.auth === "needs-token" || snap.auth === "invalid"
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

/**
 * The close guard's answer: `true` lets the close go through (a real quit: Cmd+Q, the tray's
 * Quit, logout), `false` keeps the app and hides the window instead (the close button).
 */
export function allowClose(reason: string): boolean {
  return reason === "quit";
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
 * Start at login, defaulting ON at the first run (the user wants Fleet always running): once
 * `defaulted` is set it's never forced again, so the user's "off" sticks.
 *
 * @returns The state after, or `null` without the API.
 */
export async function ensureLoginDefault(
  api: LoginItemApi | undefined,
  defaulted: boolean,
  markDefaulted: () => Promise<void>,
): Promise<boolean | null> {
  if (!api) return null;
  try {
    if (!defaulted) {
      await markDefaulted();
      return loginOn(await api.set(true));
    }
    return loginOn(await api.get());
  } catch {
    return null;
  }
}
