// Test helpers: the recorded fixtures (trimmed GitHub responses, no credentials), a fixed clock,
// and a fake `fetch` that serves routes with ETags and answers 304 to a matching If-None-Match.
// Importing it applies the settings the fixtures were recorded under (tests/fixture-settings.ts).

import "./fixture-settings.ts";

/** The fixtures' "now": 2026-11-11T17:30:00Z, mid-way through the recorded CI run. */
export const NOW = Date.parse("2026-11-11T17:30:00Z");

/** A fixture's JSON. */
export function fixture<T = unknown>(name: string): T {
  return JSON.parse(Deno.readTextFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
}

/** One route's answer. */
export interface Route {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/** A recorded request. */
export interface Seen {
  url: string;
  headers: Headers;
  status: number;
}

/** A fake fetch over `routes` (keyed by path + query). */
export function fakeFetch(
  routes: Record<string, Route | (() => Route)>,
  rate = { remaining: 4999, limit: 5000, reset: Math.floor(NOW / 1000) + 3600 },
): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const f = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(
      typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
    );
    const key = url.pathname + url.search;
    const headers = new Headers(init?.headers);
    const r0 = routes[key];
    const r = typeof r0 === "function" ? r0() : r0;
    const rateHeaders = {
      "x-ratelimit-remaining": String(rate.remaining),
      "x-ratelimit-limit": String(rate.limit),
      "x-ratelimit-reset": String(rate.reset),
    };
    let res: Response;
    if (!r) {
      res = new Response(JSON.stringify({ message: "Not Found" }), {
        status: 404,
        headers: rateHeaders,
      });
    } else {
      const text = JSON.stringify(r.body ?? {});
      const etag = `"${hash(text)}"`;
      const status = r.status ?? 200;
      if (status === 200 && headers.get("if-none-match") === etag) {
        res = new Response(null, { status: 304, headers: { ...rateHeaders, etag } });
      } else {
        res = new Response(status === 304 ? null : text, {
          status,
          headers: { "content-type": "application/json", etag, ...rateHeaders, ...r.headers },
        });
      }
    }
    seen.push({ url: key, headers, status: res.status });
    return Promise.resolve(res);
  };
  return { fetch: f as typeof fetch, seen };
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** The standard routes: denext's CI run in progress, deno's queued runs, runners, health. */
export function standardRoutes(): Record<string, Route> {
  const empty = { body: { total_count: 0, workflow_runs: [] } };
  const routes: Record<string, Route> = {
    "/orgs/Brainwires/repos?per_page=100&type=all": {
      body: [
        { full_name: "Brainwires/deno", pushed_at: "2026-11-11T16:00:00Z" },
        { full_name: "Brainwires/denext", pushed_at: "2026-11-11T16:40:00Z" },
        { full_name: "Brainwires/laufey", pushed_at: "2026-11-01T00:00:00Z" },
        { full_name: "Brainwires/qutty", pushed_at: "2026-11-01T00:00:00Z" },
        { full_name: "Brainwires/old-thing", pushed_at: "2024-01-01T00:00:00Z" },
        { full_name: "Brainwires/archived", pushed_at: "2026-11-11T00:00:00Z", archived: true },
      ],
    },
    "/orgs/Brainwires/actions/runners?per_page=100": { body: fixture("runners.json") },
    "/orgs/Brainwires/actions/variables/DENEXT_POOL_HEALTH": {
      body: fixture("health-variable.json"),
    },
  };
  for (const repo of ["deno", "denext", "laufey", "qutty", "old-thing"]) {
    for (const s of ["queued", "in_progress", "waiting"]) {
      routes[`/repos/Brainwires/${repo}/actions/runs?status=${s}&per_page=100`] = empty;
    }
  }
  routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
    body: fixture("denext-runs-in_progress.json"),
  };
  routes["/repos/Brainwires/deno/actions/runs?status=queued&per_page=100"] = {
    body: fixture("deno-runs-queued.json"),
  };
  const run = fixture<{ workflow_runs: { id: number }[] }>("denext-runs-in_progress.json")
    .workflow_runs[0];
  routes[`/repos/Brainwires/denext/actions/runs/${run.id}/jobs?per_page=100`] = {
    body: fixture("denext-ci-jobs.json"),
  };
  for (
    const r of fixture<{ workflow_runs: { id: number }[] }>("deno-runs-queued.json").workflow_runs
  ) {
    routes[`/repos/Brainwires/deno/actions/runs/${r.id}/jobs?per_page=100`] = {
      body: { total_count: 0, jobs: [] },
    };
  }
  return routes;
}

/** The denext CI run's id in the fixtures. */
export function ciRunId(): number {
  return fixture<{ workflow_runs: { id: number }[] }>("denext-runs-in_progress.json")
    .workflow_runs[0].id;
}
