// Fleet under settings that aren't the fixtures' org: the owners' repos (an org's and a user's),
// pools grouped from the org's runners with no health variable read, a user owner's repos with no
// runner request, the snapshot naming the owners, and the MCP server's optional paths. No network.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { withSettings } from "./fixture-settings.ts";
import { fakeFetch, NOW, type Route } from "./helpers.ts";
import { DEFAULT_SETTINGS, type FleetSettings } from "../lib/settings.ts";
import { createGitHubClient } from "../lib/github.ts";
import { Poller } from "../lib/poller.ts";
import { seedPools } from "../lib/pools.ts";
import { statusResult } from "../mcp/queries.ts";
import { buildAgentSnapshot } from "../lib/agent-snapshot.ts";
import { pathsFromArgs } from "../mcp/fleet-mcp.ts";
import { forgetDefaultBranches } from "../lib/branches.ts";

const SETTINGS: FleetSettings = {
  ...DEFAULT_SETTINGS,
  setupComplete: true,
  owners: [{ login: "acme", kind: "org" }, { login: "jo", kind: "user" }],
  repos: { allow: [], deny: ["acme/secret"], pinned: [] },
};

const empty = { body: { total_count: 0, workflow_runs: [] } };

function routes(): Record<string, Route> {
  const r: Record<string, Route> = {
    "/orgs/acme/repos?per_page=100&type=all": {
      body: [
        { full_name: "acme/web", default_branch: "main" },
        { full_name: "acme/secret", default_branch: "main" },
        { full_name: "acme/old", default_branch: "main", archived: true },
      ],
    },
    "/user/repos?per_page=100&affiliation=owner": {
      body: [{ full_name: "jo/dots", default_branch: "trunk", private: true }],
    },
    "/orgs/acme/actions/runners?per_page=100": {
      body: {
        total_count: 2,
        runners: [
          {
            id: 1,
            name: "gpu-1",
            status: "online",
            busy: true,
            labels: [{ name: "self-hosted", type: "read-only" }, { name: "gpu", type: "custom" }],
          },
          {
            id: 2,
            name: "gpu-2",
            status: "online",
            busy: false,
            labels: [{ name: "self-hosted", type: "read-only" }, { name: "gpu", type: "custom" }],
          },
        ],
      },
    },
  };
  for (const repo of ["acme/web", "jo/dots", "acme/secret"]) {
    for (const s of ["queued", "in_progress", "waiting"]) {
      r[`/repos/${repo}/actions/runs?status=${s}&per_page=100`] = empty;
    }
  }
  return r;
}

Deno.test("neutral: the owners' repos, pools from the runners, no health variable, owners named", async () => {
  forgetDefaultBranches();
  await withSettings(SETTINGS, async () => {
    const { fetch, seen } = fakeFetch(routes());
    const p = new Poller({
      client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
      auth: "gh",
      now: () => NOW,
    });
    assertEquals(seedPools(), []);
    assert((await p.poll()).ok);
    const urls = seen.map((s) => s.url);
    assertFalse(urls.some((u) => u.includes("/actions/variables/")), "no variable configured");
    assertFalse(urls.some((u) => u.includes("/users/jo/repos")), "the user's own list sufficed");
    assertFalse(urls.some((u) => u.includes("acme/secret/actions")), "a denied repo isn't polled");
    assertFalse(urls.some((u) => u.includes("/repos/acme/old/")), "an archived repo isn't polled");
    assertEquals(p.repoNames().sort(), ["acme/web", "jo/dots"]);
    assertEquals(p.defaultBranch("jo/dots"), "trunk");
    const snap = p.snapshot();
    assertEquals(snap.owners, ["acme", "jo"]);
    const gpu = snap.pools.find((c) => c.id === "gpu")!;
    assertEquals([gpu.slots, gpu.busy, gpu.state], [2, 1, "ok"]);
    assertEquals(snap.health.message, "", "no 'unavailable' note without a variable");
    // The agents' snapshot and fleet_status name the owners.
    const agent = buildAgentSnapshot({
      now: NOW,
      updatedAt: NOW,
      source: "poll",
      snapshot: snap,
      hosts: {},
      runs: [],
      annotations: new Map(),
    });
    assertEquals(agent.owners, ["acme", "jo"]);
    assertEquals(
      (statusResult(agent, NOW, { watchdog: null, hooksSpoolAt: null }) as unknown as {
        owners: string[];
      })
        .owners,
      ["acme", "jo"],
    );
  });
  forgetDefaultBranches();
});

Deno.test("neutral: no owners and nothing pinned polls nothing", async () => {
  await withSettings(DEFAULT_SETTINGS, async () => {
    const { fetch, seen } = fakeFetch({});
    const p = new Poller({
      client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
      auth: "gh",
      now: () => NOW,
    });
    assert((await p.poll()).ok);
    assertEquals(seen.map((s) => s.url), []);
    assertEquals(p.snapshot().pools.map((c) => c.id), ["github"]);
  });
});

Deno.test("mcp: the spool and the health file are optional", () => {
  assertEquals(pathsFromArgs(["--data-dir", "/d"]), {
    dataDir: "/d",
    hooksDir: null,
    healthFile: null,
  });
  assertEquals(pathsFromArgs(["--data-dir=/d", "--hooks-dir", "/h", "--health-file", "/f"]), {
    dataDir: "/d",
    hooksDir: "/h",
    healthFile: "/f",
  });
});
