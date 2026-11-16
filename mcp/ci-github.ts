// The `ci` server's GitHub access: GETs and job-log downloads through Fleet's own client
// (lib/github.ts: ETags, a 20 s deadline per request, rate-limit back-off, log redirects only to
// GitHub's log hosts and without the token), plus a POST that returns the answer's body (a
// workflow_dispatch with `return_run_details` answers the new run's id). The token comes from
// GH_TOKEN / GITHUB_TOKEN when granted, else the GitHub CLI (`gh auth token`); it lives only in the
// clients' closures and is never logged, returned or put in an error.

import { ghToken } from "../lib/deno-host.ts";
import {
  API,
  createGitHubClient,
  type DownloadResult,
  type GitHubClient,
  GitHubError,
  REQUEST_TIMEOUT_MS,
} from "../lib/github.ts";

export { GitHubError };

/** What the tools need from GitHub (tests stub it). */
export interface CiGitHub {
  /** GET an API path; rejects with a GitHubError (`not-found` for 404). */
  get<T>(path: string, signal?: AbortSignal): Promise<T>;
  /** POST an API path under /repos/; resolves the status and the JSON body (or `null`). */
  post(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<{ status: number; body: unknown }>;
  /** A job's log (its end past `maxBytes`). */
  log(path: string, maxBytes: number, signal?: AbortSignal): Promise<DownloadResult>;
  /** The last rate limit seen (`null` until a request). */
  rate(): { remaining: number; limit: number; resetAt: number } | null;
}

/** The token: GH_TOKEN / GITHUB_TOKEN when this process may read them, else `gh auth token`. */
async function findToken(): Promise<string | null> {
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"]) {
    try {
      if (Deno.permissions.querySync({ name: "env", variable: name }).state !== "granted") continue;
      const v = Deno.env.get(name)?.trim();
      if (v && /^[A-Za-z0-9_]{20,255}$/.test(v)) return v;
    } catch {
      // Not readable: the next source.
    }
  }
  return await ghToken();
}

/** A POST under the deadline; a network failure or the deadline as a GitHubError. */
async function postRaw(
  doFetch: typeof fetch,
  path: string,
  token: string | null,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const deadline = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  try {
    return await doFetch(API + path, {
      method: "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
  } catch (err) {
    if (deadline.aborted) throw new GitHubError("timed out", 0, "timeout");
    throw new GitHubError(`network: ${err instanceof Error ? err.name : "error"}`, 0, "network");
  }
}

/** A response's JSON body, or `null` (none, or not JSON). */
async function jsonOf(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** The live adapter over `fetch` (tests pass a fake one). */
export function ciGitHub(
  options: { token?: () => Promise<string | null>; fetch?: typeof fetch } = {},
): CiGitHub {
  const doFetch = options.fetch ?? fetch;
  const getToken = options.token ?? findToken;
  let token: Promise<string | null> | null = null;
  let client: GitHubClient | null = null;
  const ready = async (): Promise<{ client: GitHubClient; token: string | null }> => {
    token ??= getToken().catch(() => null);
    const t = await token;
    client ??= createGitHubClient({ token: t, fetch: doFetch, timeoutMs: 15_000 });
    return { client, token: t };
  };
  const reset = (err: unknown) => {
    if (err instanceof GitHubError && err.kind === "auth") {
      token = null;
      client = null;
    }
    throw err;
  };
  return {
    async get<T>(path: string, signal?: AbortSignal): Promise<T> {
      const { client: c } = await ready();
      return (await c.get<T>(path, { signal }).catch(reset)).body;
    },
    async post(path, body, signal) {
      if (!path.startsWith("/repos/")) throw new GitHubError("refusing that path", 0, "http");
      const { token: t } = await ready();
      const res = await postRaw(doFetch, path, t, body, signal);
      const json = await jsonOf(res);
      if (res.status === 401) reset(new GitHubError("the token was refused (401)", 401, "auth"));
      if (!res.ok) {
        const msg = (json as { message?: unknown } | null)?.message;
        const detail = typeof msg === "string" ? `: ${msg.slice(0, 200)}` : "";
        throw new GitHubError(`HTTP ${res.status}${detail}`, res.status, "http");
      }
      return { status: res.status, body: json };
    },
    async log(path, maxBytes, signal) {
      const { client: c } = await ready();
      return await c.downloadLog(path, { signal, maxBytes }).catch(reset);
    },
    rate: () => client?.rate() ?? null,
  };
}
