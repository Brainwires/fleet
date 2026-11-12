// What the backend hands the page (and the tray): plain JSON, no token, no Deno types. Times are
// epoch ms; the page ticks elapsed / waited from them itself.

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
  /** The pool's short name (`mac-arm`, an unknown `denext-*` label as is), or `github`. */
  readonly pool: string;
  /** The runner's name while running. */
  readonly runner: string | null;
  /** Queued: when it was created. Running: when it started. */
  readonly since: number;
  /** The median length of this job's recent successful runs, when known. */
  readonly usualMs: number | null;
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
  /** The branch must stay green (`development-denext`, `development`, `main`). */
  readonly defaultBranch: boolean;
  /** Queued with no jobs listed yet (GitHub hasn't expanded the run). */
  readonly pendingJobs: boolean;
  readonly jobs: readonly JobRow[];
}

/** One repo's runs in a lane. */
export interface RepoGroup {
  readonly repo: string;
  readonly runs: readonly RunGroup[];
}

/** A pool card's health. */
export type PoolState = "ok" | "paused" | "unhealthy" | "unknown";

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
}

/** A job that finished in the last 30 minutes. */
export interface FinishedJob {
  readonly id: number;
  readonly repo: string;
  readonly name: string;
  readonly workflow: string;
  readonly branch: string;
  readonly defaultBranch: boolean;
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
  /** When it was built. */
  readonly at: number;
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
  /** The repos polled this round (core + any with activity). */
  readonly repos: readonly string[];
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
