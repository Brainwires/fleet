// Routing rules on Fleet's side: the helper's answers parsed, a draft bounded, the save flow (the
// helper's check, its dry-run plan, the OS dialog naming what changes and where the next jobs go,
// then the token and the draft on the helper's stdin), a refusal, a revert, the dry-run build; and
// the form rendered from a schema with denext/testing: typed widgets, an edit, the live preview,
// Save. The helper is a fake; no pool or label of any real fleet is in here.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import {
  draftOf,
  MAX_DRAFT_BYTES,
  parseRoutingHistory,
  parseRoutingPreview,
  parseRoutingSchema,
  parseRoutingShow,
  previewLines,
  routingExitText,
  type RoutingRules,
} from "../lib/routing.ts";
import {
  routingCheck,
  type RoutingDeps,
  routingLoad,
  runRoutingApply,
  runRoutingRevert,
} from "../lib/routing-runner.ts";
import type { JsonRun } from "../lib/deno-config.ts";
import { blank, resolve, type RoutingApi, RoutingForm, textProblem } from "../app/routing-form.tsx";
import { MachinesView } from "../app/machines-view.tsx";
import { MachinesState } from "../lib/machines.ts";

const GEN = "a".repeat(64), GEN2 = "b".repeat(64);
const POOLS = [
  { name: "win-pc", label: "acme-windows", labels: ["acme-windows"], slots: 1 },
  {
    name: "win-vm",
    label: "acme-windows",
    labels: ["acme-windows", "acme-windows-fast"],
    slots: 1,
  },
  { name: "mac", label: "acme-macos", labels: ["acme-macos"], slots: 2 },
];
const SCHEMA = {
  type: "object",
  required: ["version", "classes"],
  properties: {
    version: { const: 1 },
    note: { type: "string", maxLength: 500, title: "Note" },
    classes: {
      type: "array",
      maxItems: 40,
      title: "Job classes",
      items: { $ref: "#/$defs/class" },
    },
    pools: {
      type: "object",
      title: "Pool conditions",
      propertyNames: { $ref: "#/$defs/pool" },
      additionalProperties: { $ref: "#/$defs/poolRule" },
    },
    machines: {
      type: "object",
      title: "Machines",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9-]{0,39}$" },
      additionalProperties: { $ref: "#/$defs/machine" },
    },
  },
  $defs: {
    pool: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", "x-widget": "pool" },
    regex: { type: "string", minLength: 1, maxLength: 200, "x-widget": "regex" },
    class: {
      type: "object",
      required: ["id", "match", "order"],
      properties: {
        id: {
          type: "string",
          pattern: "^[a-z0-9][a-z0-9-]{0,39}$",
          title: "Id",
          description: "Lower-case letters, digits and dashes.",
        },
        title: { type: "string", maxLength: 80, title: "Name" },
        match: {
          type: "object",
          title: "Matches jobs with",
          properties: {
            labels: {
              type: "array",
              title: "A runs-on label",
              "x-widget": "labels",
              items: { type: "string" },
            },
            job: { $ref: "#/$defs/regex", title: "Job name" },
          },
        },
        order: {
          type: "array",
          title: "Goes to, in order",
          "x-widget": "order",
          items: { type: "string" },
        },
      },
    },
    poolRule: {
      type: "object",
      properties: {
        onlyWhenIdle: {
          type: "array",
          title: "Only while these pools are idle",
          "x-widget": "pools",
          items: { $ref: "#/$defs/pool" },
        },
        never: {
          type: "array",
          maxItems: 20,
          title: "Never takes jobs named like",
          "x-widget": "regexes",
          items: { $ref: "#/$defs/regex" },
        },
      },
    },
    machine: {
      type: "object",
      required: ["pools"],
      properties: {
        pools: {
          type: "array",
          title: "Pools",
          "x-widget": "pools",
          items: { $ref: "#/$defs/pool" },
        },
        maxJobs: { type: "integer", minimum: 1, maximum: 16, title: "Jobs at once, at most" },
      },
    },
  },
};
const RULES: RoutingRules = {
  version: 1,
  classes: [{
    id: "windows",
    title: "Windows",
    match: { labels: ["acme-windows"] },
    order: ["win-pc", "win-vm", "github"],
  }],
  pools: { "win-vm": { onlyWhenIdle: ["mac"] }, "win-pc": { never: ["^slow test"] } },
};
const preview = (next: string, ok = true) => ({
  ok,
  errors: ok ? [] : ["class windows order: there is no pool nope"],
  warnings: [],
  classes: ok
    ? [{
      class: "windows",
      title: "Windows",
      next,
      github: true,
      candidates: [{ target: "win-pc", ok: next === "win-pc", why: "1 free slot(s)" }, {
        target: "win-vm",
        ok: next === "win-vm",
        why: "1 free slot(s)",
      }],
      note: null,
    }]
    : [],
});
const show = (rules: RoutingRules = RULES, generation = GEN) => ({
  ok: true,
  file: "/home/jo/.runners/routing.json",
  is_default: false,
  generation,
  valid: true,
  errors: [],
  warnings: [],
  rules,
});
const HISTORY = [{
  id: "rt-20261119-120000-abc123",
  at: "2026-11-19T12:00:00Z",
  actor: "fleet-jo",
  via: "fleet",
  kind: "apply",
  summary: "windows: win-vm > win-pc → win-pc > win-vm",
}];

Deno.test("routing: the helper's answers are parsed and bounded", () => {
  const s = parseRoutingSchema({
    ok: true,
    schema: SCHEMA,
    pools: [...POOLS, { name: "Bad Name", labels: [] }],
  })!;
  assertEquals(s.pools.map((p) => p.name), ["win-pc", "win-vm", "mac"]);
  assertEquals(parseRoutingSchema({ ok: false }), null);
  assertEquals(parseRoutingShow(show())?.rules?.classes[0].order, ["win-pc", "win-vm", "github"]);
  assertEquals(parseRoutingShow({ ok: true, generation: "short" }), null);
  const p = parseRoutingPreview(preview("win-pc"))!;
  assertEquals(previewLines(p), ["Windows → win-pc"]);
  assertEquals(
    previewLines(
      parseRoutingPreview({
        ok: true,
        classes: [{ class: "a", next: null }, { class: "b", next: "github" }],
      })!,
    ),
    ["a → waits for our pools", "b → GitHub-hosted"],
  );
  assertEquals(parseRoutingPreview("nope"), null);
  assertEquals(parseRoutingHistory([...HISTORY, { id: "../../x" }]).length, 1);
  assertEquals(draftOf({ classes: "x" }), null);
  assertEquals(
    draftOf({ version: 1, classes: [], note: "x".repeat(MAX_DRAFT_BYTES) }),
    null,
    "a draft larger than the helper takes is refused here",
  );
  assertStringIncludes(routingExitText(3), "changed since");
  assertStringIncludes(routingExitText(9), "only from Fleet or a terminal");
});

interface Call {
  args: string[];
  input?: string;
}
function deps(
  o: {
    answers: (c: Call) => JsonRun;
    confirm?: number | null;
    dryRun?: boolean;
    token?: string | null;
  },
) {
  const calls: Call[] = [];
  const asked: { message: string; detail?: string; buttons: string[] }[] = [];
  const logged: string[] = [];
  const d: RoutingDeps = {
    run: (args, input) => {
      const c = { args: [...args], input };
      calls.push(c);
      return Promise.resolve(o.answers(c));
    },
    token: () => (o.token === undefined ? "T".repeat(43) : o.token),
    confirm: (q) => {
      asked.push(q);
      return Promise.resolve(o.confirm === undefined ? 0 : o.confirm);
    },
    log: (e) => {
      logged.push(e.text);
      return Promise.resolve();
    },
    actor: "fleet-jo",
    dryRun: o.dryRun,
  };
  return { d, calls, asked, logged };
}
const ok = (json: unknown): JsonRun => ({ code: 0, json, err: "" });
const helper = (c: Call): JsonRun => {
  if (c.args[0] === "--schema") return ok({ ok: true, schema: SCHEMA, pools: POOLS });
  if (c.args[0] === "--show") return ok(show());
  if (c.args[0] === "--history") return ok(HISTORY);
  if (c.args[0] === "--preview") return ok(preview("win-pc"));
  if (c.args[0] === "--apply" && c.args.includes("--dry-run")) {
    return ok({
      ok: true,
      dry_run: true,
      changed: true,
      summary: "windows: win-pc > win-vm > github → win-vm > win-pc > github",
    });
  }
  if (c.args[0] === "--apply") {
    return ok({
      ok: true,
      accepted: true,
      changed: true,
      id: "rt-20261119-130000-0a0b0c",
      generation: GEN2,
      summary: "x",
    });
  }
  if (c.args[0] === "--revert") {
    return ok({ ok: true, accepted: true, id: "rt-20261119-140000-0d0e0f", generation: GEN });
  }
  return { code: 2, json: null, err: "?" };
};
/** A result's refusal flags (absent on a success). */
const flags = (r: unknown) =>
  r as { ok: boolean; message: string; cancelled?: boolean; refused?: boolean };
const DRAFT: RoutingRules = {
  ...RULES,
  classes: [{ ...RULES.classes[0], order: ["win-vm", "win-pc", "github"] }],
};

Deno.test("routing: a save is checked, planned, confirmed in the OS dialog, then handed to the helper with the token on stdin", async () => {
  const x = deps({ answers: helper });
  const l = await routingLoad(x.d);
  assert(
    l.ok && l.show.generation === GEN && l.history.length === 1 &&
      l.preview?.classes[0].next === "win-pc",
  );
  assertEquals(x.calls.map((c) => c.args.join(" ")), [
    "--schema",
    "--show",
    "--preview --live",
    "--history --limit 20",
  ]);
  x.calls.length = 0;
  const r = await runRoutingApply(x.d, { generation: GEN, draft: DRAFT });
  assertEquals([r.ok, r.id, r.generation], [true, "rt-20261119-130000-0a0b0c", GEN2]);
  assertEquals(x.calls.map((c) => c.args.join(" ")), [
    "--preview",
    `--apply --generation ${GEN} --actor fleet-jo --dry-run`,
    `--apply --generation ${GEN} --actor fleet-jo --token-stdin`,
  ]);
  assertEquals(x.calls[0].input, JSON.stringify(DRAFT));
  assertEquals(
    x.calls[2].input,
    `${"T".repeat(43)}\n${JSON.stringify(DRAFT)}`,
    "the token is stdin's first line, never argv",
  );
  assertFalse(x.calls.some((c) => c.args.some((a) => a.includes("TTTT"))));
  assertStringIncludes(x.asked[0].message, "win-pc > win-vm > github → win-vm > win-pc > github");
  assertStringIncludes(x.asked[0].detail ?? "", "Windows → win-pc");
  assertEquals(x.asked[0].buttons, ["Save rules", "Don't"]);
  assert(x.logged[0].startsWith("routing rules rt-20261119-130000-0a0b0c saved"));
});

Deno.test("routing: nothing is saved without a yes, in a dry-run build, with an invalid draft or a stale generation", async () => {
  const no = deps({ answers: helper, confirm: 1 });
  assertEquals(
    flags(await runRoutingApply(no.d, { generation: GEN, draft: DRAFT })).cancelled,
    true,
  );
  assertFalse(no.calls.some((c) => c.args.includes("--token-stdin")));
  const dry = deps({ answers: helper, dryRun: true });
  const r = await runRoutingApply(dry.d, { generation: GEN, draft: DRAFT });
  assertEquals([r.ok, r.message], [false, "Dry run: nothing was saved."]);
  assertStringIncludes(dry.asked[0].detail ?? "", "Dry run");
  assertFalse(dry.calls.some((c) => c.args.includes("--token-stdin")));
  // An invalid draft stops at the helper's check: no dialog.
  const bad = deps({
    answers: (
      c,
    ) => (c.args[0] === "--preview" ? { code: 2, json: preview("", false), err: "" } : helper(c)),
  });
  const br = flags(await runRoutingApply(bad.d, { generation: GEN, draft: DRAFT }));
  assertEquals([br.ok, br.refused, bad.asked.length], [false, true, 0]);
  assertStringIncludes(br.message, "there is no pool nope");
  // The file changed since the form loaded: the helper's dry run says so (exit 3).
  const stale = deps({
    answers: (c) => (c.args.includes("--dry-run")
      ? {
        code: 3,
        json: { ok: false, message: "the routing rules changed since they were read: reload them" },
        err: "",
      }
      : helper(c)),
  });
  const sr = flags(await runRoutingApply(stale.d, { generation: GEN, draft: DRAFT }));
  assertEquals([sr.ok, sr.refused, stale.asked.length], [false, true, 0]);
  // Arguments from the page are never trusted.
  assertEquals(
    (await runRoutingApply(no.d, { generation: "x; rm -rf /", draft: DRAFT })).message,
    "No rules generation.",
  );
  assertEquals(
    flags(await runRoutingApply(no.d, { generation: GEN, draft: "nope" })).refused,
    true,
  );
  // The helper refusing the save itself is logged as a refusal.
  const refused = deps({
    answers: (
      c,
    ) => (c.args.includes("--token-stdin")
      ? { code: 9, json: { ok: false, message: "refused: the token does not match" }, err: "" }
      : helper(c)),
  });
  const rr = await runRoutingApply(refused.d, { generation: GEN, draft: DRAFT });
  assertFalse(rr.ok);
  assert(refused.logged[0].startsWith("routing rules refused"));
  // A check of a draft that isn't one never runs the helper.
  const chk = deps({ answers: helper });
  assertFalse((await routingCheck(chk.d, { draft: 5 })).ok);
  assertEquals(chk.calls.length, 0);
  // Revert: an id of the helper's form only; confirmed; the token alone on stdin.
  const rv = deps({ answers: helper });
  assertEquals(
    (await runRoutingRevert(rv.d, { id: "x", generation: GEN })).message,
    "No change to revert.",
  );
  const done = await runRoutingRevert(rv.d, { id: HISTORY[0].id, generation: GEN });
  assertEquals([done.ok, rv.calls[0].args.join(" "), rv.calls[0].input], [
    true,
    `--revert ${HISTORY[0].id} --generation ${GEN} --actor fleet-jo --token-stdin`,
    `${"T".repeat(43)}\n`,
  ]);
});

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
const settle = () => new Promise((r) => setTimeout(r, 0));

Deno.test("routing form: schema helpers", () => {
  const root = SCHEMA as never;
  assertEquals(resolve({ $ref: "#/$defs/pool", title: "X" }, root)["x-widget"], "pool");
  assertEquals(resolve({ $ref: "#/$defs/nope" }, root).$ref, "#/$defs/nope");
  assertEquals(blank({ $ref: "#/$defs/class" }, root), { id: "", match: {}, order: [] });
  assertEquals(blank({ $ref: "#/$defs/machine" }, root), { pools: [] });
  assertEquals(textProblem({ "x-widget": "regex" }, "("), "not a regular expression");
  assertEquals(textProblem({ pattern: "^[a-z]+$" }, "ABC"), "not in the expected form");
  assertEquals(textProblem({ minLength: 1 }, ""), "required");
  assertEquals(textProblem({ pattern: "^[a-z]+$", maxLength: 5 }, "abc"), "");
});

Deno.test("routing form: typed widgets from the schema, an edit previewed by the helper, Save", async () => {
  const checks: RoutingRules[] = [];
  const applied: { generation: string; draft: RoutingRules }[] = [];
  let rules = RULES;
  const api: RoutingApi = {
    load: () =>
      Promise.resolve({
        ok: true,
        schema: parseRoutingSchema({ ok: true, schema: SCHEMA, pools: POOLS })!,
        show: parseRoutingShow(show(rules))!,
        preview: parseRoutingPreview(preview("win-pc")),
        history: parseRoutingHistory(HISTORY),
      }),
    check: (draft) => {
      checks.push(draft);
      return Promise.resolve(parseRoutingPreview(preview(draft.classes[0]?.order[0] ?? "github"))!);
    },
    apply: (generation, draft) => {
      applied.push({ generation, draft });
      rules = draft;
      return Promise.resolve({
        ok: true,
        message: "Saved (rt-1); the scheduler uses them from its next tick.",
      });
    },
    revert: () => Promise.resolve({ ok: true, message: "Reverted." }),
  };
  const screen = await render(<RoutingForm api={api} />);
  await settle();
  const root = screen.container;
  // No raw document box: the order is a ranked list with move buttons, pools and labels are
  // checkboxes, patterns are checked text fields.
  assertEquals(all(root, "textarea").length, 0);
  assertEquals(all(root, ".rf-order-item").map((li) => text(li).replace(/[↑↓✕]/g, "").trim()), [
    "1win-pc",
    "2win-vm",
    "3GitHub-hosted (the backup, always last)",
  ]);
  assert(all(root, "input").some((i) => i.getAttribute("type") === "checkbox"));
  assertEquals(all(root, ".rf-mono").map((i) => i.getAttribute("value")).filter(Boolean), [
    "^slow test",
  ]);
  assertStringIncludes(text(all(root, ".rf-next")[0]), "Windows");
  assertEquals(text(all(root, ".rf-target")[0]), "win-pc");
  const save = all(root, "button").find((b) => text(b).trim() === "Save…")!;
  assert(save.hasAttribute("disabled"), "nothing to save before an edit");
  // Move the PC down: the VM is now first; the helper previews the draft.
  const down = all(root, "button").find((b) =>
    b.getAttribute("aria-label") === "Move win-pc down"
  )!;
  await screen.fireEvent.click(down);
  await new Promise((r) => setTimeout(r, 500));
  assertEquals(
    checks.at(-1)?.classes[0].order,
    ["win-vm", "win-pc", "github"],
    "github stays last",
  );
  assertEquals(text(all(root, ".rf-target")[0]), "win-vm");
  assertStringIncludes(text(root), "Preview of your changes");
  const save2 = all(root, "button").find((b) => text(b).trim() === "Save…")!;
  assertFalse(save2.hasAttribute("disabled"));
  await screen.fireEvent.click(save2);
  await settle();
  await settle();
  assertEquals([applied.length, applied[0].generation, applied[0].draft.classes[0].order[0]], [
    1,
    GEN,
    "win-vm",
  ]);
  assertStringIncludes(text(root), "Saved (rt-1)");
  // A helper that can't run says so instead of an empty form.
  const broken = await render(
    <RoutingForm
      api={{
        ...api,
        load: () =>
          Promise.resolve({ ok: false, message: "The routing helper gave no schema (exit 1)." }),
      }}
    />,
  );
  await settle();
  assertStringIncludes(text(broken.container), "gave no schema");
});

Deno.test("machines screen: a card per machine with its pools nested, live stats, the jobs' usage; offline and unconfigured states", async () => {
  const NOW = 1_800_000_000_000;
  const st = new MachinesState();
  const mk = (t: number, cpu: number) => ({
    t,
    cpu: { pct: cpu, cores: [cpu, cpu, cpu, cpu], load: [1.5, 1, 0.5] },
    mem: { totalMb: 16384, usedMb: 12288, availMb: 4096, pressure: 30 },
    swap: { usedMb: 512, totalMb: 2048 },
    disk: [{ name: "root", mount: "/", totalGb: 500, freeGb: 40 }],
    net: { rxBps: 1_500_000, txBps: 20_000 },
    temps: [{ name: "cpu", c: 71 }],
    gpu: { pct: 12 },
    sandboxes: [{ kind: "qemu", name: "Windows", cpuPct: 390, rssMb: 8192 }],
    pools: { "win-vm": { cpuPct: 390, rssMb: 8192 } },
  });
  st.apply({
    event: "machines",
    data: JSON.stringify({
      at: NOW,
      machines: [
        {
          id: "laptop",
          name: "The laptop",
          info: {
            os: "macOS 15",
            arch: "x86_64",
            cpuModel: "i7",
            host: "laptop.local",
            bootAt: NOW - 86_400_000,
          },
          source: "bridge",
          lastAt: NOW,
          online: true,
          latest: mk(NOW, 56),
          pools: [
            {
              name: "mac",
              label: "acme-macos",
              slots: 1,
              busy: 0,
              state: "healthy",
              reason: "",
              use: null,
              jobs: [],
            },
            {
              name: "win-vm",
              label: "acme-windows",
              slots: 1,
              busy: 1,
              state: "healthy",
              reason: "",
              use: { cpuPct: 390, rssMb: 8192 },
              jobs: [{
                pool: "win-vm",
                slot: 1,
                phase: "running",
                since: NOW - 300_000,
                job: { repo: "acme/web", runId: 1, jobId: 2, name: "windows-tests" },
                runner: "r-1",
                cpuPct: 390,
                rssMb: 8192,
                sandbox: "Windows",
              }],
            },
          ],
        },
        {
          id: "pc",
          name: "The PC",
          info: null,
          source: null,
          lastAt: NOW - 600_000,
          online: false,
          latest: mk(NOW - 600_000, 5),
          pools: [{
            name: "win-pc",
            label: "acme-windows",
            slots: 1,
            busy: 0,
            state: "down",
            reason: "host unreachable",
            use: null,
            jobs: [],
          }],
        },
      ],
    }),
  }, NOW);
  st.apply({
    event: "samples",
    data: JSON.stringify({ host: "laptop", samples: [mk(NOW + 5000, 60), mk(NOW + 10_000, 64)] }),
  }, NOW);
  st.connected = true;
  const api = { history: () => Promise.resolve({ error: "not asked" }) };
  const screen = await render(
    <MachinesView
      view={st.view(true)}
      now={NOW + 10_000}
      api={api}
      routing={null}
      onBack={() => {}}
    />,
  );
  const root = screen.container;
  const cards = all(root, ".m-card");
  assertEquals(cards.length, 2);
  const laptop = text(cards[0]);
  for (
    const want of [
      "The laptop",
      "live",
      "64%",
      "12.0 GB",
      "of 16.0 GB",
      "pressure 30%",
      "512 MB",
      "↓ 1.5 MB/s",
      "40 GB free",
      "71°C",
      "GPU 12%",
      "win-vm",
      "windows-tests",
      "3.9 cores",
      "8.0 GB",
      "running 5m",
    ]
  ) {
    assertStringIncludes(laptop, want);
  }
  assertEquals(all(cards[0], ".m-pool").length, 2, "the machine's pools are nested in its card");
  assertEquals(all(cards[0], ".m-core").length, 4);
  assertEquals(
    all(cards[0], ".spark").length,
    4,
    "CPU, memory, swap and network each have a sparkline",
  );
  assertStringIncludes(all(cards[0], ".spark")[0].getAttribute("aria-label") ?? "", "now 64%");
  assertStringIncludes(text(cards[1]), "No live stats: last sample 10m ago.");
  assertStringIncludes(text(cards[1]), "win-pc");
  assertEquals(all(root, ".tab").length, 0, "no Routing tab without a routing helper");
  assertStringIncludes(text(root), "1 of 2 live");
  // The range picker asks the service for each machine's history.
  const asked: string[] = [];
  const api2 = {
    history: (
      host: string,
      range: string,
    ) => (asked.push(`${host}:${range}`),
      Promise.resolve({ error: "The machines service can't be reached (is it running?)." })),
  };
  const s2 = await render(
    <MachinesView view={st.view(true)} now={NOW} api={api2} routing={null} onBack={() => {}} />,
  );
  await s2.fireEvent.click(all(s2.container, "button").find((b) => text(b).trim() === "24 h")!);
  await settle();
  await settle();
  assertEquals(asked.sort(), ["laptop:24h", "pc:24h"]);
  assertStringIncludes(text(s2.container), "can't be reached");
  // Not configured, and not loaded yet.
  const off = await render(
    <MachinesView
      view={new MachinesState().view(false)}
      now={NOW}
      api={api}
      routing={null}
      onBack={() => {}}
    />,
  );
  assertStringIncludes(text(off.container), "No machines service is set up");
  const loading = await render(
    <MachinesView view={null} now={NOW} api={api} routing={null} onBack={() => {}} />,
  );
  assertStringIncludes(text(loading.container), "Loading the machines");
});
