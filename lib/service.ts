// The backend service: finds a token (the GitHub CLI's, else one pasted earlier from the secure
// store), polls GitHub every 15 s while a window is visible and every 60 s otherwise (or later, while
// backing off), posts the native notifications once each, and tells listeners (the pages, the tray)
// when the snapshot changed. Everything that touches the machine is injected (`ServiceDeps`), so the
// tests run it with fakes. The token stays inside: no method returns it, nothing logs it.

import { createGitHubClient, type GitHubClient } from "./github.ts";
import type { AuthState, Snapshot } from "./model.ts";
import {
  diffObservation,
  EventLog,
  type FleetEvent,
  type NewEvent,
  restoreTracker,
  type TrackerState,
} from "./events.ts";
import { type FleetNotification, pendingNotifications, type SeenKeys } from "./notify.ts";
import { type PersistedState, Poller } from "./poller.ts";

import { pollPlan } from "./budget.ts";
import type { HealthState } from "./health.ts";
import { type HookDelivery, HOOKS_STALE_MS, hooksState, isStaleDelivery } from "./hooks.ts";
import { backfillEvents, backfillFrom, dropLogged } from "./backfill.ts";
import { AGENT_HEARTBEAT_MS, type AgentSnapshot, buildAgentSnapshot } from "./agent-snapshot.ts";
/** A page that hasn't said it's visible for this long counts as hidden (it may be suspended). */
export const VISIBLE_TTL_MS = 30_000;
/** The secure-store key of a pasted token. */
export const TOKEN_KEY = "github-token";
/**
 * A poll still running after this long is stuck (each request has its own 20 s deadline, so only
 * a bug gets here): the next poll goes ahead without it, and its late result is ignored.
 */
export const POLL_STUCK_MS = 2 * 60_000;

/** A secret store (the extension's own `host.secureStore`). */
export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** What the service needs from the machine. */
export interface ServiceDeps {
  /** `gh auth token`'s output, trimmed, or `null` when gh is missing or not signed in. */
  readonly ghToken: () => Promise<string | null>;
  readonly secrets: SecretStore;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  /** Post a native notification (best effort). */
  readonly notify: (n: FleetNotification) => void | Promise<void>;
  /** The persisted state (no token in it). */
  readonly load: () => Promise<PersistedState | null>;
  readonly save: (s: PersistedState) => Promise<void>;
  /** The event log and its tracker (`{ log, tracker }`), or `null`. */
  readonly loadLog?: () => Promise<unknown>;
  readonly saveLog?: (data: { log: unknown; tracker: TrackerState }) => Promise<void>;
  /** Write the agents' snapshot (snapshot.json) after every poll and webhook update. */
  readonly saveAgentSnapshot?: (s: AgentSnapshot) => Promise<void>;
  /** Append newly logged events to the append-only journal (fleet-events.jsonl). */
  readonly appendJournal?: (events: readonly FleetEvent[]) => Promise<void>;
  /**
   * The webhook spool's deliveries received after `since` (ms): the back-fill of what happened
   * while Fleet was closed. Absent (or `[]`) without a spool.
   */
  readonly readSpool?: (since: number) => Promise<HookDelivery[]>;
  /** The journal's last `seq`, so the log never numbers below it after a restart. */
  readonly journalLastSeq?: () => Promise<number>;
  /** The Mac mini's local pool health, merged over the variable's. */
  readonly localHealth?: (variable: HealthState) => Promise<HealthState>;
  readonly setTimeout?: (fn: () => void, ms: number) => number;
  readonly clearTimeout?: (id: number) => void;
  /** Each GitHub request's deadline (tests shorten it; default the client's 20 s). */
  readonly requestTimeoutMs?: number;
  /** Where a recovered fault is noted (never a token or a payload). Default `console.warn`. */
  readonly warn?: (message: string) => void;
}

/** A token's check result. */
export type TokenCheck = { ok: true } | { ok: false; message: string };

/** The service. */
export interface FleetService {
  /** Find a token and start polling. */
  start(): Promise<void>;
  /** The snapshot now (a placeholder before the first poll). */
  snapshot(): Snapshot;
  /** A page reports whether it is visible; a hidden → visible flip polls now if due. */
  visibility(visible: boolean): void;
  /** Poll now. */
  refresh(): Promise<void>;
  /** Check a pasted token against GitHub, store it and use it. */
  setToken(token: string): Promise<TokenCheck>;
  /** Try the GitHub CLI again. */
  retryGh(): Promise<boolean>;
  /** Forget the stored token. */
  clearToken(): Promise<void>;
  /** Go on without a token (public data only). */
  usePublic(): Promise<void>;
  /** Called after every poll (and auth change). Returns the unsubscribe. */
  onChange(fn: (snap: Snapshot) => void): () => void;
  /** Webhooks: whether this instance receives them (the receiver is listening). */
  setHooksEnabled(on: boolean, via?: "listener" | "spool"): void;
  /** A verified delivery arrived (any event, ping included): the "last delivery" time. */
  hookVerified(at: number): void;
  /** Apply a verified workflow_job / workflow_run delivery; resolves once it's in the log. */
  applyHook(d: HookDelivery): Promise<void>;
  /**
   * Back-fill the log from the webhook spool: what happened while Fleet was closed, at its real
   * times, never notified. Idempotent (de-duplicated against the log); resolves to the lines added.
   */
  backfill(): Promise<number>;
  /** The event log after `seq` (everything when `seq` is from before a restart of the log). */
  events(seq: number): { events: FleetEvent[]; lastSeq: number };
  /** Log something the user did (a control) to the event log. */
  logAction(event: Omit<NewEvent, "at" | "user">): Promise<void>;
  /** Pause or resume native notifications (conditions are still marked, so resuming is quiet). */
  setNotificationsPaused(paused: boolean): Promise<void>;
  readonly notificationsPaused: boolean;
  /** Persisted app prefs (first launch, start-at-login defaulted). Loaded by `start()`. */
  prefs(): FleetPrefs;
  setPrefs(p: Partial<FleetPrefs>): Promise<void>;
  /** The GitHub client and poller for controls (`null` without a token / before start). */
  github(): { client: GitHubClient; poller: Poller; canWrite: boolean } | null;
  /** Stop the timers. */
  stop(): void;
}

/** Prefs kept in the state file. */
export interface FleetPrefs {
  readonly notificationsPaused?: boolean;
  /** Start at login was turned on once at the first run (never forced again). */
  readonly loginDefaulted?: boolean;
  /** Fleet has launched before (the first launch shows the window). */
  readonly launched?: boolean;
}

/** A token as pasted: trimmed, one line, a plausible GitHub token. */
export function cleanToken(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (t.length < 20 || t.length > 255 || !/^[A-Za-z0-9_]+$/.test(t)) return null;
  return t;
}

/** The service. */
export function createFleetService(deps: ServiceDeps): FleetService {
  const now = deps.now ?? Date.now;
  const setT = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number);
  const clearT = deps.clearTimeout ?? ((id) => clearTimeout(id));
  const startedAt = now();
  const listeners = new Set<(s: Snapshot) => void>();
  let seen: SeenKeys = new Map();
  let durations: Record<string, number[]> = {};
  let poller: Poller | null = null;
  let client: GitHubClient | null = null;
  let auth: AuthState = "pending";
  let timer: number | null = null;
  let lastPoll = -Infinity;
  let polling: Promise<void> | null = null;
  /** When the poll in flight started, and its generation (a dropped stuck poll's result is ignored). */
  let pollingSince = 0;
  let pollGen = 0;
  let pollWatchdog: number | null = null;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let visibleUntil = -Infinity;
  let stopped = false;
  let loading: Promise<void> | null = null;
  /** The log's newest line's time as loaded (before this start): the back-fill starts after it. */
  let logEndAt: number | null = null;
  let backfilling: Promise<number> = Promise.resolve(0);
  let log = new EventLog();
  let tracker: TrackerState = restoreTracker(null, now());
  let prefs: FleetPrefs = {};
  let hooksEnabled = false;
  let hooksVia: "listener" | "spool" = "listener";
  let lastDelivery: number | null = null;
  const hooks = () => hooksState(hooksEnabled, lastDelivery, now());
  /** The agents' snapshot: when its data last changed, and from what. */
  let dataAt: number | null = null;
  let dataSource: "poll" | "hook" = "poll";
  let agentWriting: Promise<void> | null = null;
  let agentDirty = false;
  let heartbeat: number | null = null;
  let journalChain: Promise<void> = Promise.resolve();
  const paused = () => prefs.notificationsPaused === true;

  const visible = () => now() < visibleUntil;
  /** Now on GitHub's clock (the API's Date headers), for comparisons with GitHub's timestamps. */
  const ghNow = () => now() + (client?.clockOffset() ?? 0);
  const plan = () =>
    pollPlan({
      rate: client?.rate() ?? null,
      visible: visible(),
      publicOnly: auth === "public",
      spentLastHour: client?.spentLastHour() ?? 0,
      now: now(),
      hooks: hooks(),
      activeRuns: poller?.activeRuns ?? 0,
    });
  const interval = () => plan().intervalMs;

  const emptySnapshot = (): Snapshot => ({
    at: now(),
    auth,
    poll: {
      ok: true,
      message: "",
      lastSuccessAt: null,
      intervalMs: interval(),
      backoffUntil: null,
      slow: null,
    },
    rate: null,
    health: { state: "unavailable", checkedAt: null, message: "pool health not read yet" },
    pools: [],
    running: [],
    queued: [],
    finished: [],
    alerts: [],
    summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
    repos: [],
    eventSeq: log.lastSeq,
    notificationsPaused: paused(),
    hooks: { state: hooks(), lastDeliveryAt: lastDelivery, via: hooksVia },
  });

  const snapshot = (): Snapshot => {
    if (!poller) return emptySnapshot();
    const pl = plan();
    poller.intervalMs = pl.intervalMs;
    poller.slow = pl.slow;
    poller.auth = auth;
    return {
      ...poller.snapshot(),
      eventSeq: log.lastSeq,
      notificationsPaused: paused(),
      hooks: { state: hooks(), lastDeliveryAt: lastDelivery, via: hooksVia },
    };
  };

  const emit = () => {
    const s = snapshot();
    for (const fn of listeners) {
      try {
        fn(s);
      } catch {
        // A listener's failure is its own.
      }
    }
  };

  const persist = async () => {
    try {
      await deps.save({
        durations: poller?.durations() ?? durations,
        notified: Object.fromEntries(seen),
        prefs,
      });
    } catch {
      // Best effort: the next poll saves again.
    }
  };

  const use = (token: string | null, state: AuthState) => {
    client = createGitHubClient({
      token,
      fetch: deps.fetch,
      now,
      ...(deps.requestTimeoutMs ? { timeoutMs: deps.requestTimeoutMs } : {}),
    });
    if (poller) durations = poller.durations();
    poller = new Poller({
      client,
      auth: state,
      now,
      durations,
      publicOnly: token === null,
      ...(deps.localHealth ? { localHealth: deps.localHealth } : {}),
    });
    auth = state;
    lastPoll = -Infinity;
  };

  const schedule = () => {
    if (stopped) return;
    if (timer !== null) clearT(timer);
    timer = null;
    if (!poller) return;
    const backoff = client?.backoffUntil() ?? null;
    const pl = plan();
    let due = Math.max(lastPoll + pl.intervalMs, backoff ?? 0, pl.notBefore ?? 0);
    // Missed-delivery guard: with runs active, poll as soon as the hooks go quiet for 10 min.
    if (hooks() === "live" && (poller?.activeRuns ?? 0) > 0 && lastDelivery !== null) {
      due = Math.max(Math.min(due, lastDelivery + HOOKS_STALE_MS), backoff ?? 0, pl.notBefore ?? 0);
    }
    timer = setT(() => {
      timer = null;
      void pollNow();
    }, Math.max(250, due - now()));
  };

  /** Append newly numbered events to the journal, in order. */
  const journal = (added: readonly FleetEvent[]): Promise<void> => {
    if (!deps.appendJournal || added.length === 0) return journalChain;
    const append = deps.appendJournal;
    journalChain = journalChain.then(() => append(added)).catch(() => {});
    return journalChain;
  };

  const agentSnapshot = (): AgentSnapshot =>
    buildAgentSnapshot({
      now: now(),
      updatedAt: dataAt ?? startedAt,
      source: dataSource,
      snapshot: snapshot(),
      hosts: poller?.hosts() ?? {},
      runs: poller?.knownRuns() ?? [],
      annotations: poller?.annotations ?? new Map(),
    });

  /** Re-arm the heartbeat: the file is rewritten (`written_at`) at least once a minute. */
  const beat = () => {
    if (!deps.saveAgentSnapshot || stopped) return;
    if (heartbeat !== null) clearT(heartbeat);
    heartbeat = setT(() => {
      heartbeat = null;
      void writeAgent();
    }, AGENT_HEARTBEAT_MS);
  };

  /** Write the agents' snapshot; writes asked for meanwhile coalesce into one more. */
  const writeAgent = (): Promise<void> => {
    const save = deps.saveAgentSnapshot;
    if (!save) return Promise.resolve();
    if (agentWriting) {
      agentDirty = true;
      return agentWriting;
    }
    agentWriting = (async () => {
      do {
        agentDirty = false;
        try {
          await save(agentSnapshot());
        } catch {
          // Best effort: the next update or heartbeat writes again.
        }
      } while (agentDirty);
    })().finally(() => {
      agentWriting = null;
      beat();
    });
    return agentWriting;
  };

  /** Diff the poller's state into the event log (after a poll or a webhook). */
  const recordEvents = async (p: Poller) => {
    // A job line the back-fill already logged (at its real time) isn't logged again.
    const added = log.append(dropLogged(diffObservation(tracker, p.observation()), log.after(0)));
    p.consumeFinished();
    await saveLog();
    await journal(added);
  };

  const notifyAndPersist = async () => {
    const snap = snapshot();
    for (const n of pendingNotifications(snap, seen, startedAt)) {
      if (paused()) continue; // marked seen all the same: resuming doesn't replay them
      try {
        await deps.notify(n);
      } catch {
        // A notification that can't be posted is dropped, never retried into a duplicate.
      }
    }
    await persist();
  };

  /** Webhook deliveries are applied one at a time, in arrival order. */
  let hookChain: Promise<void> = Promise.resolve();

  const pollNow = (): Promise<void> => {
    if (polling) {
      if (now() - pollingSince < POLL_STUCK_MS) return polling;
      warn(
        `fleet: a poll ran over ${POLL_STUCK_MS / 60_000} min; dropped it and polling again`,
      );
      polling = null;
    }
    if (pollWatchdog !== null) clearT(pollWatchdog);
    pollWatchdog = null;
    if (!poller) return Promise.resolve();
    // Under the rate floor nothing polls until the reset (the runner scheduler needs the budget).
    const nb = plan().notBefore;
    if (nb !== null && now() < nb) {
      emit();
      schedule();
      return Promise.resolve();
    }
    const p = poller;
    const gen = ++pollGen;
    pollingSince = now();
    // Belt and braces: if this poll never settles, the watchdog drops it and polls again.
    pollWatchdog = stopped ? null : setT(() => {
      pollWatchdog = null;
      void pollNow();
    }, POLL_STUCK_MS + 1000);
    const current = (async () => {
      lastPoll = now();
      const r = await p.poll();
      if (gen !== pollGen) return; // dropped as stuck: a newer poll owns the state
      if (p !== poller) return; // the token changed meanwhile
      if (r.authFailed) {
        auth = "invalid";
        poller = null;
      } else {
        if (r.ok) {
          await recordEvents(p);
          dataAt = now();
          dataSource = "poll";
        }
        await notifyAndPersist();
      }
      await writeAgent();
      emit();
    })().finally(() => {
      if (gen !== pollGen) return;
      if (pollWatchdog !== null) clearT(pollWatchdog);
      pollWatchdog = null;
      polling = null;
      schedule();
    });
    polling = current;
    return current;
  };

  const loadState = () => loading ??= loadStateOnce();
  const loadStateOnce = async () => {
    const s = await deps.load().catch(() => null);
    if (s) {
      durations = s.durations ?? {};
      seen = new Map(Object.entries(s.notified ?? {}).filter(([, v]) => typeof v === "number"));
      prefs = { ...(s.prefs ?? {}) };
    }
    const l = await deps.loadLog?.().catch(() => null) as
      | { log?: unknown; tracker?: unknown }
      | null;
    log = EventLog.from(l?.log ?? null);
    // The journal outlives a lost or garbled log file: never number below its last line.
    const journaled = await deps.journalLastSeq?.().catch(() => 0) ?? 0;
    if (journaled > log.lastSeq) log = EventLog.from({ ...log.toJSON(), seq: journaled });
    tracker = restoreTracker(l?.tracker ?? null, now());
    const held = log.after(0);
    logEndAt = held.length ? Math.max(...held.map((e) => e.at)) : null;
  };

  /** One back-fill at a time (startup and the spool's discovery may ask together). */
  const backfill = (): Promise<number> => {
    backfilling = backfilling.then(async () => {
      if (!deps.readSpool) return 0;
      await loadState();
      const opts = { since: logEndAt, now: now() };
      const deliveries = await deps.readSpool(backfillFrom(opts)).catch(() => []);
      const lines = backfillEvents(deliveries, log.after(0), opts);
      if (lines.length === 0) return 0;
      const added = log.insert(lines);
      await saveLog();
      await journal(added);
      emit();
      return added.length;
    }).catch(() => 0);
    return backfilling;
  };

  const saveLog = async () => {
    try {
      await deps.saveLog?.({ log: log.toJSON(), tracker });
    } catch {
      // Best effort: the next poll saves again.
    }
  };

  const tryGh = async (): Promise<boolean> => {
    const t = await deps.ghToken().catch(() => null);
    if (!t) return false;
    use(t, "gh");
    return true;
  };

  /** Check a token cheaply: `GET /rate_limit` costs no rate limit. */
  const check = async (token: string): Promise<TokenCheck> => {
    const c = createGitHubClient({
      token,
      fetch: deps.fetch,
      now,
      ...(deps.requestTimeoutMs ? { timeoutMs: deps.requestTimeoutMs } : {}),
    });
    try {
      await c.get("/rate_limit");
      return { ok: true };
    } catch (err) {
      const kind = (err as { kind?: string }).kind;
      return {
        ok: false,
        message: kind === "auth"
          ? "GitHub refused that token."
          : "Couldn't reach GitHub to check it.",
      };
    }
  };

  return {
    async start() {
      await loadState();
      await backfill();
      if (!(await tryGh())) {
        const stored = await deps.secrets.get(TOKEN_KEY).catch(() => null);
        if (stored) use(stored, "stored");
        else auth = "needs-token";
      }
      emit();
      if (poller) await pollNow();
      else await writeAgent();
    },
    snapshot,
    visibility(v) {
      const wasVisible = visible();
      visibleUntil = v ? now() + VISIBLE_TTL_MS : -Infinity;
      if (v && !wasVisible) {
        if (now() - lastPoll >= interval()) void pollNow();
        else schedule();
      }
    },
    refresh: () => pollNow(),
    async setToken(raw) {
      const token = cleanToken(raw);
      if (!token) return { ok: false, message: "That doesn't look like a GitHub token." };
      const r = await check(token);
      if (!r.ok) return r;
      await deps.secrets.set(TOKEN_KEY, token);
      use(token, "stored");
      emit();
      void pollNow();
      return { ok: true };
    },
    async retryGh() {
      const ok = await tryGh();
      emit();
      if (ok) void pollNow();
      return ok;
    },
    async clearToken() {
      await deps.secrets.delete(TOKEN_KEY).catch(() => {});
      if (auth === "stored" || auth === "invalid") {
        poller = null;
        client = null;
        auth = "needs-token";
        if (timer !== null) clearT(timer);
        timer = null;
      }
      emit();
    },
    async usePublic() {
      use(null, "public");
      emit();
      await pollNow();
    },
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    setHooksEnabled(on, how = "listener") {
      hooksEnabled = on;
      hooksVia = how;
      emit();
      schedule();
    },
    hookVerified(at) {
      lastDelivery = at;
    },
    applyHook(d) {
      hookChain = hookChain.then(async () => {
        lastDelivery = Math.max(lastDelivery ?? 0, d.receivedAt);
        // A replay (its newest timestamp over 10 min old on GitHub's clock) changes nothing.
        if (isStaleDelivery(d.event, d.payload, ghNow())) return;
        const p = poller;
        if (!p || !p.applyHook(d)) return;
        await recordEvents(p);
        dataAt = now();
        dataSource = "hook";
        await notifyAndPersist();
        await writeAgent();
        emit();
        schedule();
      }).catch(() => {});
      return hookChain;
    },
    backfill,
    events: (seq) => ({ events: log.after(seq), lastSeq: log.lastSeq }),
    async logAction(e) {
      const added = log.append([{ ...e, at: now(), user: true }]);
      await saveLog();
      await journal(added);
      emit();
    },
    async setNotificationsPaused(v) {
      prefs = { ...prefs, notificationsPaused: v };
      await persist();
      emit();
    },
    get notificationsPaused() {
      return paused();
    },
    prefs: () => prefs,
    async setPrefs(p) {
      prefs = { ...prefs, ...p };
      await persist();
    },
    github: () => (client && poller ? { client, poller, canWrite: auth !== "public" } : null),
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
      if (heartbeat !== null) clearT(heartbeat);
      heartbeat = null;
      if (pollWatchdog !== null) clearT(pollWatchdog);
      pollWatchdog = null;
    },
  };
}
