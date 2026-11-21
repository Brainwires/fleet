// Which machines may never update together. Pure.
//
// - One run fleet-wide at a time (the lock is `update-run.json`).
// - Beyond that, a machine with pools is refused while another configured machine sharing a pool
//   id or runs-on label is held, unhealthy or unreachable, and while its labels' other pools have
//   no healthy, unheld one left: a label never loses its last healthy host to an update. A label
//   this machine alone serves is named (the dialog says its jobs wait or overflow).
// - A machine with no pools (a `server`) is bound only by the one-run lock.

import type { PeerFacts, RunRecord, UpdatesConfig, UpdatesMachine } from "./model.ts";

/** The verdict. */
export type ExclusiveVerdict =
  | {
    readonly ok: true;
    /** The machine's runs-on labels. */
    readonly labels: readonly string[];
    /** Labels no other pool serves: their jobs wait or overflow during the run. */
    readonly soleLabels: readonly string[];
  }
  | { readonly ok: false; readonly reason: string };

/** Whether `machine` may start a run now. */
export function checkExclusive(
  machine: UpdatesMachine,
  config: UpdatesConfig,
  facts: PeerFacts,
  activeRun: RunRecord | null,
): ExclusiveVerdict {
  if (activeRun) {
    return {
      ok: false,
      reason: `Another update is in flight (${activeRun.machine}); one runs at a time.`,
    };
  }
  if (machine.pools.length === 0) return { ok: true, labels: [], soleLabels: [] };
  const mine = new Set(machine.pools);
  const labelOf = (p: string) => facts.pools[p]?.label ?? null;
  const labels = [...new Set(machine.pools.map(labelOf).filter((l): l is string => !!l))];
  const unreachable = new Set(facts.unreachable.map((m) => m.toLowerCase()));

  for (const other of config.machines) {
    if (other.id === machine.id) continue;
    const shared = other.pools.some((p) => mine.has(p) || labels.includes(labelOf(p) ?? ""));
    if (!shared) continue;
    if (unreachable.has(other.id.toLowerCase())) {
      return { ok: false, reason: `${other.id} shares a label and is unreachable.` };
    }
    for (const p of other.pools) {
      const f = facts.pools[p];
      if (f?.held) return { ok: false, reason: `${other.id} shares a label and is held (${p}).` };
      if (f && !f.healthy) {
        return { ok: false, reason: `${other.id} shares a label and is unhealthy (${p}).` };
      }
    }
  }

  const soleLabels: string[] = [];
  for (const label of labels) {
    const others = Object.entries(facts.pools).filter(([p, f]) =>
      !mine.has(p) && f.label === label
    );
    if (others.length === 0) soleLabels.push(label);
    else if (!others.some(([, f]) => f.healthy && !f.held)) {
      return {
        ok: false,
        reason:
          `${machine.id} is the last healthy host for ${label}; an update would leave it none.`,
      };
    }
  }
  return { ok: true, labels, soleLabels };
}
