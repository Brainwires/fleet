// Fleet's backend as a desktop extension (`desktop.capabilities.extensions`): it runs in the app's
// Deno process, holds the GitHub token, polls, and answers the page through denext's token-gated
// bridge (`desktopExtension("fleet")`, wrapped by app/fleet-client.ts). The page only ever gets the
// Snapshot (lib/model.ts): no token, no headers. desktop.ts drives the tray from the same instance.

import { defineDesktopExtension, DesktopCapError, type DesktopExtensionHost } from "denext/desktop";
import {
  ghToken,
  loadLog,
  loadState,
  postNotification,
  saveLog,
  saveState,
} from "../lib/deno-host.ts";
import { CHANGED_EVENT, type Snapshot } from "../lib/model.ts";
import { createFleetService, type FleetService } from "../lib/service.ts";
import type { WindowManager } from "../lib/tray-driver.ts";
import {
  type ControlDeps,
  listWorkflows,
  runControl,
  runPoolControl,
} from "../lib/control-runner.ts";
import { localPoolPaths, readLocalHealth, runProgram } from "../lib/deno-pools.ts";
import {
  hooksAvailable,
  readHookSecret,
  type Receiver,
  startReceiver,
  tailSpool,
} from "../lib/deno-hooks.ts";

let service: FleetService | undefined;
let extHost: DesktopExtensionHost | undefined;
const pools = localPoolPaths();
/** Test builds: controls show their dialogs and send nothing (set in the environment at launch). */
const DRY_RUN = (() => {
  try {
    return Deno.env.get("FLEET_CONTROLS_DRY_RUN") === "1";
  } catch {
    return false;
  }
})();
let windows: WindowManager | undefined;

/** Hand the methods desktop.ts's window manager (the page's close button hides through it). */
export function setFleetWindows(manager: WindowManager): void {
  windows = manager;
}
const waiting: ((s: FleetService) => void)[] = [];

/** Start the service once the extension's host (secure store, data folder) is known. */
function start(host: DesktopExtensionHost): void {
  if (service) return;
  extHost = host;
  const dir = host.appSupportDir;
  service = createFleetService({
    ghToken: () => ghToken(),
    secrets: host.secureStore,
    notify: (n) => postNotification(n),
    load: () => loadState(dir),
    save: (s) => saveState(dir, s),
    loadLog: () => loadLog(dir),
    saveLog: (d) => saveLog(dir, d),
    ...(pools ? { localHealth: readLocalHealth } : {}),
  });
  service.onChange(() => {
    try {
      host.emit(CHANGED_EVENT, null);
    } catch {
      // No page subscribed yet: events are replayed, nothing to do.
    }
  });
  for (const fn of waiting.splice(0)) fn(service);
  service.start().catch((err) => console.error("fleet: start failed:", errName(err)));
  void startHooks(service);
  host.onAppQuit(() => {
    stopSpool?.();
    return receiver?.stop();
  });
}

let receiver: Receiver | null = null;
let stopSpool: (() => void) | undefined;

/**
 * GitHub webhooks, only on the machine that runs the tunnel and holds the secret (the Mac mini):
 * deliveries feed the same state and log as polling, which then only reconciles.
 */
async function startHooks(s: FleetService): Promise<void> {
  if (!(await hooksAvailable())) return;
  const secret = await readHookSecret();
  if (!secret) return;
  receiver = startReceiver(secret, {
    onDelivery: (d) => void s.applyHook(d),
    onVerified: (_event, at) => s.hookVerified(at),
    onReject: (why) => console.warn(`fleet: hooks: rejected ${why}`),
  });
  if (receiver) return s.setHooksEnabled(true, "listener");
  // The port is held by the standalone receiver (`denext task hooks`): read its spool instead.
  const stop = await tailSpool((d) => void s.applyHook(d));
  if (stop) {
    stopSpool = stop;
    s.setHooksEnabled(true, "spool");
  } else {
    console.warn("fleet: hooks: 127.0.0.1:8789 is taken and there is no spool; polling only");
    s.setHooksEnabled(false);
  }
}

/** An error's name only: a message could, in principle, echo a request. */
function errName(err: unknown): string {
  return err instanceof Error ? err.name : "error";
}

/** The service, for desktop.ts's tray (resolves once the extension's setup ran). */
export function fleetService(): Promise<FleetService> {
  return service ? Promise.resolve(service) : new Promise((resolve) => waiting.push(resolve));
}

function svc(): FleetService {
  if (!service) throw new DesktopCapError("unavailable", "Fleet's backend is starting");
  return service;
}

/** The controls' machine access: the token's client, the OS dialog, the event log, pool scripts. */
function controlDeps(): ControlDeps {
  const s = svc();
  return {
    github: () => s.github(),
    confirm: async (o) => {
      if (!extHost) throw new DesktopCapError("unavailable", "no desktop host");
      // Never act without the OS's confirmation: a runtime without native message boxes refuses.
      return await extHost.confirm(o);
    },
    log: (e) => s.logAction(e),
    poolPaths: pools,
    uid: Deno.uid() ?? -1,
    runProgram,
    dryRun: DRY_RUN,
  };
}

function obj(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

export default defineDesktopExtension({
  name: "fleet",
  events: [CHANGED_EVENT],
  setup: start,
  methods: {
    /** The snapshot; `visible` says whether the calling page is on screen (poll rate). */
    snapshot: {
      handler: (raw: unknown): Snapshot => {
        const s = svc();
        const v = obj(raw).visible;
        if (typeof v === "boolean") s.visibility(v);
        return s.snapshot();
      },
    },
    /** The event log after `after` (the page keeps its own copy and asks for what's new). */
    events: {
      handler: (raw: unknown) => {
        const after = Number(obj(raw).after);
        return svc().events(Number.isFinite(after) && after >= 0 ? after : 0);
      },
    },
    /** Hide the main window to the tray (its close button); the Dock icon goes with it. */
    hide: {
      handler: () => {
        if (!windows) throw new DesktopCapError("unavailable", "no window manager in this launch");
        service?.visibility(false);
        windows.hide();
        return null;
      },
    },
    visibility: {
      handler: (raw: unknown) => {
        svc().visibility(obj(raw).visible === true);
        return null;
      },
    },
    refresh: {
      timeoutMs: 120_000,
      handler: async () => {
        await svc().refresh();
        return svc().snapshot();
      },
    },
    /** A pasted token: checked against GitHub, then kept in the extension's own secure store. */
    setToken: {
      handler: (raw: unknown) => svc().setToken(String(obj(raw).token ?? "")),
    },
    retryGh: { handler: () => svc().retryGh() },
    /** What the page may offer: GitHub controls (always; a token is checked on confirm), pools here. */
    capabilities: { handler: () => ({ pools: pools !== null }) },
    /** The watched repos, for the dispatch form. */
    repos: { handler: () => svc().github()?.poller.repoNames() ?? [] },
    /** A repo's dispatchable workflows and their inputs (from the workflow YAML). */
    workflows: {
      timeoutMs: 60_000,
      handler: (raw: unknown) => listWorkflows(controlDeps(), obj(raw).repo),
    },
    /** A GitHub control: guardrails, the OS confirm dialog, then the request. */
    control: { timeoutMs: false, handler: (raw: unknown) => runControl(controlDeps(), raw) },
    /** A pool control (the Mac mini only): guardrails, the OS confirm dialog, then the script. */
    poolControl: {
      timeoutMs: false,
      handler: (raw: unknown) => runPoolControl(controlDeps(), raw),
    },
    clearToken: {
      handler: async () => {
        await svc().clearToken();
        return null;
      },
    },
    usePublic: {
      timeoutMs: 120_000,
      handler: async () => {
        await svc().usePublic();
        return null;
      },
    },
  },
});
