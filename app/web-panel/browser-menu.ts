// The app menu behind the GitHub browser's back / forward keys. While the native web view has the
// keyboard, Fleet's page sees no key presses; app-menu accelerators still fire, so Back (Cmd+[) and
// Forward (Cmd+]) are menu items (CommandOrControl: Ctrl off macOS). Esc is not one: an accelerator
// would take Esc from GitHub's own dialogs and menus, so Esc returns to Fleet only from Fleet's page.
//
// Back is enabled while the panel can step back or return to the Fleet screen the link came from.
// Fleet sets no menu until the panel first opens (until then the host's default menu stays, as
// before). The menu it sets keeps the editing roles that default menu carried (copy, paste, …, for
// Fleet's fields and GitHub's page alike). The items are enabled only while the panel shows and its
// history allows, so the keys reach the focused page otherwise.
//
// With the window zoom (lib/zoom.ts) connected, the menu is set at once (not on the panel's first
// open) and carries a View submenu (Actual Size, Zoom In, Zoom Out) between Edit and Go, re-set as
// the level reaches a bound.

import type { AppMenuItem } from "denext/desktop/app";
import type { BrowserCommand, BrowserControls, BrowserState } from "./github-browser.ts";
import { type ZoomAction, zoomMenu, zoomMenuAction } from "../../lib/zoom.ts";

export const MENU_BACK = "fleet-browser-back";
export const MENU_FORWARD = "fleet-browser-forward";

/** The app menu's surface (denext/desktop/app). */
export interface AppMenuApi {
  setAppMenu(menu: readonly AppMenuItem[]): Promise<void>;
  onAppMenuItem(handler: (id: string) => void): () => void;
}

/** The window zoom the menu shows and drives (lib/zoom.ts ZoomController). */
export interface MenuZoom {
  readonly level: number;
  subscribe(fn: (pct: number) => void): () => void;
  zoom(action: ZoomAction, source: "page" | "menu"): void;
}

/** The menu for `state` (with a View submenu at `zoom` percent when given). */
export function browserMenu(
  state: Pick<BrowserState, "open" | "canGoBack" | "canGoForward" | "canReturn">,
  mac: boolean,
  zoom?: number,
): AppMenuItem[] {
  const edit: AppMenuItem = {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      "separator",
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
    ],
  };
  const go: AppMenuItem = {
    label: "Go",
    submenu: [
      {
        id: MENU_BACK,
        label: "Back",
        accelerator: "CommandOrControl+[",
        disabled: !(state.open && (state.canGoBack || state.canReturn)),
      },
      {
        id: MENU_FORWARD,
        label: "Forward",
        accelerator: "CommandOrControl+]",
        disabled: !(state.open && state.canGoForward),
      },
    ],
  };
  // macOS makes the first submenu the application menu (not shown: Fleet is an accessory app).
  const middle: AppMenuItem[] = zoom === undefined ? [edit] : [edit, zoomMenu(zoom)];
  return mac ? [{ label: "Fleet", submenu: [{ role: "hide" }] }, ...middle, go] : [...middle, go];
}

/**
 * Keep the app menu in step with `browser`: set on the panel's first open (at once with `zoom`),
 * re-set when Back / Forward (or the zoom's bounds) change, their clicks and accelerators run the
 * browser's commands (and the zoom's). Returns the stop.
 */
export function connectBrowserMenu(
  browser: BrowserControls,
  api: AppMenuApi,
  mac: boolean,
  zoom?: MenuZoom,
): () => void {
  let installed = false;
  let lastKey = "";
  let stopItems: (() => void) | null = null;
  type MenuState = Pick<BrowserState, "open" | "canGoBack" | "canGoForward" | "canReturn">;
  let current: MenuState = { open: false, canGoBack: false, canGoForward: false, canReturn: false };
  const sync = (s: MenuState) => {
    current = s;
    if (!installed && !s.open && !zoom) return;
    const menu = browserMenu(s, mac, zoom?.level);
    const key = JSON.stringify(menu);
    if (key === lastKey) return;
    lastKey = key;
    if (!installed) {
      installed = true;
      stopItems = api.onAppMenuItem((id) => {
        const cmd: BrowserCommand | null = id === MENU_BACK
          ? "back"
          : id === MENU_FORWARD
          ? "forward"
          : null;
        if (cmd) return browser.command(cmd, "menu");
        const z = zoom ? zoomMenuAction(id) : null;
        if (z) zoom!.zoom(z, "menu");
      });
    }
    void api.setAppMenu(menu).catch((err) => {
      lastKey = "";
      console.error("fleet: app menu:", err instanceof Error ? err.message : String(err));
    });
  };
  const unsubscribe = browser.subscribe(sync);
  const unsubscribeZoom = zoom?.subscribe(() => sync(current));
  if (zoom) sync(current);
  return () => {
    unsubscribe();
    unsubscribeZoom?.();
    stopItems?.();
  };
}
