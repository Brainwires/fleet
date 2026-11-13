// The self-hosted runner pools: the short name a card shows, the runs-on label(s) a job targets it
// with, the runner-name prefix its runners register with (when they have one), and the slot count.
// The list follows the live data, rebuilt on every poll:
// - with the pool-health variable configured (settings `pools.healthVariable`), from its per-pool
//   `hosts` (or its labels plus the runners) — `derivePools`;
// - else grouped from the owners' self-hosted runners by their custom labels — `groupRunners`.
// The seed list (the runner scheduler integration's declared pools; none by default) is only the
// first render's, before any data arrives. Several pools may share a label: a job's label then
// names the FIRST of them.

import type { GhRunner } from "./github-types.ts";
import type { PoolHealthDoc } from "./health.ts";
import { onSettingsApplied, type RunnerHostRule, settings } from "./settings.ts";

export type { RunnerHostRule } from "./settings.ts";

/** One self-hosted pool. */
export interface PoolDef {
  /** The short name: the card's title, and `alerts[].pool` in the health variable. */
  readonly id: string;
  /** The runs-on label (the first of `labels` for a grouped pool). */
  readonly label: string;
  /** Every label a job must carry to target it (a grouped pool's custom labels); `[label]` else. */
  readonly labels?: readonly string[];
  /** The runner-name prefix, for a running job whose labels say nothing (`""`: none). */
  readonly runnerPrefix: string;
  /** The pool's own slot count (`null`: unknown). */
  readonly slots: number | null;
}

/** The seed pools (the runner scheduler integration's declared ones), in card order. */
export function seedPools(): PoolDef[] {
  const sched = settings().integrations.runnerScheduler;
  if (!sched) return [];
  return sched.pools.map((p) => ({
    id: p.id,
    label: p.label,
    runnerPrefix: p.runnerPrefix ??
      (sched.runnerNamePrefix ? `${sched.runnerNamePrefix}${p.id}-` : ""),
    slots: p.slots ?? null,
  }));
}

/** The runner-host workflows (settings `runnerHosts`). */
export function runnerHosts(): readonly RunnerHostRule[] {
  return settings().runnerHosts;
}

/** The rule for a run's repo and workflow name, or `undefined` when it isn't a runner host. */
export function runnerHostRule(repo: string, workflow: string): RunnerHostRule | undefined {
  const lower = repo.toLowerCase();
  return runnerHosts().find((r) => r.repo.toLowerCase() === lower && r.workflow === workflow);
}

/** The slot number in a matrix job name (`helper (1)` → `1`), or `null`. */
export function hostSlot(jobName: string): string | null {
  return /\((\d+)\)\s*$/.exec(jobName)?.[1] ?? null;
}

/** The rule whose runner prefix a runner name carries, or `undefined`. */
export function hostRuleOfRunner(name: string): RunnerHostRule | undefined {
  return runnerHosts().find((r) => name.startsWith(r.runnerPrefix));
}

/** The runner of rule `rule` for `slot`, true when `name` is `<prefix><slot>-…`. */
export function runnerIsSlot(name: string, rule: RunnerHostRule, slot: string): boolean {
  return name.startsWith(`${rule.runnerPrefix}${slot}-`);
}

/** The pseudo-pool for GitHub-hosted runners. */
export const GITHUB_POOL = "github";

/** The repos always polled, in lane order (settings `repos.pinned`). */
export function pinnedRepos(): readonly string[] {
  return settings().repos.pinned;
}

let current: readonly PoolDef[] = seedPools();
/** The FIRST pool per label (a job's label can't say which host of a shared label takes it). */
let byLabel = firstByLabel(current);
/** The registered self-hosted runners' names → their pool (from the last runner list). */
let runnerIndex = new Map<string, string>();

const lc = (s: string) => s.toLowerCase();

function firstByLabel(defs: readonly PoolDef[]): Map<string, PoolDef> {
  const m = new Map<string, PoolDef>();
  for (const d of defs) if (!m.has(lc(d.label))) m.set(lc(d.label), d);
  return m;
}

/** The current pool list, in card order. */
export function currentPools(): readonly PoolDef[] {
  return current;
}

/** Replace the pool list (from `derivePools` / `groupRunners`); every lookup below follows it. */
export function setPools(defs: readonly PoolDef[]): void {
  current = defs;
  byLabel = firstByLabel(defs);
}

// New settings: back to their seed list until the next poll derives the live one.
onSettingsApplied(() => {
  setPools(seedPools());
  runnerIndex = new Map();
});

/** Whether another pool shares this pool's label. */
export function labelIsShared(label: string, defs: readonly PoolDef[] = current): boolean {
  return defs.filter((d) => lc(d.label) === lc(label)).length > 1;
}

/** The runner scheduler's naming prefix (`""`: none). */
function namePrefix(): string {
  return settings().integrations.runnerScheduler?.runnerNamePrefix ?? "";
}

/** A scheduler runner name (`<prefix><pool>-<slot>-<epoch>`) → its pool name, or `null`. */
export function poolNameOfRunner(name: string): string | null {
  const prefix = namePrefix();
  if (!prefix || !name.startsWith(prefix)) return null;
  return /^(.+)-\d+-\d+$/.exec(name.slice(prefix.length))?.[1] ?? null;
}

/** GitHub's own runner labels (every self-hosted runner gets them): not a pool's identity. */
const DEFAULT_RUNNER_LABELS = new Set([
  "self-hosted",
  "linux",
  "windows",
  "macos",
  "x64",
  "x86",
  "arm",
  "arm64",
]);

/** A runner's identifying labels: its custom ones, else its OS / architecture ones. */
function runnerLabels(r: GhRunner): string[] {
  const all = r.labels ?? [];
  const custom = all
    .filter((l) =>
      l.type === "custom" || (l.type === undefined && !DEFAULT_RUNNER_LABELS.has(lc(l.name)))
    )
    .map((l) => l.name);
  if (custom.length) return [...new Set(custom)].sort((a, b) => lc(a).localeCompare(lc(b)));
  return all.map((l) => l.name).filter((n) => lc(n) !== "self-hosted");
}

/**
 * Pools grouped from the owners' self-hosted runners: one per distinct set of custom labels (a
 * runner with none goes by its OS / architecture labels), named by its labels (`gpu+linux`), its
 * slots the runners registered. `null` without a runner list (no access, or none read yet).
 */
export function groupRunners(runners: readonly GhRunner[] | null): PoolDef[] | null {
  if (!runners) return null;
  const groups = new Map<string, { labels: string[]; count: number }>();
  for (const r of runners) {
    const labels = runnerLabels(r);
    const id = labels.length ? labels.join("+") : "self-hosted";
    const g = groups.get(id) ?? { labels: labels.length ? labels : ["self-hosted"], count: 0 };
    g.count++;
    groups.set(id, g);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, g]) => ({
      id,
      label: g.labels[0],
      labels: g.labels,
      runnerPrefix: "",
      slots: g.count,
    }));
}

/**
 * The runner index: each registered runner's name → its pool in `defs` (the grouped pool of its
 * labels, else its scheduler name, else a pool whose labels it carries).
 */
export function indexRunners(
  runners: readonly GhRunner[] | null,
  defs: readonly PoolDef[] = current,
): void {
  const m = new Map<string, string>();
  for (const r of runners ?? []) {
    const labels = runnerLabels(r);
    const grouped = defs.find((d) => d.labels && d.labels.join("+") === labels.join("+"));
    const named = poolNameOfRunner(r.name);
    const id = grouped?.id ??
      (named && defs.some((d) => d.id === named) ? named : null) ??
      poolOfLabels((r.labels ?? []).map((l) => l.name), defs)?.id ?? named;
    if (id) m.set(r.name, id);
  }
  runnerIndex = m;
}

/**
 * The pool list from the health variable, or `null` when there is none yet (keep the current list):
 * 1. its per-pool `hosts` (the local health file merged in, or the variable's), in its order;
 * 2. else per label of its `pools`: the pools its registered runners' names show, plus the seed
 *    pools on that label, else one pool named for the label.
 */
export function derivePools(
  doc: PoolHealthDoc | null,
  runners: readonly GhRunner[] | null,
): PoolDef[] | null {
  if (!doc) return null;
  const seed = seedPools();
  const known = new Map(seed.map((p) => [p.id, p]));
  const prefix = namePrefix();
  const prefixOf = (id: string) => known.get(id)?.runnerPrefix ?? (prefix ? `${prefix}${id}-` : "");
  const hosts = Object.entries(doc.hosts ?? {});
  if (hosts.length > 0) {
    const out: PoolDef[] = [];
    for (const [id, h] of hosts) {
      const label = h.label ?? known.get(id)?.label;
      if (!label) continue;
      out.push({
        id,
        label,
        runnerPrefix: h.runnerPrefix ?? prefixOf(id),
        slots: h.slots ?? known.get(id)?.slots ?? null,
      });
    }
    return out;
  }
  const labels = Object.keys(doc.pools);
  if (labels.length === 0) return null;
  const order = (label: string) => {
    const i = seed.findIndex((p) => p.label === label);
    return i < 0 ? seed.length : i;
  };
  labels.sort((a, b) => order(a) - order(b) || a.localeCompare(b));
  const out: PoolDef[] = [];
  for (const label of labels) {
    const ids: string[] = seed.filter((p) => p.label === label).map((p) => p.id);
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
        runnerPrefix: prefixOf(id),
        slots: ids.length === 1
          ? merged.slots ?? known.get(id)?.slots ?? null
          : known.get(id)?.slots ?? null,
      });
    }
  }
  return out;
}

/** The pool for a runs-on label, or `undefined` for a label that isn't a pool's. */
export function poolByLabel(label: string): PoolDef | undefined {
  return byLabel.get(lc(label));
}

/** The short name for a pool label; an unknown label as is. */
export function poolIdOfLabel(label: string): string {
  return byLabel.get(lc(label))?.id ?? label;
}

/** The pool in `defs` whose labels a job's labels all include (the most specific first). */
function poolOfLabels(labels: readonly string[], defs: readonly PoolDef[]): PoolDef | undefined {
  const have = new Set(labels.map(lc));
  let best: PoolDef | undefined;
  for (const d of defs) {
    const need = d.labels ?? [d.label];
    if (!need.every((l) => have.has(lc(l)))) continue;
    if (!best || need.length > (best.labels ?? [best.label]).length) best = d;
  }
  return best;
}

/**
 * The pool a set of runs-on labels targets: a pool whose labels the job carries (for a single-label
 * pool, the first such label in the job's order wins), else the first label with the scheduler's
 * label prefix, else `null`.
 */
export function poolFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const known = byLabel.get(lc(label));
    if (known && (known.labels ?? [known.label]).length <= 1) return known.id;
  }
  const multi = poolOfLabels(labels, current.filter((d) => (d.labels?.length ?? 1) > 1));
  if (multi) return multi.id;
  const prefix = settings().integrations.runnerScheduler?.labelPrefix ?? "";
  return (prefix && labels.find((l) => l.startsWith(prefix))) || null;
}

/** Whether a runs-on label belongs to a pool (or carries the scheduler's label prefix). */
export function isPoolLabel(label: string): boolean {
  if (byLabel.has(lc(label))) return true;
  if (current.some((d) => d.labels?.some((l) => lc(l) === lc(label)))) return true;
  const prefix = settings().integrations.runnerScheduler?.labelPrefix ?? "";
  return prefix !== "" && label.startsWith(prefix);
}

/**
 * The pool a runner name belongs to: a runner-host rule's pool, the runner list's, else the longest
 * matching pool prefix; `null` when none.
 */
export function poolFromRunnerName(name: string): string | null {
  const host = hostRuleOfRunner(name);
  if (host) return host.pool;
  const indexed = runnerIndex.get(name);
  if (indexed) return indexed;
  let best: PoolDef | undefined;
  for (const p of current) {
    if (
      p.runnerPrefix && name.startsWith(p.runnerPrefix) &&
      (!best || p.runnerPrefix.length > best.runnerPrefix.length)
    ) {
      best = p;
    }
  }
  return best?.id ?? null;
}

/** Whether a runner name is one of the owners' self-hosted runners (or a runner host's). */
export function isSelfHostedRunner(name: string): boolean {
  if (!name) return false;
  if (hostRuleOfRunner(name) || runnerIndex.has(name)) return true;
  const prefix = namePrefix();
  if (prefix && name.startsWith(prefix)) return true;
  return current.some((p) => p.runnerPrefix && name.startsWith(p.runnerPrefix));
}
