// The pool detail's Logs tab: GitHub job logs on demand (through the shared, budgeted client,
// cached), and the runner scheduler's logs on this machine (lib/deno-logs.ts). Everything the page
// gets is redacted and bounded; nothing here writes or deletes.

import { RATE_SLOW } from "./budget.ts";
import { type GitHubClient, GitHubError, LOG_MAX_BYTES } from "./github.ts";
import { redactLine } from "./redact.ts";
import { type LogGroup, logGroups } from "./runner-logs.ts";
import { repoWatched } from "./settings.ts";

/** Job logs downloaded per hour at most (each costs one request of the shared budget). */
export const JOB_LOGS_PER_HOUR = 30;
/** Job logs kept in memory (finished jobs only: their logs no longer change). */
export const JOB_LOG_CACHE = 8;
/** Lines the page gets at most for one log. */
export const LOG_LINES_MAX = 60_000;

/** What the log viewer shows. */
export interface LogView {
  readonly kind: "runner" | "github";
  readonly title: string;
  /** Redacted lines (ANSI colour codes kept; the viewer renders them as colours). */
  readonly lines: readonly string[];
  /** `##[group]` sections (GitHub logs). */
  readonly groups?: readonly LogGroup[];
  /** The log has more before the first line (a tail was shown). */
  readonly truncated: boolean;
  /** Bytes: where the lines start / end in the file (runner logs page and follow with these). */
  readonly start?: number;
  readonly end?: number;
  readonly size?: number;
  /** Still being written (a running job's launcher log): the viewer may follow it. */
  readonly live?: boolean;
  readonly file?: string;
  readonly jobId?: number;
  readonly note?: string;
}

/** A refusal or failure, said plainly. */
export interface LogError {
  readonly error: string;
}

/** The lines as the page gets them: capped to the last {@linkcode LOG_LINES_MAX}. */
export function capLines(lines: readonly string[]): { lines: string[]; cut: boolean } {
  return lines.length > LOG_LINES_MAX
    ? { lines: lines.slice(-LOG_LINES_MAX), cut: true }
    : { lines: [...lines], cut: false };
}

/** The job log fetcher's machine access. */
export interface JobLogDeps {
  readonly github: () => { client: GitHubClient; canWrite: boolean } | null;
  readonly now?: () => number;
}

/** GitHub job logs: budgeted, cached, redacted. */
export interface JobLogs {
  /** A job's log; `completed` jobs are cached. */
  get(repo: string, jobId: number, title: string, completed: boolean): Promise<LogView | LogError>;
}

/** The fetcher. */
export function createJobLogs(deps: JobLogDeps): JobLogs {
  const now = deps.now ?? Date.now;
  const cache = new Map<number, LogView>();
  let spent: number[] = [];
  const inflight = new Map<number, Promise<LogView | LogError>>();
  return {
    get(repo, jobId, title, completed) {
      const hit = cache.get(jobId);
      if (hit) {
        cache.delete(jobId);
        cache.set(jobId, hit);
        return Promise.resolve(hit);
      }
      const running = inflight.get(jobId);
      if (running) return running;
      if (!repoWatched(repo) || !Number.isSafeInteger(jobId) || jobId <= 0) {
        return Promise.resolve({ error: "That job isn't in a watched repo." });
      }
      const gh = deps.github();
      if (!gh || !gh.canWrite) {
        return Promise.resolve({
          error: "Job logs need a GitHub token (public mode can't read them).",
        });
      }
      const rate = gh.client.rate();
      if (rate && rate.limit > 1000 && rate.remaining < RATE_SLOW) {
        return Promise.resolve({
          error: `The shared API budget is low (${rate.remaining} left): job logs wait until it ` +
            "recovers, so the runner scheduler keeps its share.",
        });
      }
      const t = now();
      spent = spent.filter((x) => x > t - 3600_000);
      if (spent.length >= JOB_LOGS_PER_HOUR) {
        return Promise.resolve({
          error: `${JOB_LOGS_PER_HOUR} job logs were fetched in the last hour; try again later.`,
        });
      }
      spent.push(t);
      const p = (async (): Promise<LogView | LogError> => {
        try {
          const r = await gh.client.downloadLog(`/repos/${repo}/actions/jobs/${jobId}/logs`, {
            maxBytes: LOG_MAX_BYTES,
          });
          const raw = r.text.split("\n");
          if (raw.length && raw[raw.length - 1] === "") raw.pop();
          const { lines, cut } = capLines(raw.map((l) => redactLine(l.replace(/\r$/, ""))));
          const view: LogView = {
            kind: "github",
            title,
            lines,
            groups: logGroups(lines),
            truncated: r.truncated || cut,
            jobId,
            ...(r.truncated || cut ? { note: "Showing the end of a long log." } : {}),
          };
          if (completed) {
            cache.set(jobId, view);
            while (cache.size > JOB_LOG_CACHE) cache.delete(cache.keys().next().value!);
          }
          return view;
        } catch (err) {
          return {
            error: err instanceof GitHubError
              ? `GitHub: ${err.message}`
              : "The log couldn't be fetched.",
          };
        } finally {
          inflight.delete(jobId);
        }
      })();
      inflight.set(jobId, p);
      return p;
    },
  };
}
