// Whether Fleet's window may give it a Dock icon (macOS), decided once at launch from where the app
// bundle really lives. The Dock records an unpinned app in "Recent applications" when its running
// tile goes away (on quit, or on switching back to accessory) only when the bundle's resolved path
// is under /Applications (measured on macOS 15 and 26; nested bundles and symlink targets
// included). So:
//
// - installed under /Applications: Fleet stays accessory for its whole life (no Dock icon, no
//   Cmd-Tab), so it never lands in Recents;
// - anywhere else (~/Applications, a dev build's temp folder): "regular" while Fleet's window is
//   open (a Dock icon and Cmd-Tab), "accessory" once it closed; nothing is left in Recents.
//
// The proper fix for any location is a separate window-helper app (denext's macOS window helper).
// No Deno APIs: the caller passes the executable path and a realpath, so the tests inject both.

/** How Fleet's activation policy follows its window. */
export type DockMode =
  /** "regular" while the window is open, "accessory" with none (not under /Applications). */
  | "follow-window"
  /** Accessory always (installed under /Applications, off macOS, or the path is unknown). */
  | "accessory";

/**
 * The outermost `.app` bundle in an executable's path (`/x/Fleet.app/Contents/MacOS/Fleet` →
 * `/x/Fleet.app`), or `null` when it is in none (a dev run from a plain folder).
 */
export function appBundleOf(execPath: string): string | null {
  const parts = execPath.split("/");
  const i = parts.findIndex((p) => p.toLowerCase().endsWith(".app"));
  if (i <= 0) return null;
  return parts.slice(0, i + 1).join("/");
}

/** Whether a resolved path is under /Applications (any depth; the Data volume's alias too). */
export function underApplications(path: string): boolean {
  const p = path.toLowerCase();
  return p.startsWith("/applications/") || p.startsWith("/system/volumes/data/applications/");
}

/**
 * Fleet's Dock mode: on macOS, `"follow-window"` unless the app bundle (resolved through every
 * symlink) is under /Applications. A path that can't be read or resolved counts as under
 * /Applications: accessory always, which never leaves a Recents entry.
 *
 * @param os `Deno.build.os`.
 * @param execPath `Deno.execPath()`, or a function that reads it (may throw without permission).
 * @param realPath `Deno.realPathSync` (throws for a path that doesn't exist).
 */
export function dockMode(
  os: string,
  execPath: string | (() => string),
  realPath: (path: string) => string,
): DockMode {
  if (os !== "darwin") return "accessory";
  try {
    const exe = typeof execPath === "function" ? execPath() : execPath;
    const resolved = realPath(appBundleOf(exe) ?? exe);
    return underApplications(resolved) ? "accessory" : "follow-window";
  } catch {
    return "accessory";
  }
}
