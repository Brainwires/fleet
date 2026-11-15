// The window's own shortcuts. While Fleet is accessory on macOS (no Dock icon, no menu bar) no app
// menu of its own answers Cmd+W. The host's built-in menu still answers the editing shortcuts
// (Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z, sent to the page's focused field) while the app sets no
// menu; the page closes the window on Cmd+W and on Cmd+Q itself, so both work however the host
// routes them. Cmd+Q closes to the tray, like the Dock's Quit (lib/quit-guard.ts): only the tray's
// "Quit Fleet" ends Fleet. No Deno or DOM APIs: the tests call it with plain objects.

/** What a key press asks of the window. */
export type WindowShortcut = "close";

/** The parts of a `KeyboardEvent` the shortcuts read. */
export interface ShortcutKey {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

/**
 * The window shortcut a key press is, on macOS only (Cmd is the Meta key there; elsewhere Meta is
 * the OS's own key): Cmd+W and Cmd+Q close the window (Fleet stays in the tray). Any other modifier
 * with them is not one.
 */
export function windowShortcut(e: ShortcutKey, mac: boolean): WindowShortcut | null {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  return key === "w" || key === "q" ? "close" : null;
}

/** What a key press asks of the in-app GitHub browser (app/web-panel/github-browser.ts). */
export type BrowserShortcut = "back" | "forward" | "home";

/**
 * The browser shortcut a key press is, while the GitHub panel shows: Cmd+[ / Cmd+] (Ctrl+[ /
 * Ctrl+] off macOS) go back / forward, and Esc returns to Fleet's view. Fleet's page sees these
 * only while the keyboard is in its own HTML; with the web view focused, the app menu's
 * accelerators carry back / forward (app/web-panel/browser-menu.ts) and Esc stays GitHub's.
 */
export function browserShortcut(e: ShortcutKey, mac: boolean): BrowserShortcut | null {
  if (e.key === "Escape") {
    return e.metaKey || e.ctrlKey || e.altKey || e.shiftKey ? null : "home";
  }
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey || e.shiftKey) return null;
  return e.key === "[" ? "back" : e.key === "]" ? "forward" : null;
}
