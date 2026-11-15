// The pool detail screen and the log viewer, rendered with denext/testing from history data: the
// charts with titles and labelled axes, the empty state, the range picker, Back, the GitHub-hosted
// variant (images, minutes), a pool card opening it, the Logs tab (runner logs, scheduler lines, a
// job's GitHub log in the viewer) and the viewer's virtualization, search and folding.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { type LogsApi, PoolDetailView } from "../app/pool-detail.tsx";
import { LogViewer, searchRows, visibleLines } from "../app/log-viewer.tsx";
import { niceTicks, timeLabel } from "../app/charts.tsx";
import { FleetView } from "../app/fleet-view.tsx";
import { COARSE_MS, HistoryStore, imageKey, type JobRecord } from "../lib/history.ts";
import { poolDetail } from "../lib/pool-detail.ts";
import type { LogView } from "../lib/logs.ts";
import type { PoolCard, Snapshot } from "../lib/model.ts";
import { createGitHubClient } from "../lib/github.ts";
import { Poller } from "../lib/poller.ts";
import { fakeFetch, NOW, standardRoutes } from "./helpers.ts";

const T0 = Math.floor(NOW / COARSE_MS) * COARSE_MS;
const MIN = 60_000;

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
const text = (el: TestElement) => el.textContent ?? "";
const button = (root: TestElement, label: string) =>
  all(root, "button").find((b) => text(b).trim() === label);

const CARD: PoolCard = {
  id: "mac-arm",
  title: "mac-arm",
  label: "acme-macos-arm64",
  slots: 2,
  busy: 1,
  running: 1,
  queued: 2,
  state: "ok",
  reason: "",
  since: null,
  oldestQueuedSince: T0 - 4 * MIN,
};

function job(id: number, over: Partial<JobRecord> = {}): JobRecord {
  return {
    id,
    runId: 9,
    repo: "acme/web",
    workflow: "CI",
    name: `build ${id}`,
    pool: "mac-arm",
    runner: `acme-mac-arm-1-${id}`,
    created: T0 - 20 * MIN,
    started: T0 - 15 * MIN,
    completed: T0 - 5 * MIN,
    conclusion: id % 3 === 0 ? "failure" : "success",
    url: `https://github.com/acme/web/actions/runs/9/job/${id}`,
    ...over,
  };
}

function store(): HistoryStore {
  const h = new HistoryStore();
  for (let i = 0; i < 40; i++) {
    h.sample(T0 - 40 * MIN + i * MIN, [
      { key: "mac-arm", busy: i % 3, slots: 2, queued: i % 2, waitMs: i * 1000 },
      { key: imageKey("ubuntu-24.04"), busy: 1, slots: null, queued: 0, waitMs: 0 },
      { key: "github", busy: 2, slots: null, queued: 0, waitMs: 0 },
    ]);
  }
  for (let i = 1; i <= 6; i++) h.jobDone(job(i), T0);
  h.jobDone(job(50, { pool: "github", image: "ubuntu-24.04", runner: "GitHub Actions 5" }), T0);
  return h;
}

function detailOf(pool: string, h = store(), range: "1h" | "24h" = "1h") {
  return poolDetail({
    store: h,
    snapshot: { pools: [CARD] } as unknown as Snapshot,
    events: [],
    pool,
    range,
    now: T0,
  });
}

Deno.test("detail: header, summary and the four charts with titles, axes and a legend", async () => {
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm")}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
    />,
  );
  const c = screen.container;
  assertEquals(text(all(c, ".detail-name")[0]), "mac-arm");
  assertStringIncludes(text(all(c, ".detail-facts")[0]), "1/2");
  assertStringIncludes(text(all(c, ".detail-facts")[0]), "oldest 4m 00s");
  const titles = all(c, ".chart-title").map(text);
  for (
    const t of [
      "Utilization",
      "Queue length",
      "Oldest wait",
      "Throughput",
      "Job duration",
      "Duration distribution",
    ]
  ) {
    assert(titles.includes(t), `missing chart ${t}: ${titles}`);
  }
  // Every chart with data has an SVG with labelled axes and a faint grid.
  const charts = all(c, ".chart");
  const util = charts.find((ch) => text(ch).includes("Utilization"))!;
  const svg = all(util, "svg")[0];
  assert(svg, "an SVG");
  assertEquals(svg.getAttribute("role"), "img");
  assert(all(util, ".axis-y")[0].children.length >= 2, "y ticks");
  assert(all(util, ".axis-x")[0].children.length >= 3, "x ticks");
  assert(all(util, ".grid").length === 1);
  assert(all(util, ".latest").length === 1, "the latest point is marked");
  assertStringIncludes(text(all(util, ".legend")[0]), "capacity (slots)");
  // The summary row and the jobs table.
  assertStringIncludes(text(all(c, ".stats")[0]), "jobs finished");
  assertEquals(all(c, ".jobs-table")[0].children.length > 0, true);
  assertStringIncludes(text(all(c, ".jobs-table")[0]), "build 6");
  // The data table opens from each chart.
  await screen.fireEvent.click(button(util, "Show as a table")!);
  assert(all(util, "table").length === 1);
});

Deno.test("detail: an empty history shows the empty state, not blank charts", async () => {
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm", new HistoryStore())}
      range="24h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
    />,
  );
  const empties = all(screen.container, ".chart-empty").map(text);
  assert(empties.length >= 5);
  assertStringIncludes(empties.join(" "), "No samples for this range yet");
  assertEquals(all(screen.container, "svg").length, 0);
  assertStringIncludes(text(screen.container), "No finished jobs recorded for this pool yet.");
});

Deno.test("detail: the range picker switches ranges; Back returns", async () => {
  const ranges: string[] = [];
  let back = 0;
  const h = store();
  const view = (r: "1h" | "24h") => (
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm", h, r)}
      range={r}
      onRange={(x) => ranges.push(x)}
      onBack={() => back++}
      onOpen={() => {}}
      now={T0}
    />
  );
  const screen = await render(view("1h"));
  const seg = (label: string) => all(screen.container, ".seg").find((b) => text(b) === label)!;
  assertEquals(seg("1 h").getAttribute("aria-pressed"), "true");
  await screen.fireEvent.click(seg("24 h"));
  assertEquals(ranges, ["24h"]);
  await screen.rerender(view("24h"));
  assertEquals(seg("24 h").getAttribute("aria-pressed"), "true");
  // 24 h: 96 points of 15 minutes.
  const util = all(screen.container, ".chart").find((ch) => text(ch).includes("Utilization"))!;
  assertEquals(all(util, ".hit").length, 96);
  await screen.fireEvent.click(button(screen.container, "← Back")!);
  assertEquals(back, 1);
});

Deno.test("detail: GitHub-hosted shows usage by image and minutes, no slots", async () => {
  const screen = await render(
    <PoolDetailView
      pool="github"
      detail={detailOf("github")}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
    />,
  );
  const titles = all(screen.container, ".chart-title").map(text);
  assert(titles.includes("Running jobs by image"));
  assert(titles.includes("Minutes used"));
  assertFalse(titles.includes("Utilization"));
  assertStringIncludes(text(all(screen.container, ".legend")[0]), "ubuntu-24.04");
  assertStringIncludes(text(all(screen.container, ".stats")[0]), "minutes used");
});

Deno.test("detail: a pool card (and the GitHub-hosted panel) opens its detail", async () => {
  const { fetch } = fakeFetch(standardRoutes());
  const p = new Poller({
    client: createGitHubClient({ token: "x".repeat(40), fetch, now: () => NOW }),
    auth: "gh",
    now: () => NOW,
  });
  await p.poll();
  const opened: string[] = [];
  const screen = await render(
    <FleetView
      snapshot={p.snapshot()}
      now={NOW}
      onOpen={() => {}}
      onRefresh={() => {}}
      onPoolDetail={(id) => opened.push(id)}
    />,
  );
  const links = all(screen.container, ".pool-link");
  assert(links.length > 2);
  await screen.fireEvent.click(links[0]);
  await screen.fireEvent.click(all(screen.container, ".pool-github")[0]);
  assertEquals(opened[0], text(links[0]));
  assertEquals(opened.at(-1), "github");
});

const VIEW: LogView = {
  kind: "github",
  title: "CI · build",
  lines: [
    "2026-11-13T00:00:00.0Z ##[group]Run actions/checkout",
    "2026-11-13T00:00:00.1Z fetching",
    "2026-11-13T00:00:00.2Z ##[endgroup]",
    "2026-11-13T00:00:01.0Z \x1b[31merror\x1b[0m: tests failed",
    "2026-11-13T00:00:02.0Z token [redacted] used",
  ],
  groups: [{ title: "Run actions/checkout", start: 0, end: 2 }],
  truncated: false,
};

Deno.test("logs tab: runner logs, scheduler lines, and a job's GitHub log in the viewer", async () => {
  const calls: string[] = [];
  const api: LogsApi = {
    runnerLogList: () =>
      Promise.resolve({
        configured: true,
        logs: [{
          file: "mac-arm-1-1794551969.log",
          pool: "mac-arm",
          slot: 1,
          startedAt: T0,
          modifiedAt: T0,
          size: 10,
          rc: 0,
          durationMs: 127_000,
          diskBeforeGb: 92,
          diskAfterGb: 91,
          jobName: "cross-package",
          jobResult: "Succeeded",
          jobId: 6,
          runId: 9,
          repo: "acme/web",
          runner: "acme-mac-arm-1-1794552008",
        }],
      }),
    poolLogLines: () =>
      Promise.resolve({
        configured: true,
        scheduler: ["2026-11-13 00:41:35 scheduler: job done pool=mac-arm slot=1"],
        alerts: [],
      }),
    runnerLog: (pool, file) => {
      calls.push(`runner ${pool} ${file}`);
      return Promise.resolve({ ...VIEW, kind: "runner", title: file, groups: [] });
    },
    runnerLogForJob: () => Promise.resolve({ error: "none" }),
    jobLog: (repo, id) => {
      calls.push(`job ${repo} ${id}`);
      return Promise.resolve(VIEW);
    },
  };
  const d = { ...detailOf("mac-arm"), runnerLogs: true };
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={d}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      logs={api}
      initialTab="logs"
    />,
  );
  await new Promise((r) => setTimeout(r, 10));
  await screen.rerender(
    <PoolDetailView
      pool="mac-arm"
      detail={d}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      logs={api}
      initialTab="logs"
    />,
  );
  const c = screen.container;
  const table = all(c, ".runner-logs")[0];
  assert(table, "the launcher logs table");
  for (
    const t of ["acme-mac-arm-1-1794552008", "cross-package", "rc=0", "2m 07s", "92 GB → 91 GB"]
  ) {
    assertStringIncludes(text(table), t);
  }
  assertStringIncludes(text(all(c, ".lines-box")[0]), "job done pool=mac-arm");
  // A job's GitHub log opens in the viewer.
  await screen.fireEvent.click(all(c, "button").find((b) => text(b) === "View log")!);
  await new Promise((r) => setTimeout(r, 10));
  await screen.rerender(
    <PoolDetailView
      pool="mac-arm"
      detail={d}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      logs={api}
      initialTab="logs"
    />,
  );
  assert(/^job acme\/web \d+$/.test(calls[0]), calls[0]);
  const viewer = all(c, ".logview")[0];
  assert(viewer, "the viewer");
  assertStringIncludes(text(viewer), "tests failed");
  assertFalse(text(viewer).includes("2026-11-13T00:00:01.0Z"), "GitHub's timestamps hidden");
  assert(all(viewer, ".ansi-red").length === 1, "ANSI colour as a class");
  assertFalse(text(viewer).includes("\x1b"));
});

Deno.test("logs tab: without the integration it says so and offers GitHub logs only", async () => {
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm")}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      logs={{} as LogsApi}
      initialTab="logs"
    />,
  );
  assertStringIncludes(text(screen.container), "logsDir");
  assertEquals(all(screen.container, ".runner-logs").length, 0);
  assert(all(screen.container, "button").some((b) => text(b) === "View log"));
  assertFalse(all(screen.container, "button").some((b) => text(b) === "Runner log"));
});

Deno.test("viewer: virtualized, searchable, foldable", async () => {
  const big: LogView = {
    kind: "runner",
    title: "big.log",
    lines: Array.from({ length: 20_000 }, (_, i) => (i % 1000 === 0 ? `needle ${i}` : `line ${i}`)),
    truncated: true,
  };
  const screen = await render(<LogViewer view={big} onClose={() => {}} />);
  const rows = all(screen.container, ".logline");
  assert(rows.length > 0 && rows.length <= 200, `rendered ${rows.length} rows of 20,000`);
  assertStringIncludes(text(all(screen.container, ".logview-note")[0]), "end of the log");
  assertEquals(searchRows(big, visibleLines(big, new Set()), "NEEDLE").length, 20);
  // Folding a group hides its body, keeps its header.
  assertEquals(visibleLines(VIEW, new Set([0])), [0, 3, 4]);
  assertEquals(visibleLines(VIEW, new Set()), [0, 1, 2, 3, 4]);
  const g = await render(<LogViewer view={VIEW} onClose={() => {}} />);
  await g.fireEvent.click(all(g.container, ".fold")[0]);
  assertEquals(all(g.container, ".logline").length, 3);
});

Deno.test("charts: nice ticks and time labels", () => {
  assertEquals(niceTicks(3), [0, 1, 2, 3]);
  assertEquals(niceTicks(7), [0, 2, 4, 6, 8]);
  assertEquals(niceTicks(0), [0, 1]);
  const t = new Date(2026, 10, 13, 9, 5).getTime();
  assertEquals(timeLabel(t, 60_000), "09:05");
  assertEquals(timeLabel(t, 6 * 3600_000), "Fri 13");
  assertEquals(timeLabel(t, 3600_000), "Fri 13 09h");
});

Deno.test("detail: Esc returns to the dashboard", async () => {
  let back = 0;
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm")}
      range="1h"
      onRange={() => {}}
      onBack={() => back++}
      onOpen={() => {}}
      now={T0}
    />,
  );
  await screen.fireEvent.keyDown(all(screen.container, ".detail")[0], { key: "Escape" });
  assertEquals(back, 1);
});

const tabsOf = (root: TestElement) =>
  all(root, "button").filter((b) => b.getAttribute("role") === "tab");

Deno.test("pool detail: reports its tab on mount and on a change, and reopens on a given one", async () => {
  const tabs: string[] = [];
  const screen = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm")}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      onTab={(t) => void tabs.push(t)}
    />,
  );
  await screen.act(() => new Promise((r) => setTimeout(r, 0)));
  assertEquals(tabs, ["usage"]);
  const logsTab = tabsOf(screen.container).find((b) => /log/i.test(text(b)))!;
  await screen.fireEvent.click(logsTab);
  assertEquals(tabs.at(-1), "logs");
  const restored = await render(
    <PoolDetailView
      pool="mac-arm"
      detail={detailOf("mac-arm")}
      range="1h"
      onRange={() => {}}
      onBack={() => {}}
      onOpen={() => {}}
      now={T0}
      initialTab="logs"
    />,
  );
  const active = tabsOf(restored.container).find((b) =>
    b.getAttribute("aria-selected") === "true"
  )!;
  assertEquals(/log/i.test(text(active)), true);
});
