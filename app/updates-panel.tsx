"use client";
// The Updates panel (the Machines screen's Updates tab): each machine's update status, the run in
// flight with its step, live, Check now / Update now… / Restart now…, the restart windows and
// their form, the agents' requests awaiting approval, and the run history. Fleet installs pending
// updates on its own when a machine's `autoInstall` is on, and restarts only when an update needs
// it, in a restart window or on Restart now. The machine Fleet runs on shows no install control,
// only Open Software Update. Every action goes through the backend's OS dialog ("Don't" by
// default); a server also needs the outage box ticked first. Host text is shown as text, never as
// markup.

import { useEffect, useState } from "denext";
import { validateSchedules } from "../lib/updates/config.ts";
import { clockText, daysText, zoneName } from "../lib/updates/dialog.ts";
import type {
  AuditEntry,
  Level,
  RebootPolicy,
  UpdateMode,
  UpdateSchedule,
  UpdatesConfig,
  UpdatesMachine,
} from "../lib/updates/model.ts";
import type { UpdatesResult } from "../lib/updates/backend.ts";
import type { UpdateRequest } from "../lib/updates/requests.ts";
import {
  ageText,
  stepText,
  type UpdatesMachineView,
  type UpdatesView,
} from "../lib/updates/view.ts";

/** What the panel asks the backend. */
export interface UpdatesApi {
  check(machine: string): Promise<UpdatesResult>;
  run(
    a: { machine: string; mode: UpdateMode; reboot: RebootPolicy; acknowledgeOutage?: boolean },
  ): Promise<UpdatesResult>;
  restart(a: { machine: string; acknowledgeOutage?: boolean }): Promise<UpdatesResult>;
  cancel(runId: string): Promise<UpdatesResult>;
  saveSchedule(schedule: Partial<UpdateSchedule>): Promise<UpdatesResult>;
  setScheduleEnabled(id: string, enabled: boolean): Promise<UpdatesResult>;
  deleteSchedule(id: string): Promise<UpdatesResult>;
  approve(a: { id: string; acknowledgeOutage?: boolean }): Promise<UpdatesResult>;
  deny(id: string): Promise<UpdatesResult>;
  openSoftwareUpdate(machine: string): Promise<UpdatesResult>;
}

export interface UpdatesPanelProps {
  readonly view: UpdatesView | null;
  readonly api: UpdatesApi;
  /** The machine shown first (a card's chip was clicked). */
  readonly selected?: string | null;
}

/** The chip class for a level. */
export const LEVEL_CHIP: Record<Level, string> = {
  ok: "chip chip-ok",
  info: "chip chip-busy",
  warn: "chip chip-blocked",
  bad: "chip chip-unhealthy",
};

const OUTCOME: Record<string, string> = {
  "succeeded": "done",
  "nothing-to-do": "nothing to do",
  "aborted": "stopped",
  "cancelled": "cancelled",
  "deferred-busy": "busy: deferred",
  "install-failed": "install failed",
  "reboot-pending": "installed, restart pending",
  "host-down": "didn't come back",
  "verify-failed": "verify failed",
  "resume-failed": "pool not resumed",
};

const WEEK = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** The update chip on a machine card (opens the panel on that machine). */
export function UpdateChip(
  props: { m: UpdatesMachineView; onOpen?: (machine: string) => void },
) {
  const { m } = props;
  return (
    <button
      type="button"
      class={`${LEVEL_CHIP[m.level]} upd-chip`}
      title={m.chip.title}
      aria-label={`Updates for ${m.id}: ${m.chip.text}`}
      onClick={() => props.onOpen?.(m.id)}
    >
      {m.chip.text}
    </button>
  );
}

/** The page's view of the config, enough for validateSchedules. */
function pseudoConfig(v: UpdatesView): UpdatesConfig {
  return {
    ssh: { program: "/usr/bin/ssh", configFile: "" },
    thresholds: v.thresholds,
    minFreeDiskMb: 0,
    machines: v.machines.map((m): UpdatesMachine => ({
      id: m.id,
      os: m.os,
      kind: m.kind,
      via: m.self ? "local" : { ssh: m.id },
      self: m.self,
      install: m.install,
      autoInstall: m.autoInstall,
      pools: m.pools,
      busy: [],
      verify: { mounts: [], reach: [] },
      reboot: m.reboot,
      drainCapMinutes: m.drainCapMinutes,
    })),
  };
}

function Runs(props: { runs: readonly AuditEntry[]; tz: string; showMachine?: boolean }) {
  if (props.runs.length === 0) return <p class="muted small">No runs yet.</p>;
  return (
    <ul class="upd-runs">
      {props.runs.map((r) => (
        <li key={r.id} class="upd-run">
          <details>
            <summary>
              <span class="upd-run-when">{clockText(r.startedAt, props.tz)}</span>
              {props.showMachine ? <span class="upd-run-machine">{r.machine}</span> : null}
              <span class="muted">
                {(r.action ?? "install") === "restart" ? "restart" : `install (${r.mode})`}
                {" · "}
                {r.origin.kind === "request"
                  ? "asked by an agent"
                  : r.origin.kind === "schedule"
                  ? "restart window"
                  : r.origin.kind === "auto"
                  ? "automatic"
                  : "you"}
              </span>
              <span class={`upd-outcome upd-outcome-${r.outcome}`}>
                {OUTCOME[r.outcome] ?? r.outcome}
              </span>
            </summary>
            <ol class="upd-steps">
              {r.steps.map((s, i) => (
                <li key={i} class={s.ok ? "" : "upd-step-bad"}>
                  <span class="upd-step-name">{s.step}</span> {s.detail}
                  {s.code !== undefined ? <span class="muted">(exit {s.code})</span> : null}
                </li>
              ))}
            </ol>
          </details>
        </li>
      ))}
    </ul>
  );
}

function Machine(
  props: {
    m: UpdatesMachineView;
    view: UpdatesView;
    api: UpdatesApi;
    act: (fn: () => Promise<UpdatesResult>) => void;
    busy: boolean;
  },
) {
  const { m, view, api, act, busy } = props;
  const [mode, setMode] = useState<UpdateMode>(m.install === "all" ? "all" : "security");
  const [reboot, setReboot] = useState<RebootPolicy>("never");
  const [ack, setAck] = useState(false);
  const h = m.status.host;
  const now = view.now;
  const engineOff = !view.engine.ok;
  const server = m.kind === "server";
  const needAck = server && !ack;
  const restartPending = h?.reboot.required === true;
  return (
    <section class="upd-machine" aria-label={`Updates: ${m.id}`}>
      <header class="upd-machine-head">
        <h3 class="upd-name">{m.id}</h3>
        <span class={LEVEL_CHIP[m.level]}>{m.level}</span>
        <span class="muted small">
          {m.os} · {m.self ? "the machine Fleet runs on" : server ? "server" : "runner host"}
          {m.pools.length ? ` · pools ${m.pools.join(", ")}` : ""}
        </span>
      </header>
      <dl class="upd-facts">
        <div>
          <dt>Pending</dt>
          <dd>
            {h ? `${h.pending.total} (${h.pending.security} security)` : "not checked yet"}
          </dd>
        </div>
        <div>
          <dt>Restart</dt>
          <dd>
            {restartPending
              ? `pending${
                m.status.firstSeen.reboot ?? h?.reboot.since
                  ? ` for ${ageText(now - (m.status.firstSeen.reboot ?? h!.reboot.since!))}`
                  : ""
              }`
              : "not needed"}
          </dd>
        </div>
        <div>
          <dt>Checked</dt>
          <dd>
            {m.status.checkedAt === null ? "never" : `${ageText(now - m.status.checkedAt)} ago`}
          </dd>
        </div>
        <div>
          <dt>Installs on its own</dt>
          <dd title="autoInstall in the settings file">
            {m.self ? "no (notices only)" : m.autoInstall ? "yes, when out of date" : "no"}
          </dd>
        </div>
      </dl>
      {m.status.error
        ? <p class="m-error" role="alert">Last check failed: {m.status.error}</p>
        : null}
      {m.status.heldPools.length
        ? (
          <p class="m-error" role="alert">
            A failed run left {m.status.heldPools.join(", ")} held: resume them once fixed.
          </p>
        )
        : null}
      {restartPending && h!.reboot.packages.length
        ? <p class="muted small">Restart asked for by: {h!.reboot.packages.join(", ")}</p>
        : null}
      {server
        ? (
          <p class="muted small">
            A restart makes its services unavailable for a few minutes; clients (mail apps, mounted
            shares on other machines) drop and reconnect.
          </p>
        )
        : null}
      {h && h.pending.names.length
        ? (
          <details class="upd-names">
            <summary>{h.pending.names.length} pending package names</summary>
            <ul>
              {h.pending.names.map((n) => (
                <li key={n} class={h.pending.securityNames.includes(n) ? "upd-sec" : ""}>
                  {n}
                </li>
              ))}
            </ul>
          </details>
        )
        : null}
      {m.self
        ? (
          <div class="upd-actions">
            <p class="muted small">
              Fleet only notifies about the machine it runs on: install its updates yourself.
            </p>
            <button
              type="button"
              class="btn"
              disabled={busy}
              onClick={() => act(() => api.openSoftwareUpdate(m.id))}
            >
              Open Software Update
            </button>
          </div>
        )
        : m.canInstall
        ? (
          <div class="upd-actions">
            <button
              type="button"
              class="btn"
              disabled={busy || engineOff}
              onClick={() => act(() => api.check(m.id))}
            >
              Check now
            </button>
            <label class="upd-field">
              Install
              <select
                onChange={(e) => setMode((e.target as HTMLSelectElement).value as UpdateMode)}
              >
                <option value="security" selected={mode === "security"}>security updates</option>
                <option value="all" selected={mode === "all"}>every update</option>
              </select>
            </label>
            <label class="upd-field">
              Restart
              <select
                onChange={(e) => setReboot((e.target as HTMLSelectElement).value as RebootPolicy)}
              >
                <option value="never" selected={reboot === "never"}>
                  later, in a restart window
                </option>
                <option value="if-needed" selected={reboot === "if-needed"}>
                  right after, if an update needs it
                </option>
              </select>
            </label>
            {server
              ? (
                <label class="set-check upd-ack">
                  <input
                    type="checkbox"
                    checked={ack}
                    onChange={(e) => setAck((e.target as HTMLInputElement).checked)}
                  />
                  <span>I accept that {m.id}'s services go down for a few minutes</span>
                </label>
              )
              : null}
            <button
              type="button"
              class="btn btn-primary"
              disabled={busy || engineOff || needAck || view.run !== null}
              onClick={() =>
                act(() => api.run({ machine: m.id, mode, reboot, acknowledgeOutage: ack }))}
            >
              Update now…
            </button>
            {restartPending
              ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy || engineOff || needAck || view.run !== null}
                  onClick={() => act(() => api.restart({ machine: m.id, acknowledgeOutage: ack }))}
                >
                  Restart now…
                </button>
              )
              : null}
          </div>
        )
        : <p class="muted small">This machine installs nothing (install: none).</p>}
      <h4 class="upd-h">Last runs</h4>
      <Runs runs={m.runs} tz={view.tz} />
    </section>
  );
}

const blankDraft = (machine: string, drain: number) => ({
  machine,
  days: [6] as number[],
  start: "03:00",
  windowMinutes: Math.max(240, drain + 90),
  drainCapMinutes: drain,
});

function ScheduleForm(
  props: { view: UpdatesView; api: UpdatesApi; act: (fn: () => Promise<UpdatesResult>) => void },
) {
  const { view } = props;
  const machines = view.machines.filter((m) => m.canInstall);
  const first = machines[0];
  const [draft, setDraft] = useState(blankDraft(first?.id ?? "", first?.drainCapMinutes ?? 90));
  if (!first) return null;
  const candidate = { id: "draft", ...draft, mode: "security", reboot: "if-needed", enabled: true };
  const check = validateSchedules([candidate], pseudoConfig(view));
  const errors = check.ok ? [] : check.errors.map((e) => e.replace(/^schedules\[0\]\./, ""));
  const set = (patch: Partial<typeof draft>) => setDraft((d) => ({ ...d, ...patch }));
  const save = () => {
    if (!errors.length) props.act(() => props.api.saveSchedule({ ...draft, enabled: true }));
  };
  const toggleDay = (d: number, on: boolean) =>
    set({ days: on ? [...new Set([...draft.days, d])].sort() : draft.days.filter((x) => x !== d) });
  return (
    <form
      class="upd-form"
      aria-label="Add a restart window"
      onSubmit={(e) => {
        e.preventDefault();
        save();
      }}
    >
      <h4 class="upd-h">Add a restart window</h4>
      <p class="muted small">
        Pending restarts happen only in these windows (or on Restart now); installs don't wait for
        them.
      </p>
      <label class="upd-field">
        Machine
        <select
          onChange={(e) => {
            const id = (e.target as HTMLSelectElement).value;
            const m = machines.find((x) => x.id === id);
            set({ machine: id, drainCapMinutes: m?.drainCapMinutes ?? draft.drainCapMinutes });
          }}
        >
          {machines.map((m) => (
            <option key={m.id} value={m.id} selected={m.id === draft.machine}>{m.id}</option>
          ))}
        </select>
      </label>
      <fieldset class="upd-days">
        <legend>Days</legend>
        {WEEK.map((name, d) => (
          <label key={name} class="set-check">
            <input
              type="checkbox"
              checked={draft.days.includes(d)}
              aria-label={name}
              onChange={(e) => toggleDay(d, (e.target as HTMLInputElement).checked)}
            />
            <span>{name}</span>
          </label>
        ))}
      </fieldset>
      <label class="upd-field">
        Starts at ({zoneName(view.tz, view.now)})
        <input
          type="time"
          value={draft.start}
          onChange={(e) => set({ start: (e.target as HTMLInputElement).value })}
        />
      </label>
      <label class="upd-field">
        Window (minutes)
        <input
          type="number"
          min={30}
          max={1440}
          step={15}
          value={draft.windowMinutes}
          onChange={(e) => set({ windowMinutes: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
      <label class="upd-field">
        Drain cap (minutes)
        <input
          type="number"
          min={5}
          max={720}
          step={5}
          value={draft.drainCapMinutes}
          onChange={(e) => set({ drainCapMinutes: Number((e.target as HTMLInputElement).value) })}
        />
      </label>
      {errors.length
        ? (
          <ul class="set-errors" role="alert">
            {errors.map((e) => <li key={e}>{e}</li>)}
          </ul>
        )
        : null}
      <button type="button" class="btn btn-primary" disabled={errors.length > 0} onClick={save}>
        Save window…
      </button>
    </form>
  );
}

function RequestRow(
  props: {
    r: UpdateRequest;
    m: UpdatesMachineView | undefined;
    view: UpdatesView;
    busy: boolean;
    onApprove: (ack: boolean) => void;
    onDeny: () => void;
  },
) {
  const { r, m, view, busy } = props;
  const [ack, setAck] = useState(false);
  const server = m?.kind === "server";
  return (
    <li class="upd-request">
      <span class="upd-run-machine">{r.machine}</span>
      <span class="muted">
        {r.mode} · {ageText(view.now - r.at)} ago
      </span>
      <q class="upd-reason">{r.reason}</q>
      {server
        ? (
          <label class="set-check upd-ack">
            <input
              type="checkbox"
              checked={ack}
              onChange={(e) => setAck((e.target as HTMLInputElement).checked)}
            />
            <span>I accept that {r.machine}'s services go down for a few minutes</span>
          </label>
        )
        : null}
      <button
        type="button"
        class="btn"
        disabled={busy || !view.engine.ok || view.run !== null || (server && !ack)}
        onClick={() => props.onApprove(ack)}
      >
        Approve…
      </button>
      <button type="button" class="btn" disabled={busy} onClick={props.onDeny}>
        Deny
      </button>
    </li>
  );
}

/** The panel. */
export function UpdatesPanel(props: UpdatesPanelProps) {
  const { view, api } = props;
  const [pick, setPick] = useState<string | null>(props.selected ?? null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => {
    if (props.selected) setPick(props.selected);
  }, [props.selected]);
  if (!view) return <p class="muted" aria-busy="true">Loading the update status…</p>;
  if (!view.configured) {
    return (
      <p class="muted">
        Machine updates aren't set up (the settings' <code>integrations.updates</code>).
      </p>
    );
  }
  const act = (fn: () => Promise<UpdatesResult>) => {
    setBusy(true);
    setMessage(null);
    void fn().then((r) => {
      if (!(!r.ok && r.cancelled)) {
        const errs = !r.ok && r.errors?.length ? ` ${r.errors.join("; ")}` : "";
        setMessage({ ok: r.ok, text: r.message + errs });
      }
    }, (err: unknown) => {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }).finally(() => setBusy(false));
  };
  const selected = view.machines.find((m) => m.id === pick) ?? view.machines[0] ?? null;
  const run = view.run;
  const machineOf = (id: string) => view.machines.find((m) => m.id === id);
  return (
    <div class="updates">
      {!view.engine.ok ? <p class="muted small upd-engine">{view.engine.reason}</p> : null}
      {run
        ? (
          <section class="upd-inflight" role="status" aria-live="polite" aria-label="Run in flight">
            <strong>
              {(run.action ?? "install") === "restart" ? "Restarting" : "Updating"} {run.machine}
            </strong>
            : {stepText(run.step)}{" "}
            <span class="muted">(since {ageText(view.now - run.stepAt)})</span>
            {run.cancellable
              ? (
                <button
                  type="button"
                  class="btn"
                  disabled={busy}
                  onClick={() => act(() => api.cancel(run.id))}
                >
                  Cancel update
                </button>
              )
              : <span class="muted small">(past the final check: it can't be cancelled)</span>}
          </section>
        )
        : null}
      {message
        ? (
          <p class={message.ok ? "set-status" : "m-error"} role="status" aria-live="polite">
            {message.text}
          </p>
        )
        : null}
      {view.requests.length
        ? (
          <section class="upd-requests" aria-label="Requests awaiting approval">
            <h3 class="upd-h">Asked by an agent</h3>
            <ul>
              {view.requests.map((r) => (
                <RequestRow
                  key={r.id}
                  r={r}
                  m={machineOf(r.machine)}
                  view={view}
                  busy={busy}
                  onApprove={(ack) => {
                    setPick(r.machine);
                    act(() => api.approve({ id: r.id, acknowledgeOutage: ack }));
                  }}
                  onDeny={() => act(() => api.deny(r.id))}
                />
              ))}
            </ul>
          </section>
        )
        : null}
      <div class="upd-layout">
        <nav class="upd-list" aria-label="Machines">
          {view.machines.map((m) => (
            <button
              key={m.id}
              type="button"
              class={`upd-pick${selected?.id === m.id ? " is-on" : ""}`}
              aria-pressed={selected?.id === m.id}
              onClick={() => setPick(m.id)}
            >
              <span class="upd-pick-name">{m.id}</span>
              <span class={LEVEL_CHIP[m.level]}>{m.chip.text}</span>
            </button>
          ))}
        </nav>
        {selected
          ? (
            <Machine
              key={selected.id}
              m={selected}
              view={view}
              api={api}
              act={act}
              busy={busy}
            />
          )
          : null}
      </div>
      <section class="upd-schedules" aria-label="Restart windows">
        <h3 class="upd-h">Restart windows</h3>
        {view.schedules.length === 0
          ? <p class="muted small">No restart window yet: pending restarts wait for Restart now.</p>
          : (
            <ul>
              {view.schedules.map((s) => (
                <li key={s.id} class="upd-schedule">
                  <span class="upd-run-machine">{s.machine}</span>
                  <span>
                    {daysText(s.days)} {s.start} {zoneName(view.tz, view.now)}, {s.windowMinutes}
                    {" "}
                    min
                  </span>
                  <span class="muted">
                    {s.enabled
                      ? s.next !== null ? `next ${clockText(s.next, view.tz)}` : "no window soon"
                      : "off"}
                  </span>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => act(() => api.setScheduleEnabled(s.id, !s.enabled))}
                  >
                    {s.enabled ? "Turn off" : "Turn on…"}
                  </button>
                  <button
                    type="button"
                    class="btn"
                    disabled={busy}
                    onClick={() => act(() => api.deleteSchedule(s.id))}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
        <ScheduleForm view={view} api={api} act={act} />
      </section>
      <section class="upd-history" aria-label="Run history">
        <h3 class="upd-h">History</h3>
        <Runs runs={view.history} tz={view.tz} showMachine />
      </section>
    </div>
  );
}
