// Fleet's backend as a desktop extension (`desktop.capabilities.extensions`): it runs in the app's
// Deno process, holds the GitHub token, polls, and answers the page through denext's token-gated
// bridge (`desktopExtension("fleet")`, wrapped by app/fleet-client.ts). The page only ever gets the
// Snapshot (lib/model.ts): no token, no headers. desktop.ts drives the tray from the same instance.

import { defineDesktopExtension, DesktopCapError, type DesktopExtensionHost } from "denext/desktop";
import {
  appendJournal,
  ghToken,
  journalLastSeq,
  loadHistory,
  loadLog,
  loadSettingsFiles,
  loadState,
  loadZoom,
  postNotification,
  readJournal,
  registerNotifierHelper,
  saveAgentMachines,
  saveAgentSnapshot,
  saveHistory,
  saveLog,
  saveSettings,
  saveState,
  saveZoom,
} from "../lib/deno-host.ts";
import { createZoomStore, ZOOM_EVENT, type ZoomStore } from "../lib/zoom.ts";
import { CHANGED_EVENT, type Snapshot } from "../lib/model.ts";
import type { FleetEvent } from "../lib/events.ts";
import { createStream, type FleetStream, replayFrom, statusMessage } from "../lib/stream.ts";
import {
  ensureStreamToken,
  listenStream,
  type StreamListener,
  writeStreamState,
} from "../lib/deno-stream.ts";
import { createFleetService, type FleetService } from "../lib/service.ts";
import {
  type ControlDeps,
  listWorkflows,
  runControl,
  runPoolControl,
} from "../lib/control-runner.ts";
import { home, localHealthReader, localPoolPaths, runProgram } from "../lib/deno-pools.ts";
import { ciLedgerDir, ciLedgerReader } from "../lib/ci-ledger.ts";
import {
  ensureConfigToken,
  localConfigHelper,
  localRoutingHelper,
  runProgramJson,
} from "../lib/deno-config.ts";
import {
  configCheck,
  type ConfigDeps,
  configHistory,
  configSchema,
  configShow,
  configStatus,
  runConfigApply,
  runConfigRevert,
} from "../lib/config-runner.ts";
import {
  hooksUnavailable,
  readHookSecret,
  readSpoolSince,
  type Receiver,
  recentSpoolIds,
  spoolDirOf,
  startReceiver,
  tailSpool,
} from "../lib/deno-hooks.ts";
import { expandHome, settings } from "../lib/settings.ts";
import { agentMachines, MACHINES_EVENT, type MachinesView } from "../lib/machines.ts";
import { type MachinesStream, startMachinesStream } from "../lib/deno-machines.ts";
import {
  routingCheck,
  type RoutingDeps,
  routingLoad,
  runRoutingApply,
  runRoutingRevert,
} from "../lib/routing-runner.ts";
import { watchdogNotifies } from "../lib/notifier.ts";
import { schedulerTargets, type StateWatch, watchState } from "../lib/state-watch.ts";
import type { PoolPaths } from "../lib/controls.ts";
import { asRange } from "../lib/pool-detail.ts";
import { createJobLogs, type JobLogs } from "../lib/logs.ts";
import { launcherForJob, listLauncherLogs, poolLogLines, runnerLogView } from "../lib/deno-logs.ts";

let service: FleetService | undefined;
let jobLogs: JobLogs | undefined;
let extHost: DesktopExtensionHost | undefined;
/** The window zoom every page shows (lib/zoom.ts), kept in the data folder's `fleet-view.json`. */
let zoom: ZoomStore | undefined;
/** The machines integration's live stream (lib/deno-machines.ts); idle until the settings name one. */
let machines: MachinesStream | undefined;
/** The pool commands the settings configure here (the runner scheduler integration), or `null`. */
const pools = (): PoolPaths | null => localPoolPaths(settings().integrations.runnerScheduler);
/** Test builds: controls show their dialogs and send nothing (set in the environment at launch). */
const DRY_RUN = (() => {
  try {
    return Deno.env.get("FLEET_CONTROLS_DRY_RUN") === "1";
  } catch {
    return false;
  }
})();
const waiting: ((s: FleetService) => void)[] = [];

/** Start the service once the extension's host (secure store, data folder) is known. */
function start(host: DesktopExtensionHost): void {
  if (service) return;
  extHost = host;
  const dir = host.appSupportDir;
  zoom = createZoomStore({
    load: () => loadZoom(dir),
    save: (pct) => saveZoom(dir, pct),
    onChange: (pct) => {
      try {
        host.emit(ZOOM_EVENT, { zoom: pct });
      } catch {
        // No page subscribed: each reads the level when it opens.
      }
    },
  });
  // The embedded Fleet Notifier, registered with LaunchServices once per build (a ditto install
  // doesn't), then asked for its notification permission (the prompt shows at Fleet's launch).
  void registerNotifierHelper(dir);
  service = createFleetService({
    ghToken: () => ghToken(),
    secrets: host.secureStore,
    notify: (n) => postNotification(n),
    // The watchdog's alerts reach the user through Fleet Notifier when this bundle embeds it.
    watchdogNotifies: () =>
      watchdogNotifies(
        Deno.execPath(),
        settings().integrations.runnerScheduler !== null,
        (p) => Deno.statSync(p).isFile,
      ),
    load: () => loadState(dir),
    save: (s) => saveState(dir, s),
    loadLog: () => loadLog(dir),
    saveLog: (d) => saveLog(dir, d),
    // For agents (mcp/fleet-mcp.ts reads these, read-only): the snapshot and the event journal.
    saveAgentSnapshot: (snap) => saveAgentSnapshot(dir, snap),
    // …and the loopback event stream (lib/stream.ts) pushes each appended event to its clients.
    appendJournal: async (events) => {
      try {
        await appendJournal(dir, events);
      } finally {
        publishToStream(events);
      }
    },
    journalLastSeq: () => journalLastSeq(dir),
    // What happened while Fleet was closed: the receiver's spool, read once at startup.
    readSpool: (since) => readSpoolSince(since, spoolDirOf(settings().webhooks, dir)),
    // The runner scheduler integration's local health file, when the settings name one.
    localHealthFor: (s) => localHealthReader(s.integrations.runnerScheduler),
    loadSettings: () => loadSettingsFiles(dir),
    saveSettings: (s) => saveSettings(dir, s),
    // The usage history per pool (the detail screens, fleet_pool_history), and its first-run
    // back-fill from the event journal (and the spool, above).
    loadHistory: () => loadHistory(dir),
    saveHistory: (doc) => saveHistory(dir, doc),
    readJournal: () => readJournal(dir),
    // The `ci` MCP server's ledger beside the scheduler's health file: events and run owners.
    readCiLedger: ciLedgerReader(() =>
      ciLedgerDir(settings().integrations.runnerScheduler?.localHealthFile, home())
    ),
  });
  jobLogs = createJobLogs({ github: () => service?.github() ?? null });
  service.onChange(() => {
    try {
      host.emit(CHANGED_EVENT, null);
    } catch {
      // No page subscribed yet: events are replayed, nothing to do.
    }
  });
  for (const fn of waiting.splice(0)) fn(service);
  service.start().catch((err) => console.error("fleet: start failed:", errName(err)));
  // Webhooks follow the startup settings (a change applies at the next launch).
  void service.settingsReady().then(() => startHooks(service!, dir), () => {});
  // The loopback event stream follows the startup settings too.
  void service.settingsReady().then(() => startStream(service!, dir), () => {});
  // The runner scheduler's state files, watched: the pool cards follow each of its ticks within a
  // second (no poll, no GitHub request). Re-armed when the settings change its paths.
  void service.settingsReady().then(() => {
    startStateWatch(service!);
    service!.onSettings(() => startStateWatch(service!));
  }, () => {});
  // Machines (hardware telemetry per machine): the stream follows the settings as they are now, so
  // setting the integration up needs no restart. The page is told of each change; agents read
  // `machines.json`, rewritten at most every 10 s.
  let machinesSaved = 0;
  let machinesPending: ReturnType<typeof setTimeout> | undefined;
  const saveMachines = (view: MachinesView) => {
    machinesSaved = Date.now();
    void saveAgentMachines(dir, agentMachines(view, Date.now())).catch(() => {});
  };
  machines = startMachinesStream({
    integration: () => settings().integrations.machines ?? null,
    home,
    readFile: async (path) => {
      try {
        return await Deno.readTextFile(path);
      } catch {
        return null;
      }
    },
    fetch: (input, init) => fetch(input, init),
    now: () => Date.now(),
    sleep: (ms, signal) =>
      new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(t);
          signal.removeEventListener("abort", done);
          resolve();
        };
        const t = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
      }),
    onChange: (view) => {
      try {
        host.emit(MACHINES_EVENT, null);
      } catch {
        // No page subscribed: it reads the view when it opens.
      }
      if (!view.configured) return;
      clearTimeout(machinesPending);
      const wait = 10_000 - (Date.now() - machinesSaved);
      if (wait <= 0) saveMachines(view);
      else machinesPending = setTimeout(() => saveMachines(machines!.view()), wait);
    },
  });
  host.onAppQuit(async () => {
    machines?.stop();
    clearTimeout(machinesPending);
    stopSpool?.();
    stateWatch?.stop();
    await Promise.all([receiver?.stop(), service?.flushHistory(), streamListener?.stop()]);
  });
}

let stateWatch: StateWatch | null = null;
/** The folders the state watch was armed for (a settings change that keeps them keeps it). */
let stateWatchKey = "";

/**
 * Watch the runner scheduler's files (its health file's folder: the health file, pool-state.json,
 * health-published; its paused folder: paused-<pool>), as the settings name them now. Each burst
 * of writes re-merges them into the pools at once (lib/state-watch.ts debounces the bursts).
 */
function startStateWatch(s: FleetService): void {
  const sched = settings().integrations.runnerScheduler;
  const targets = schedulerTargets({
    healthFile: sched?.localHealthFile ? expandHome(sched.localHealthFile, home()) : null,
    pausedDir: sched?.pausedDir ? expandHome(sched.pausedDir, home()) : null,
  });
  const key = JSON.stringify(targets);
  if (key === stateWatchKey && stateWatch) return;
  // Stopping reports "not watching" (the status line drops the watch from its sources).
  stateWatch?.stop();
  stateWatch = null;
  stateWatchKey = key;
  if (targets.length === 0) return;
  stateWatch = watchState({
    targets,
    onChange: () => void s.localStateChanged(),
    onWatching: (n) => s.setWatching(n > 0),
  });
  s.setWatching(stateWatch.watching > 0);
}

let receiver: Receiver | null = null;
let stopSpool: (() => void) | undefined;

/**
 * GitHub webhooks, when the settings turn them on and this machine has what they need (the secret;
 * the endpoint's launchd job when one is required): deliveries feed the same state and log as
 * polling, which then only reconciles.
 */
async function startHooks(s: FleetService, dataDir: string): Promise<void> {
  const cfg = s.settings().webhooks;
  if (!cfg.enabled) return;
  const why = await hooksUnavailable(cfg, extHost?.secureStore);
  if (why) {
    console.warn(`fleet: hooks: off (${why})`);
    return;
  }
  const secret = await readHookSecret(cfg, extHost?.secureStore);
  if (!secret) {
    console.warn("fleet: hooks: the webhook secret is unreadable or shorter than 32 characters");
    return;
  }
  const spoolDir = spoolDirOf(cfg, dataDir);
  // The ids already spooled: a replay of one after a restart is still a duplicate.
  const seen = await recentSpoolIds(spoolDir).catch(() => []);
  receiver = startReceiver(secret, {
    onDelivery: (d) => void s.applyHook(d),
    onVerified: (_event, at) => s.hookVerified(at),
    onReject: (why) => console.warn(`fleet: hooks: rejected ${why}`),
  }, {
    seen,
    port: cfg.port,
    spoolDir,
    clockOffset: () => s.github()?.client.clockOffset() ?? 0,
  });
  if (receiver) {
    s.setHooksEnabled(true, "listener");
    return void s.backfill();
  }
  // The port is held by the standalone receiver (a service, or `denext task hooks`): read its spool.
  const tail = await tailSpool((d) => void s.applyHook(d), spoolDir, undefined, seen);
  if (tail) {
    stopSpool = tail.stop;
    // Start from the spool's newest delivery, not "no delivery yet": the receiver has been live
    // all along, Fleet just started.
    if (tail.lastDeliveryAt !== null) s.hookVerified(tail.lastDeliveryAt);
    s.setHooksEnabled(true, "spool");
    void s.backfill();
  } else {
    console.warn(
      `fleet: hooks: 127.0.0.1:${cfg.port} is taken and there is no spool; polling only`,
    );
    s.setHooksEnabled(false);
  }
}

let stream: FleetStream | null = null;
let streamListener: StreamListener | null = null;
/** The last event `seq` handed to the stream. */
let streamSeq = 0;

/** Newly journaled events to the stream's clients (none before it starts). */
function publishToStream(events: readonly FleetEvent[]): void {
  for (const e of events) streamSeq = Math.max(streamSeq, e.seq);
  stream?.publish(events);
}

/**
 * The loopback event stream for agents and monitors (settings `stream`): 127.0.0.1 only, the
 * per-install token in the data folder, `fleet-stream.json` saying the port. A taken port leaves
 * Fleet running without it.
 */
async function startStream(s: FleetService, dataDir: string): Promise<void> {
  const cfg = s.settings().stream;
  if (!cfg.enabled || stream) return;
  let token: string;
  try {
    token = await ensureStreamToken(dataDir);
  } catch (err) {
    console.warn(`fleet: stream: off (the token file: ${errName(err)})`);
    return;
  }
  const lastSeq = () => Math.max(streamSeq, s.snapshot().eventSeq);
  const st = createStream({
    token,
    lastSeq,
    replay: (since) => replayFrom(s.events(since), since, () => readJournal(dataDir)),
    status: () => statusMessage(s.snapshot(), lastSeq(), Date.now()),
    heartbeatMs: cfg.heartbeatSeconds * 1000,
    maxClients: cfg.maxClients,
  });
  const listener = listenStream(st, cfg.port);
  if (!listener) {
    console.warn(`fleet: stream: 127.0.0.1:${cfg.port} is taken; no event stream`);
    return;
  }
  stream = st;
  streamListener = listener;
  await writeStreamState(dataDir, {
    port: listener.port,
    pid: Deno.pid,
    started_at: new Date().toISOString(),
  }).catch((err) => console.warn(`fleet: stream: fleet-stream.json: ${errName(err)}`));
  // Webhook state changes (live / stale / off) are stream messages too (not journaled).
  let hooksWas = s.snapshot().hooks?.state ?? "off";
  s.onChange((snap) => {
    const now = snap.hooks?.state ?? "off";
    if (now === hooksWas) return;
    st.publishHooks(now, hooksWas);
    hooksWas = now;
  });
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
    poolPaths: pools(),
    uid: Deno.uid() ?? -1,
    runProgram,
    dryRun: DRY_RUN,
  };
}

/** The runner settings' machine access, or `null` when no configuration helper exists here. */
function configDeps(): ConfigDeps | null {
  const helper = localConfigHelper(settings().integrations.runnerScheduler);
  if (!helper || !extHost) return null;
  const dir = extHost.appSupportDir;
  let user = "";
  try {
    user = (Deno.env.get("USER") ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  } catch {
    user = "";
  }
  return {
    run: (args, input) => runProgramJson(helper, args, input),
    token: () => ensureConfigToken(dir),
    confirm: async (o) => {
      if (!extHost) throw new DesktopCapError("unavailable", "no desktop host");
      return await extHost.confirm(o);
    },
    log: (e) => svc().logAction(e),
    actor: user ? `fleet-${user}` : "fleet",
    dryRun: DRY_RUN,
  };
}

const NO_CONFIG = "Runner settings need the scheduler's configuration helper on this machine.";
const NO_ROUTING = "Routing rules need the scheduler's routing helper on this machine.";

/** The routing rules' machine access, or `null` when no routing helper exists here. */
function routingDeps(): RoutingDeps | null {
  const helper = localRoutingHelper(settings().integrations.runnerScheduler);
  if (!helper || !extHost) return null;
  const dir = extHost.appSupportDir;
  let user = "";
  try {
    user = (Deno.env.get("USER") ?? "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 32);
  } catch {
    user = "";
  }
  return {
    run: (args, input) => runProgramJson(helper, args, input),
    token: () => ensureConfigToken(dir),
    confirm: async (o) => {
      if (!extHost) throw new DesktopCapError("unavailable", "no desktop host");
      return await extHost.confirm(o);
    },
    log: (e) => svc().logAction(e),
    actor: user ? `fleet-${user}` : "fleet",
    dryRun: DRY_RUN,
  };
}

function obj(raw: unknown): Record<string, unknown> {
  return typeof raw === "object" && raw !== null ? raw as Record<string, unknown> : {};
}

/** The runner scheduler's log folder on this machine (settings), or `null`. */
function logsDir(): string | null {
  const dir = settings().integrations.runnerScheduler?.logsDir;
  return dir ? expandHome(dir, home()) : null;
}

/** A pool id from a request (a name the cards could show), or `""`. */
function poolArg(raw: unknown): string {
  const p = obj(raw).pool;
  return typeof p === "string" && /^[\w.+-]{1,100}$/.test(p) ? p : "";
}

const optNum = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;

export default defineDesktopExtension({
  name: "fleet",
  events: [CHANGED_EVENT, ZOOM_EVENT, MACHINES_EVENT],
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
    capabilities: {
      handler: () => {
        const p = pools();
        return {
          pools: p !== null,
          restart: !!p?.launchdLabel,
          watchdog: !!p?.watchdog,
          config: localConfigHelper(settings().integrations.runnerScheduler) !== null,
          routing: localRoutingHelper(settings().integrations.runnerScheduler) !== null,
          machines: (settings().integrations.machines ?? null) !== null,
        };
      },
    },
    /** The settings, and what the Settings view shows about this machine. */
    settings: {
      handler: () => {
        const s = svc().settings();
        const dir = extHost?.appSupportDir ?? "";
        const sched = s.integrations.runnerScheduler;
        const healthFile = sched?.localHealthFile
          ? expandHome(sched.localHealthFile, home())
          : null;
        return {
          settings: s,
          machine: {
            dataDir: dir,
            spoolDir: s.webhooks.enabled ? spoolDirOf(s.webhooks, dir) : null,
            healthFile,
            logsDir: logsDir(),
            os: Deno.build.os,
          },
        };
      },
    },
    /** New settings: validated, saved (0600) and applied; the problems when they don't validate. */
    saveSettings: {
      timeoutMs: 60_000,
      handler: (raw: unknown) => svc().saveSettings(obj(raw).settings),
    },
    /** The token's account, scopes and organizations (the wizard's sign-in step). */
    tokenInfo: { timeoutMs: 60_000, handler: () => svc().tokenInfo() },
    /** An owner's repos with their default branches (the wizard's repo step). */
    ownerRepos: {
      timeoutMs: 120_000,
      handler: (raw: unknown) => {
        const r = obj(raw);
        const owner = typeof r.owner === "string" ? r.owner : "";
        return svc().ownerRepos(owner, r.kind === "user" ? "user" : "org");
      },
    },
    /** The page showed the Settings view the tray asked for. */
    settingsShown: {
      handler: () => {
        svc().settingsShown();
        return null;
      },
    },
    /** The watched repos, for the dispatch form. */
    repos: { handler: () => svc().github()?.poller.repoNames() ?? [] },
    /** A repo's dispatchable workflows and their inputs (from the workflow YAML). */
    workflows: {
      timeoutMs: 60_000,
      handler: (raw: unknown) => listWorkflows(controlDeps(), obj(raw).repo),
    },
    /** A GitHub control: guardrails, the OS confirm dialog, then the request. */
    control: { timeoutMs: false, handler: (raw: unknown) => runControl(controlDeps(), raw) },
    /** A pool control (the runner scheduler integration): guardrails, the OS dialog, the script. */
    poolControl: {
      timeoutMs: false,
      handler: (raw: unknown) => runPoolControl(controlDeps(), raw),
    },
    /** Runner settings: the helper's schema, the live values and the newest changes. */
    configLoad: {
      timeoutMs: 90_000,
      handler: async () => {
        const d = configDeps();
        if (!d) return { ok: false, message: NO_CONFIG };
        const [schema, show, history] = await Promise.all([
          configSchema(d),
          configShow(d),
          configHistory(d),
        ]);
        if (!schema.ok) return { ok: false, message: schema.message };
        if (!show.ok) return { ok: false, message: show.message };
        return { ok: true, schema: schema.schema, show: show.show, history };
      },
    },
    /** Runner settings: the helper's check of a change (nothing written). */
    configCheck: {
      timeoutMs: 90_000,
      handler: (raw: unknown) => {
        const d = configDeps();
        return d ? configCheck(d, raw) : { ok: false, errors: [NO_CONFIG], warnings: [] };
      },
    },
    /** Runner settings: apply a change (guardrails, the OS dialog, the helper). */
    configApply: {
      timeoutMs: false,
      handler: (raw: unknown) => {
        const d = configDeps();
        return d ? runConfigApply(d, raw) : { ok: false, message: NO_CONFIG };
      },
    },
    /** Runner settings: revert the newest change (the OS dialog, the helper). */
    configRevert: {
      timeoutMs: false,
      handler: (raw: unknown) => {
        const d = configDeps();
        return d ? runConfigRevert(d, raw) : { ok: false, message: NO_CONFIG };
      },
    },
    /** Runner settings: one change's status while the helper verifies it. */
    configStatus: {
      timeoutMs: 30_000,
      handler: (raw: unknown) => {
        const d = configDeps();
        return d ? configStatus(d, raw) : null;
      },
    },
    /** A pool's detail (or `github`): its usage history over a range, recent jobs and events. */
    poolDetail: {
      handler: (raw: unknown) => svc().poolDetail(poolArg(raw), asRange(obj(raw).range)),
    },
    /** A pool's launcher logs (newest first), when the runner scheduler's logs are configured. */
    runnerLogList: {
      timeoutMs: 30_000,
      handler: async (raw: unknown) => {
        const dir = logsDir();
        const pool = poolArg(raw);
        if (!dir || !pool) return { configured: false, logs: [] };
        return { configured: true, logs: await listLauncherLogs(dir, pool) };
      },
    },
    /** The scheduler's and the watchdog's lines about a pool (their files' tails), redacted. */
    poolLogLines: {
      handler: async (raw: unknown) => {
        const dir = logsDir();
        const pool = poolArg(raw);
        if (!dir || !pool) return { configured: false, scheduler: [], alerts: [] };
        const [sched, alerts] = await Promise.all([
          poolLogLines(dir, pool, "scheduler"),
          poolLogLines(dir, pool, "alerts"),
        ]);
        return { configured: true, scheduler: sched.lines, alerts: alerts.lines };
      },
    },
    /** One launcher log: its tail, or the lines after / before an offset; redacted. */
    runnerLog: {
      handler: async (raw: unknown) => {
        const dir = logsDir();
        const r = obj(raw);
        const file = typeof r.file === "string" ? r.file : "";
        const view = dir
          ? await runnerLogView(dir, poolArg(raw), file, {
            after: optNum(r.after),
            before: optNum(r.before),
          })
          : null;
        return view ?? { error: "That log isn't one of this pool's launcher logs." };
      },
    },
    /** The launcher log that took a job (the scheduler's records say which), as above. */
    runnerLogForJob: {
      handler: async (raw: unknown) => {
        const dir = logsDir();
        const jobId = optNum(obj(raw).jobId);
        if (!dir || !jobId) return { error: "No runner logs are configured here." };
        const found = await launcherForJob(dir, jobId);
        const view = found ? await runnerLogView(dir, found.pool, found.file) : null;
        return view ?? { error: "The scheduler's logs don't name a launcher log for that job." };
      },
    },
    /** A job's GitHub log, fetched on demand (budgeted, cached), redacted. */
    jobLog: {
      timeoutMs: 120_000,
      handler: (raw: unknown) => {
        const r = obj(raw);
        const jobId = optNum(r.jobId) ?? 0;
        const rec = svc().history().job(jobId);
        const repo = typeof r.repo === "string" ? r.repo : rec?.repo ?? "";
        const title = rec ? `${rec.workflow} · ${rec.name}` : `job ${jobId}`;
        return jobLogs!.get(repo, jobId, title, rec !== undefined);
      },
    },
    /** Machines: the live view (each machine's newest reading, its pools and jobs, the trails). */
    machines: {
      handler: () => {
        if (!machines) throw new DesktopCapError("unavailable", "Fleet's backend is starting");
        return machines.view();
      },
    },
    /** A machine's history over a range (1h, 24h, 7d), from the machines service. */
    machineHistory: {
      timeoutMs: 30_000,
      handler: (raw: unknown) => {
        if (!machines) throw new DesktopCapError("unavailable", "Fleet's backend is starting");
        const r = obj(raw);
        return machines.history(String(r.host ?? ""), r.range);
      },
    },
    /** Routing rules: the helper's schema, the rules in force, their preview and history. */
    routingLoad: {
      timeoutMs: 90_000,
      handler: async () => {
        const d = routingDeps();
        return d ? await routingLoad(d) : { ok: false, message: NO_ROUTING };
      },
    },
    /** A draft checked by the helper, with where each class's next job would go. */
    routingCheck: {
      timeoutMs: 60_000,
      handler: async (raw: unknown) => {
        const d = routingDeps();
        if (!d) return { ok: false, errors: [NO_ROUTING], warnings: [], classes: [] };
        return await routingCheck(d, raw);
      },
    },
    /** Save a draft: the helper's check, the OS dialog, then the helper (audited). */
    routingApply: {
      timeoutMs: false,
      handler: async (raw: unknown) => {
        const d = routingDeps();
        return d ? await runRoutingApply(d, raw) : { ok: false, message: NO_ROUTING };
      },
    },
    /** Revert the newest routing change: the OS dialog, then the helper. */
    routingRevert: {
      timeoutMs: false,
      handler: async (raw: unknown) => {
        const d = routingDeps();
        return d ? await runRoutingRevert(d, raw) : { ok: false, message: NO_ROUTING };
      },
    },
    /** The window zoom (percent) every page shows. */
    zoom: {
      handler: async () => {
        if (!zoom) throw new DesktopCapError("unavailable", "Fleet's backend is starting");
        await zoom.ready();
        return zoom.level();
      },
    },
    /** A new window zoom: clamped, saved, pushed to every page; answers the level kept. */
    setZoom: {
      handler: (raw: unknown) => {
        if (!zoom) throw new DesktopCapError("unavailable", "Fleet's backend is starting");
        return zoom.set(obj(raw).zoom);
      },
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
