import type { DenextConfig } from "denext/server";
import { ALL_GH_PATHS } from "./lib/deno-host.ts";
import { SECURITY_BIN } from "./lib/deno-hooks.ts";
import { LOG_HOSTS } from "./lib/github.ts";
import { internalGrants } from "./lib/build-grants.ts";
import { LSREGISTER, OPEN_BIN } from "./lib/notifier.ts";
import { INITIAL_MENU } from "./lib/tray-driver.ts";

// Fleet: GitHub Actions jobs and self-hosted runner pools, live. One window plus a tray icon. The
// backend is the `fleet` desktop extension (desktop/fleet.ts), which runs in the app's Deno process
// and is the only code that holds the GitHub token.
//
// A release build bakes only what every install needs. An internal build (FLEET_INTERNAL=1, e.g.
// `denext task desktop:package:internal`) also bakes the grants the build machine's local config
// (`fleet-local-config.json`, or $FLEET_LOCAL_CONFIG) calls for: the runner scheduler's pool
// commands and a webhook spool outside the data folder (lib/build-grants.ts). It refuses to build
// without that config, so an internal build never silently ships without its controls.
const INTERNAL = internalGrants();

export default {
  desktop: {
    // A .dmg on macOS; a .zip on Windows (an .msi needs WiX, which runs on Windows only, and the
    // Windows build is cross-packaged from the Mac: `--target-os windows`, `--arch x86_64`); a
    // .tar.gz and a .deb on Linux (both written by denext, no tool needed). An empty list would
    // build only the bundle directory.
    installers: { macos: ["dmg"], linux: ["tar.gz", "deb"], windows: ["zip"] },
    app: {
      name: "Fleet",
      identifier: "dev.brainwires.fleet",
      icons: {
        macos: "./icons/app.png",
        linux: "./icons/app.png",
        windows: "./icons/app.ico",
      },
      // A stable origin: the page's storage survives relaunches, and a github.com link the page
      // opens leaves the window for the user's browser.
      origin: "fleet://app",
      singleInstance: true,
      // Closing the window (it closes for good) leaves Fleet running in the tray.
      keepAlive: true,
      // A tray app: no Dock icon or menu bar from the first frame to quit, its window open or not.
      // Never "regular": an app that was ever regular lands in the Dock's recent apps once its
      // running tile goes away. The window comes to the front through focus() (lib/tray-driver.ts).
      activationPolicy: "accessory",
    },
    // Hidden at launch: desktop.ts shows it on the first launch or when a token is needed, else
    // closes it. Keyed like every window desktop.ts opens later (lib/tray-driver.ts WINDOW_KEY), so
    // they are found by key and share one remembered frame.
    // The default size gives way to the remembered one.
    window: { defaultWidth: 1320, defaultHeight: 860, title: "Fleet", show: false, key: "fleet" },
    minSize: { width: 860, height: 560 },
    tray: {
      // The macOS template until desktop.ts sets the art for the OS (lib/icons.ts trayIcons).
      icon: "/tray.png",
      tooltip: "Fleet",
      menu: [...INITIAL_MENU],
    },
    // Keychain items written by this app's own process only (no /usr/bin/security).
    secureStore: { legacy: false },
    capabilities: {
      // The pasted token, in the `fleet` extension's own namespace (host.secureStore).
      secureStore: true,
      // Pool unhealthy, queued over 15 min, a protected-branch job failed.
      notifications: true,
      // Start at login (opt-in: the wizard, the Settings view or the tray).
      launchAtLogin: true,
      extensions: ["./desktop/fleet.ts"],
    },
    extraPermissions: {
      // The GitHub API, outbound only, and the hosts its job-log downloads redirect to (a signed
      // URL fetched without the token; the pool detail's "View log"). The webhook receiver listens
      // on loopback, inside the loopback listen grant every desktop app has.
      netConnect: ["api.github.com", ...LOG_HOSTS],
      // `gh auth token`, a webhook secret from the macOS login keychain, and for the embedded Fleet
      // Notifier (lib/notifier.ts) LaunchServices' lsregister and `open` (its permission instance),
      // by absolute path only; an internal build adds the runner scheduler's pool commands.
      run: [...ALL_GH_PATHS, SECURITY_BIN, LSREGISTER, OPEN_BIN, ...INTERNAL.run],
      // The settings, state, event log and webhook spool: the app's own data folder only
      // ($DENO_DESKTOP_DATA on the pinned runtime). No token is ever written there. An internal
      // build adds a spool folder its local config puts outside it.
      write: ["$APPDATA", ...INTERNAL.write],
    },
  },
} satisfies DenextConfig;
