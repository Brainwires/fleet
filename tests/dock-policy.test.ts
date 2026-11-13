// Where Fleet is installed decides whether its window brings a Dock icon (lib/dock-policy.ts): under
// /Applications (the bundle resolved through symlinks) accessory always, so no Recents entry;
// anywhere else the icon follows the window. Paths and realpaths are injected.

import "./fixture-settings.ts";

import { assertEquals } from "@std/assert";
import { appBundleOf, dockMode, underApplications } from "../lib/dock-policy.ts";

const EXE = (bundle: string) => `${bundle}/Contents/MacOS/Fleet`;
/** A realpath over a symlink table (exact paths); unknown paths resolve to themselves. */
const realPathOf = (links: Record<string, string> = {}) => (p: string) => links[p] ?? p;

Deno.test("dock policy: the outermost .app in the executable's path", () => {
  assertEquals(appBundleOf(EXE("/Applications/Fleet.app")), "/Applications/Fleet.app");
  assertEquals(
    appBundleOf("/Users/u/Applications/Fleet.app/Contents/Helpers/W.app/Contents/MacOS/W"),
    "/Users/u/Applications/Fleet.app",
  );
  assertEquals(appBundleOf("/var/folders/x/T/denext-desktop/Fleet"), null);
});

Deno.test("dock policy: under /Applications at any depth, the Data volume too", () => {
  assertEquals(underApplications("/Applications/Fleet.app"), true);
  assertEquals(underApplications("/Applications/Tools/Fleet.app"), true);
  assertEquals(underApplications("/System/Volumes/Data/Applications/Fleet.app"), true);
  assertEquals(underApplications("/Users/u/Applications/Fleet.app"), false);
  assertEquals(underApplications("/ApplicationsX/Fleet.app"), false);
});

Deno.test("dock policy: installed under /Applications → accessory always (no Recents entry)", () => {
  assertEquals(dockMode("darwin", EXE("/Applications/Fleet.app"), realPathOf()), "accessory");
  // ~/Applications/Fleet.app a symlink to the /Applications copy: the resolved path counts.
  assertEquals(
    dockMode(
      "darwin",
      EXE("/Users/u/Applications/Fleet.app"),
      realPathOf({ "/Users/u/Applications/Fleet.app": "/Applications/Fleet.app" }),
    ),
    "accessory",
  );
});

Deno.test("dock policy: anywhere else → the Dock icon follows the window", () => {
  assertEquals(
    dockMode("darwin", EXE("/Users/u/Applications/Fleet.app"), realPathOf()),
    "follow-window",
  );
  // A /Applications path that resolves elsewhere (a symlink out of it) follows the window.
  assertEquals(
    dockMode(
      "darwin",
      EXE("/Applications/Fleet.app"),
      realPathOf({ "/Applications/Fleet.app": "/Users/u/Applications/Fleet.app" }),
    ),
    "follow-window",
  );
  // A dev run outside any bundle: the executable itself.
  assertEquals(dockMode("darwin", "/tmp/denext/Fleet", realPathOf()), "follow-window");
});

Deno.test("dock policy: off macOS, or a path that can't be read, stays accessory", () => {
  assertEquals(dockMode("windows", "C:\\Fleet\\Fleet.exe", realPathOf()), "accessory");
  assertEquals(dockMode("linux", "/opt/fleet/Fleet", realPathOf()), "accessory");
  const denied = () => {
    throw new Error("NotCapable");
  };
  assertEquals(dockMode("darwin", denied, realPathOf()), "accessory");
  assertEquals(dockMode("darwin", EXE("/Users/u/Applications/Fleet.app"), denied), "accessory");
  // A function for the executable path is read lazily.
  assertEquals(
    dockMode("darwin", () => EXE("/Users/u/Applications/Fleet.app"), realPathOf()),
    "follow-window",
  );
});
