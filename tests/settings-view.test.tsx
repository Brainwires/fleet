// The first-run wizard and the Settings view, rendered with denext/testing's `render` and fake
// backends: the steps in order (sign in → owners → branches → start → integrations), keyboardable
// controls with labels, Next held back until a step is answered, Finish saving with
// `setupComplete`, validation errors shown, sections the form doesn't edit kept as they were, and
// the header naming the configured owners. No desktop runtime, no network.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { ORG_SETTINGS } from "./fixture-settings.ts";
import {
  mcpCommand,
  type SettingsApi,
  SettingsView,
  SetupWizard,
  splitList,
  WIZARD_STEPS,
} from "../app/settings-view.tsx";
import { ownerLine } from "../app/fleet-view.tsx";
import { DEFAULT_SETTINGS, type FleetSettings, validateSettings } from "../lib/settings.ts";
import type { TokenInfo } from "../lib/discover.ts";

/** Every element under `root` (depth first). */
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
const byTag = (root: TestElement, tag: string) => walk(root).filter((e) => e.localName === tag);
const button = (root: TestElement, text: string) =>
  byTag(root, "button").find((b) => (b.textContent ?? "").trim() === text);

const INFO: TokenInfo = {
  kind: "oauth",
  login: "jo",
  scopes: ["repo", "read:org"],
  write: "yes",
  orgs: ["acme"],
  message: "",
};

const MACHINE = { dataDir: "/data dir", spoolDir: null, healthFile: null, os: "darwin" };

function fakeApi(result?: (s: FleetSettings) => ReturnType<SettingsApi["save"]>) {
  const saved: FleetSettings[] = [];
  const api: SettingsApi = {
    save: (s) => {
      saved.push(s);
      if (result) return result(s);
      const r = validateSettings(s);
      return Promise.resolve(r);
    },
    tokenInfo: () => Promise.resolve(INFO),
    ownerRepos: () =>
      Promise.resolve([
        { fullName: "acme/web", defaultBranch: "main", private: false, archived: false },
        { fullName: "acme/api", defaultBranch: "trunk", private: true, archived: false },
      ]),
    onOpen: () => {},
  };
  return { api, saved };
}

const SIGN_IN = {
  submit: () => Promise.resolve({ ok: true as const }),
  retryGh: () => Promise.resolve(true),
  usePublic: () => Promise.resolve(),
};

const settle = (screen: { act(fn: () => Promise<void>): Promise<void> }) =>
  screen.act(() => new Promise<void>((r) => setTimeout(r, 0)));

/** Tick a checkbox or radio (the test DOM's change sets values only), then let it settle. */
async function tick(
  screen: Awaited<ReturnType<typeof render>>,
  el: TestElement | undefined,
  on = true,
): Promise<void> {
  assert(el, "no such control");
  (el as unknown as { checked: boolean }).checked = on;
  await screen.fireEvent.change(el);
  await settle(screen);
}

Deno.test("wizard: the steps in order; Next waits for an answer; Finish saves with setupComplete", async () => {
  const { api, saved } = fakeApi();
  const screen = await render(
    <SetupWizard
      settings={DEFAULT_SETTINGS}
      machine={MACHINE}
      auth="gh"
      api={api}
      signIn={SIGN_IN}
    />,
  );
  await settle(screen);
  const root = screen.container;
  // The step list: one current step, announced as such.
  const steps = byTag(root, "li").filter((l) =>
    (l.getAttribute("class") ?? "").match(/on|done/) || l.getAttribute("aria-current")
  );
  assertEquals(steps.filter((l) => l.getAttribute("aria-current") === "step").length, 1);
  assertStringIncludes(screen.html(), "Signed in with the GitHub CLI.");
  // The token's facts: account, scopes and what the controls need.
  assertStringIncludes(screen.html(), "jo");
  assertStringIncludes(screen.html(), "repo, read:org");
  assertStringIncludes(screen.html(), "can write Actions");
  const next = () =>
    byTag(screen.container, "button").find((b) => b.getAttribute("type") === "submit")!;
  const form = () => byTag(screen.container, "form").at(-1)!;
  assertFalse(next().hasAttribute("disabled"));
  await screen.fireEvent.submit(form());
  await settle(screen);

  // Owners: the token's account and orgs are offered; Next waits until one is chosen.
  assertStringIncludes(screen.html(), "Owners and repositories");
  assert(byId(screen.container, "set-owner-acme"), "the org is offered");
  assert(byId(screen.container, "set-owner-jo"), "the account is offered");
  assert(next().hasAttribute("disabled"));
  await tick(screen, byId(screen.container, "set-owner-acme"), true);
  assertFalse(next().hasAttribute("disabled"));
  // Picking repos lists the owners' repos.
  await tick(screen, byId(screen.container, "set-repos-some"), true);
  assert(byId(screen.container, "set-repo-acme/api"));
  await tick(screen, byId(screen.container, "set-repo-acme/web"), true);
  await screen.fireEvent.submit(form());
  await settle(screen);

  // Branches: the default rule, labelled controls.
  assertStringIncludes(screen.html(), "Protected branches");
  const branch = walk(screen.container).find((e) =>
    e.getAttribute("aria-label") === "Rule 1 branch"
  );
  assertEquals(
    branch?.getAttribute("value") ?? (branch as unknown as { value?: string })?.value,
    ":default",
  );
  await screen.fireEvent.change(byId(screen.container, "set-rule-0-cancel")!, {
    target: { value: "refuse" },
  });
  await settle(screen);
  await screen.fireEvent.submit(form());
  await settle(screen);

  // Start and notifications: start at login is off until chosen.
  assertStringIncludes(screen.html(), "Start Fleet at login");
  await tick(screen, byId(screen.container, "set-login"), true);
  await screen.fireEvent.submit(form());
  await settle(screen);

  // Integrations: the webhooks guide and this machine's MCP command.
  assertStringIncludes(screen.html(), "docs/webhooks.md");
  assertStringIncludes(screen.html(), "claude mcp add --scope user fleet");
  assertEquals((next().textContent ?? "").trim(), "Finish");
  await screen.fireEvent.submit(form());
  await settle(screen);
  assertEquals(saved.length, 1);
  const s = saved[0];
  assert(s.setupComplete);
  assertEquals(s.owners, [{ login: "acme", kind: "org" }]);
  assertEquals(s.repos.allow, ["acme/web"]);
  assertEquals(s.branches.rules[0].cancel, "refuse");
  assert(s.startAtLogin);
  await screen.unmount();
});

Deno.test("wizard: without a token the sign-in step holds; Back works; errors are shown", async () => {
  const { api } = fakeApi(() =>
    Promise.resolve({ ok: false, errors: ["owners[0].login: a GitHub login"] })
  );
  const screen = await render(
    <SetupWizard
      settings={{ ...DEFAULT_SETTINGS, owners: [{ login: "acme", kind: "org" }] }}
      machine={MACHINE}
      auth="needs-token"
      api={api}
      signIn={SIGN_IN}
    />,
  );
  await settle(screen);
  const submit = () =>
    byTag(screen.container, "button").find((b) =>
      b.getAttribute("type") === "submit" && (b.textContent ?? "").trim() !== "Save token"
    )!;
  assert(submit().hasAttribute("disabled"), "no Next before signing in");
  assert(walk(screen.container).find((e) => e.getAttribute("name") === "token"), "the token form");
  assert(button(screen.container, "Back")!.hasAttribute("disabled"));
  await screen.rerender(
    <SetupWizard
      settings={{ ...DEFAULT_SETTINGS, owners: [{ login: "acme", kind: "org" }] }}
      machine={MACHINE}
      auth="public"
      api={api}
      signIn={SIGN_IN}
    />,
  );
  await settle(screen);
  const form = () => byTag(screen.container, "form").at(-1)!;
  for (let i = 0; i < WIZARD_STEPS.length - 1; i++) {
    await screen.fireEvent.submit(form());
    await settle(screen);
  }
  await screen.fireEvent.click(button(screen.container, "Back")!);
  await settle(screen);
  assertStringIncludes(screen.html(), "Start and notifications");
  await screen.fireEvent.submit(form());
  await settle(screen);
  await screen.fireEvent.submit(form());
  await settle(screen);
  assertStringIncludes(screen.html(), "can't be saved yet");
  assertStringIncludes(screen.html(), "owners[0].login");
  await screen.unmount();
});

Deno.test("settings view: every section; Save only after a change; untouched sections kept", async () => {
  const { api, saved } = fakeApi();
  let closed = 0;
  let rerun = 0;
  const screen = await render(
    <SettingsView
      settings={ORG_SETTINGS}
      machine={{ ...MACHINE, spoolDir: "/h/spool", healthFile: "/h/health.json" }}
      auth="gh"
      api={api}
      signIn={SIGN_IN}
      onClose={() => closed++}
      onRerun={() => rerun++}
    />,
  );
  await settle(screen);
  for (
    const t of [
      "Sign in to GitHub",
      "Owners and repositories",
      "Protected branches",
      "Start and notifications",
      "Integrations (optional)",
    ]
  ) {
    assertStringIncludes(screen.html(), t);
  }
  assertStringIncludes(screen.html(), "8 declared pools");
  assertStringIncludes(screen.html(), "--hooks-dir /h/spool --health-file /h/health.json");
  const save = button(screen.container, "Save")!;
  assert(save.hasAttribute("disabled"));
  await tick(screen, byId(screen.container, "set-n-queued"), false);
  assertFalse(button(screen.container, "Save")!.hasAttribute("disabled"));
  await screen.fireEvent.click(button(screen.container, "Save")!);
  await settle(screen);
  assertEquals(saved.length, 1);
  assertFalse(saved[0].notifications.queuedLong);
  assertEquals(saved[0].integrations, ORG_SETTINGS.integrations, "the integration is kept");
  assertEquals(saved[0].runnerHosts, ORG_SETTINGS.runnerHosts);
  await screen.fireEvent.click(button(screen.container, "Run setup again")!);
  await screen.fireEvent.click(button(screen.container, "Close")!);
  assertEquals([rerun, closed], [1, 1]);
  await screen.unmount();
});

Deno.test("copy: the header names the configured owners; lists and the MCP command", () => {
  assertEquals(ownerLine(["acme"]), "acme · Actions");
  assertEquals(ownerLine(["a", "b", "c", "d", "e"]), "a, b, c +2 · Actions");
  assertEquals(ownerLine([]), "GitHub Actions");
  assertEquals(splitList("acme/web, acme/api\nacme/web  x/y"), ["acme/web", "acme/api", "x/y"]);
  assertEquals(
    mcpCommand({ dataDir: "/d", spoolDir: null, healthFile: null, os: "linux" }, "/src/fleet"),
    "claude mcp add --scope user fleet -- deno run --no-config --no-prompt --allow-read=/d --allow-write=/d/update-requests /src/fleet/mcp/fleet-mcp.ts --data-dir /d",
  );
  assertStringIncludes(mcpCommand(MACHINE), '"--allow-read=/data dir"');
  // The one write grant: the agents' update-request spool.
  assertStringIncludes(mcpCommand(MACHINE), '"--allow-write=/data dir/update-requests"');
});
