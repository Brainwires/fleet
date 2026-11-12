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
import { type HookDelivery, HOOKS_STALE_MS, hooksState } from "./hooks.ts";
/** A page that hasn't said it's visible for this long counts as hidden (it may be suspended). */
export const VISIBLE_TTL_MS = 30_000;
/** The secure-store key of a pasted token. */
export const TOKEN_KEY = "github-token";

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
  readonly setTimeout?: (fn: () => void, ms: number) => number;
  readonly clearTimeout?: (id: number) => void;
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
  setHooksEnabled(on: boolean): void;
  /** A verified delivery arrived (any event, ping included): the "last delivery" time. */
  hookVerified(at: number): void;
  /** Apply a verified workflow_job / workflow_run delivery; resolves once it's in the log. */
  applyHook(d: HookDelivery): Promise<void>;
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
  let visibleUntil = -Infinity;
  let stopped = false;
  let loaded = false;
  let log = new EventLog();
  let tracker: TrackerState = restoreTracker(null, now());
  let prefs: FleetPrefs = {};
  let hooksEnabled = false;
  let lastDelivery: number | null = null;
  const hooks = () => hooksState(hooksEnabled, lastDelivery, now());
  const paused = () => prefs.notificationsPaused === true;

  const visible = () => now() < visibleUntil;
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
    hooks: { state: hooks(), lastDeliveryAt: lastDelivery },
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
      hooks: { state: hooks(), lastDeliveryAt: lastDelivery },
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
    client = createGitHubClient({ token, fetch: deps.fetch, now });
    if (poller) durations = poller.durations();
    poller = new Poller({ client, auth: state, now, durations, publicOnly: token === null });
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

  /** Diff the poller's state into the event log (after a poll or a webhook). */
  const recordEvents = async (p: Poller) => {
    log.append(diffObservation(tracker, p.observation()));
    p.consumeFinished();
    await saveLog();
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
    if (polling) return polling;
    if (!poller) return Promise.resolve();
    // Under the rate floor nothing polls until the reset (the runner scheduler needs the budget).
    const nb = plan().notBefore;
    if (nb !== null && now() < nb) {
      emit();
      schedule();
      return Promise.resolve();
    }
    const p = poller;
    polling = (async () => {
      lastPoll = now();
      const r = await p.poll();
      if (p !== poller) return; // the token changed meanwhile
      if (r.authFailed) {
        auth = "invalid";
        poller = null;
      } else {
        if (r.ok) await recordEvents(p);
        await notifyAndPersist();
      }
      emit();
    })().finally(() => {
      polling = null;
      schedule();
    });
    return polling;
  };

  const loadState = async () => {
    if (loaded) return;
    loaded = true;
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
    tracker = restoreTracker(l?.tracker ?? null, now());
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
    const c = createGitHubClient({ token, fetch: deps.fetch, now });
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
      if (!(await tryGh())) {
        const stored = await deps.secrets.get(TOKEN_KEY).catch(() => null);
        if (stored) use(stored, "stored");
        else auth = "needs-token";
      }
      emit();
      if (poller) await pollNow();
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
    setHooksEnabled(on) {
      hooksEnabled = on;
      emit();
      schedule();
    },
    hookVerified(at) {
      lastDelivery = at;
    },
    applyHook(d) {
      hookChain = hookChain.then(async () => {
        lastDelivery = Math.max(lastDelivery ?? 0, d.receivedAt);
        const p = poller;
        if (!p || !p.applyHook(d)) return;
        await recordEvents(p);
        await notifyAndPersist();
        emit();
        schedule();
      }).catch(() => {});
      return hookChain;
    },
    events: (seq) => ({ events: log.after(seq), lastSeq: log.lastSeq }),
    async logAction(e) {
      log.append([{ ...e, at: now(), user: true }]);
      await saveLog();
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
    stop() {
      stopped = true;
      if (timer !== null) clearT(timer);
      timer = null;
    },
  };
}
