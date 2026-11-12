// The main view and the first-run screen, rendered with denext/testing's `render` from fixture
// data (the poller's snapshot of the recorded CI run). No desktop runtime, no network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { FleetView } from "../app/fleet-view.tsx";
import { TokenScreen } from "../app/token-screen.tsx";
import { createGitHubClient } from "../lib/github.ts";
import type { GhRunList } from "../lib/github-types.ts";
import type { FleetEvent } from "../lib/events.ts";
import type { JobRow, Snapshot } from "../lib/model.ts";
import { eventText } from "../app/event-log.tsx";
import { githubImage } from "../lib/classify.ts";
import { shortRunner } from "../lib/format.ts";
import { Poller } from "../lib/poller.ts";
import { fakeFetch, fixture, NOW, standardRoutes } from "./helpers.ts";

/** Every descendant matching `sel`: a `.class` (all of `.a.b`'s classes) or a tag name. */
function all(root: TestElement, sel: string): TestElement[] {
  const want = sel.startsWith(".") ? sel.slice(1).split(".") : null;
  const out: TestElement[] = [];
  const walk = (el: TestElement) => {
    for (const c of el.children) {
      const cls = (c.getAttribute("class") ?? "").split(/\s+/);
      if (want ? want.every((w) => cls.includes(w)) : c.localName === sel) out.push(c);
      walk(c);
    }
  };
  walk(root);
  return out;
}

/** The first match of a space-separated path of selectors (`.count-run .num`). */
function one(root: TestElement, path: string): TestElement | undefined {
  let found: TestElement[] = [root];
  for (const sel of path.split(" ")) found = found.flatMap((el) => all(el, sel));
  return found[0];
}

async function fixtureSnapshot(defaultBranch = false): Promise<Snapshot> {
  const routes = standardRoutes();
  if (defaultBranch) {
    const runs = fixture<GhRunList>("denext-runs-in_progress.json");
    routes["/repos/Brainwires/denext/actions/runs?status=in_progress&per_page=100"] = {
      body: { ...runs, workflow_runs: [{ ...runs.workflow_runs[0], head_branch: "development" }] },
    };
  }
  const { fetch } = fakeFetch(routes);
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  return p.snapshot();
}

Deno.test("view: counts, pools, lanes, alerts and finished jobs from the fixtures", async () => {
  const snap = await fixtureSnapshot();
  const opened: string[] = [];
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={(u) => opened.push(u)} onRefresh={() => {}} />,
  );
  const html = screen.html();
  // The summary: 2 running, 3 queued, red because win-x64 is unhealthy.
  assertStringIncludes(html, "sev-alert");
  assertEquals(one(screen.container, ".count-run .num")?.textContent, "2");
  assertEquals(one(screen.container, ".count-q .num")?.textContent, "3");
  // One card per pool (per host: win-x64 and win-x64-brain share a label) plus GitHub-hosted.
  const names = all(screen.container, ".pool-name").map((n) => n.textContent);
  assertEquals(names, [
    "mac-arm",
    "mac-x64",
    "linux-x64",
    "linux-x64-2204",
    "linux-x64-docker",
    "win-arm64",
    "win-x64",
    "win-x64-brain",
    "GitHub-hosted",
  ]);
  assertStringIncludes(html, "pool pool-unhealthy");
  assertStringIncludes(html, "the Windows guest on macbook unreachable");
  assertStringIncludes(html, "pool pool-paused");
  // linux-x64: 3 slots, 3 busy pips; its oldest queued job waited 47 min.
  const linux = all(screen.container, ".pool")[2];
  assertEquals(all(linux, ".pip").length, 3);
  assertEquals(all(linux, ".pip-on").length, 3);
  assertStringIncludes(linux.textContent ?? "", "47m 06s");
  // Lanes: the running jobs with their pools and ticking times.
  const lanes = all(screen.container, ".lane");
  assertStringIncludes(lanes[0].textContent ?? "", "coverage");
  assertStringIncludes(lanes[0].textContent ?? "", "linux-x64-docker");
  assertStringIncludes(lanes[0].textContent ?? "", "45m 39s");
  assertStringIncludes(lanes[0].textContent ?? "", "train/4.17");
  // Queued: deno's two runs waiting for jobs, and denext's late jobs flagged. linux-x64 has every
  // slot busy, so its long waits are capacity waits (amber), not faults.
  assertStringIncludes(lanes[1].textContent ?? "", "queued, no jobs yet");
  assertEquals(all(lanes[1], ".job-queued-long").length, 0);
  assertEquals(all(lanes[1], ".job-queued-capacity").length, 3);
  assertStringIncludes(lanes[1].textContent ?? "", "waiting for a free slot (pool full)");
  assertEquals(all(linux, ".is-capacity").length, 1);
  assertEquals(all(linux, ".is-late").length, 0);
  // Not a default branch: no marker.
  assertFalse(html.includes("run-default"));
  // Side: alerts and finished.
  assertStringIncludes(html, "RECOVERED: biscuits reachable again");
  assertEquals(all(one(screen.container, ".finished")!, ".done").length, 5);
  assertStringIncludes(html, "API");
  assertStringIncludes(html, "4,999");
  // Clicking a job opens it on github.com, through onOpen.
  const link = one(lanes[0], ".job-name")!;
  await screen.fireEvent.click(link);
  assertEquals(opened.length, 1);
  assert(opened[0].startsWith("https://github.com/Brainwires/denext/actions/runs/"));
  await screen.unmount();
});

Deno.test("view: a default branch gets its marker; the clock ticks the times", async () => {
  const snap = await fixtureSnapshot(true);
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  assertStringIncludes(screen.html(), "run run-default");
  assertStringIncludes(screen.html(), 'aria-label="default branch"');
  await screen.rerender(
    <FleetView snapshot={snap} now={NOW + 61_000} onOpen={() => {}} onRefresh={() => {}} />,
  );
  assertStringIncludes(one(screen.container, ".lane")?.textContent ?? "", "46m 40s");
  await screen.unmount();
});

Deno.test("view: an empty, healthy snapshot reads calmly", async () => {
  const snap = await fixtureSnapshot();
  const calm: Snapshot = {
    ...snap,
    running: [],
    queued: [],
    finished: [],
    alerts: [],
    health: { state: "unavailable", checkedAt: null, message: "pool health unavailable" },
    pools: snap.pools.map((p) => ({
      ...p,
      state: "unknown",
      reason: "",
      queued: 0,
      oldestQueuedSince: null,
    })),
    summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
  };
  const screen = await render(
    <FleetView snapshot={calm} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  const html = screen.html();
  assertStringIncludes(html, "sev-ok");
  assertStringIncludes(html, "Nothing running.");
  assertStringIncludes(html, "Nothing queued.");
  assertStringIncludes(html, "pool health unavailable");
  assertStringIncludes(html, "all clear");
  await screen.unmount();
});

Deno.test("token screen: the pasted token goes to the backend and the field is cleared", async () => {
  const submitted: string[] = [];
  const screen = await render(
    <TokenScreen
      auth="needs-token"
      submit={(t) => {
        submitted.push(t);
        return Promise.resolve({ ok: false, message: "GitHub refused that token." });
      }}
      retryGh={() => Promise.resolve(false)}
      usePublic={() => Promise.resolve()}
      onOpen={() => {}}
    />,
  );
  const input = one(screen.container, "input")!;
  await screen.fireEvent.input(input, { target: { value: "github_pat_test_only" } });
  const form = one(screen.container, "form");
  await screen.fireEvent.submit(form!);
  await screen.act(() => new Promise((r) => setTimeout(r, 0)));
  assertEquals(submitted, ["github_pat_test_only"]);
  assertStringIncludes(screen.html(), "GitHub refused that token.");
  assertFalse(screen.html().includes("github_pat_test_only"));
  await screen.unmount();
});

const EVENTS: FleetEvent[] = [
  {
    seq: 1,
    at: NOW,
    sev: "info",
    kind: "queued",
    repo: "Brainwires/denext",
    workflow: "CI",
    job: "check",
    text: "queued for linux-x64",
    url: "https://github.com/Brainwires/denext/actions/runs/1/job/11",
    branch: "development",
  },
  {
    seq: 2,
    at: NOW + 1000,
    sev: "bad",
    kind: "finished",
    repo: "Brainwires/deno",
    workflow: "denext tests",
    job: "unit",
    text: 'finished: failure at step "Run tests"',
    url: "https://github.com/Brainwires/deno/actions/runs/2/job/22",
  },
  {
    seq: 3,
    at: NOW + 2000,
    sev: "muted",
    kind: "run-cancelled",
    repo: "Brainwires/denext",
    workflow: "CI",
    job: null,
    text: "run 3 cancelled (14 jobs)",
    url: "https://github.com/Brainwires/denext/actions/runs/3",
  },
  {
    seq: 4,
    at: NOW + 3000,
    sev: "warn",
    kind: "pool-health",
    repo: "",
    workflow: "pool win-x64",
    job: null,
    text: "win-x64 paused",
    url: null,
  },
];

Deno.test("event log: lines with a glyph mark, filters, search, and links out", async () => {
  const snap = await fixtureSnapshot();
  const opened: string[] = [];
  const screen = await render(
    <FleetView
      snapshot={snap}
      now={NOW}
      onOpen={(u) => opened.push(u)}
      onRefresh={() => {}}
      events={EVENTS}
    />,
  );
  const log = one(screen.container, ".log")!;
  const lines = () => all(log, ".ev");
  assertEquals(lines().length, 4);
  // Severity is a glyph with a label, not colour alone.
  const marks = all(log, ".ev-mark");
  assertEquals(marks.map((m) => m.textContent), ["•", "✕", "⊘", "▲"]);
  assertEquals(marks[1].getAttribute("aria-label"), "problem");
  assertStringIncludes(lines()[0].textContent, "CI / check");
  assertStringIncludes(lines()[3].textContent, "fleet");
  // Problems only.
  const [allBtn, problemsBtn] = all(log, ".seg-btn");
  await screen.fireEvent.click(problemsBtn);
  assertEquals(lines().map((l) => one(l, ".ev-text")?.textContent), [
    'finished: failure at step "Run tests"',
    "win-x64 paused",
  ]);
  await screen.fireEvent.click(allBtn);
  // By repo.
  await screen.fireEvent.change(one(log, "select")!, { target: { value: "Brainwires/denext" } });
  assertEquals(lines().length, 2);
  await screen.fireEvent.change(one(log, "select")!, { target: { value: "" } });
  // Search.
  await screen.fireEvent.input(one(log, "input")!, { target: { value: "cancelled" } });
  assertEquals(lines().length, 1);
  await screen.fireEvent.click(one(lines()[0], ".ev-link")!);
  assertEquals(opened, ["https://github.com/Brainwires/denext/actions/runs/3"]);
  await screen.fireEvent.input(one(log, "input")!, { target: { value: "nothing like this" } });
  assertStringIncludes(log.textContent, "No events match.");
  await screen.unmount();
});

Deno.test("view: the rate-limit banner and the budget colour", async () => {
  const snap = await fixtureSnapshot();
  const low: Snapshot = {
    ...snap,
    rate: { remaining: 700, limit: 5000, resetAt: NOW + 600_000 },
    poll: { ...snap.poll, slow: "low" },
  };
  const screen = await render(
    <FleetView snapshot={low} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  assertStringIncludes(
    one(screen.container, ".banner")!.textContent,
    "Rate limit low: slowed down to protect the runner scheduler.",
  );
  assertStringIncludes(one(screen.container, ".rate")!.getAttribute("class") ?? "", "status-bad");
  await screen.rerender(
    <FleetView
      snapshot={{ ...low, rate: { remaining: 1400, limit: 5000, resetAt: NOW }, poll: snap.poll }}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );
  assertEquals(one(screen.container, ".banner"), undefined);
  assertStringIncludes(one(screen.container, ".rate")!.getAttribute("class") ?? "", "status-warn");
  await screen.unmount();
});

/** The fixture snapshot with one GitHub-hosted job running in the first running run. */
async function withGithubJob(): Promise<Snapshot> {
  const snap = await fixtureSnapshot();
  const [g, ...rest] = snap.running;
  const [r, ...runs] = g.runs;
  const gh: JobRow = {
    id: 999,
    name: "ios-export-router",
    url: "https://github.com/Brainwires/denext/actions/runs/1/job/999",
    lane: "running",
    target: "github",
    pool: "github",
    runner: "GitHub Actions 1000058781",
    image: "macos-15-intel",
    since: NOW - 125_000,
    usualMs: null,
  };
  return {
    ...snap,
    running: [{ ...g, runs: [{ ...r, jobs: [...r.jobs, gh] }, ...runs] }, ...rest],
  };
}

Deno.test("view: long names truncate with the full name as a tooltip", async () => {
  const snap = await withGithubJob();
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  // Pool names: the full name as a title (the chip stays on the head's line: CSS, no wrap).
  const names = all(screen.container, ".pool-name");
  assert(names.every((n) => n.getAttribute("title") === n.textContent));
  // Job rows: the name has a title; GitHub's runner shows as #id with the full name on hover.
  const running = all(screen.container, ".lane")[0];
  const jobNames = all(running, ".job-name");
  assert(jobNames.every((n) => n.getAttribute("title") === n.textContent));
  const ghRunner = all(running, ".job-runner").find((n) => n.textContent === "#1000058781");
  assertEquals(ghRunner?.getAttribute("title"), "GitHub Actions 1000058781");
  // Run headers: the workflow and branch keep their full text as titles.
  assert(all(running, ".run-name").every((n) => n.getAttribute("title") === n.textContent));
  assertEquals(one(running, ".branch")?.getAttribute("title"), "train/4.17");
  await screen.unmount();
});

Deno.test("view: the GitHub-hosted card lists each runner and its job", async () => {
  const snap = await withGithubJob();
  const opened: string[] = [];
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={(u) => opened.push(u)} onRefresh={() => {}} />,
  );
  const gh = one(screen.container, ".pool-github")!;
  // The wide panel sits beside the self-hosted grid, not in it.
  assertEquals(gh.localName, "div");
  assertEquals(all(one(screen.container, ".pools")!, ".pool-github").length, 0);
  const rows = all(gh, ".runner");
  assertEquals(rows.length, 1);
  const name = one(rows[0], ".runner-name")!;
  assertEquals(name.getAttribute("title"), "GitHub Actions 1000058781");
  assertStringIncludes(name.textContent, "macos-15-intel");
  assertEquals(one(rows[0], ".runner-id")?.textContent, "#1000058781");
  assertEquals(one(rows[0], ".runner-state")?.textContent, "running");
  assertEquals(one(rows[0], ".runner-time")?.textContent, "2m 05s");
  const job = one(rows[0], ".runner-job")!;
  assertStringIncludes(job.textContent, "denext · ");
  assertStringIncludes(job.textContent, " · ios-export-router");
  assertEquals(job.getAttribute("title"), job.textContent);
  await screen.fireEvent.click(job);
  assertEquals(opened, ["https://github.com/Brainwires/denext/actions/runs/1/job/999"]);
  await screen.unmount();
  // No GitHub job running: the panel says so.
  const empty = await render(
    <FleetView
      snapshot={await fixtureSnapshot()}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );
  assertStringIncludes(
    one(empty.container, ".pool-github")!.textContent,
    "No GitHub-hosted jobs running.",
  );
  await empty.unmount();
});

Deno.test("view: a self-hosted card opens its busy runners on demand", async () => {
  const snap = await fixtureSnapshot();
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  const card = () =>
    all(screen.container, ".pool").find((p) =>
      one(p, ".pool-name")?.textContent === "linux-x64-docker"
    )!;
  // Compact by default: the load is a toggle, no runner rows.
  const toggle = one(card(), ".pool-toggle")!;
  assertEquals(toggle.getAttribute("aria-expanded"), "false");
  assertEquals(all(card(), ".runner").length, 0);
  assertFalse((card().getAttribute("class") ?? "").includes("pool-open"));
  // A pool with nothing running has no toggle.
  const macX64 = all(screen.container, ".pool").find((p) =>
    one(p, ".pool-name")?.textContent === "mac-x64"
  )!;
  assertEquals(one(macX64, ".pool-toggle"), undefined);
  await screen.fireEvent.click(toggle);
  assertStringIncludes(card().getAttribute("class") ?? "", "pool-open");
  const rows = all(card(), ".runner");
  assertEquals(rows.length, 1);
  assertEquals(
    one(rows[0], ".runner-name")?.getAttribute("title"),
    "denext-linux-x64-docker-1-1794415456",
  );
  assertStringIncludes(one(rows[0], ".runner-job")!.textContent, "coverage");
  await screen.fireEvent.click(one(card(), ".pool-toggle")!);
  assertEquals(all(card(), ".runner").length, 0);
  await screen.unmount();
});

Deno.test("view: an empty Queued lane collapses; it returns when jobs queue", async () => {
  const snap = await fixtureSnapshot();
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  assertFalse(one(screen.container, "main")!.getAttribute("class")!.includes("lanes-q-empty"));
  assertEquals(all(screen.container, ".lane-collapsed").length, 0);
  await screen.rerender(
    <FleetView
      snapshot={{ ...snap, queued: [] }}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );
  assertStringIncludes(one(screen.container, "main")!.getAttribute("class")!, "lanes-q-empty");
  const collapsed = all(screen.container, ".lane-collapsed");
  assertEquals(collapsed.length, 1);
  assertEquals(collapsed[0].getAttribute("aria-label"), "Queued");
  assertStringIncludes(collapsed[0].textContent, "Nothing queued.");
  // An empty Running lane never collapses.
  await screen.rerender(
    <FleetView
      snapshot={{ ...snap, running: [] }}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
    />,
  );
  assertEquals(all(screen.container, ".lane-collapsed").length, 0);
  await screen.unmount();
});

Deno.test("view: an alert is clamped with its text as a title, expanded on click", async () => {
  const snap = await fixtureSnapshot();
  const screen = await render(
    <FleetView snapshot={snap} now={NOW} onOpen={() => {}} onRefresh={() => {}} />,
  );
  const msg = one(screen.container, ".alert-msg")!;
  assertEquals(msg.localName, "button");
  assertEquals(msg.getAttribute("title"), msg.textContent);
  assertEquals(msg.getAttribute("aria-expanded"), "false");
  await screen.fireEvent.click(msg);
  assertStringIncludes(one(screen.container, ".alert")!.getAttribute("class") ?? "", "is-open");
  assertEquals(one(screen.container, ".alert-msg")!.getAttribute("aria-expanded"), "true");
  await screen.unmount();
});

Deno.test("view: a pool's pause durations are one compact segmented group", async () => {
  const snap = await fixtureSnapshot();
  const asked: unknown[] = [];
  const screen = await render(
    <FleetView
      snapshot={snap}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
      controls={{ onControl: () => {}, onPool: (c) => asked.push(c) }}
    />,
  );
  const card = all(screen.container, ".pool")[0];
  const seg = one(card, ".ctl-seg")!;
  const durs = all(seg, ".ctl-dur");
  assertEquals(durs.map((b) => b.textContent), ["1m", "2m", "3m"]);
  assertEquals(durs[0].getAttribute("title"), "Pause for 60 seconds");
  await screen.fireEvent.click(durs[1]);
  await screen.fireEvent.click(all(card, ".ctl")[0]);
  assertEquals(asked, [{ kind: "pause", pool: "mac-arm", seconds: 120 }]);
  // The GitHub panel has no pool controls.
  assertEquals(one(one(screen.container, ".pool-github")!, ".ctl"), undefined);
  await screen.unmount();
});

Deno.test("event log: a start reads short, the runner trimmed apart with a tooltip", async () => {
  const snap = await fixtureSnapshot();
  const base = EVENTS[0];
  const events: FleetEvent[] = [
    {
      ...base,
      seq: 10,
      kind: "started",
      text: "started on GitHub-hosted on GitHub Actions 1000058781",
    },
    {
      ...base,
      seq: 11,
      kind: "started",
      text: "started on mac-arm on denext-mac-arm-1-1794415653",
    },
    { ...base, seq: 12, kind: "started", text: "started on linux-x64" },
  ];
  const screen = await render(
    <FleetView
      snapshot={snap}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
      events={events}
    />,
  );
  const texts = all(one(screen.container, ".log")!, ".ev-text");
  assertEquals(texts.map((t) => t.textContent), [
    "started · GitHub #1000058781",
    "started · mac-arm · denext-mac-arm-1-1794415653",
    "started · linux-x64",
  ]);
  assertEquals(one(texts[0], ".ev-runner")?.getAttribute("title"), "GitHub Actions 1000058781");
  assertEquals(
    one(texts[1], ".ev-runner")?.getAttribute("title"),
    "denext-mac-arm-1-1794415653",
  );
  assertEquals(texts[0].getAttribute("title"), events[0].text);
  // The job column keeps its full text as a title.
  assertEquals(one(screen.container, ".ev-where")?.getAttribute("title"), "CI / check");
  await screen.unmount();
});

Deno.test("format: shortRunner, githubImage and eventText", () => {
  assertEquals(shortRunner("GitHub Actions 1000058781"), "#1000058781");
  assertEquals(shortRunner("denext-mac-arm-1-17944"), "denext-mac-arm-1-17944");
  assertEquals(githubImage(["macos-15-intel"]), "macos-15-intel");
  assertEquals(githubImage(["self-hosted", "denext-linux-x64"]), null);
  assertEquals(githubImage(undefined), null);
  assertEquals(eventText("started on GitHub-hosted on GitHub Actions 7"), {
    text: "started · GitHub",
    runner: "GitHub Actions 7",
  });
  assertEquals(eventText("started on linux-x64"), { text: "started · linux-x64", runner: null });
  assertEquals(eventText("finished: success"), { text: "finished: success", runner: null });
});
