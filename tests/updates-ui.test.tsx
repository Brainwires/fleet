// Machine updates on the page and its backend: the chip and the Updates panel rendered from
// fixtures for every level, a run in flight (its step, Cancel), the self machine (no install
// control, only Open Software Update), the automatic-install setting shown; the Update now and
// Restart now dialogs (machine, pools, labels, mode, restart policy, drain cap; "Don't" first and
// default; a server's outage); the backend's flows over fakes (nothing runs without the confirm
// button, a server needs the outage box, a restart only when one is pending, agents' requests
// approved only through the dialog, windows validated); the audit's held pools; the restart-window
// form's typed widgets; and the settings section. No host, no program, no window.

import { assert, assertEquals, assertFalse, assertStringIncludes } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { DEFAULT_SETTINGS, validateSettings } from "../lib/settings.ts";
import {
  type AuditEntry,
  emptyStatus,
  type RunRecord,
  type UpdateSchedule,
  withCheck,
} from "../lib/updates/model.ts";
import {
  heldPoolsFromAudit,
  parseAudit,
  parseStatusFile,
  statusFile,
} from "../lib/updates/files.ts";
import {
  buildUpdatesView,
  chipText,
  updatesTrayLine,
  type UpdatesView,
} from "../lib/updates/view.ts";
import { DONT, restartDialog, scheduleDialog, updateDialog } from "../lib/updates/dialog.ts";
import {
  createUpdatesBackend,
  type UpdatesEngine,
  type UpdatesFilesPort,
} from "../lib/updates/backend.ts";
import type { RunRequest } from "../lib/updates/orchestrator.ts";
import type { UpdateRequest } from "../lib/updates/requests.ts";
import { type UpdatesApi, UpdatesPanel } from "../app/updates-panel.tsx";
import { MachinesView } from "../app/machines-view.tsx";
import { CONFIG, D, H, host, NOW, statuses, TZ } from "./updates-fixtures.ts";

const RUN: RunRecord = {
  v: 1,
  id: "runner-2-abc-0001",
  machine: "runner-2",
  origin: { kind: "auto" },
  action: "install",
  mode: "security",
  reboot: "never",
  drainCapMinutes: 90,
  windowEnd: null,
  startedAt: NOW - 10 * 60_000,
  step: "drain",
  stepAt: NOW - 4 * 60_000,
  holds: [{ pool: "arm-a", until: NOW + 3 * H, pausedBefore: false }],
  bootId: "b1",
  baseline: null,
  installAt: null,
  installOk: null,
  rebootNeeded: false,
  rebooted: false,
  steps: [],
  outcome: null,
  keptHolds: [],
};

const audit = (over: Partial<AuditEntry> = {}): AuditEntry => ({
  v: 1,
  id: "runner-1-x-0001",
  machine: "runner-1",
  origin: { kind: "user" },
  action: "install",
  mode: "security",
  reboot: "never",
  startedAt: NOW - 2 * D,
  endedAt: NOW - 2 * D + H,
  outcome: "succeeded",
  steps: [{
    step: "preflight",
    startedAt: NOW - 2 * D,
    endedAt: NOW - 2 * D + 1000,
    ok: true,
    detail: "3 pending",
  }],
  keptHolds: [],
  ...over,
});

const SCHED: UpdateSchedule = {
  id: "s-mail",
  machine: "mail-1",
  days: [0],
  start: "03:00",
  windowMinutes: 240,
  mode: "security",
  reboot: "if-needed",
  drainCapMinutes: 90,
  enabled: true,
};

function view(over: Partial<Parameters<typeof buildUpdatesView>[0]> = {}): UpdatesView {
  return buildUpdatesView({
    config: CONFIG,
    statuses: statuses(),
    run: null,
    audit: [audit()],
    schedules: [SCHED],
    requests: [],
    tz: TZ,
    now: NOW,
    engine: { ok: true },
    ...over,
  });
}

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
const button = (root: TestElement, label: string) =>
  all(root, "button").find((b) => text(b).trim() === label);

function fakeApi(): UpdatesApi & { calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const ok = (name: string) => (a: unknown) => {
    calls.push([name, a]);
    return Promise.resolve({ ok: true as const, message: `${name} ok` });
  };
  return {
    calls,
    check: ok("check"),
    run: ok("run"),
    restart: ok("restart"),
    cancel: ok("cancel"),
    saveSchedule: ok("saveSchedule"),
    setScheduleEnabled: (id, enabled) => ok("setScheduleEnabled")({ id, enabled }),
    deleteSchedule: ok("deleteSchedule"),
    approve: ok("approve"),
    deny: ok("deny"),
    openSoftwareUpdate: ok("openSoftwareUpdate"),
  };
}

// ---- the view ----

Deno.test("updates view: every level from fixtures, its chip and causes", () => {
  const v = view();
  const by = Object.fromEntries(v.machines.map((m) => [m.id, m]));
  assertEquals(by["runner-1"].level, "ok");
  assertEquals(by["runner-1"].chip.text, "Up to date");
  assertEquals(by["runner-2"].level, "info");
  assertEquals(by["runner-2"].chip.text, "4 updates");
  assertEquals(by["mail-1"].level, "warn");
  assertEquals(by["mail-1"].chip.text, "Restart pending 2 d");
  assertEquals(by["files-1"].level, "bad");
  assertEquals(by["files-1"].causes, ["security-old"]);
  assertEquals(by["files-1"].chip.text, "12 updates, 3 security");
  assertStringIncludes(by["files-1"].chip.title, "checked 1 h ago");
  // A stale check joins the chip; never checked says so.
  const stale = withCheck(emptyStatus("x"), host(1, 1), NOW - 2 * D);
  assertEquals(chipText(stale, "warn", NOW).text, "1 update, 1 security · Checked 2 d ago");
  assertEquals(chipText(emptyStatus("x"), "bad", NOW).text, "Never checked");
  // Settings shown: auto-install on by default, off where configured, never for self.
  assert(by["runner-1"].autoInstall && by["mail-1"].autoInstall);
  assertFalse(by["files-1"].autoInstall);
  assertFalse(by["here"].autoInstall);
  assertFalse(by["here"].canInstall);
  // The next window of each restart window.
  assertEquals(new Date(v.schedules[0].next!).toISOString(), "2026-11-29T09:00:00.000Z");
});

Deno.test("updates view: the audit's kept holds become the machine's heldPools (bad)", () => {
  const failed = audit({
    id: "runner-1-y-0002",
    outcome: "verify-failed",
    keptHolds: ["lx-a"],
    endedAt: NOW - H,
  });
  const v = view({ audit: [audit(), failed] });
  const m = v.machines.find((x) => x.id === "runner-1")!;
  assertEquals(m.status.heldPools, ["lx-a"]);
  assertEquals(m.level, "bad");
  assertStringIncludes(m.chip.text, "Pools held: lx-a");
  // A later clean run clears them; a hold the user resumed is dropped.
  assertEquals(heldPoolsFromAudit([failed, audit({ id: "z", endedAt: NOW })]), {});
  assertEquals(heldPoolsFromAudit([failed], () => false), {});
  assertEquals(heldPoolsFromAudit([failed]), { "runner-1": ["lx-a"] });
});

Deno.test("updates files: parsed back, hostile text clamped, garbage ignored", () => {
  const s = statuses();
  const evil = { ...s["files-1"], error: "x\u202e\n".repeat(400) };
  const doc = JSON.parse(JSON.stringify(statusFile([...Object.values(s), evil])));
  const back = parseStatusFile(doc);
  assertEquals(back["runner-2"].host?.pending.total, 4);
  assert(back["files-1"].error!.length <= 200);
  assertFalse(/[\u202e\n]/.test(back["files-1"].error!));
  assertEquals(parseStatusFile({ v: 2 }), {});
  assertEquals(parseStatusFile({ v: 1, machines: { "-bad": s["runner-1"] } }), {});
  const lines = `${JSON.stringify(audit())}\nnot json\n${JSON.stringify({ v: 1, id: "x" })}\n`;
  assertEquals(parseAudit(lines).length, 1);
});

Deno.test("updates panel: every level renders with its chip; a server notes the outage", async () => {
  const screen = await render(<UpdatesPanel view={view()} api={fakeApi()} />);
  const root = screen.container;
  const picks = all(root, ".upd-pick").map(text);
  assertEquals(picks, [
    "runner-1Up to date",
    "runner-24 updates",
    "mail-1Restart pending 2 d",
    "files-112 updates, 3 security",
    "here2 updates, 2 security",
  ]);
  const chips = all(root, ".upd-pick").map((p) => all(p, ".chip")[0].getAttribute("class"));
  assertEquals(chips, [
    "chip chip-ok",
    "chip chip-busy",
    "chip chip-blocked",
    "chip chip-unhealthy",
    "chip chip-blocked",
  ]);
  // The first machine's detail: install controls, its last run, auto-install shown.
  assert(button(root, "Update now…"));
  assert(button(root, "Check now"));
  assertFalse(button(root, "Restart now…"), "no restart pending on runner-1");
  assertStringIncludes(text(root), "Installs on its own");
  assertStringIncludes(text(root), "yes, when out of date");
  assertEquals(all(root, ".upd-run").length >= 1, true);
  // The restart select defaults to later (a window): nothing restarts unasked.
  const restartOpts = all(all(root, "select")[1], "option");
  assertEquals(restartOpts[0].getAttribute("value"), "never");
  // mail-1: a server with a restart pending: the outage note, the ack box gating the buttons.
  await screen.fireEvent.click(all(root, ".upd-pick")[2]);
  await settle();
  assertStringIncludes(text(root), "unavailable for a few minutes");
  const update = button(root, "Update now…")!;
  const restart = button(root, "Restart now…")!;
  assert(update.hasAttribute("disabled") && restart.hasAttribute("disabled"));
  const ack = all(all(root, ".upd-ack")[0], "input")[0];
  (ack as unknown as { checked: boolean }).checked = true;
  await screen.fireEvent.change(ack);
  await settle();
  assertFalse(button(root, "Restart now…")!.hasAttribute("disabled"));
});

Deno.test("updates panel: the self machine shows no install control, only Open Software Update", async () => {
  const api = fakeApi();
  const screen = await render(<UpdatesPanel view={view()} api={api} selected="here" />);
  await settle();
  const root = screen.container;
  const machine = all(root, ".upd-machine")[0];
  assertStringIncludes(text(machine), "the machine Fleet runs on");
  for (const label of ["Update now…", "Restart now…", "Check now"]) {
    assertFalse(button(machine, label), `${label} on the self machine`);
  }
  assertEquals(all(machine, "select").length, 0);
  assertStringIncludes(text(machine), "no (notices only)");
  await screen.fireEvent.click(button(machine, "Open Software Update")!);
  await settle();
  assertEquals(api.calls, [["openSoftwareUpdate", "here"]]);
  // And the restart-window form never offers it.
  const options = all(all(root, ".upd-form")[0], "option").map(text);
  assertFalse(options.includes("here"));
});

Deno.test("updates panel: a run in flight shows its step live, and Cancel while it can", async () => {
  const api = fakeApi();
  const screen = await render(
    <UpdatesPanel view={view({ run: RUN })} api={api} />,
  );
  const root = screen.container;
  const banner = all(root, ".upd-inflight")[0];
  assertStringIncludes(text(banner), "Updating runner-2");
  assertStringIncludes(text(banner), "draining");
  assertStringIncludes(text(banner), "since 4 min");
  assert(button(root, "Update now…")!.hasAttribute("disabled"), "one run at a time");
  await screen.fireEvent.click(button(banner, "Cancel update")!);
  await settle();
  assertEquals(api.calls, [["cancel", RUN.id]]);
  // Past the final check: no Cancel; a restart run says so.
  const later = await render(
    <UpdatesPanel view={view({ run: { ...RUN, step: "reboot", action: "restart" } })} api={api} />,
  );
  const b2 = all(later.container, ".upd-inflight")[0];
  assertStringIncludes(text(b2), "Restarting runner-2: restarting");
  assertFalse(button(b2, "Cancel update"));
  assertStringIncludes(text(b2), "can't be cancelled");
});

Deno.test("updates panel: agents' requests await approval; a server's needs the outage box", async () => {
  const req = (id: string, machine: string): UpdateRequest => ({
    v: 1,
    id,
    machine,
    mode: "security",
    reboot: "if-needed",
    reason: "<b>CVE-2026-1</b> is exploited",
    at: NOW - H,
    by: "agent",
  });
  const api = fakeApi();
  const screen = await render(
    <UpdatesPanel
      view={view({ requests: [req("req-aaaaaaaa", "runner-2"), req("req-bbbbbbbb", "mail-1")] })}
      api={api}
    />,
  );
  const root = screen.container;
  const rows = all(root, ".upd-request");
  assertEquals(rows.length, 2);
  assertStringIncludes(text(all(root, ".upd-requests")[0]), "Asked by an agent");
  // Host or agent text is text: no markup made of it.
  assertEquals(all(rows[0], "b").length, 0);
  assertStringIncludes(text(rows[0]), "<b>CVE-2026-1</b>");
  assert(button(rows[1], "Approve…")!.hasAttribute("disabled"));
  await screen.fireEvent.click(button(rows[0], "Approve…")!);
  await settle();
  await screen.fireEvent.click(button(rows[1], "Deny")!);
  await settle();
  assertEquals(api.calls, [
    ["approve", { id: "req-aaaaaaaa", acknowledgeOutage: false }],
    ["deny", "req-bbbbbbbb"],
  ]);
});

Deno.test("updates panel: the restart-window form has typed widgets and validates", async () => {
  const api = fakeApi();
  const screen = await render(<UpdatesPanel view={view({ schedules: [] })} api={api} />);
  const form = all(screen.container, ".upd-form")[0];
  assertEquals(all(form, "textarea").length, 0, "no raw text config");
  const inputs = all(form, "input");
  assertEquals(inputs.filter((i) => i.getAttribute("type") === "checkbox").length, 7);
  assert(inputs.some((i) => i.getAttribute("type") === "time"));
  assertEquals(inputs.filter((i) => i.getAttribute("type") === "number").length, 2);
  assertStringIncludes(text(form), "CST");
  // A window too short for runner-1's drain cap (45 + 90) is refused before Save.
  const windowBox = inputs.find((i) => i.getAttribute("max") === "1440")!;
  await screen.fireEvent.change(windowBox, { target: { value: "60" } });
  await settle();
  assertStringIncludes(text(form), "at least 135");
  assert(button(form, "Save window…")!.hasAttribute("disabled"));
  await screen.fireEvent.change(windowBox, { target: { value: "240" } });
  await settle();
  await screen.fireEvent.click(button(form, "Save window…")!);
  await settle();
  assertEquals(api.calls.length, 1);
  const [name, sent] = api.calls[0] as [string, Record<string, unknown>];
  assertEquals(name, "saveSchedule");
  assertEquals(sent.machine, "runner-1");
  assertEquals(sent.windowMinutes, 240);
  assertEquals(sent.days, [6]);
  assertEquals(sent.start, "03:00");
});

Deno.test("machines screen: each card carries its update chip, which opens the Updates tab", async () => {
  const machinesView = {
    configured: true,
    connected: true,
    error: "",
    machines: [{
      id: "runner-2",
      name: "Runner two",
      info: null,
      source: null,
      lastAt: null,
      online: false,
      latest: null,
      pools: [],
    }],
    trails: {},
  };
  const screen = await render(
    <MachinesView
      // deno-lint-ignore no-explicit-any
      view={machinesView as any}
      now={NOW}
      api={{ history: () => Promise.resolve({ error: "no" }) }}
      routing={null}
      onBack={() => {}}
      updates={view()}
      updatesApi={fakeApi()}
    />,
  );
  const root = screen.container;
  const chip = all(root, ".upd-chip")[0];
  assertEquals(text(chip), "4 updates");
  assertEquals(all(root, ".tab").map(text), ["Machines", "Updates"]);
  await screen.fireEvent.click(chip);
  await settle();
  const on = all(root, ".upd-pick").find((b) => b.getAttribute("aria-pressed") === "true")!;
  assertStringIncludes(text(on), "runner-2");
  // With no machines service, the Updates panel stands alone.
  const alone = await render(
    <MachinesView
      // deno-lint-ignore no-explicit-any
      view={{ ...machinesView, configured: false, machines: [] } as any}
      now={NOW}
      api={{ history: () => Promise.resolve({ error: "no" }) }}
      routing={null}
      onBack={() => {}}
      updates={view()}
      updatesApi={fakeApi()}
    />,
  );
  assertEquals(all(alone.container, ".tab").length, 0);
  assertEquals(all(alone.container, ".upd-pick").length, 5);
});

// ---- the dialogs ----

Deno.test("dialog: Update now names the machine, pools, labels, mode, restart and drain cap; Don't is the default", () => {
  const m = CONFIG.machines[0];
  const d = updateDialog({
    machine: m,
    mode: "security",
    reboot: "never",
    drainCapMinutes: 45,
    pending: { total: 12, security: 3 },
    labels: ["lx", "lx-2204"],
    soleLabels: ["lx-2204"],
  });
  assertEquals(d.buttons[DONT], "Don't");
  assertEquals([d.defaultId, d.cancelId], [0, 0]);
  assertEquals(d.message, "Update runner-1 now?");
  for (
    const want of [
      "security updates only (3 of 12 pending)",
      "waits for the next restart window",
      "Holds pools lx-a",
      "lx, lx-2204",
      "No other machine serves lx-2204",
      "up to 45 min",
      "running jobs are never stopped",
    ]
  ) assertStringIncludes(d.detail!, want);
  // A server: the outage in the message and on the button; no pools.
  const s = updateDialog({
    machine: CONFIG.machines[2],
    mode: "all",
    reboot: "if-needed",
    drainCapMinutes: 90,
    pending: null,
    labels: [],
    soleLabels: [],
    request: { id: "req-aaaaaaaa", reason: "a CVE" },
  });
  assertStringIncludes(s.message, "unavailable for a few minutes");
  assertEquals(s.buttons, ["Don't", "Update, accept the outage"]);
  assertStringIncludes(s.detail!, "No runner pools");
  assertStringIncludes(s.detail!, "only if an update needs it");
  assertStringIncludes(s.detail!, "Asked by an agent (request req-aaaaaaaa)");
  // Restart now and a restart window: Don't first too.
  const r = restartDialog({
    machine: m,
    drainCapMinutes: 45,
    packages: ["linux-image"],
    labels: ["lx"],
    soleLabels: [],
  });
  assertEquals([r.buttons[0], r.defaultId, r.cancelId], ["Don't", 0, 0]);
  assertStringIncludes(r.detail!, "Nothing installs");
  const w = scheduleDialog(SCHED, CONFIG.machines[2], TZ, NOW);
  assertEquals([w.buttons[0], w.defaultId], ["Don't", 0]);
  assertStringIncludes(w.detail!, "Every Sun at 03:00 CST, a 240-minute window.");
  assertStringIncludes(w.detail!, "only when a restart is pending");
});

// ---- the backend ----

function fakeFiles(init: { requests?: UpdateRequest[]; schedules?: UpdateSchedule[] } = {}) {
  const st = statuses();
  const f = {
    saved: [] as UpdateSchedule[][],
    removed: [] as string[],
    requestsList: init.requests ?? [],
    schedulesList: init.schedules ?? [],
  };
  const port: UpdatesFilesPort = {
    statuses: () => Promise.resolve(st),
    run: () => Promise.resolve(null),
    audit: () => Promise.resolve([]),
    schedules: () => Promise.resolve(f.schedulesList),
    saveSchedules: (l) => {
      f.saved.push([...l]);
      f.schedulesList = [...l];
      return Promise.resolve();
    },
    requests: () => Promise.resolve(f.requestsList),
    removeRequest: (id) => {
      f.removed.push(id);
      f.requestsList = f.requestsList.filter((r) => r.id !== id);
      return Promise.resolve();
    },
  };
  return { f, port };
}

function backend(answer: number | null, files = fakeFiles(), engineOn = true) {
  const starts: RunRequest[] = [];
  const dialogs: { message: string; buttons: string[]; defaultId: number }[] = [];
  const engine: UpdatesEngine = {
    orchestrator: {
      start: (req) => {
        starts.push(req);
        return Promise.resolve({
          ok: true,
          runId: "run-1",
          done: Promise.resolve({ ...RUN, id: "run-1", outcome: "succeeded" }),
        });
      },
      cancel: () => ({ ok: true }),
      current: () => null,
    },
    status: {
      refresh: (m) => Promise.resolve(statuses()[m.id]),
      current: () => null,
    },
    peers: {
      facts: () =>
        Promise.resolve({
          pools: {
            "lx-a": { label: "lx", healthy: true, held: false },
            "arm-a": { label: "arm", healthy: true, held: false },
          },
          unreachable: [],
        }),
    },
  };
  const b = createUpdatesBackend({
    config: () => CONFIG,
    files: files.port,
    engine: () => (engineOn ? engine : null),
    confirm: (o) => {
      dialogs.push(o);
      return Promise.resolve(answer);
    },
    openSoftwareUpdate: () => Promise.resolve({ ok: true, message: "open" }),
    now: () => NOW,
    tz: () => TZ,
    log: () => Promise.resolve(),
  });
  return { b, starts, dialogs, files };
}

Deno.test("backend: Update now runs only after the confirm button; Don't, Escape and a server without the box run nothing", async () => {
  for (const answer of [0, null]) {
    const t = backend(answer);
    const r = await t.b.updateNow({ machine: "runner-1" });
    assertFalse(r.ok);
    assertEquals(t.starts, []);
    assertEquals(t.dialogs[0].defaultId, 0);
  }
  const yes = backend(1);
  const r = await yes.b.updateNow({ machine: "runner-1", mode: "all", reboot: "always" });
  assert(r.ok);
  // "always" never reaches a run: a restart happens only when an update needs it.
  assertEquals(yes.starts, [{
    machine: "runner-1",
    origin: { kind: "user" },
    mode: "all",
    reboot: "if-needed",
  }]);
  // Default: the restart waits for a window.
  const def = backend(1);
  await def.b.updateNow({ machine: "runner-1" });
  assertEquals(def.starts[0].reboot, "never");
  // A server needs the outage box first; the self machine and unknown ids are refused unasked.
  const srv = backend(1);
  assertStringIncludes(
    (await srv.b.updateNow({ machine: "mail-1" })).message,
    "confirm the outage",
  );
  assertEquals(srv.dialogs.length, 0);
  assert((await srv.b.updateNow({ machine: "mail-1", acknowledgeOutage: true })).ok);
  assertStringIncludes(srv.dialogs[0].message, "unavailable");
  const self = backend(1);
  assertStringIncludes(
    (await self.b.updateNow({ machine: "here" })).message,
    "Open Software Update",
  );
  assertFalse((await self.b.updateNow({ machine: "nope; rm -rf /" })).ok);
  assertEquals(self.starts, []);
  // No engine in this build: said, nothing asked.
  const off = backend(1, fakeFiles(), false);
  assertStringIncludes((await off.b.updateNow({ machine: "runner-1" })).message, "can't reach");
  assertEquals(off.dialogs.length, 0);
});

Deno.test("backend: Restart now only when a restart is pending, as a restart run", async () => {
  const t = backend(1);
  assertStringIncludes(
    (await t.b.restartNow({ machine: "runner-1" })).message,
    "No restart is pending",
  );
  assertStringIncludes(
    (await t.b.restartNow({ machine: "mail-1" })).message,
    "confirm the outage",
  );
  assert((await t.b.restartNow({ machine: "mail-1", acknowledgeOutage: true })).ok);
  assertEquals(t.starts, [{ machine: "mail-1", origin: { kind: "user" }, action: "restart" }]);
  assertEquals(t.dialogs[0].buttons, ["Don't", "Restart, accept the outage"]);
  const no = backend(0);
  await no.b.restartNow({ machine: "mail-1", acknowledgeOutage: true });
  assertEquals(no.starts, []);
});

Deno.test("backend: an agent's request runs only through the dialog, once; deny removes it", async () => {
  const req: UpdateRequest = {
    v: 1,
    id: "req-aaaaaaaa",
    machine: "runner-2",
    mode: "all",
    reboot: "always",
    reason: "CVE",
    at: NOW - H,
    by: "agent",
  };
  const no = backend(0, fakeFiles({ requests: [req] }));
  assertFalse((await no.b.approveRequest({ id: req.id })).ok);
  assertEquals([no.starts.length, no.files.f.removed.length], [0, 0]);
  const yes = backend(1, fakeFiles({ requests: [req] }));
  assert((await yes.b.approveRequest({ id: req.id })).ok);
  assertEquals(yes.starts, [{
    machine: "runner-2",
    origin: { kind: "request", requestId: req.id },
    mode: "all",
    reboot: "if-needed",
  }]);
  assertStringIncludes(yes.dialogs[0].message, "Approve the agent's request");
  assertEquals(yes.files.f.removed, [req.id]);
  assertFalse((await yes.b.approveRequest({ id: req.id })).ok, "spent");
  const deny = backend(1, fakeFiles({ requests: [req] }));
  assert((await deny.b.denyRequest({ id: req.id })).ok);
  assertEquals([deny.starts.length, deny.dialogs.length, deny.files.f.removed], [0, 0, [req.id]]);
});

Deno.test("backend: a restart window is validated, asked once, then saved; off needs no dialog", async () => {
  const t = backend(1);
  const bad = await t.b.saveSchedule({ schedule: { machine: "here", days: [1], start: "03:00" } });
  assertFalse(bad.ok);
  assert(!bad.ok && bad.errors!.some((e) => e.includes("notify-only")));
  assertEquals(t.dialogs.length, 0);
  const good = await t.b.saveSchedule({
    schedule: { machine: "mail-1", days: [0], start: "03:00", windowMinutes: 240 },
  });
  assert(good.ok, good.message);
  assertEquals(t.dialogs.length, 1);
  assertEquals(t.files.f.saved.length, 1);
  const id = t.files.f.schedulesList[0].id;
  assert((await t.b.setScheduleEnabled({ id, enabled: false })).ok);
  assertEquals(t.dialogs.length, 1, "turning off asks nothing");
  const no = backend(0, t.files);
  assertFalse((await no.b.setScheduleEnabled({ id, enabled: true })).ok);
  assertFalse(no.files.f.schedulesList[0].enabled);
  assert((await t.b.deleteSchedule({ id })).ok);
  assertEquals(t.files.f.schedulesList, []);
});

Deno.test("backend: the view, and the tray's one line", async () => {
  const t = backend(1);
  const v = await t.b.view();
  assert(v.configured);
  assertEquals(updatesTrayLine(v), {
    line: "3 machines need updates",
    bad: true,
    cancellable: null,
  });
  assertEquals(
    updatesTrayLine(view({ run: RUN })),
    { line: "Updating runner-2: draining", bad: true, cancellable: RUN.id },
  );
  const calm = buildUpdatesView({
    config: CONFIG,
    statuses: {},
    run: null,
    audit: [],
    schedules: [],
    requests: [],
    tz: TZ,
    now: NOW,
    engine: { ok: true },
  });
  // Never checked is bad for every machine (the no-check cause).
  assertEquals(updatesTrayLine(calm)?.line, "5 machines need updates");
  assertEquals(updatesTrayLine(null), null);
});

// ---- settings ----

Deno.test("settings: integrations.updates is validated with the rest; notifications.updates defaults on", () => {
  const base = { ...DEFAULT_SETTINGS };
  const ok = validateSettings({
    ...base,
    integrations: {
      runnerScheduler: null,
      updates: {
        ssh: { configFile: "~/fleet-test/ssh_config" },
        machines: [{ id: "m1", os: "ubuntu", via: { ssh: "m1" } }],
      },
    },
  });
  assert(ok.ok);
  assert(ok.ok && ok.settings.integrations.updates?.machines[0].autoInstall);
  assert(ok.ok && ok.settings.notifications.updates);
  const bad = validateSettings({
    ...base,
    integrations: {
      runnerScheduler: null,
      updates: {
        machines: [{ id: "me", os: "macos", via: "local", self: true, autoInstall: true }],
      },
    },
  });
  assertFalse(bad.ok);
  assert(!bad.ok && bad.errors.some((e) => e.includes("autoInstall")));
  const off = validateSettings({
    ...base,
    notifications: { ...base.notifications, updates: false },
  });
  assert(off.ok && off.settings.notifications.updates === false);
  // Absent: off, and no key in the document.
  const none = validateSettings(base);
  assert(none.ok && !("updates" in none.settings.integrations));
});
