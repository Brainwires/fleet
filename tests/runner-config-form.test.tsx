// The runner settings form (app/runner-config-form.tsx) with a fake backend: typed widgets from the
// schema (a number field with its range, a checkbox for a switch), the diff preview, Apply held back
// until the helper's check passed for exactly this change, the change sent as typed, its status
// followed to "applied", and a pool's tab limited to that pool's own settings. No desktop runtime.

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { type ConfigApi, RunnerConfigForm } from "../app/runner-config-form.tsx";
import { type ChangeRecord, parseSchema, type ValueChange } from "../lib/runner-config.ts";

const SCHEMA = parseSchema(JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/runner-config-schema.json", import.meta.url)),
))!;
const GEN = "d".repeat(64);
const VALUES = {
  SLOTS_GPU_A: "2",
  MIN_DISK_GB_GPU_A: "30",
  POOL_DISABLED_GPU_A: "0",
  RACK_SLOTS: "3",
  RACK_MEM_MB: "3000",
  PAUSE_SECONDS: "180",
};

function walk(root: TestElement): TestElement[] {
  const out: TestElement[] = [];
  const go = (el: TestElement) => {
    for (const c of el.children) {
      out.push(c);
      go(c);
    }
  };
  go(root);
  return out;
}
const byId = (root: TestElement, id: string) => walk(root).find((e) => e.getAttribute("id") === id);
const button = (root: TestElement, text: string) =>
  walk(root).find((e) => e.localName === "button" && (e.textContent ?? "").trim() === text);
const settle = (screen: { act(fn: () => Promise<void>): Promise<void> }) =>
  screen.act(() => new Promise<void>((r) => setTimeout(r, 0)));

function fakeApi() {
  const applied: { generation: string; changes: ValueChange[] }[] = [];
  const checked: ValueChange[][] = [];
  let loads = 0;
  const api: ConfigApi = {
    configLoad: () => {
      loads++;
      return Promise.resolve({
        ok: true,
        schema: SCHEMA,
        show: {
          ok: true,
          generation: GEN,
          values: VALUES,
          errors: [],
          warnings: [],
          lastChange: null,
        },
        history: [],
      });
    },
    configCheck: ({ changes }) => {
      checked.push(changes);
      return Promise.resolve({ ok: true, errors: [], warnings: [] });
    },
    configApply: (a) => {
      applied.push(a);
      return Promise.resolve({ ok: true, id: "cfg-20261116-010203-abcd", message: "Accepted" });
    },
    configRevert: () => Promise.resolve({ ok: false, message: "no" }),
    configStatus: ({ id }) =>
      Promise.resolve(
        {
          id,
          time: "",
          actor: "fleet-jo",
          via: "fleet",
          changes: [],
          state: "applied",
          result: "",
          revertOf: null,
          generationAfter: GEN,
        } satisfies ChangeRecord,
      ),
  };
  return { api, applied, checked, loads: () => loads };
}

Deno.test("form: typed widgets from the schema; diff; Apply only after a passing check; status to applied", async () => {
  const f = fakeApi();
  const screen = await render(<RunnerConfigForm api={f.api} />);
  await settle(screen);
  const root = screen.container;
  const pause = byId(root, "rc-PAUSE_SECONDS")!;
  assertEquals(pause.getAttribute("type"), "number");
  assertEquals(pause.getAttribute("min"), "60");
  assertEquals(pause.getAttribute("max"), "600");
  assertEquals(byId(root, "rc-POOL_DISABLED_GPU_A")!.getAttribute("type"), "checkbox");
  assertStringIncludes(root.textContent ?? "", "No changes.");
  await screen.fireEvent.input(pause, { target: { value: "240" } });
  await settle(screen);
  assertStringIncludes(root.textContent ?? "", "Pause length 180 s → 240 s");
  const apply = button(root, "Apply settings")!;
  assert(apply.hasAttribute("disabled"), "Apply waits for a check");
  await screen.fireEvent.click(button(root, "Check")!);
  await settle(screen);
  assertEquals(f.checked, [[{ key: "PAUSE_SECONDS", from: "180", to: "240" }]]);
  assert(
    !button(root, "Apply settings")!.hasAttribute("disabled"),
    "a passing check enables Apply",
  );
  await screen.fireEvent.click(button(root, "Apply settings")!);
  await settle(screen);
  await settle(screen);
  assertEquals(f.applied, [{
    generation: GEN,
    changes: [{ key: "PAUSE_SECONDS", from: "180", to: "240" }],
  }]);
  assertStringIncludes(root.textContent ?? "", "applied — the scheduler picked it up");
  assert(f.loads() >= 2, "the values are reloaded after the change applied");
  screen.unmount?.();
});

Deno.test("form: an invalid value is flagged and keeps Check off; a pool's tab shows only its own settings", async () => {
  const f = fakeApi();
  const screen = await render(<RunnerConfigForm api={f.api} />);
  await settle(screen);
  await screen.fireEvent.input(byId(screen.container, "rc-RACK_SLOTS")!, {
    target: { value: "9" },
  });
  await settle(screen);
  assertStringIncludes(screen.container.textContent ?? "", "1 to 3");
  assert(button(screen.container, "Check")!.hasAttribute("disabled"));
  screen.unmount?.();
  const pool = await render(<RunnerConfigForm api={fakeApi().api} pool="gpu-a" />);
  await settle(pool);
  assert(byId(pool.container, "rc-SLOTS_GPU_A"));
  assertEquals(
    byId(pool.container, "rc-RACK_SLOTS"),
    undefined,
    "a shared setting is not on the pool's tab",
  );
  pool.unmount?.();
});
