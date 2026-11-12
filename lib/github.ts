// A small GitHub REST client for the poller: conditional requests (ETag / If-None-Match, so an
// unchanged list costs no rate limit), the rate limit from the response headers, and back-off on
// 403 / 429 (the reset time or Retry-After, else exponential). `fetch` and the clock are injected,
// so the tests replay recorded JSON. The token lives only in this object's closure; it is never
// logged, put in an error, or returned.

import type { RateInfo } from "./model.ts";

/** The API's origin: the only host Fleet talks to (`--allow-net=api.github.com`). */
export const API = "https://api.github.com";

/** First back-off when GitHub gives no time (doubled per failure, capped). */
export const BACKOFF_FIRST_MS = 60_000;
/** The longest back-off. */
export const BACKOFF_MAX_MS = 15 * 60_000;

/** A failure the poller shows. Its message never holds the token. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "auth" | "backoff" | "not-found" | "http" | "network",
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

/** The client's options. */
export interface GitHubClientOptions {
  /** The token, or `null` for unauthenticated (public data, 60 requests an hour). */
  readonly token: string | null;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
}

/** A GET's result. */
export interface GetResult<T> {
  readonly body: T;
  /** Served from the ETag cache (304). */
  readonly cached: boolean;
  /** The next page's URL (`Link: rel="next"`), if any. */
  readonly next: string | null;
}

/** The client. */
export interface GitHubClient {
  /**
   * GET a path (`/orgs/x/repos?per_page=100`) or a full `https://api.github.com/…` URL. Rejects
   * with a {@linkcode GitHubError}; `not-found` for 404.
   */
  get<T>(pathOrUrl: string): Promise<GetResult<T>>;
  /**
   * POST (a control: cancel, re-run, dispatch). No cache; not held back by the rate floor (the user
   * confirmed it). Resolves the status; rejects with a {@linkcode GitHubError} on a failure.
   */
  post(path: string, body?: unknown): Promise<number>;
  /** The last rate limit seen. */
  rate(): RateInfo | null;
  /** While backing off: until when (epoch ms); else `null`. */
  backoffUntil(): number | null;
  /** How many requests went out / were answered 304 (for tests and the status line). */
  stats(): { requests: number; notModified: number };
  /** Requests in the last hour that counted against the rate limit (everything but 304s). */
  spentLastHour(): number;
}

interface CacheEntry {
  readonly etag: string;
  readonly body: unknown;
  readonly next: string | null;
}

/** The `rel="next"` URL of a Link header. */
export function nextLink(link: string | null): string | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1];
  }
  return null;
}

/** The client. */
export function createGitHubClient(options: GitHubClientOptions): GitHubClient {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const token = options.token;
  const cache = new Map<string, CacheEntry>();
  let rate: RateInfo | null = null;
  let backoff: number | null = null;
  let failures = 0;
  let requests = 0;
  let notModified = 0;
  let spent: number[] = [];
  const count = () => {
    const t = now();
    spent.push(t);
    if (spent.length > 4000 || spent[0] < t - 3600_000) {
      spent = spent.filter((x) => x > t - 3600_000);
    }
  };

  const readRate = (h: Headers) => {
    const remaining = Number(h.get("x-ratelimit-remaining"));
    const limit = Number(h.get("x-ratelimit-limit"));
    const reset = Number(h.get("x-ratelimit-reset"));
    if (h.has("x-ratelimit-remaining") && Number.isFinite(remaining) && Number.isFinite(limit)) {
      rate = { remaining, limit, resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
    }
  };

  const backOff = (h: Headers, status: number): GitHubError => {
    const t = now();
    const retryAfter = Number(h.get("retry-after"));
    let until: number;
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      until = t + retryAfter * 1000;
    } else if (h.get("x-ratelimit-remaining") === "0" && Number(h.get("x-ratelimit-reset")) > 0) {
      until = Number(h.get("x-ratelimit-reset")) * 1000;
    } else {
      until = t + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** failures);
    }
    failures++;
    backoff = Math.max(until, t + 1000);
    return new GitHubError(
      status === 429 ? "rate limited (429)" : "rate limited or forbidden (403)",
      status,
      "backoff",
    );
  };

  return {
    async get<T>(pathOrUrl: string): Promise<GetResult<T>> {
      if (backoff !== null && now() < backoff) {
        throw new GitHubError("backing off", 0, "backoff");
      }
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : API + pathOrUrl;
      if (!url.startsWith(API + "/")) {
        throw new GitHubError("refusing a non-API URL", 0, "http");
      }
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const hit = cache.get(url);
      if (hit) headers["if-none-match"] = hit.etag;
      let res: Response;
      requests++;
      try {
        res = await doFetch(url, { headers });
      } catch (err) {
        throw new GitHubError(
          `network: ${err instanceof Error ? err.name : "error"}`,
          0,
          "network",
        );
      }
      readRate(res.headers);
      if (res.status !== 304) count();
      if (res.status === 304 && hit) {
        await res.body?.cancel();
        notModified++;
        failures = 0;
        return { body: hit.body as T, cached: true, next: hit.next };
      }
      if (res.status === 401) {
        await res.body?.cancel();
        throw new GitHubError("the token was refused (401)", 401, "auth");
      }
      if (res.status === 429 || (res.status === 403 && isRateLimited(res.headers))) {
        await res.body?.cancel();
        throw backOff(res.headers, res.status);
      }
      if (res.status === 404) {
        await res.body?.cancel();
        throw new GitHubError("not found (404)", 404, "not-found");
      }
      if (!res.ok) {
        await res.body?.cancel();
        throw new GitHubError(`HTTP ${res.status}`, res.status, "http");
      }
      const body = await res.json() as T;
      const next = nextLink(res.headers.get("link"));
      const etag = res.headers.get("etag");
      if (etag) cache.set(url, { etag, body, next });
      failures = 0;
      backoff = null;
      return { body, cached: false, next };
    },
    async post(path: string, body?: unknown): Promise<number> {
      if (!path.startsWith("/repos/")) throw new GitHubError("refusing that path", 0, "http");
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      let res: Response;
      requests++;
      try {
        res = await doFetch(API + path, {
          method: "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        throw new GitHubError(
          `network: ${err instanceof Error ? err.name : "error"}`,
          0,
          "network",
        );
      }
      count();
      readRate(res.headers);
      let detail = "";
      try {
        const j = await res.json() as { message?: unknown };
        if (typeof j?.message === "string") detail = j.message.slice(0, 200);
      } catch {
        // 202 / 204: no body.
      }
      if (res.status === 401) throw new GitHubError("the token was refused (401)", 401, "auth");
      if (!res.ok) {
        throw new GitHubError(
          `HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
          res.status,
          "http",
        );
      }
      return res.status;
    },
    rate: () => rate,
    backoffUntil: () => (backoff !== null && now() < backoff ? backoff : null),
    stats: () => ({ requests, notModified }),
    spentLastHour: () => spent.filter((x) => x > now() - 3600_000).length,
  };
}

/** A 403 that is a rate limit (primary or secondary), not a permissions refusal. */
function isRateLimited(h: Headers): boolean {
  return h.get("x-ratelimit-remaining") === "0" || h.has("retry-after");
}
