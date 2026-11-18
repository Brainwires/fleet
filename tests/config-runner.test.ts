// The runner settings' flow on Fleet's side (lib/config-runner.ts) with a fake helper, dialog and
// event log: what runs in which order, the token only ever on stdin, cancel and a test build never
// applying, a stale generation refused before the dialog, the helper's refusals shown. And the
// machine side (lib/deno-config.ts): the token file's mode, content and replacement; a helper run's
// JSON. No network; the token file lives in a temporary folder.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import {
  configCheck,
  type ConfigDeps,
  runConfigApply,
  runConfigRevert,
} from "../lib/config-runner.ts";
import {
  CONFIG_TOKEN_FILE,
  ensureConfigToken,
  runProgramJson,
  tokenFileOk,
} from "../lib/deno-config.ts";
import type { JsonRun } from "../lib/deno-config.ts";

const SCHEMA = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/runner-config-schema.json", import.meta.url)),
);
const GEN = "b".repeat(64);
const VALUES = {
  SLOTS_GPU_A: "2",
  MIN_DISK_GB_GPU_A: "30",
  POOL_DISABLED_GPU_A: "0",
  RACK_SLOTS: "3",
  RACK_MEM_MB: "3000",
  PAUSE_SECONDS: "180",
};
const TOKEN = "t".repeat(43);

interface Fake {
  deps: ConfigDeps;
  calls: { args: string[]; input?: string }[];
  dialogs: { message: string; detail?: string }[];
  logs: string[];
}

function fake(opts: {
  answer?: number | null;
  generation?: string;
  check?: JsonRun;
  apply?: JsonRun;
  dryRun?: boolean;
} = {}): Fake {
  const calls: Fake["calls"] = [];
  const dialogs: Fake["dialogs"] = [];
  const logs: string[] = [];
  const deps: ConfigDeps = {
    run: (args, input) => {
      calls.push({ args: [...args], ...(input !== undefined ? { input } : {}) });
      const v = args[0];
      const ok = (json: unknown): JsonRun => ({ code: 0, json, err: "" });
      if (v === "--schema") return Promise.resolve(ok(SCHEMA));
      if (v === "--show") {
        return Promise.resolve(
          ok({ ok: true, generation: opts.generation ?? GEN, values: VALUES, warnings: [] }),
        );
      }
      if (v === "--check") {
        return Promise.resolve(opts.check ?? ok({ ok: true, warnings: [{ message: "w1" }] }));
      }
      if (v === "--apply" || v === "--revert") {
        return Promise.resolve(
          opts.apply ??
            ok({ ok: true, id: "cfg-20261116-010203-abcd", accepted: true, state: "verifying" }),
        );
      }
      if (v === "--status") {
        return Promise.resolve(
          ok({
            ok: true,
            id: args[1],
            state: "applied",
            changes: [{ key: "PAUSE_SECONDS", from: "180", to: "240" }],
          }),
        );
      }
      return Promise.resolve({ code: 2, json: null, err: "unexpected" });
    },
    token: () => TOKEN,
    confirm: (o) => {
      dialogs.push({ message: o.message, detail: o.detail });
      return Promise.resolve(opts.answer === undefined ? 0 : opts.answer);
    },
    log: (e) => {
      logs.push(e.text);
      return Promise.resolve();
    },
    actor: "fleet-jo",
    dryRun: opts.dryRun,
  };
  return { deps, calls, dialogs, logs };
}

const CHANGE = { generation: GEN, changes: [{ key: "PAUSE_SECONDS", from: "1", to: "240" }] };

Deno.test("apply: schema, show, the helper's check, the dialog, then --apply with the token on stdin", async () => {
  const f = fake();
  const r = await runConfigApply(f.deps, CHANGE);
  assert(r.ok, r.message);
  assertEquals(r.id, "cfg-20261116-010203-abcd");
  assertEquals(f.calls.map((c) => c.args[0]), [
    "--schema",
    "--show",
    "--schema",
    "--check",
    "--apply",
  ]);
  const apply = f.calls.at(-1)!;
  assertEquals(apply.args, [
    "--apply",
    "--token-stdin",
    "--generation",
    GEN,
    "--set",
    "PAUSE_SECONDS=240",
    "--actor",
    "fleet-jo",
  ]);
  assertEquals(apply.input, `${TOKEN}\n`, "the token goes on stdin");
  for (const c of f.calls) assertFalse(c.args.join(" ").includes(TOKEN), "never in argv");
  assertEquals(f.dialogs.length, 1);
  assertStringIncludes(
    f.dialogs[0].message,
    "Pause length 180 s → 240 s",
    "the from is the live value, not the page's",
  );
  assertStringIncludes(f.dialogs[0].detail ?? "", "Warnings: w1");
  assertStringIncludes(f.logs[0], "accepted");
  for (const l of f.logs) assertFalse(l.includes(TOKEN));
});

Deno.test("apply: cancel and a test build (dry run) never call --apply", async () => {
  for (const answer of [1, null]) {
    const f = fake({ answer });
    const r = await runConfigApply(f.deps, CHANGE);
    assertFalse(r.ok);
    assertFalse(f.calls.some((c) => c.args[0] === "--apply"));
  }
  const d = fake({ dryRun: true });
  const r = await runConfigApply(d.deps, CHANGE);
  assertStringIncludes(r.message, "Dry run");
  assertStringIncludes(d.dialogs[0].detail ?? "", "Dry run");
  assertFalse(d.calls.some((c) => c.args[0] === "--apply"));
});

Deno.test("apply: a stale generation, a local rule break or the helper's refusal: no dialog, no apply", async () => {
  const stale = fake({ generation: "c".repeat(64) });
  const r1 = await runConfigApply(stale.deps, CHANGE);
  assertFalse(r1.ok);
  assertStringIncludes(r1.message, "changed since this form was loaded");
  assertEquals(stale.dialogs.length, 0);
  const rule = fake();
  const r2 = await runConfigApply(rule.deps, {
    generation: GEN,
    changes: [{ key: "RACK_MEM_MB", to: "4000" }],
  });
  assertFalse(r2.ok);
  assertStringIncludes(r2.message, "RACK_MEM_BUDGET_MB");
  assertFalse(
    rule.calls.some((c) => c.args[0] === "--check"),
    "refused before the helper is asked",
  );
  const refused = fake({
    check: { code: 2, json: { ok: false, errors: [{ message: "rule x: no" }] }, err: "" },
  });
  const r3 = await runConfigApply(refused.deps, CHANGE);
  assertStringIncludes(r3.message, "rule x: no");
  assertEquals(refused.dialogs.length, 0);
  const junk = fake();
  const r4 = await runConfigApply(junk.deps, {
    generation: GEN,
    changes: [{ key: "PAUSE_SECONDS", to: "1;id" }],
  });
  assertFalse(r4.ok);
  assertFalse(junk.calls.some((c) => c.args.includes("PAUSE_SECONDS=1;id")));
});

Deno.test("apply: the helper's exit codes become the page's words", async () => {
  const cases: [number, string][] = [[3, "changed since they were read"], [8, "busy"], [
    9,
    "didn't accept Fleet",
  ]];
  for (const [code, words] of cases) {
    const f = fake({ apply: { code, json: { ok: false, message: "m" }, err: "" } });
    const r = await runConfigApply(f.deps, CHANGE);
    assertFalse(r.ok);
    assertStringIncludes(r.message, words);
  }
});

Deno.test("check and revert: the helper's own check; revert asks, then --revert with the token on stdin", async () => {
  const f = fake();
  const c = await configCheck(f.deps, { changes: [{ key: "PAUSE_SECONDS", to: "240" }] });
  assert(c.ok);
  assertEquals(c.warnings, ["w1"]);
  const r = await runConfigRevert(f.deps, { id: "cfg-20261116-010203-abcd", generation: GEN });
  assert(r.ok, r.message);
  const rev = f.calls.find((x) => x.args[0] === "--revert")!;
  assertEquals(rev.args, [
    "--revert",
    "cfg-20261116-010203-abcd",
    "--token-stdin",
    "--generation",
    GEN,
    "--actor",
    "fleet-jo",
  ]);
  assertEquals(rev.input, `${TOKEN}\n`);
  assertStringIncludes(f.dialogs[0].message, "PAUSE_SECONDS 180→240");
  const bad = await runConfigRevert(fake().deps, { id: "../../x", generation: GEN });
  assertFalse(bad.ok);
});

Deno.test("token file: made 0600 with 32+ token characters, kept when valid, remade when not", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/${CONFIG_TOKEN_FILE}`;
    const t1 = ensureConfigToken(dir)!;
    assert(/^[A-Za-z0-9_-]{43}$/.test(t1));
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    assert(tokenFileOk(path));
    assertEquals(ensureConfigToken(dir), t1, "a valid file is kept");
    await Deno.chmod(path, 0o644);
    const t2 = ensureConfigToken(dir)!;
    assert(t2 !== t1, "a world-readable file is replaced");
    assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    await Deno.writeTextFile(path, "short\n", { mode: 0o600 });
    assert(ensureConfigToken(dir) !== "short", "a malformed token is replaced");
    await Deno.remove(path);
    await Deno.writeTextFile(`${dir}/elsewhere`, `${"x".repeat(40)}\n`, { mode: 0o600 });
    await Deno.symlink(`${dir}/elsewhere`, path);
    assertFalse(tokenFileOk(path), "a symlink is not a token file");
    const t3 = ensureConfigToken(dir)!;
    assertFalse((await Deno.lstat(path)).isSymlink, "the symlink is replaced by a file");
    assert(t3 !== "x".repeat(40));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("helper run: stdout as JSON apart from stderr; stdin only when given", async () => {
  const r = await runProgramJson("/bin/cat", [], '{"ok":true}');
  assertEquals(r.code, 0);
  assertEquals(r.json, { ok: true });
  const n = await runProgramJson("/bin/sh", ["-c", "echo nope; echo err >&2; exit 3"]);
  assertEquals(n.code, 3);
  assertEquals(n.json, null);
  assertEquals(n.err, "err");
});
