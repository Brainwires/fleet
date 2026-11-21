// The runner scheduler's pools as machine updates see them, pure: the pause `pause-pool.sh --status`
// prints, whether a run's kept hold is still in force, and the peer facts the exclusivity rule reads
// from Fleet's pool cards. The status output is the scheduler's own text (it carries the pause
// file's line, written by `pause-pool.sh`): every field taken from it is checked and clamped.

import { holdReason } from "../controls.ts";
import type { PoolCard } from "../model.ts";
import { clampText, epochSecondsToMs, MAX_REASON_LEN, outputLines } from "./model.ts";
import type { MachineStatus, PeerFacts, PoolPause, UpdatesConfig } from "./model.ts";

/** `pool <id> is PAUSED (N s left): <the pause file's line>`. */
const PAUSED = /\bis PAUSED\b[^:]*:\s*(.*)$/;
/** The pause file's expiry, `expires=<epoch s>`. */
const EXPIRES = /\bexpires=(\d{9,11})\b/;
/** A Fleet hold's reason inside the line (`fleet-update:<runId>`). */
const HOLD = /\bfleet-update:[A-Za-z0-9][A-Za-z0-9-]{0,79}\b/;

/**
 * The pause in force from `pause-pool.sh --status <pool>` output, or `null` (not paused, or its
 * pause expired: the script calls an expired pause void). The reason is the Fleet hold's
 * `fleet-update:<runId>` when the line carries one, else the line itself, clamped.
 */
export function parsePauseStatus(text: unknown): PoolPause | null {
  for (const line of outputLines(text)) {
    const m = PAUSED.exec(line);
    if (!m) continue;
    const rest = m[1];
    const exp = EXPIRES.exec(rest);
    const until = exp ? epochSecondsToMs(Number(exp[1])) : null;
    const hold = HOLD.exec(rest);
    return { reason: hold ? hold[0] : clampText(rest, MAX_REASON_LEN), until };
  }
  return null;
}

/** Whether `pause` is the hold run `runId` took (and it hasn't expired at `now`). */
export function heldByRun(pause: PoolPause | null, runId: string, now: number): boolean {
  if (!pause || pause.reason !== holdReason(runId)) return false;
  return pause.until === null || pause.until > now;
}

/** A pool card's facts for the orchestrator: running jobs and health. */
export function cardFacts(card: PoolCard): { jobs: number; healthy: boolean } {
  return { jobs: Math.max(card.busy, card.running), healthy: card.state !== "unhealthy" };
}

/**
 * The rest of the fleet for the exclusivity rule: each self-hosted pool card's runs-on label,
 * health and whether it is paused (held), and the configured machines whose last check failed.
 * GitHub-hosted cards (no label) are left out.
 */
export function peerFacts(
  cards: readonly PoolCard[],
  config: UpdatesConfig,
  statuses: Readonly<Record<string, MachineStatus>>,
): PeerFacts {
  const pools: Record<string, { label: string; healthy: boolean; held: boolean }> = {};
  for (const c of cards) {
    if (!c.label) continue;
    pools[c.id] = {
      label: c.label,
      healthy: c.state !== "unhealthy",
      held: c.state === "paused" || c.start?.state === "paused",
    };
  }
  const unreachable = config.machines
    .filter((m) => !m.self && statuses[m.id]?.error)
    .map((m) => m.id);
  return { pools, unreachable };
}
