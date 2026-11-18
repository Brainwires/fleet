// Runner settings (lib/runner-config.ts) over a neutral fixture schema: the parser's caps and
// refusals, the rule grammar evaluated as the helper's jq does, the draft check, the diff, the
// confirm text and the helper's exact argv. Pure: no I/O.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  applyArgs,
  checkArgs,
  checkDraft,
  type ConfigSchema,
  confirmText,
  diffConfig,
  MAX_KNOBS,
  parseChange,
  parseHistory,
  parseSchema,
  parseShow,
  revertArgs,
  ruleHolds,
  validChanges,
} from "../lib/runner-config.ts";

const RAW = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/runner-config-schema.json", import.meta.url)),
);
const SCHEMA: ConfigSchema = parseSchema(RAW)!;
const LIVE = {
  SLOTS_GPU_A: "2",
  MIN_DISK_GB_GPU_A: "30",
  POOL_DISABLED_GPU_A: "0",
  RACK_SLOTS: "3",
  RACK_MEM_MB: "3000",
  PAUSE_SECONDS: "180",
};
const GEN = "a".repeat(64);

Deno.test("schema: the fixture parses with its knobs, rules, constants and groups", () => {
  assert(SCHEMA);
  assertEquals(SCHEMA.knobs.map((k) => k.key), Object.keys(LIVE));
  assertEquals(SCHEMA.knobs[2].type, "bool");
  assertEquals([SCHEMA.knobs[2].min, SCHEMA.knobs[2].max], [0, 1]);
  assertEquals(SCHEMA.rules.map((r) => r.id), ["rack-mem", "disk-floor", "busy-warn"]);
  assertEquals(SCHEMA.constants.RACK_MEM_BUDGET_MB, 10000);
  assertEquals(SCHEMA.groups.rack.title, "Rack host");
});

Deno.test("schema: refused when malformed, over the caps, or a key repeats", () => {
  assertEquals(parseSchema({ ok: false }), null);
  assertEquals(parseSchema({ knobs: [] }), null);
  const k = RAW.knobs[0];
  assertEquals(parseSchema({ ...RAW, knobs: [k, k] }), null, "a key twice");
  assertEquals(parseSchema({ ...RAW, knobs: [{ ...k, key: "lower" }] }), null, "a bad key");
  assertEquals(parseSchema({ ...RAW, knobs: [{ ...k, min: 5, max: 1 }] }), null, "min > max");
  assertEquals(parseSchema({ ...RAW, knobs: [{ ...k, pool: "" }] }), null, "a pool knob, no pool");
  const many = Array.from({ length: MAX_KNOBS + 1 }, (_, i) => ({ ...k, key: `K${i}` }));
  assertEquals(parseSchema({ ...RAW, knobs: many }), null, "over the knob cap");
  const badRule = { id: "x", sev: "error", message: "", test: { lt: [{ key: "lower" }, 1] } };
  assertEquals(parseSchema({ ...RAW, rules: [badRule] }), null, "a rule naming a bad key");
  assertEquals(parseSchema({ ...RAW, rules: [{ ...badRule, test: { nope: [1, 2] } }] }), null);
});

Deno.test("schema: free text is capped and stripped of control characters", () => {
  const k = { ...RAW.knobs[0], title: "a\u0007b\nc".padEnd(200, "x"), help: "h" };
  const s = parseSchema({ ...RAW, knobs: [k], rules: [] })!;
  // deno-lint-ignore no-control-regex
  assertFalse(/[\u0000-\u001f]/.test(s.knobs[0].title));
  assert(s.knobs[0].title.length <= 80);
});

Deno.test("rules: the grammar as the helper evaluates it (add, mul, min, max, all, any, const)", () => {
  const v = { A: 3, B: 4 };
  const s = { ...SCHEMA, constants: { C: 10 } };
  const table: [unknown, boolean][] = [
    [{ lt: [{ key: "A" }, { key: "B" }] }, true],
    [{ le: [{ add: [{ key: "A" }, { key: "B" }] }, 7] }, true],
    [{ ge: [{ mul: [{ key: "A" }, { key: "B" }] }, { const: "C" }] }, true],
    [{ eq: [{ min: [{ key: "A" }, { key: "B" }] }, 3] }, true],
    [{ eq: [{ max: [{ key: "A" }, { key: "B" }, 9] }, 9] }, true],
    [{ all: [{ lt: [1, 2] }, { lt: [2, 1] }] }, false],
    [{ any: [{ lt: [2, 1] }, { lt: [1, 2] }] }, true],
  ];
  for (const [test, want] of table) {
    const parsed = parseSchema({ ...RAW, rules: [{ id: "t", sev: "error", message: "", test }] })!;
    assertEquals(ruleHolds(parsed.rules[0].test, v, s), want, JSON.stringify(test));
  }
});

Deno.test("draft: per-field type and range, then the rules (errors and warnings)", () => {
  const ok = checkDraft(SCHEMA, LIVE);
  assert(ok.ok);
  assertEquals(ok.warnings, ["two slots and three containers is a lot"]);
  const bad = checkDraft(SCHEMA, {
    ...LIVE,
    SLOTS_GPU_A: "3",
    POOL_DISABLED_GPU_A: "2",
    PAUSE_SECONDS: "x",
  });
  assertFalse(bad.ok);
  assertEquals(bad.fields, {
    SLOTS_GPU_A: "1 to 2",
    POOL_DISABLED_GPU_A: "on or off",
    PAUSE_SECONDS: "a whole number",
  });
  assertEquals(bad.errors, [], "no rule is evaluated over invalid fields");
  const rule = checkDraft(SCHEMA, { ...LIVE, RACK_MEM_MB: "4000" });
  assertFalse(rule.ok);
  assertEquals(rule.errors, ["RACK_SLOTS x RACK_MEM_MB <= RACK_MEM_BUDGET_MB"]);
  const floor = checkDraft(SCHEMA, { ...LIVE, MIN_DISK_GB_GPU_A: "12" });
  assertEquals(floor.errors, ["MIN_DISK_GB_GPU_A > 12 and at least 2 per slot"]);
});

Deno.test("diff: only what changed, in the schema's order; the confirm text names place and values", () => {
  const draft = { ...LIVE, PAUSE_SECONDS: "240", SLOTS_GPU_A: "1", POOL_DISABLED_GPU_A: "1" };
  const d = diffConfig(SCHEMA, LIVE, draft);
  assertEquals(d, [
    { key: "SLOTS_GPU_A", from: "2", to: "1" },
    { key: "POOL_DISABLED_GPU_A", from: "0", to: "1" },
    { key: "PAUSE_SECONDS", from: "180", to: "240" },
  ]);
  const t = confirmText(SCHEMA, d);
  assertStringIncludes(t.message, "Apply 3 runner setting changes?");
  assertStringIncludes(t.message, "gpu-a: Slots 2 slots → 1 slots");
  assertStringIncludes(t.message, "gpu-a: Disabled off → on");
  assertStringIncludes(t.message, "Scheduler: Pause length 180 s → 240 s");
  assertStringIncludes(t.detail, "nothing restarts");
  assertEquals(diffConfig(SCHEMA, LIVE, LIVE), []);
});

Deno.test("argv: check, apply (token on stdin, never argv) and revert, exactly", () => {
  const d = [{ key: "PAUSE_SECONDS", from: "180", to: "240" }, {
    key: "RACK_SLOTS",
    from: "3",
    to: "2",
  }];
  assertEquals(checkArgs(d), ["--check", "--set", "PAUSE_SECONDS=240", "--set", "RACK_SLOTS=2"]);
  assertEquals(applyArgs(GEN, d, "fleet-jo"), [
    "--apply",
    "--token-stdin",
    "--generation",
    GEN,
    "--set",
    "PAUSE_SECONDS=240",
    "--set",
    "RACK_SLOTS=2",
    "--actor",
    "fleet-jo",
  ]);
  assertEquals(revertArgs("cfg-20261116-010203-abcd", GEN, ""), [
    "--revert",
    "cfg-20261116-010203-abcd",
    "--token-stdin",
    "--generation",
    GEN,
  ]);
});

Deno.test("changes from the page: known keys, integer values, no repeats, at most 40", () => {
  assert(validChanges(SCHEMA, [{ key: "PAUSE_SECONDS", to: "240" }]).ok);
  const refusals: [unknown, string][] = [
    [[], "nothing to change"],
    [[{ key: "NOPE", to: "1" }], "is not a setting"],
    [[{ key: "PAUSE_SECONDS", to: "1;id" }], "not a whole number"],
    [[{ key: "PAUSE_SECONDS", to: "$(id)" }], "not a whole number"],
    [[{ key: "PAUSE_SECONDS", to: "1" }, { key: "PAUSE_SECONDS", to: "2" }], "set twice"],
    [Array.from({ length: 41 }, () => ({ key: "PAUSE_SECONDS", to: "1" })), "at most 40"],
  ];
  for (const [raw, msg] of refusals) {
    const r = validChanges(SCHEMA, raw);
    assertFalse(r.ok, JSON.stringify(raw).slice(0, 60));
    if (!r.ok) assertStringIncludes(r.message, msg);
  }
});

Deno.test("show / status / history: parsed, ids and generations checked", () => {
  const show = parseShow({
    ok: true,
    generation: GEN,
    values: { ...LIVE, BAD: "1;id" },
    warnings: [{ message: "w" }],
  })!;
  assertEquals(show.values, LIVE, "a value outside the pattern is dropped");
  assertEquals(show.warnings, ["w"]);
  assertEquals(parseShow({ generation: "nope" }), null);
  const invalid = parseShow({
    ok: false,
    generation: GEN,
    values: null,
    errors: [{ message: "line 3 …" }],
  })!;
  assertEquals(invalid.values, null);
  const c = parseChange({
    id: "cfg-20261116-010203-abcd",
    state: "applied",
    changes: [{ key: "PAUSE_SECONDS", from: "180", to: "240" }],
    generation_after: GEN,
    revert_of: null,
  });
  assertEquals(c?.state, "applied");
  assertEquals(parseChange({ id: "../etc" }), null);
  assertEquals(parseHistory([{ id: "cfg-20261116-010203-abcd" }, { id: "x" }]).length, 1);
});
