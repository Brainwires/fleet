// The window's own shortcuts (lib/shortcuts.ts): Cmd+W closes and Cmd+Q quits on macOS, where the
// accessory app has no menu bar to own them; nothing elsewhere or with other modifiers.

import "./fixture-settings.ts";

import { assertEquals } from "@std/assert";
import { type ShortcutKey, windowShortcut } from "../lib/shortcuts.ts";

const key = (k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key: k,
  metaKey: true,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

Deno.test("shortcuts: Cmd+W closes the window and Cmd+Q quits, on macOS", () => {
  assertEquals(windowShortcut(key("w"), true), "close");
  assertEquals(windowShortcut(key("W"), true), "close");
  assertEquals(windowShortcut(key("q"), true), "quit");
});

Deno.test("shortcuts: none off macOS, without Cmd, with another modifier, or for other keys", () => {
  assertEquals(windowShortcut(key("w"), false), null);
  assertEquals(windowShortcut(key("w", { metaKey: false, ctrlKey: true }), true), null);
  assertEquals(windowShortcut(key("w", { shiftKey: true }), true), null);
  assertEquals(windowShortcut(key("q", { altKey: true }), true), null);
  // The editing shortcuts stay with the host's Edit menu and the page's fields.
  for (const k of ["c", "v", "x", "a", "z"]) assertEquals(windowShortcut(key(k), true), null);
});
