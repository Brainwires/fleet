// A small GitHub REST client for the poller: conditional requests (ETag / If-None-Match, so an
// unchanged list costs no rate limit), the rate limit from the response headers, and back-off on
// 403 / 429 (the reset time or Retry-After, else exponential). Every request has a deadline
// (`REQUEST_TIMEOUT_MS`): a hung connection rejects as a retryable `timeout`, never a stuck poll.
// The ETag cache is a bounded LRU. GitHub's clock is tracked from the responses' `Date` headers, so
// ages computed against GitHub's timestamps can use a corrected now (`clockOffset()`). `fetch` and
// the clock are injected, so the tests replay recorded JSON. The token lives only in this object's
// closure; it is never logged, put in an error, or returned.

import type { RateInfo } from "./model.ts";

/** The API's origin: the only host Fleet talks to (`--allow-net=api.github.com`). */
export const API = "https://api.github.com";

/** First back-off when GitHub gives no time (doubled per failure, capped). */
export const BACKOFF_FIRST_MS = 60_000;
/** The longest back-off. */
export const BACKOFF_MAX_MS = 15 * 60_000;
/** Each request's deadline (connect, headers and body). */
export const REQUEST_TIMEOUT_MS = 20_000;
/** ETag cache entries kept (least recently used evicted first). */
export const ETAG_CACHE_MAX = 2000;
/** `Date` header samples kept for the clock offset (their median is used). */
const CLOCK_SAMPLES = 9;
/** An offset under this is the `Date` header's 1 s resolution, not skew. */
const CLOCK_NOISE_MS = 1500;

/** A failure the poller shows. Its message never holds the token. */
export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "auth" | "backoff" | "not-found" | "http" | "network" | "timeout",
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
  /** Each request's deadline (default {@linkcode REQUEST_TIMEOUT_MS}). */
  readonly timeoutMs?: number;
  /** ETag cache size (default {@linkcode ETAG_CACHE_MAX}). */
  readonly cacheMax?: number;
}

/** A request's options. */
export interface RequestOptions {
  /** Aborts the request (combined with the client's deadline). */
  readonly signal?: AbortSignal;
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
  get<T>(pathOrUrl: string, opts?: RequestOptions): Promise<GetResult<T>>;
  /**
   * POST (a control: cancel, re-run, dispatch). No cache; not held back by the rate floor (the user
   * confirmed it). Resolves the status; rejects with a {@linkcode GitHubError} on a failure.
   */
  post(path: string, body?: unknown, opts?: RequestOptions): Promise<number>;
  /** The last rate limit seen. */
  rate(): RateInfo | null;
  /** While backing off: until when (epoch ms); else `null`. */
  backoffUntil(): number | null;
  /** How many requests went out / were answered 304 (for tests and the status line). */
  stats(): { requests: number; notModified: number };
  /** Requests in the last hour that counted against the rate limit (everything but 304s). */
  spentLastHour(): number;
  /**
   * GitHub's clock minus ours (ms), from the responses' `Date` headers (median of the recent
   * ones); 0 until known or when within the header's resolution. Add it to `Date.now()` before
   * comparing with a GitHub timestamp.
   */
  clockOffset(): number;
  /** Drop cached ETags whose URL `match` accepts (a run that left the poller's view). */
  evict(match: (url: string) => boolean): void;
  /** ETag cache entries held. */
  cacheSize(): number;
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
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const cacheMax = Math.max(1, options.cacheMax ?? ETAG_CACHE_MAX);
  /** Insertion order is recency: a hit is re-inserted, the first key is the least recent. */
  const cache = new Map<string, CacheEntry>();
  const cacheGet = (url: string): CacheEntry | undefined => {
    const hit = cache.get(url);
    if (hit) {
      cache.delete(url);
      cache.set(url, hit);
    }
    return hit;
  };
  const cacheSet = (url: string, e: CacheEntry) => {
    cache.delete(url);
    cache.set(url, e);
    while (cache.size > cacheMax) cache.delete(cache.keys().next().value!);
  };
  let clockSamples: number[] = [];
  const readClock = (h: Headers, sentAt: number, gotAt: number) => {
    const server = Date.parse(h.get("date") ?? "");
    if (!Number.isFinite(server)) return;
    // The header is whole seconds (truncated): +500 is its expected value; the request's midpoint
    // is the best guess of when GitHub stamped it.
    clockSamples = [...clockSamples, server + 500 - (sentAt + gotAt) / 2].slice(-CLOCK_SAMPLES);
  };
  /** Run `fn` under the deadline (and the caller's signal), even if `fn` ignores the signal. */
  const deadline = async <R>(
    outer: AbortSignal | undefined,
    fn: (signal: AbortSignal) => Promise<R>,
  ): Promise<R> => {
    const timer = new AbortController();
    const id = setTimeout(
      () => timer.abort(new DOMException("timed out", "TimeoutError")),
      timeoutMs,
    );
    const signal = outer ? AbortSignal.any([outer, timer.signal]) : timer.signal;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([fn(signal), aborted]);
    } catch (err) {
      if (timer.signal.aborted) {
        throw new GitHubError(`timed out after ${Math.round(timeoutMs / 1000)} s`, 0, "timeout");
      }
      if (err instanceof GitHubError) throw err;
      throw new GitHubError(
        `network: ${err instanceof Error ? err.name : "error"}`,
        0,
        "network",
      );
    } finally {
      clearTimeout(id);
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  };
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
    get<T>(pathOrUrl: string, opts?: RequestOptions): Promise<GetResult<T>> {
      if (backoff !== null && now() < backoff) {
        return Promise.reject(new GitHubError("backing off", 0, "backoff"));
      }
      const url = pathOrUrl.startsWith("https://") ? pathOrUrl : API + pathOrUrl;
      if (!url.startsWith(API + "/")) {
        return Promise.reject(new GitHubError("refusing a non-API URL", 0, "http"));
      }
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      const hit = cacheGet(url);
      if (hit) headers["if-none-match"] = hit.etag;
      requests++;
      return deadline(opts?.signal, async (signal) => {
        const sentAt = now();
        const res = await doFetch(url, { headers, signal });
        readClock(res.headers, sentAt, now());
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
        if (etag) cacheSet(url, { etag, body, next });
        failures = 0;
        backoff = null;
        return { body, cached: false, next };
      });
    },
    post(path: string, body?: unknown, opts?: RequestOptions): Promise<number> {
      if (!path.startsWith("/repos/")) {
        return Promise.reject(new GitHubError("refusing that path", 0, "http"));
      }
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "content-type": "application/json",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      requests++;
      return deadline(opts?.signal, async (signal) => {
        const sentAt = now();
        const res = await doFetch(API + path, {
          method: "POST",
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          signal,
        });
        readClock(res.headers, sentAt, now());
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
      });
    },
    rate: () => rate,
    backoffUntil: () => (backoff !== null && now() < backoff ? backoff : null),
    stats: () => ({ requests, notModified }),
    spentLastHour: () => spent.filter((x) => x > now() - 3600_000).length,
    clockOffset: () => {
      if (clockSamples.length === 0) return 0;
      const s = [...clockSamples].sort((a, b) => a - b);
      const m = s[s.length >> 1];
      return Math.abs(m) < CLOCK_NOISE_MS ? 0 : Math.round(m);
    },
    evict: (match) => {
      for (const url of [...cache.keys()]) if (match(url)) cache.delete(url);
    },
    cacheSize: () => cache.size,
  };
}

/** A 403 that is a rate limit (primary or secondary), not a permissions refusal. */
function isRateLimited(h: Headers): boolean {
  return h.get("x-ratelimit-remaining") === "0" || h.has("retry-after");
}
