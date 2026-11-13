// The MCP server's fleet_pool_history (bucketed, bounded, read from fleet-history.json) and
// fleet_runner_log (a launcher log's redacted tail, only with --logs-dir), plus the Settings view's
// MCP command naming the logs folder. Temp folders only; no network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { NOW } from "./helpers.ts";
import { createFleetMcp, FleetFiles, TOOLS } from "../mcp/fleet-mcp.ts";
import { HISTORY_FILE } from "../lib/agent-files.ts";
import { COARSE_MS, HistoryStore } from "../lib/history.ts";
import { mcpCommand } from "../app/settings-view.tsx";

// deno-lint-ignore no-explicit-any
type Any = any;
const T0 = Math.floor(NOW / COARSE_MS) * COARSE_MS;
const TOKEN = "gh" + "s_" + "Qw8".repeat(12);

async function setup(withLogs: boolean) {
  const dir = await Deno.makeTempDir({ prefix: "fleet-mcp-h-" });
  const h = new HistoryStore();
  h.sample(T0, [{ key: "mac-arm", busy: 1, slots: 2, queued: 0, waitMs: 0 }]);
  h.jobDone({
    id: 5,
    runId: 9,
    repo: "acme/web",
    workflow: "CI",
    name: "build\u0007",
    pool: "mac-arm",
    runner: "acme-mac-arm-1-1",
    created: T0 - 600_000,
    started: T0 - 500_000,
    completed: T0 - 100_000,
    conclusion: "success",
    url: null,
  }, T0);
  await Deno.writeTextFile(`${dir}/${HISTORY_FILE}`, JSON.stringify(h.toJSON(T0)));
  let logs: string | null = null;
  if (withLogs) {
    logs = `${dir}/logs`;
    await Deno.mkdir(`${logs}/jobs`, { recursive: true });
    const lines = Array.from({ length: 500 }, (_, i) => `step ${i}`);
    lines.push(
      `./run.sh --jitconfig ${"ZXlK".repeat(20)}`,
      `auth ${TOKEN}`,
      "ACME_RUNNER_RESULT rc=0",
    );
    await Deno.writeTextFile(`${logs}/jobs/mac-arm-1-1794551969.log`, lines.join("\n") + "\n");
    await Deno.writeTextFile(
      `${logs}/scheduler.log`,
      "2026-11-13 00:41:35 scheduler: job done pool=mac-arm slot=1 repo=acme/web run=9 job=5 result=rc=0 duration=10s log=/x/jobs/mac-arm-1-1794551969.log\n",
    );
  }
  const server = createFleetMcp(
    new FleetFiles({ dataDir: dir, hooksDir: null, healthFile: null, logsDir: logs }),
    { now: () => T0, watch: false },
  );
  return { dir, server };
}

function call(server: ReturnType<typeof createFleetMcp>, name: string, args: unknown) {
  return server.handle(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
    () => {},
  ) as Promise<Any>;
}
const body = (r: Any) => JSON.parse(r.result.content[0].text);

Deno.test("mcp: the two new tools are listed, read-only, with bounded arguments", () => {
  const names = TOOLS.map((t) => t.name);
  assert(names.includes("fleet_pool_history"));
  assert(names.includes("fleet_runner_log"));
  const rl = TOOLS.find((t) => t.name === "fleet_runner_log")!;
  assertEquals((rl.inputSchema.properties as Any).tail.maximum, 2000);
});

Deno.test("mcp: fleet_pool_history returns the bucketed series, totals and recent jobs", async () => {
  const { dir, server } = await setup(false);
  try {
    const r = body(await call(server, "fleet_pool_history", { pool: "mac-arm", range: "1h" }));
    assertEquals(r.step_s, 60);
    assertEquals(r.points.length, 60);
    assertEquals(r.columns[0], "t");
    const at = r.points.find((p: Any[]) => Date.parse(p[0]) === T0);
    assertEquals([at[1], at[2], at[3]], [1, 2, 0.5]);
    assertEquals(r.totals.ok, 1);
    assertEquals(r.recent_jobs[0].name, "build", "control characters stripped");
    assertEquals(r.recent_jobs[0].duration_s, 400);
    assert("stale" in r, "every answer carries its freshness");
    // 30 d: 120 points; an unknown pool says which are known.
    const month = body(await call(server, "fleet_pool_history", { pool: "nope", range: "30d" }));
    assertEquals(month.points.length, 120);
    assertStringIncludes(month.note, "mac-arm");
    const bad = await call(server, "fleet_pool_history", { pool: "../x y", range: "1h" });
    assert(bad.result.isError);
    const badRange = await call(server, "fleet_pool_history", { pool: "mac-arm", range: "1y" });
    assert(badRange.result.isError);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("mcp: fleet_runner_log: a redacted, bounded tail by job id or file; refused without --logs-dir", async () => {
  const { dir, server } = await setup(true);
  try {
    const r = body(await call(server, "fleet_runner_log", { job_id: 5, tail: 50 }));
    assertEquals(r.file, "mac-arm-1-1794551969.log");
    const lines = r.text.split("\n");
    assertEquals(lines.length, 50);
    assert(r.truncated);
    assertFalse(r.text.includes(TOKEN));
    assertFalse(r.text.includes("ZXlKZXlK"));
    assertStringIncludes(r.text, "--jitconfig [redacted]");
    const byFile = body(
      await call(server, "fleet_runner_log", { pool: "mac-arm", file: "mac-arm-1-1794551969.log" }),
    );
    assertEquals(byFile.text.split("\n").length, 200);
    for (
      const args of [
        { pool: "mac-arm", file: "../scheduler.log" },
        { pool: "linux", file: "mac-arm-1-1794551969.log" },
        { job_id: 999 },
        { file: "mac-arm-1-1794551969.log" },
        { job_id: 5, tail: 5000 },
      ]
    ) {
      assert((await call(server, "fleet_runner_log", args)).result.isError, JSON.stringify(args));
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
  const { dir: d2, server: s2 } = await setup(false);
  try {
    const r = await call(s2, "fleet_runner_log", { job_id: 5 });
    assert(r.result.isError);
    assertStringIncludes(r.result.content[0].text, "--logs-dir");
  } finally {
    await Deno.remove(d2, { recursive: true });
  }
});

Deno.test("settings view: the MCP command grants and passes the runner logs folder", () => {
  const cmd = mcpCommand({
    dataDir: "/data",
    spoolDir: null,
    healthFile: null,
    logsDir: "/logs/runners",
    os: "darwin",
  });
  assertStringIncludes(cmd, "--allow-read=/data,/logs/runners");
  assertStringIncludes(cmd, "--logs-dir /logs/runners");
});
