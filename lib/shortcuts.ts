// The window's own shortcuts. Fleet is an accessory app on macOS (no Dock icon, no menu bar), so
// no app menu of its own answers Cmd+W. The host's built-in menu still answers Cmd+Q and the editing
// shortcuts (Cmd+C / Cmd+V / Cmd+X / Cmd+A / Cmd+Z, sent to the page's focused field) while the app
// sets no menu; the page closes the window on Cmd+W and quits on Cmd+Q itself, so both work however
// the host routes them. No Deno or DOM APIs: the tests call it with plain objects.

/** What a key press asks of the window. */
export type WindowShortcut = "close" | "quit";

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
 * the OS's own key): Cmd+W closes the window, Cmd+Q quits. Any other modifier with them is not one.
 */
export function windowShortcut(e: ShortcutKey, mac: boolean): WindowShortcut | null {
  if (!mac || !e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return null;
  const key = e.key.toLowerCase();
  return key === "w" ? "close" : key === "q" ? "quit" : null;
}
