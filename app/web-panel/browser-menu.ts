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

import type { AppMenuItem } from "denext/desktop/app";
import type { BrowserCommand, BrowserControls, BrowserState } from "./github-browser.ts";

export const MENU_BACK = "fleet-browser-back";
export const MENU_FORWARD = "fleet-browser-forward";

/** The app menu's surface (denext/desktop/app). */
export interface AppMenuApi {
  setAppMenu(menu: readonly AppMenuItem[]): Promise<void>;
  onAppMenuItem(handler: (id: string) => void): () => void;
}

/** The menu for `state`. */
export function browserMenu(
  state: Pick<BrowserState, "open" | "canGoBack" | "canGoForward" | "canReturn">,
  mac: boolean,
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
  return mac ? [{ label: "Fleet", submenu: [{ role: "hide" }] }, edit, go] : [edit, go];
}

/**
 * Keep the app menu in step with `browser`: set on the panel's first open, re-set when Back /
 * Forward change, their clicks and accelerators run the browser's commands. Returns the stop.
 */
export function connectBrowserMenu(
  browser: BrowserControls,
  api: AppMenuApi,
  mac: boolean,
): () => void {
  let installed = false;
  let lastKey = "";
  let stopItems: (() => void) | null = null;
  const sync = (s: BrowserState) => {
    if (!installed && !s.open) return;
    const menu = browserMenu(s, mac);
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
        if (cmd) browser.command(cmd, "menu");
      });
    }
    void api.setAppMenu(menu).catch((err) => {
      lastKey = "";
      console.error("fleet: app menu:", err instanceof Error ? err.message : String(err));
    });
  };
  const unsubscribe = browser.subscribe(sync);
  return () => {
    unsubscribe();
    stopItems?.();
  };
}
