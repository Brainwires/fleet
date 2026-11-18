// ci_logs' failed test names: pulled from a job log's own lines (mcp/ci-read.ts failedTests). Pure.

import { assertEquals } from "@std/assert";
import { FAILED_TESTS_MAX, failedTests } from "../mcp/ci-read.ts";

Deno.test("failedTests: libtest / Deno, the failures list, TAP and FAIL lines, once each, in order", () => {
  const log = [
    "running 3 tests",
    "test ops::fs::write ... ok",
    "test ops::fs::read ... FAILED",
    "test specs::run::worker_close ... FAILED (12ms)",
    "node_compat::parallel/test-fs-cp.js ... failed",
    "",
    "failures:",
    "",
    "---- ops::fs::read stdout ----",
    "thread 'ops::fs::read' panicked at src/x.rs:1:1",
    "",
    "failures:",
    "    ops::fs::read",
    "    specs::run::worker_close",
    "    integration::lsp::only_in_list",
    "",
    "test result: FAILED. 1 passed; 3 failed",
    " FAILURES ",
    "worker closes => ./tests/unit/worker_test.ts:12:6",
    "not ok 7 - stream ends # time=3ms",
    "ok 8 - fine",
    "[FAIL] parallel/test-http-agent.js",
    "  ✗ renders the list",
    "FAIL  src/a.test.ts",
    "error: test failed",
  ];
  assertEquals(failedTests(log), {
    tests: [
      "ops::fs::read",
      "specs::run::worker_close",
      "node_compat::parallel/test-fs-cp.js",
      "integration::lsp::only_in_list",
      "worker closes",
      "stream ends",
      "parallel/test-http-agent.js",
      "renders the list",
      "src/a.test.ts",
    ],
    more: false,
  });
});

Deno.test("failedTests: a passing log names none; a long list is capped and says so", () => {
  assertEquals(
    failedTests([
      "test a ... ok",
      "test result: ok. 1 passed; 0 failed",
      "FAILED to fetch the cache, retrying",
      "FAIL fast is off",
      "failures: 0",
    ]),
    { tests: [], more: false },
  );
  const many = Array.from({ length: FAILED_TESTS_MAX + 5 }, (_, i) => `test t${i} ... FAILED`);
  const r = failedTests(many);
  assertEquals([r.tests.length, r.more, r.tests[0]], [FAILED_TESTS_MAX, true, "t0"]);
});
