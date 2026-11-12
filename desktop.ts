// Entry for `deno desktop`: serves the static export in `out/`, runs the `fleet` extension (the
// GitHub poller, desktop/fleet.ts) in this process, and drives the tray from here (lib/tray-driver.ts),
// so the tray keeps its count, menu and notifications while the window is hidden: a hidden window's
// page may be suspended (macOS). Fleet lives in the tray: the window starts hidden (shown on the
// first launch, or when Fleet needs a token), its close button hides it, and only Quit quits.
import config from "./.deno-desktop/config.json" with { type: "json" };
import { resolveDesktopCapabilities, runDesktop } from "denext/desktop";
import { fleetService, setFleetWindows } from "./desktop/fleet.ts";
import { trayIcons } from "./lib/icons.ts";
import type { Snapshot } from "./lib/model.ts";
import {
  createWindowManager,
  driveTray,
  ensureLoginDefault,
  type LoginItemApi,
  loginOn,
  type TrayDriver,
} from "./lib/tray-driver.ts";

const app = await runDesktop({
  importMetaUrl: import.meta.url,
  ...(await resolveDesktopCapabilities(config, { base: import.meta.url })),
});

/** The runtime's own pieces, feature-detected (newer denext / runtime versions). */
const runtime = app as typeof app & {
  quit?: () => Promise<boolean>;
  onSecondInstance?: (fn: () => void) => () => void;
};
const desktopApi = (Deno as unknown as {
  desktop?: { launchAtLogin?: LoginItemApi; quit?: () => void };
}).desktop;

let tray: TrayDriver | undefined;
const windows = createWindowManager({
  main: () => app.windows.get("main"),
  setActivationPolicy: (p) => app.setActivationPolicy(p),
}, () => tray?.refreshMenu());
setFleetWindows(windows);

// A second launch shows the window (singleInstance; the runtime re-shows it, this syncs the Dock).
runtime.onSecondInstance?.(() => windows.show());

const quit = () => {
  if (runtime.quit) void runtime.quit();
  else desktopApi?.quit?.();
};

const service = await fleetService();

if (app.tray) {
  // Per OS: a macOS template (black + alpha; status by shape), Windows / Linux colour art.
  const icons = await trayIcons(Deno.build.os);
  tray = driveTray(app.tray, icons, windows, {
    refresh: () => service.refresh(),
    setNotificationsPaused: (p) => service.setNotificationsPaused(p),
    setStartAtLogin: async (on) => {
      const api = desktopApi?.launchAtLogin;
      return api ? loginOn(await api.set(on)) : null;
    },
    quit,
  }, (err) => console.error("fleet: tray:", err instanceof Error ? err.name : "error"));
  service.onChange((snap) => tray!.update(snap));
  tray.update(service.snapshot());
} else {
  // No tray host (stock GNOME without the AppIndicator extension): the window is the only way in.
  windows.show();
}

// Once the token lookup is done: show the window on the first launch or when a token is needed,
// and turn start at login on the first time (the user wants Fleet always running).
let decided = false;
const decide = async (snap: Snapshot) => {
  if (decided || snap.auth === "pending") return;
  decided = true;
  const prefs = service.prefs();
  if (!prefs.launched || snap.auth === "needs-token" || snap.auth === "invalid") windows.show();
  if (!prefs.launched) await service.setPrefs({ launched: true });
  const login = await ensureLoginDefault(
    desktopApi?.launchAtLogin,
    prefs.loginDefaulted === true,
    () => service.setPrefs({ loginDefaulted: true }),
  );
  if (tray) {
    tray.startAtLogin = login;
    tray.refreshMenu();
  }
};
service.onChange((snap) => void decide(snap));
void decide(service.snapshot());
