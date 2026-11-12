// Our self-hosted runner pools: the short pool name the cards show, the runs-on label a job carries
// (the key DENEXT_POOL_HEALTH's `pools` uses), the runner-name prefix the scheduler registers
// (`denext-<pool>-<slot>-<epoch>`), and the slot count. The list is rebuilt from live data on every
// poll (`derivePools` → `setPools`): the watchdog's per-pool `hosts` (the Mac mini's health.json or
// the variable), else the variable's labels plus the org's runners. POOLS, the static list, is only
// the first render's, before any data arrives. Several pools may share a label (win-x64 and
// win-x64-brain on denext-windows-x64): a job's label then names the FIRST of them.

import type { GhRunner } from "./github-types.ts";
import type { PoolHealthDoc } from "./health.ts";

/** One self-hosted pool. */
export interface PoolDef {
  /** The short name (`mac-arm`): the card's title, and `alerts[].pool` in the health variable. */
  readonly id: string;
  /** The runs-on label (`denext-macos-arm64`). */
  readonly label: string;
  /** The runner-name prefix (`denext-mac-arm-`), for a running job whose labels say nothing. */
  readonly runnerPrefix: string;
  /** The pool's own slot count (`null`: unknown). */
  readonly slots: number | null;
}

/** The static pools, in card order: the list before any live data arrives. */
export const POOLS: readonly PoolDef[] = [
  { id: "mac-arm", label: "denext-macos-arm64", runnerPrefix: "denext-mac-arm-", slots: 2 },
  { id: "mac-x64", label: "denext-macos-x64", runnerPrefix: "denext-mac-x64-", slots: 1 },
  { id: "linux-x64", label: "denext-linux-x64", runnerPrefix: "denext-linux-x64-", slots: 3 },
  {
    id: "linux-x64-2204",
    label: "denext-linux-x64-2204",
    runnerPrefix: "denext-linux-x64-2204-",
    slots: 3,
  },
  {
    id: "linux-x64-docker",
    label: "denext-linux-x64-docker",
    runnerPrefix: "denext-linux-x64-docker-",
    slots: 1,
  },
  { id: "win-arm64", label: "denext-windows-arm64", runnerPrefix: "denext-win-arm64-", slots: 2 },
  { id: "win-x64", label: "denext-windows-x64", runnerPrefix: "denext-win-x64-", slots: 1 },
  {
    id: "win-x64-brain",
    label: "denext-windows-x64",
    runnerPrefix: "denext-win-x64-brain-",
    slots: 1,
  },
];

/**
 * A workflow whose GitHub-hosted job only hosts a self-hosted runner for a while ("runner host"):
 * long-lived by design, so it never warns (no STALLED, over usual). Its real work shows up as
 * another job whose runner name starts with `runnerPrefix` + the slot. Add a rule here to teach
 * Fleet another such workflow (documented in the README).
 */
export interface RunnerHostRule {
  readonly repo: string;
  readonly workflow: string;
  /** The runner-name prefix it registers (`gh-intel-helper-`, then `<slot>-<ts>`). */
  readonly runnerPrefix: string;
  /** The pool its runners serve. */
  readonly pool: string;
}

/** The runner-host workflows. */
export const RUNNER_HOSTS: readonly RunnerHostRule[] = [
  {
    repo: "Brainwires/deno",
    workflow: "intel helper",
    runnerPrefix: "gh-intel-helper-",
    pool: "mac-x64",
  },
];

/** The rule for a run's repo and workflow name, or `undefined` when it isn't a runner host. */
export function runnerHostRule(repo: string, workflow: string): RunnerHostRule | undefined {
  return RUNNER_HOSTS.find((r) => r.repo === repo && r.workflow === workflow);
}

/** The slot number in a matrix job name (`helper (1)` → `1`), or `null`. */
export function hostSlot(jobName: string): string | null {
  return /\((\d+)\)\s*$/.exec(jobName)?.[1] ?? null;
}

/** The rule whose runner prefix a runner name carries (`gh-intel-helper-1-…`), or `undefined`. */
export function hostRuleOfRunner(name: string): RunnerHostRule | undefined {
  return RUNNER_HOSTS.find((r) => name.startsWith(r.runnerPrefix));
}

/** The runner of rule `rule` for `slot`, true when `name` is `<prefix><slot>-…`. */
export function runnerIsSlot(name: string, rule: RunnerHostRule, slot: string): boolean {
  return name.startsWith(`${rule.runnerPrefix}${slot}-`);
}

/** The pseudo-pool for GitHub-hosted runners. */
export const GITHUB_POOL = "github";

/** The repos always watched, in lane order. */
export const CORE_REPOS: readonly string[] = [
  "Brainwires/deno",
  "Brainwires/denext",
  "Brainwires/laufey",
  "Brainwires/qutty",
];

/** The org. */
export const ORG = "Brainwires";

/** Branches that must stay green. */
export const DEFAULT_BRANCHES: ReadonlySet<string> = new Set([
  "development-denext",
  "development",
  "main",
]);

let current: readonly PoolDef[] = POOLS;
/** The FIRST pool per label (a job's label can't say which host of a shared label takes it). */
let byLabel = firstByLabel(POOLS);

function firstByLabel(defs: readonly PoolDef[]): Map<string, PoolDef> {
  const m = new Map<string, PoolDef>();
  for (const d of defs) if (!m.has(d.label)) m.set(d.label, d);
  return m;
}

/** The current pool list, in card order. */
export function currentPools(): readonly PoolDef[] {
  return current;
}

/** Replace the pool list (from `derivePools`); every lookup below follows it. */
export function setPools(defs: readonly PoolDef[]): void {
  current = defs;
  byLabel = firstByLabel(defs);
}

/** Whether another pool shares this pool's label. */
export function labelIsShared(label: string, defs: readonly PoolDef[] = current): boolean {
  return defs.filter((d) => d.label === label).length > 1;
}

/** A scheduler runner name (`denext-<pool>-<slot>-<epoch>`) → its pool name, or `null`. */
export function poolNameOfRunner(name: string): string | null {
  return /^denext-(.+)-\d+-\d+$/.exec(name)?.[1] ?? null;
}

/**
 * The pool list from live data, or `null` when there is none yet (keep the current list):
 * 1. the watchdog's per-pool `hosts` (the mini's health.json merged in, or the variable's), in
 *    its order: exactly the scheduler's pools;
 * 2. else (an older watchdog) per label of the variable's `pools`: the pools its registered
 *    runners' names show, plus the static pools on that label, else one pool named for the label.
 */
export function derivePools(
  doc: PoolHealthDoc | null,
  runners: readonly GhRunner[] | null,
): PoolDef[] | null {
  if (!doc) return null;
  const known = new Map(POOLS.map((p) => [p.id, p]));
  const hosts = Object.entries(doc.hosts ?? {});
  if (hosts.length > 0) {
    const out: PoolDef[] = [];
    for (const [id, h] of hosts) {
      const label = h.label ?? known.get(id)?.label;
      if (!label) continue;
      out.push({
        id,
        label,
        runnerPrefix: h.runnerPrefix ?? `denext-${id}-`,
        slots: h.slots ?? known.get(id)?.slots ?? null,
      });
    }
    return out;
  }
  const labels = Object.keys(doc.pools);
  if (labels.length === 0) return null;
  const order = (label: string) => {
    const i = POOLS.findIndex((p) => p.label === label);
    return i < 0 ? POOLS.length : i;
  };
  labels.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const out: PoolDef[] = [];
  for (const label of labels) {
    const ids: string[] = POOLS.filter((p) => p.label === label).map((p) => p.id);
    for (const r of runners ?? []) {
      const id = poolNameOfRunner(r.name);
      if (id && !ids.includes(id) && (r.labels ?? []).some((l) => l.name === label)) ids.push(id);
    }
    if (ids.length === 0) ids.push(label);
    const merged = doc.pools[label];
    for (const id of ids) {
      out.push({
        id,
        label,
        runnerPrefix: known.get(id)?.runnerPrefix ?? `denext-${id}-`,
        slots: ids.length === 1
          ? merged.slots ?? known.get(id)?.slots ?? null
          : known.get(id)?.slots ?? null,
      });
    }
  }
  return out;
}

/** The pool for a runs-on label, or `undefined` for a label that isn't one of ours. */
export function poolByLabel(label: string): PoolDef | undefined {
  return byLabel.get(label);
}

/** The short name for a pool label (`denext-macos-arm64` → `mac-arm`); an unknown label as is. */
export function poolIdOfLabel(label: string): string {
  return byLabel.get(label)?.id ?? label;
}

/**
 * The pool a set of runs-on labels targets: the first `denext-*` label (known pools first), or
 * `null` when none is ours.
 */
export function poolFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const known = byLabel.get(label);
    if (known) return known.id;
  }
  const ours = labels.find((l) => l.startsWith("denext-"));
  return ours ?? null;
}

/**
 * The pool a runner name belongs to (`denext-linux-x64-2204-1-…` → `linux-x64-2204`), the longest
 * prefix winning, or `null`.
 */
export function poolFromRunnerName(name: string): string | null {
  const host = hostRuleOfRunner(name);
  if (host) return host.pool;
  let best: PoolDef | undefined;
  for (const p of current) {
    if (
      name.startsWith(p.runnerPrefix) && (!best || p.runnerPrefix.length > best.runnerPrefix.length)
    ) {
      best = p;
    }
  }
  return best?.id ?? null;
}
