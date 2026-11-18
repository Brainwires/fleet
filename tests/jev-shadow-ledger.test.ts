// The jev shadow's ledger lines (jev-shadow.jsonl beside the runner scheduler's health file): a live
// disagreement becomes one `action` event "jev-shadow: …"; agreements, failed calls, replay lines and
// garbled lines are not read.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  ciEvent,
  ciLedgerTail,
  JEV_SHADOW_FILE,
  ownershipOf,
  parseCiLine,
} from "../lib/ci-ledger.ts";

const base = {
  v: 1,
  kind: "shadow",
  mode: "live",
  at: 1_794_869_000_000,
  type: "route",
  subject: "mac-arm job 133644046408 'native-e2e / cef / macos-15'",
  repo: "Brainwires/laufey",
  run_id: 43965503020,
  inputs_digest: "0123456789abcdef",
  rule: "ours",
  rule_reason: "pool healthy: a queued job stays",
  pick_rule: "github",
  jev: "github",
  jev_p: 0.93,
  jev_reason: "p=0.93: overflow to GitHub now",
  agree: false,
  latency_ms: 256,
};

Deno.test("jev shadow: a live disagreement is an action event", () => {
  const r = parseCiLine(JSON.stringify(base));
  assert(r && r.kind === "shadow");
  const ev = ciEvent(r);
  assertEquals(ev.kind, "action");
  assertEquals(ev.sev, "info");
  assertEquals(ev.repo, "Brainwires/laufey");
  assertEquals(ev.run_id, 43965503020);
  assertStringIncludes(ev.text, "jev-shadow: route mac-arm job 133644046408");
  assertStringIncludes(ev.text, "rules ours, jev github (p=0.93)");
  assertEquals(ownershipOf([r]).size, 0); // a shadow line never claims a run
});

Deno.test("jev shadow: agreements, failed calls, replay lines and bad fields are skipped", () => {
  assertEquals(parseCiLine(JSON.stringify({ ...base, agree: true })), null);
  assertEquals(
    parseCiLine(
      JSON.stringify({ ...base, agree: null, jev: null, error: "timeout after 2500 ms" }),
    ),
    null,
  );
  assertEquals(parseCiLine(JSON.stringify({ ...base, mode: "replay" })), null);
  assertEquals(parseCiLine(JSON.stringify({ ...base, jev: "rm -rf" })), null);
  assertEquals(parseCiLine(JSON.stringify({ ...base, subject: "" })), null);
  assertEquals(parseCiLine("{garbled"), null);
});

Deno.test("jev shadow: control characters are stripped and the text is capped", () => {
  const r = parseCiLine(
    JSON.stringify({ ...base, subject: "x\n‮y".padEnd(400, "z"), rule_reason: "a\nb" }),
  );
  assert(r);
  const t = ciEvent(r).text;
  assertFalse(t.includes("\n"));
  assertFalse(t.includes("‮"));
  assert(t.length <= 300);
});

Deno.test("jev shadow: the ledger tail reads jev-shadow.jsonl beside the audit log", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const lines = [JSON.stringify(base), JSON.stringify({ ...base, agree: true, at: base.at + 1 })];
    await Deno.writeTextFile(`${dir}/${JEV_SHADOW_FILE}`, lines.join("\n") + "\n");
    const read = ciLedgerTail(dir);
    const first = await read();
    assertEquals(first.length, 1);
    assertEquals(first[0].kind, "shadow");
    await Deno.writeTextFile(
      `${dir}/${JEV_SHADOW_FILE}`,
      JSON.stringify({ ...base, at: base.at + 5, type: "stuck", rule: "slow", jev: "stuck" }) +
        "\n",
      { append: true },
    );
    const next = await read();
    assertEquals(next.length, 1);
    assertStringIncludes(ciEvent(next[0]).text, "jev-shadow: stuck");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
