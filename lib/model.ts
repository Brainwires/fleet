// What the backend hands the page (and the tray): plain JSON, no token, no Deno types. Times are
// epoch ms; the page ticks elapsed / waited from them itself.

import type { PoolStart } from "./pool-state.ts";

/** Where a job runs (or waits to run). */
export type JobTarget = "pool" | "github";

/** Running or waiting. */
export type Lane = "running" | "queued";

/** One job row. */
export interface JobRow {
  readonly id: number;
  readonly name: string;
  readonly url: string | null;
  readonly lane: Lane;
  readonly target: JobTarget;
  /** The pool's short name (`mac-arm`, an unknown pool label as is), or `github`. */
  readonly pool: string;
  /** The runner's name while running. */
  readonly runner: string | null;
  /**
   * GitHub-hosted: the runner image the job asked for (its runs-on label, `ubuntu-22.04`,
   * `macos-15-intel`), when the job data has one. Absent / `null` for self-hosted.
   */
  readonly image?: string | null;
  /** Queued: when it was created. Running: when it started. */
  readonly since: number;
  /** The median length of this job's recent successful runs, when known. */
  readonly usualMs: number | null;
  /**
   * Queued on a self-hosted pool that is ok with every slot busy: a long wait there is a capacity
   * wait, not a fault. Set when the snapshot is built (it needs the pool cards).
   */
  readonly capacityWait?: boolean;
  /**
   * A runner-host job (a GitHub-hosted job that only hosts a self-hosted runner): what it hosts,
   * `hosting helper-1 · idle`. Present means never late.
   */
  readonly hosting?: string;
  /** Running on a runner a GitHub-hosted helper registered (pool is still the runner's pool). */
  readonly helper?: boolean;
}

/** One workflow run with its active jobs. */
export interface RunGroup {
  readonly id: number;
  readonly repo: string;
  readonly workflow: string;
  readonly title: string;
  readonly branch: string;
  readonly sha: string;
  readonly event: string;
  readonly url: string;
  /**
   * The run is on a protected branch (settings `branches.rules`; by default the repo's own
   * default branch): the name, from this repo, not a PR (a fork PR's `main` is not).
   */
  readonly defaultBranch: boolean;
  /** A fork PR: the fork's owner ("fork PR from <owner>"). Absent for this repo's own runs. */
  readonly forkOwner?: string;
  /** Queued with no jobs listed yet (GitHub hasn't expanded the run). */
  readonly pendingJobs: boolean;
  /** Dispatched (or re-run) through the `ci` MCP server: the agent and why (lib/ci-ledger.ts). */
  readonly ci?: { readonly owner: string; readonly purpose: string };
  readonly jobs: readonly JobRow[];
}

/** One repo's runs in a lane. */
export interface RepoGroup {
  readonly repo: string;
  readonly runs: readonly RunGroup[];
}

/**
 * A pool card's badge (lib/pool-status.ts): `paused` by hand, `unhealthy` a real failure (red),
 * `blocked` a gate holds the launch, `busy` every slot busy with jobs queued, `ok`, or `unknown`.
 */
export type PoolState = "ok" | "paused" | "busy" | "blocked" | "unhealthy" | "unknown";

/** One pool card. */
export interface PoolCard {
  /** Short name, or `github`. */
  readonly id: string;
  readonly title: string;
  /** The runs-on label (`null` for GitHub-hosted). */
  readonly label: string | null;
  /** Slots; `null` for GitHub-hosted (no limit we know). */
  readonly slots: number | null;
  /** Busy slots: the health variable's count when fresh, else our running jobs there. */
  readonly busy: number;
  readonly running: number;
  readonly queued: number;
  readonly state: PoolState;
  readonly reason: string;
  /** When the state last flipped (the health variable's `since`). */
  readonly since: number | null;
  /** The oldest queued job's `created_at`, or `null` with nothing queued. */
  readonly oldestQueuedSince: number | null;
  /**
   * Whether the pool can START jobs, and why not, from the runner scheduler's own decision
   * (lib/pool-state.ts): a pool running a job fine may still be blocked, degraded, paused or down.
   */
  readonly start?: PoolStart | null;
  /**
   * Pools that share one machine (settings `host`): the machine's name, busy slots summed over its
   * pools and its shared capacity (the largest slot count among them). Absent: a machine of its own.
   */
  readonly host?: string;
  readonly hostBusy?: number;
  readonly hostSlots?: number;
}

/** A job that finished in the last 30 minutes. */
export interface FinishedJob {
  readonly id: number;
  readonly runId: number;
  readonly repo: string;
  readonly name: string;
  readonly workflow: string;
  readonly branch: string;
  /** On a default branch by provenance (see RunGroup.defaultBranch). */
  readonly defaultBranch: boolean;
  /** From a fork PR. */
  readonly fork?: boolean;
  readonly conclusion: string;
  readonly url: string | null;
  readonly pool: string;
  readonly completedAt: number;
  readonly durationMs: number | null;
}

/** An alert line from the health variable. */
export interface AlertRow {
  readonly at: number;
  readonly pool: string;
  readonly msg: string;
}

/** How Fleet is signed in. */
export type AuthState =
  | "pending" // looking for a token
  | "gh" // the GitHub CLI's token
  | "stored" // a token pasted earlier, from the secure store
  | "public" // no token: public data only
  | "needs-token" // none found: the first-run screen
  | "invalid"; // the token was refused (401)

/** The remaining rate limit. */
export interface RateInfo {
  readonly remaining: number;
  readonly limit: number;
  readonly resetAt: number;
}

/** The overall severity (tray colour, the window's stripe). */
export type Severity = "ok" | "warn" | "alert";

/** The tray / window summary. */
export interface Summary {
  readonly running: number;
  readonly queued: number;
  readonly severity: Severity;
  /** Why, one short line each. */
  readonly reasons: readonly string[];
}

/** Everything the page shows. */
export interface Snapshot {
  /** When it was built (this machine's clock). */
  readonly at: number;
  /**
   * GitHub's clock minus this machine's (ms, from the API's `Date` headers; 0 when unknown). Ages
   * of GitHub timestamps (queue waits, elapsed, "finished N min ago") use `now + clockOffsetMs`.
   */
  readonly clockOffsetMs?: number;
  readonly auth: AuthState;
  /** The last poll: ok, or what went wrong (never the token). */
  readonly poll: {
    readonly ok: boolean;
    readonly message: string;
    readonly lastSuccessAt: number | null;
    readonly intervalMs: number;
    readonly backoffUntil: number | null;
    /** Why polling is slowed to protect the shared rate limit (the banner), or `null`. */
    readonly slow: "low" | "floor" | "budget" | null;
  };
  readonly rate: RateInfo | null;
  readonly health: {
    readonly state: "ok" | "stale" | "unavailable" | "invalid";
    readonly checkedAt: number | null;
    readonly message: string;
  };
  readonly pools: readonly PoolCard[];
  readonly running: readonly RepoGroup[];
  readonly queued: readonly RepoGroup[];
  readonly finished: readonly FinishedJob[];
  readonly alerts: readonly AlertRow[];
  readonly summary: Summary;
  /** The repos polled this round (pinned + any with activity). */
  readonly repos: readonly string[];
  /** The watched owners' logins (the header names them). */
  readonly owners?: readonly string[];
  /** The first-run wizard is done (`false`: the window shows it). */
  readonly setupComplete?: boolean;
  /** The tray asked for the Settings view (the page shows it, then says so). */
  readonly settingsRequested?: boolean;
  /** The event log's last sequence number (the page fetches newer events when it grows). */
  readonly eventSeq: number;
  /** Native notifications paused from the tray. */
  readonly notificationsPaused: boolean;
  /** GitHub webhooks: received here (live / stale), or off (polling only). */
  readonly hooks: {
    readonly state: "live" | "stale" | "off";
    readonly lastDeliveryAt: number | null;
    /** Received here, or read from the standalone receiver's spool. */
    readonly via?: "listener" | "spool";
  };
}

/** The `fleet` extension's event: the snapshot changed. */
export const CHANGED_EVENT = "changed";
