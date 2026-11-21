// The OS dialogs (denext's `host.confirm`) before a machine update or restart starts, or a restart
// window is saved. Pure: they name the machine, what installs, whether it may reboot, the pools held and
// the runs-on labels left without a host meanwhile, the drain cap, and that running jobs are never
// stopped. The safe answer, "Don't", is the first button, the default and what Escape picks.
//
// A `server` (a service host with no CI) gets the outage warning in the message itself, and its
// confirm button says so; the page also asks for an explicit acknowledgement before it sends the
// request (lib/updates/backend.ts refuses a server run without it).

import type { ConfirmFn } from "../control-runner.ts";
import { localParts } from "./schedule.ts";
import type { RebootPolicy, UpdateMode, UpdateSchedule, UpdatesMachine } from "./model.ts";

/** The dialog's options (the shape `host.confirm` takes). */
export type ConfirmOptions = Parameters<ConfirmFn>[0];

/** Index of "Don't" in every dialog here: the default and the cancel answer. */
export const DONT = 0;

/** What the update dialog shows. */
export interface UpdateDialogInput {
  readonly machine: UpdatesMachine;
  readonly mode: UpdateMode;
  readonly reboot: RebootPolicy;
  readonly drainCapMinutes: number;
  /** Pending updates (total and security), when known. */
  readonly pending: { readonly total: number; readonly security: number } | null;
  /** The machine's runs-on labels. */
  readonly labels: readonly string[];
  /** Labels no other pool serves: their jobs wait or overflow during the run. */
  readonly soleLabels: readonly string[];
  /** An approved agent request: its reason (untrusted text). */
  readonly request?: { readonly id: string; readonly reason: string } | null;
  /** Test builds: nothing will run, whatever is pressed. */
  readonly dryRun?: boolean;
}

/** The outage warning for a server, one sentence. */
export function outageText(m: UpdatesMachine): string {
  return `${m.id} is a server: its services (mail, file shares or whatever it runs) will be ` +
    "unavailable for a few minutes while it installs and restarts; clients reconnect afterwards.";
}

/** What installs, in words. */
export function modeText(
  mode: UpdateMode,
  pending: { total: number; security: number } | null,
): string {
  if (mode === "security") {
    return pending
      ? `Installs security updates only (${pending.security} of ${pending.total} pending).`
      : "Installs security updates only.";
  }
  return pending
    ? `Installs every pending update (${pending.total}).`
    : "Installs every pending update.";
}

/** The reboot policy of an install, in words (a restart only ever happens when one is needed). */
export function rebootText(r: RebootPolicy): string {
  return r === "never"
    ? "Doesn't restart: a restart an update needs waits for the next restart window (or Restart now)."
    : "Restarts the machine afterwards only if an update needs it.";
}

/** The update-now dialog (also the approval of an agent's request). */
export function updateDialog(i: UpdateDialogInput): ConfirmOptions {
  const m = i.machine;
  const server = m.kind === "server";
  const lines: string[] = [
    modeText(i.mode, i.pending),
    rebootText(i.reboot),
  ];
  if (m.pools.length > 0) {
    lines.push(
      `Holds pools ${m.pools.join(", ")}: no new job starts there until the update is done.`,
    );
    if (i.labels.length) lines.push(`Runs-on labels served here: ${i.labels.join(", ")}.`);
    if (i.soleLabels.length) {
      lines.push(
        `No other machine serves ${
          i.soleLabels.join(", ")
        }: those jobs wait or overflow meanwhile.`,
      );
    }
    lines.push(
      `Waits up to ${i.drainCapMinutes} min for running jobs to finish (the drain cap); ` +
        "running jobs are never stopped.",
    );
  } else {
    lines.push("No runner pools to hold.");
  }
  if (i.request) lines.push(`Asked by an agent (request ${i.request.id}): “${i.request.reason}”`);
  if (i.dryRun) lines.push("Dry run (test build): nothing will run, whichever button you press.");
  const what = i.request ? "Approve the agent's request and update" : "Update";
  return {
    title: "Fleet",
    message: server ? `${what} ${m.id} now? ${outageText(m)}` : `${what} ${m.id} now?`,
    detail: lines.join("\n\n"),
    buttons: ["Don't", server ? "Update, accept the outage" : `Update ${m.id}`],
    defaultId: DONT,
    cancelId: DONT,
    kind: "warning",
  };
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** A schedule's days in words ("Mon, Wed" / "every day"). */
export function daysText(days: readonly number[]): string {
  if (days.length === 7) return "every day";
  return [...days].sort().map((d) => DAY_NAMES[d] ?? "?").join(", ");
}

/** The zone's short name at `t` ("CST"), else the zone id. */
export function zoneName(tz: string, t: number): string {
  try {
    const p = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" })
      .formatToParts(new Date(t)).find((x) => x.type === "timeZoneName");
    return p?.value ?? tz;
  } catch {
    return tz;
  }
}

/** The dialog before a restart window is saved (or turned back on): it is then pre-approved. */
export function scheduleDialog(
  s: UpdateSchedule,
  m: UpdatesMachine,
  tz: string,
  now: number,
  dryRun = false,
): ConfirmOptions {
  const lines = [
    `Every ${daysText(s.days)} at ${s.start} ${
      zoneName(tz, now)
    }, a ${s.windowMinutes}-minute window.`,
    "Restarts the machine in the window only when a restart is pending (an installed update " +
    "needs one); nothing installs in it, and a window with no restart pending is skipped.",
    m.pools.length > 0
      ? `Holds pools ${m.pools.join(", ")} and waits up to ${s.drainCapMinutes} min for running ` +
        "jobs (never stopped); still busy then, the window is skipped."
      : "No runner pools to hold.",
    "Fleet restarts it unattended in each window from now on, without asking again; it " +
    "notifies 10 minutes before.",
  ];
  if (m.kind === "server") lines.unshift(outageText(m));
  if (dryRun) lines.push("Dry run (test build): nothing will run, whichever button you press.");
  return {
    title: "Fleet",
    message: `Save the restart window for ${m.id}?`,
    detail: lines.join("\n\n"),
    buttons: ["Don't", "Save window"],
    defaultId: DONT,
    cancelId: DONT,
    kind: "warning",
  };
}

/** What the restart dialog shows. */
export interface RestartDialogInput {
  readonly machine: UpdatesMachine;
  readonly drainCapMinutes: number;
  /** Packages that asked for the restart (host text, untrusted). */
  readonly packages: readonly string[];
  readonly labels: readonly string[];
  readonly soleLabels: readonly string[];
  readonly dryRun?: boolean;
}

/** The Restart now dialog (a restart that is pending: nothing installs). */
export function restartDialog(i: RestartDialogInput): ConfirmOptions {
  const m = i.machine;
  const lines = [
    i.packages.length
      ? `A restart is pending (asked for by ${i.packages.slice(0, 10).join(", ")}).`
      : "A restart is pending.",
    "Nothing installs; Fleet restarts the machine, waits for it to come back and verifies it.",
  ];
  if (m.pools.length > 0) {
    lines.push(`Holds pools ${m.pools.join(", ")}: no new job starts there until it is back.`);
    if (i.labels.length) lines.push(`Runs-on labels served here: ${i.labels.join(", ")}.`);
    if (i.soleLabels.length) {
      lines.push(
        `No other machine serves ${
          i.soleLabels.join(", ")
        }: those jobs wait or overflow meanwhile.`,
      );
    }
    lines.push(
      `Waits up to ${i.drainCapMinutes} min for running jobs to finish (the drain cap); ` +
        "running jobs are never stopped.",
    );
  }
  if (i.dryRun) lines.push("Dry run (test build): nothing will run, whichever button you press.");
  return {
    title: "Fleet",
    message: m.kind === "server" ? `Restart ${m.id} now? ${outageText(m)}` : `Restart ${m.id} now?`,
    detail: lines.join("\n\n"),
    buttons: ["Don't", m.kind === "server" ? "Restart, accept the outage" : `Restart ${m.id}`],
    defaultId: DONT,
    cancelId: DONT,
    kind: "warning",
  };
}

/** The local wall clock of `t` as `HH:MM` in `tz` (the schedule list's next run). */
export function clockText(t: number, tz: string): string {
  const p = localParts(t, tz);
  return `${DAY_NAMES[p.weekday]} ${String(p.hour).padStart(2, "0")}:${
    String(p.minute).padStart(2, "0")
  }`;
}
