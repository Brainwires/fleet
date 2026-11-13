import type { DenextConfig } from "denext/server";
import { ALL_GH_PATHS } from "./lib/deno-host.ts";
import { HOOKS_LOG_DIR, SECURITY_BIN } from "./lib/deno-hooks.ts";
import { poolPaths, poolPrograms } from "./lib/controls.ts";
import { INITIAL_MENU } from "./lib/tray-driver.ts";

// Fleet: the Brainwires org's GitHub Actions jobs and our self-hosted runner pools, live. One
// window plus a tray icon. The backend is the `fleet` desktop extension (desktop/fleet.ts), which
// runs in the app's Deno process and is the only code that holds the GitHub token.
const HOME = Deno.env.get("HOME");
// The pool controls' exact programs, only when the build machine has the runner scheduler's ops
// checkout (the Mac mini): pause-pool.sh, watchdog.sh, /bin/launchctl. Elsewhere none.
const POOL_PROGRAMS = (() => {
  if (!HOME) return [];
  const paths = poolPaths(HOME);
  try {
    return Deno.statSync(paths.pausePool).isFile ? poolPrograms(paths) : [];
  } catch {
    return [];
  }
})();

export default {
  desktop: {
    // A .dmg on macOS; a .zip on Windows (an .msi needs WiX, which runs on Windows only, and the
    // Windows build is cross-packaged from the Mac: `--target-os windows`, `--arch x86_64`).
    installers: { macos: ["dmg"], linux: [], windows: ["zip"] },
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
      // Pool unhealthy, queued over 15 min, a default-branch job failed.
      notifications: true,
      // Start at login (a tray toggle, on at the first run).
      launchAtLogin: true,
      extensions: ["./desktop/fleet.ts"],
    },
    extraPermissions: {
      // The GitHub API, outbound only. The webhook receiver listens on 127.0.0.1:8789, inside the
      // loopback listen grant every desktop app has.
      netConnect: ["api.github.com"],
      // `gh auth token`, and the webhook secret from the login keychain (the Mac mini only), by
      // absolute path only.
      run: [...ALL_GH_PATHS, SECURITY_BIN, ...POOL_PROGRAMS],
      // fleet-state.json (usual job lengths, notifications already posted): the app's own data
      // folder only ($DENO_DESKTOP_DATA on the pinned runtime). No token is ever written there.
      // The webhook log the runner scheduler reads (~/.denext-runners/hooks, the build machine's
      // home: the receiver only runs on the Mac mini, where Fleet is built for itself).
      write: ["$APPDATA", ...(HOME ? [`${HOME}/${HOOKS_LOG_DIR}`] : [])],
    },
  },
} satisfies DenextConfig;
