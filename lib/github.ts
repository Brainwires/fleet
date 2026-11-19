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

/**
 * Where GitHub redirects a job log download (`GET /repos/{repo}/actions/jobs/{id}/logs` answers 302
 * to a short-lived signed URL there): the results service's storage accounts (the list GitHub
 * documents for self-hosted runners) and the older pipelines host. The app's `--allow-net` bakes
 * exactly these; a redirect anywhere else is refused.
 */
export const LOG_HOSTS: readonly string[] = [
  ...Array.from({ length: 20 }, (_, i) => `productionresultssa${i}.blob.core.windows.net`),
  "pipelines.actions.githubusercontent.com",
];

/** A job log download's cap: past it, the log's last this many bytes are kept. */
export const LOG_MAX_BYTES = 4 * 1024 * 1024;

/** A download's result. */
export interface DownloadResult {
  readonly text: string;
  /** The log was longer than the cap: `text` is its end. */
  readonly truncated: boolean;
  readonly bytes: number;
}

/** First back-off when GitHub gives no time (doubled per failure, capped). */
export const BACKOFF_FIRST_MS = 60_000;
/** The longest back-off. */
export const BACKOFF_MAX_MS = 15 * 60_000;
/** No hint, however large, holds requests back longer than this (the primary limit's window). */
export const BACKOFF_CEILING_MS = 60 * 60_000;
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
  /**
   * Download a job's log: GET the API path (it counts against the rate limit like any request),
   * follow its redirect to one of {@linkcode LOG_HOSTS} WITHOUT the token, and keep at most
   * `maxBytes` (the end of a longer log). Rejects with a {@linkcode GitHubError}.
   */
  downloadLog(path: string, opts?: RequestOptions & { maxBytes?: number }): Promise<DownloadResult>;
  /**
   * The last rate limit seen, or `null` once its reset time has passed (the budget is refilled and
   * the old `remaining` says nothing any more; the next response reports the new one).
   */
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
  /**
   * The token's OAuth scopes (`X-OAuth-Scopes`) from the last response that reported them: a
   * classic or OAuth token's; `null` until seen (a fine-grained token never reports any).
   */
  scopes(): string[] | null;
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

  let scopes: string[] | null = null;
  const readScopes = (h: Headers) => {
    const v = h.get("x-oauth-scopes");
    if (v !== null) scopes = v.split(",").map((x) => x.trim()).filter(Boolean);
  };
  const readRate = (h: Headers) => {
    const remaining = Number(h.get("x-ratelimit-remaining"));
    const limit = Number(h.get("x-ratelimit-limit"));
    const reset = Number(h.get("x-ratelimit-reset"));
    if (h.has("x-ratelimit-remaining") && Number.isFinite(remaining) && Number.isFinite(limit)) {
      rate = { remaining, limit, resetAt: Number.isFinite(reset) ? reset * 1000 : 0 };
    }
  };

  const backOff = (h: Headers, status: number, url: string): GitHubError => {
    const t = now();
    const retryAfter = retryAfterMs(h.get("retry-after"), t);
    const reset = Number(h.get("x-ratelimit-reset"));
    let until: number;
    if (retryAfter !== null) {
      until = t + retryAfter;
    } else if (h.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset) && reset > 0) {
      // The reset is on GitHub's clock: moved onto ours.
      until = reset * 1000 - clockOffset();
    } else {
      until = t + Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** failures);
    }
    failures++;
    // Never shorter than a second, never longer than an hour (a garbled header can't park polling).
    backoff = Math.min(Math.max(until, t + 1000), t + BACKOFF_CEILING_MS);
    return new GitHubError(
      `rate limited (${status}) on ${endpoint(url)}; retrying after ${
        new Date(backoff).toISOString()
      }`,
      status,
      "backoff",
    );
  };
  /** A 403 / 429 answer: a (primary or secondary) rate limit backs off, else a permission refusal. */
  const refused = async (res: Response, url: string): Promise<GitHubError> => {
    let message = "";
    try {
      const j = JSON.parse((await res.text()).slice(0, 4096)) as { message?: unknown };
      if (typeof j?.message === "string") message = j.message;
    } catch {
      // No JSON body.
    }
    if (res.status === 429 || isRateLimited(res.headers, message)) {
      return backOff(res.headers, res.status, url);
    }
    return new GitHubError(
      `forbidden (403) on ${endpoint(url)}${message ? `: ${message.slice(0, 200)}` : ""}`,
      403,
      "http",
    );
  };
  const clockOffset = (): number => {
    if (clockSamples.length === 0) return 0;
    const s = [...clockSamples].sort((a, b) => a - b);
    const m = s[s.length >> 1];
    return Math.abs(m) < CLOCK_NOISE_MS ? 0 : Math.round(m);
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
        readScopes(res.headers);
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
        if (res.status === 429 || res.status === 403) throw await refused(res, url);
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
    downloadLog(path, opts) {
      if (backoff !== null && now() < backoff) {
        return Promise.reject(new GitHubError("backing off", 0, "backoff"));
      }
      if (!/^\/repos\/[\w.-]+\/[\w.-]+\/actions\/jobs\/\d+\/logs$/.test(path)) {
        return Promise.reject(new GitHubError("refusing that path", 0, "http"));
      }
      const max = Math.max(1024, opts?.maxBytes ?? LOG_MAX_BYTES);
      const headers: Record<string, string> = {
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      };
      if (token) headers.authorization = `Bearer ${token}`;
      requests++;
      return deadline(opts?.signal, async (signal) => {
        const sentAt = now();
        const res = await doFetch(API + path, { headers, signal, redirect: "manual" });
        readClock(res.headers, sentAt, now());
        readRate(res.headers);
        count();
        if (res.status === 429 || res.status === 403) throw await refused(res, API + path);
        await res.body?.cancel();
        if (res.status === 401) throw new GitHubError("the token was refused (401)", 401, "auth");
        if (res.status === 404 || res.status === 410) {
          throw new GitHubError(
            "no log (404: expired, or not visible to the token)",
            404,
            "not-found",
          );
        }
        if (res.status < 300 || res.status >= 400) {
          throw new GitHubError(`HTTP ${res.status}`, res.status, "http");
        }
        let where: URL;
        try {
          where = new URL(res.headers.get("location") ?? "");
        } catch {
          throw new GitHubError("no log location", 0, "http");
        }
        if (where.protocol !== "https:" || !LOG_HOSTS.includes(where.hostname)) {
          throw new GitHubError("the log is on a host Fleet doesn't fetch from", 0, "http");
        }
        // The signed URL is the credential: no token, no cookies, no further redirects.
        const blob = await doFetch(where.href, { signal, redirect: "error" });
        if (!blob.ok || !blob.body) {
          await blob.body?.cancel();
          throw new GitHubError(`log download: HTTP ${blob.status}`, blob.status, "http");
        }
        const chunks: Uint8Array[] = [];
        let held = 0;
        let total = 0;
        for await (const c of blob.body) {
          chunks.push(c);
          held += c.length;
          total += c.length;
          while (held - chunks[0].length >= max) held -= chunks.shift()!.length;
        }
        let bytes = new Uint8Array(held);
        let off = 0;
        for (const c of chunks) {
          bytes.set(c, off);
          off += c.length;
        }
        const truncated = total > held || held > max;
        if (held > max) bytes = bytes.subarray(held - max);
        let text = new TextDecoder().decode(bytes);
        if (truncated) text = text.slice(text.indexOf("\n") + 1); // a partial first line
        failures = 0;
        return { text, truncated, bytes: total };
      });
    },
    rate: () => (rate !== null && rate.resetAt > now() ? rate : null),
    backoffUntil: () => (backoff !== null && now() < backoff ? backoff : null),
    stats: () => ({ requests, notModified }),
    spentLastHour: () => spent.filter((x) => x > now() - 3600_000).length,
    clockOffset,
    evict: (match) => {
      for (const url of [...cache.keys()]) if (match(url)) cache.delete(url);
    },
    cacheSize: () => cache.size,
    scopes: () => scopes,
  };
}

/**
 * A 403 that is a rate limit (primary or secondary), not a permissions refusal: no requests left,
 * a `Retry-After`, or GitHub's message naming a (secondary) rate limit, which may come with
 * neither header.
 */
function isRateLimited(h: Headers, message = ""): boolean {
  return h.get("x-ratelimit-remaining") === "0" || h.has("retry-after") ||
    /rate limit|abuse detection/i.test(message);
}

/** `Retry-After` in ms: delta seconds or an HTTP date; `null` when absent or unusable. */
export function retryAfterMs(v: string | null, now: number): number | null {
  if (v === null || v.trim() === "") return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : null;
  const at = Date.parse(v);
  return Number.isFinite(at) && at > now ? at - now : null;
}

/** An API URL as the status line names it: the method and path, without the query or origin. */
export function endpoint(url: string): string {
  const path = url.startsWith(API) ? url.slice(API.length) : url;
  return `GET ${path.split("?")[0]}`;
}
