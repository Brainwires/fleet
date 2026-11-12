// The slices of GitHub's REST responses Fleet reads. Everything else in a response is ignored.

/** `GET /orgs/{org}/repos` item. */
export interface GhRepo {
  readonly full_name: string;
  readonly archived?: boolean;
  readonly disabled?: boolean;
  readonly pushed_at?: string | null;
  readonly default_branch?: string;
}

/** A workflow run (`GET /repos/{repo}/actions/runs`). */
export interface GhRun {
  readonly id: number;
  readonly name?: string | null;
  readonly display_title?: string | null;
  readonly head_branch?: string | null;
  readonly head_sha: string;
  readonly event: string;
  readonly status: string | null;
  readonly conclusion?: string | null;
  readonly html_url: string;
  readonly workflow_id?: number;
  readonly created_at: string;
  readonly run_started_at?: string | null;
  readonly updated_at?: string | null;
  readonly run_attempt?: number;
  /** The repo the run belongs to. */
  readonly repository?: { readonly full_name?: string } | null;
  /** The repo the head commit came from: another one for a fork PR (`null`: a deleted fork). */
  readonly head_repository?: {
    readonly full_name?: string;
    readonly owner?: { readonly login?: string } | null;
  } | null;
  /** Who started the run (the first attempt). */
  readonly actor?: { readonly login?: string } | null;
  /** Who started this attempt (a re-run's). */
  readonly triggering_actor?: { readonly login?: string } | null;
}

/** `GET /repos/{repo}/actions/runs` body. */
export interface GhRunList {
  readonly total_count?: number;
  readonly workflow_runs: readonly GhRun[];
}

/** A job (`GET /repos/{repo}/actions/runs/{id}/jobs`). */
export interface GhJob {
  readonly id: number;
  readonly run_id: number;
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly html_url?: string | null;
  readonly labels?: readonly string[];
  readonly runner_name?: string | null;
  readonly runner_group_name?: string | null;
  readonly created_at: string;
  readonly started_at?: string | null;
  readonly completed_at?: string | null;
  readonly workflow_name?: string | null;
  readonly head_branch?: string | null;
  readonly steps?: readonly GhStep[];
}

/** A job's step. */
export interface GhStep {
  readonly name: string;
  readonly status: string;
  readonly conclusion?: string | null;
  readonly number?: number;
}

/** A check-run annotation (`GET /repos/{repo}/check-runs/{job_id}/annotations`). */
export interface GhAnnotation {
  readonly annotation_level?: string;
  readonly message?: string;
  readonly title?: string | null;
}

/** `GET …/jobs` body. */
export interface GhJobList {
  readonly total_count?: number;
  readonly jobs: readonly GhJob[];
}

/** A runner (`GET /orgs/{org}/actions/runners`). */
export interface GhRunner {
  readonly id: number;
  readonly name: string;
  readonly status: string;
  readonly busy: boolean;
  readonly labels?: readonly { readonly name: string }[];
}

/** `GET /orgs/{org}/actions/runners` body. */
export interface GhRunnerList {
  readonly total_count?: number;
  readonly runners: readonly GhRunner[];
}

/** `GET /orgs/{org}/actions/variables/{name}` body. */
export interface GhVariable {
  readonly name: string;
  readonly value: string;
  readonly updated_at?: string;
}
