// Fleet's settings: who and what it watches, which branches are protected and how, where pools come
// from, notifications, start at login, webhooks, and the optional integrations. A typed, versioned
// document kept as `fleet-settings.json` (0600) in the app's data folder, validated on every read
// and write. Pure: the file comes in as a value (lib/deno-host.ts reads and writes it).
//
// The defaults name nobody's infrastructure: no owner, every repo of the owners chosen in the first-
// run wizard, each repo's own default branch protected (cancel / duplicate dispatch warn), pools
// grouped from the owners' self-hosted runners, webhooks off, start at login off, no integrations.
//
// The active settings are module state (like the pool list in lib/pools.ts): `applySettings` swaps
// them, and every reader (the poller, classification, guardrails, notifications) follows.

/** The schema version this build reads and writes. */
export const SETTINGS_VERSION = 1;
/** The settings file, in the app's data folder. */
export const SETTINGS_FILE = "fleet-settings.json";
/**
 * A machine's own config, next to it (never in the repo): a complete settings document read once,
 * when there is no settings file yet. Lets a team ship its integrations to a machine without the
 * first-run wizard (README → Settings).
 */
export const LOCAL_CONFIG_FILE = "fleet-local-config.json";

/** What a guardrail does when it matches. */
export type Policy = "warn" | "refuse";
/** What the duplicate-dispatch check does on a branch no rule protects. */
export type OtherPolicy = "allow" | "warn" | "refuse";

/** An account Fleet watches: an organization or a user. */
export interface OwnerSetting {
  readonly login: string;
  readonly kind: "org" | "user";
}

/** The match a branch rule uses for "the repo's own default branch". */
export const DEFAULT_BRANCH_TOKEN = ":default";

/** One protected-branch rule. */
export interface BranchRule {
  /**
   * {@linkcode DEFAULT_BRANCH_TOKEN} (each repo's default branch, from the API), an exact branch
   * name, or a pattern with `*` (any run of characters, `/` included).
   */
  readonly branch: string;
  /** `owner/name`; absent: every watched repo. */
  readonly repo?: string;
  /** Cancelling a run on the branch. */
  readonly cancel: Policy;
  /** Dispatching a workflow on a commit that already has a run of it. */
  readonly duplicateDispatch: Policy;
}

/** A self-hosted pool, declared rather than grouped from the runners. */
export interface PoolDefSetting {
  /** The short name the card shows. */
  readonly id: string;
  /** The runs-on label jobs target it with. */
  readonly label: string;
  /** The runner-name prefix its runners register with, when it has one. */
  readonly runnerPrefix?: string;
  /** Its slot count, when known. */
  readonly slots?: number | null;
  /**
   * The machine it runs on, when several pools share one (their capacity is shared): the pool
   * detail screen shows their combined usage. Absent: a machine of its own.
   */
  readonly host?: string;
}

/**
 * A workflow whose GitHub-hosted job only hosts a self-hosted runner for a while: long-lived by
 * design, so it never warns. Its real work shows up as a job on a runner named
 * `<runnerPrefix><slot>-…`, counted in `pool`.
 */
export interface RunnerHostRule {
  readonly repo: string;
  readonly workflow: string;
  readonly runnerPrefix: string;
  readonly pool: string;
}

/** Where the webhook secret is read from. */
export type WebhookSecretSource =
  | { readonly source: "macos-keychain"; readonly service: string; readonly account: string }
  | { readonly source: "secure-store" };

/** GitHub webhooks (docs/webhooks.md). */
export interface WebhookSettings {
  readonly enabled: boolean;
  /** The loopback port the receiver listens on. */
  readonly port: number;
  /** The spool folder (`~/` allowed); `""`: `hooks/` in the app's data folder. */
  readonly spoolDir: string;
  readonly secret: WebhookSecretSource;
  /**
   * A launchd label whose job file must exist before webhooks turn on (the public endpoint's
   * tunnel, macOS); `""`: none required.
   */
  readonly requireLaunchdJob: string;
}

/** The runner scheduler's pool commands (absolute paths, `~/` allowed). */
export interface SchedulerControls {
  /** `pause-pool.sh <pool> --seconds N [reason]` / `pause-pool.sh --resume <pool>`. */
  readonly pausePool: string;
  /** One watchdog pass; `""`: not offered. */
  readonly watchdog: string;
  /** The scheduler's launchd label (Restart scheduler: `launchctl kickstart -k`); `""`: none. */
  readonly launchdLabel: string;
}

/**
 * A self-hosted runner scheduler Fleet works with: its pools (the first render's list, slot counts,
 * runner prefixes), its naming, the watchdog's local health file and the pool controls. Inactive
 * unless configured.
 */
export interface RunnerSchedulerIntegration {
  readonly pools: readonly PoolDefSetting[];
  /** Runner names are `<runnerNamePrefix><pool>-<slot>-<epoch>`; `""`: no such naming. */
  readonly runnerNamePrefix: string;
  /** A runs-on label with this prefix targets one of its pools (even an unlisted one). */
  readonly labelPrefix: string;
  /** The watchdog's local health file (`~/` allowed), fresher than the variable; `""`: none. */
  readonly localHealthFile: string;
  /** The folder of the scheduler's `paused-<pool>` files; `""`: none. */
  readonly pausedDir: string;
  /**
   * The scheduler's log folder (`~/` allowed): `jobs/<pool>-<slot>-<epoch>.log` launcher logs,
   * `scheduler.log`, `alerts.log`; read-only, for the pool detail's Logs tab. `""`: none.
   */
  readonly logsDir: string;
  readonly controls: SchedulerControls | null;
}

/** The pool-health variable (an org Actions variable, docs/pool-health.md). */
export interface PoolHealthVariable {
  readonly org: string;
  readonly name: string;
}

/** The settings document. */
export interface FleetSettings {
  readonly v: 1;
  /** The first-run wizard finished (or the settings came from a local config). */
  readonly setupComplete: boolean;
  readonly owners: readonly OwnerSetting[];
  readonly repos: {
    /** Only these `owner/name` repos (empty: every repo of the owners). */
    readonly allow: readonly string[];
    /** Never these. */
    readonly deny: readonly string[];
    /** Always polled, every round, first in the lanes, in this order. */
    readonly pinned: readonly string[];
  };
  readonly branches: {
    readonly rules: readonly BranchRule[];
    /** Duplicate dispatch on a branch no rule protects. */
    readonly otherDuplicateDispatch: OtherPolicy;
  };
  readonly pools: {
    /** The pool list and health from this variable; `null`: grouped from the runners' labels. */
    readonly healthVariable: PoolHealthVariable | null;
  };
  readonly runnerHosts: readonly RunnerHostRule[];
  readonly notifications: {
    readonly poolUnhealthy: boolean;
    readonly queuedLong: boolean;
    readonly protectedFailure: boolean;
  };
  /** Start Fleet at login (applied when changed in the wizard, the Settings view or the tray). */
  readonly startAtLogin: boolean;
  readonly webhooks: WebhookSettings;
  readonly integrations: {
    readonly runnerScheduler: RunnerSchedulerIntegration | null;
  };
}

/** The defaults: nobody's infrastructure (tests/settings.test.ts checks). */
export const DEFAULT_SETTINGS: FleetSettings = Object.freeze({
  v: 1,
  setupComplete: false,
  owners: [],
  repos: { allow: [], deny: [], pinned: [] },
  branches: {
    rules: [{ branch: DEFAULT_BRANCH_TOKEN, cancel: "warn", duplicateDispatch: "warn" }],
    otherDuplicateDispatch: "warn",
  },
  pools: { healthVariable: null },
  runnerHosts: [],
  notifications: { poolUnhealthy: true, queuedLong: true, protectedFailure: true },
  startAtLogin: false,
  webhooks: {
    enabled: false,
    port: 8789,
    spoolDir: "",
    secret: { source: "secure-store" },
    requireLaunchdJob: "",
  },
  integrations: { runnerScheduler: null },
}) as FleetSettings;

// ---- validation ----

/** A validation result: the normalized settings, or every problem found. */
export type SettingsResult =
  | { readonly ok: true; readonly settings: FleetSettings }
  | { readonly ok: false; readonly errors: readonly string[] };

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[\w.-]{1,100}\/[\w.-]{1,100}$/;
const BRANCH = /^[\w./*-]{1,200}$/;
const NAME = /^[\w.:-]{1,100}$/;
const LABEL_ID = /^[\w.-]{1,200}$/;
const KEYCHAIN = /^[\w.@ -]{1,100}$/;
const VARIABLE = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** A path setting: absolute or `~/`-relative, one line, no `..` segment. */
export function validPath(p: string): boolean {
  if (p.length === 0 || p.length > 1024 || /[\0\r\n]/.test(p)) return false;
  if (!(p.startsWith("/") || p.startsWith("~/") || /^[A-Za-z]:\\/.test(p))) return false;
  return !p.split(/[\\/]/).includes("..");
}

/** A repo name GitHub would accept (and nothing that could reach a path or shell). */
export function validRepoName(repo: unknown): repo is string {
  return typeof repo === "string" && REPO.test(repo) && !repo.includes("..");
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A small reader that collects errors with the field's path. */
class Reader {
  readonly errors: string[] = [];
  err(path: string, msg: string): void {
    this.errors.push(`${path}: ${msg}`);
  }
  obj(v: unknown, path: string): Record<string, unknown> {
    if (v === undefined) return {};
    if (!isObj(v)) {
      this.err(path, "must be an object");
      return {};
    }
    return v;
  }
  bool(v: unknown, path: string, dflt: boolean): boolean {
    if (v === undefined) return dflt;
    if (typeof v !== "boolean") this.err(path, "must be true or false");
    return typeof v === "boolean" ? v : dflt;
  }
  str(v: unknown, path: string, dflt: string, ok: (s: string) => boolean, what: string): string {
    if (v === undefined) return dflt;
    if (typeof v !== "string" || !(v === "" || ok(v))) {
      this.err(path, what);
      return dflt;
    }
    return v;
  }
  /** A required non-empty string. */
  req(v: unknown, path: string, ok: (s: string) => boolean, what: string): string | null {
    if (typeof v !== "string" || !ok(v)) {
      this.err(path, what);
      return null;
    }
    return v;
  }
  oneOf<T extends string>(v: unknown, path: string, options: readonly T[], dflt: T): T {
    if (v === undefined) return dflt;
    if (typeof v !== "string" || !options.includes(v as T)) {
      this.err(path, `must be one of ${options.join(", ")}`);
      return dflt;
    }
    return v as T;
  }
  list<T>(
    v: unknown,
    path: string,
    max: number,
    item: (x: unknown, p: string) => T | null,
  ): T[] {
    if (v === undefined) return [];
    if (!Array.isArray(v)) {
      this.err(path, "must be a list");
      return [];
    }
    if (v.length > max) this.err(path, `at most ${max} entries`);
    const out: T[] = [];
    v.slice(0, max).forEach((x, i) => {
      const r = item(x, `${path}[${i}]`);
      if (r !== null) out.push(r);
    });
    return out;
  }
}

/** Unique by `key`, case-insensitively, first wins. */
function unique<T>(items: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((t) => {
    const k = key(t).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function readPoolDef(r: Reader, x: unknown, p: string): PoolDefSetting | null {
  if (!isObj(x)) return (r.err(p, "must be an object"), null);
  const id = r.req(x.id, `${p}.id`, (s) => LABEL_ID.test(s), "a pool name (letters, digits, .-_)");
  const label = r.req(x.label, `${p}.label`, (s) => NAME.test(s), "a runs-on label");
  const runnerPrefix = r.str(
    x.runnerPrefix,
    `${p}.runnerPrefix`,
    "",
    (s) => LABEL_ID.test(s),
    "a runner-name prefix",
  );
  let slots: number | null = null;
  if (x.slots !== undefined && x.slots !== null) {
    if (
      typeof x.slots !== "number" || !Number.isInteger(x.slots) || x.slots < 0 || x.slots > 1000
    ) {
      r.err(`${p}.slots`, "a whole number from 0 to 1000");
    } else slots = x.slots;
  }
  const host = r.str(x.host, `${p}.host`, "", (s) => LABEL_ID.test(s), "a machine name");
  if (!id || !label) return null;
  return { id, label, ...(runnerPrefix ? { runnerPrefix } : {}), slots, ...(host ? { host } : {}) };
}

/**
 * Validate and normalize a settings document (missing sections take their defaults; a present field
 * of the wrong shape is an error). A document of another version is refused, never guessed at.
 */
export function validateSettings(raw: unknown): SettingsResult {
  const migrated = migrateSettings(raw);
  if (!migrated.ok) return migrated;
  const doc = migrated.doc;
  const r = new Reader();
  const d = DEFAULT_SETTINGS;

  const owners = unique(
    r.list(doc.owners, "owners", 20, (x, p) => {
      if (!isObj(x)) return (r.err(p, "must be an object"), null);
      const login = r.req(x.login, `${p}.login`, (s) => LOGIN.test(s), "a GitHub login");
      const kind = r.oneOf(x.kind, `${p}.kind`, ["org", "user"] as const, "org");
      return login ? { login, kind } : null;
    }),
    (o) => o.login,
  );

  const repoList = (v: unknown, p: string) =>
    unique(
      r.list(v, p, 500, (x, q) => r.req(x, q, (s) => validRepoName(s), "an owner/name repo")),
      (s) => s,
    );
  const ro = r.obj(doc.repos, "repos");
  const repos = {
    allow: repoList(ro.allow, "repos.allow"),
    deny: repoList(ro.deny, "repos.deny"),
    pinned: repoList(ro.pinned, "repos.pinned"),
  };

  const bo = r.obj(doc.branches, "branches");
  const policies = ["warn", "refuse"] as const;
  const rules = bo.rules === undefined ? [...d.branches.rules] : r.list(
    bo.rules,
    "branches.rules",
    100,
    (x, p) => {
      if (!isObj(x)) return (r.err(p, "must be an object"), null);
      const branch = r.req(
        x.branch,
        `${p}.branch`,
        (s) => s === DEFAULT_BRANCH_TOKEN || (BRANCH.test(s) && !s.includes("..")),
        `${DEFAULT_BRANCH_TOKEN}, a branch name, or a pattern with *`,
      );
      const repo = x.repo === undefined
        ? undefined
        : r.req(x.repo, `${p}.repo`, (s) => validRepoName(s), "an owner/name repo");
      const cancel = r.oneOf(x.cancel, `${p}.cancel`, policies, "warn");
      const duplicateDispatch = r.oneOf(
        x.duplicateDispatch,
        `${p}.duplicateDispatch`,
        policies,
        "warn",
      );
      if (!branch || repo === null) return null;
      return { branch, ...(repo ? { repo } : {}), cancel, duplicateDispatch };
    },
  );
  const branches = {
    rules,
    otherDuplicateDispatch: r.oneOf(
      bo.otherDuplicateDispatch,
      "branches.otherDuplicateDispatch",
      ["allow", "warn", "refuse"] as const,
      d.branches.otherDuplicateDispatch,
    ),
  };

  const po = r.obj(doc.pools, "pools");
  let healthVariable: PoolHealthVariable | null = null;
  if (po.healthVariable !== undefined && po.healthVariable !== null) {
    const hv = r.obj(po.healthVariable, "pools.healthVariable");
    const org = r.req(hv.org, "pools.healthVariable.org", (s) => LOGIN.test(s), "a GitHub org");
    const name = r.req(
      hv.name,
      "pools.healthVariable.name",
      (s) => VARIABLE.test(s),
      "an Actions variable name",
    );
    if (org && name) healthVariable = { org, name };
  }

  const runnerHosts = r.list(doc.runnerHosts, "runnerHosts", 50, (x, p) => {
    if (!isObj(x)) return (r.err(p, "must be an object"), null);
    const repo = r.req(x.repo, `${p}.repo`, (s) => validRepoName(s), "an owner/name repo");
    const workflow = r.req(
      x.workflow,
      `${p}.workflow`,
      (s) => s.length > 0 && s.length <= 200 && !/[\p{Cc}]/u.test(s),
      "a workflow name",
    );
    const runnerPrefix = r.req(
      x.runnerPrefix,
      `${p}.runnerPrefix`,
      (s) => LABEL_ID.test(s),
      "a runner-name prefix",
    );
    const pool = r.req(x.pool, `${p}.pool`, (s) => LABEL_ID.test(s), "a pool name");
    return repo && workflow && runnerPrefix && pool ? { repo, workflow, runnerPrefix, pool } : null;
  });

  const no = r.obj(doc.notifications, "notifications");
  const notifications = {
    poolUnhealthy: r.bool(no.poolUnhealthy, "notifications.poolUnhealthy", true),
    queuedLong: r.bool(no.queuedLong, "notifications.queuedLong", true),
    protectedFailure: r.bool(no.protectedFailure, "notifications.protectedFailure", true),
  };

  const wo = r.obj(doc.webhooks, "webhooks");
  let port = d.webhooks.port;
  if (wo.port !== undefined) {
    if (
      typeof wo.port !== "number" || !Number.isInteger(wo.port) || wo.port < 1024 ||
      wo.port > 65535
    ) {
      r.err("webhooks.port", "a port from 1024 to 65535");
    } else port = wo.port;
  }
  let secret: WebhookSecretSource = d.webhooks.secret;
  if (wo.secret !== undefined) {
    const so = r.obj(wo.secret, "webhooks.secret");
    const source = r.oneOf(
      so.source,
      "webhooks.secret.source",
      ["macos-keychain", "secure-store"] as const,
      "secure-store",
    );
    if (source === "macos-keychain") {
      const service = r.req(
        so.service,
        "webhooks.secret.service",
        (s) => KEYCHAIN.test(s),
        "a keychain service name",
      );
      const account = r.req(
        so.account,
        "webhooks.secret.account",
        (s) => KEYCHAIN.test(s),
        "a keychain account name",
      );
      if (service && account) secret = { source, service, account };
    } else secret = { source };
  }
  const webhooks: WebhookSettings = {
    enabled: r.bool(wo.enabled, "webhooks.enabled", false),
    port,
    spoolDir: r.str(wo.spoolDir, "webhooks.spoolDir", "", validPath, "an absolute or ~/ path"),
    secret,
    requireLaunchdJob: r.str(
      wo.requireLaunchdJob,
      "webhooks.requireLaunchdJob",
      "",
      (s) => LABEL_ID.test(s),
      "a launchd label",
    ),
  };

  const io = r.obj(doc.integrations, "integrations");
  let runnerScheduler: RunnerSchedulerIntegration | null = null;
  if (io.runnerScheduler !== undefined && io.runnerScheduler !== null) {
    const p = "integrations.runnerScheduler";
    const so = r.obj(io.runnerScheduler, p);
    const pools = unique(
      r.list(so.pools, `${p}.pools`, 100, (x, q) => readPoolDef(r, x, q)),
      (x) => x.id,
    );
    let controls: SchedulerControls | null = null;
    if (so.controls !== undefined && so.controls !== null) {
      const co = r.obj(so.controls, `${p}.controls`);
      const pausePool = r.req(co.pausePool, `${p}.controls.pausePool`, validPath, "a path");
      const watchdog = r.str(co.watchdog, `${p}.controls.watchdog`, "", validPath, "a path");
      const launchdLabel = r.str(
        co.launchdLabel,
        `${p}.controls.launchdLabel`,
        "",
        (s) => LABEL_ID.test(s),
        "a launchd label",
      );
      if (pausePool) controls = { pausePool, watchdog, launchdLabel };
    }
    runnerScheduler = {
      pools,
      runnerNamePrefix: r.str(
        so.runnerNamePrefix,
        `${p}.runnerNamePrefix`,
        "",
        (s) => LABEL_ID.test(s),
        "a runner-name prefix",
      ),
      labelPrefix: r.str(
        so.labelPrefix,
        `${p}.labelPrefix`,
        "",
        (s) => NAME.test(s),
        "a label prefix",
      ),
      localHealthFile: r.str(
        so.localHealthFile,
        `${p}.localHealthFile`,
        "",
        validPath,
        "an absolute or ~/ path",
      ),
      pausedDir: r.str(so.pausedDir, `${p}.pausedDir`, "", validPath, "an absolute or ~/ path"),
      logsDir: r.str(so.logsDir, `${p}.logsDir`, "", validPath, "an absolute or ~/ path"),
      controls,
    };
  }

  const setupComplete = r.bool(doc.setupComplete, "setupComplete", false);
  const startAtLogin = r.bool(doc.startAtLogin, "startAtLogin", false);
  if (r.errors.length) return { ok: false, errors: r.errors };
  return {
    ok: true,
    settings: {
      v: 1,
      setupComplete,
      owners,
      repos,
      branches,
      pools: { healthVariable },
      runnerHosts,
      notifications,
      startAtLogin,
      webhooks,
      integrations: { runnerScheduler },
    },
  };
}

/**
 * Bring an older document up to {@linkcode SETTINGS_VERSION} (each step one version). Version 1 is
 * the first; a newer version than this build knows is refused (a downgrade must not rewrite it).
 */
export function migrateSettings(
  raw: unknown,
): { ok: true; doc: Record<string, unknown> } | { ok: false; errors: string[] } {
  if (!isObj(raw)) return { ok: false, errors: ["settings: must be an object"] };
  const v = raw.v;
  if (v === SETTINGS_VERSION) return { ok: true, doc: raw };
  if (typeof v === "number" && v > SETTINGS_VERSION) {
    return {
      ok: false,
      errors: [`v: settings version ${v} is newer than this Fleet (${SETTINGS_VERSION})`],
    };
  }
  return { ok: false, errors: [`v: unknown settings version ${String(v)}`] };
}

// ---- startup: which settings to use ----

/** Where the startup settings came from. */
export type SettingsOrigin = "file" | "local-config" | "defaults";

/** What startup decided. */
export interface StartupSettings {
  readonly settings: FleetSettings;
  readonly origin: SettingsOrigin;
  /** Write `settings` to the settings file now (seeded from the local config). */
  readonly write: boolean;
  /** Problems with a file that was there (shown once in the console; never the values). */
  readonly problems: readonly string[];
}

/**
 * The settings to start with:
 * 1. the settings file, when it parses;
 * 2. else the machine's local config ({@linkcode LOCAL_CONFIG_FILE}), marked set up and written to
 *    the settings file (an existing install keeps working with no wizard);
 * 3. else the defaults (the first-run wizard shows). A settings file that doesn't parse is never
 *    overwritten until the user saves new settings.
 */
export function startupSettings(input: {
  readonly settingsRaw: unknown;
  readonly localConfigRaw: unknown;
}): StartupSettings {
  const problems: string[] = [];
  if (input.settingsRaw !== null && input.settingsRaw !== undefined) {
    const r = validateSettings(input.settingsRaw);
    if (r.ok) return { settings: r.settings, origin: "file", write: false, problems };
    problems.push(...r.errors.map((e) => `${SETTINGS_FILE}: ${e}`));
  }
  if (input.localConfigRaw !== null && input.localConfigRaw !== undefined) {
    const r = validateSettings(input.localConfigRaw);
    if (r.ok) {
      return {
        settings: { ...r.settings, setupComplete: true },
        origin: "local-config",
        write: problems.length === 0,
        problems,
      };
    }
    problems.push(...r.errors.map((e) => `${LOCAL_CONFIG_FILE}: ${e}`));
  }
  return { settings: DEFAULT_SETTINGS, origin: "defaults", write: false, problems };
}

// ---- the active settings ----

let active: FleetSettings = DEFAULT_SETTINGS;
const listeners = new Set<(s: FleetSettings) => void>();

/** The settings in force. */
export function settings(): FleetSettings {
  return active;
}

/** Put settings in force (already validated); listeners (the pool list) follow. */
export function applySettings(s: FleetSettings): void {
  active = s;
  for (const fn of listeners) fn(s);
}

/** Follow every `applySettings`. Returns the unsubscribe. */
export function onSettingsApplied(fn: (s: FleetSettings) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The watched owners' logins. */
export function ownerLogins(s: FleetSettings = active): string[] {
  return s.owners.map((o) => o.login);
}

/** Whether `repo` (`owner/name`) belongs to a watched owner and passes the allow / deny lists. */
export function repoWatched(repo: string, s: FleetSettings = active): boolean {
  if (!validRepoName(repo)) return false;
  const lower = repo.toLowerCase();
  const owner = lower.slice(0, lower.indexOf("/"));
  const pinned = s.repos.pinned.some((r) => r.toLowerCase() === lower);
  if (!pinned && !s.owners.some((o) => o.login.toLowerCase() === owner)) return false;
  if (s.repos.deny.some((r) => r.toLowerCase() === lower)) return false;
  if (pinned) return true;
  return s.repos.allow.length === 0 || s.repos.allow.some((r) => r.toLowerCase() === lower);
}

/** `~/x` → `<home>/x`; other paths as they are; `null` for `~/` without a home. */
export function expandHome(path: string, home: string | null): string | null {
  if (!path.startsWith("~/")) return path;
  return home ? `${home}/${path.slice(2)}` : null;
}
