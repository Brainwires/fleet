// Our self-hosted runner pools, as ops/runners/runners.conf defines them: the short pool name the
// cards show, the runs-on label a job carries (the key DENEXT_POOL_HEALTH uses), the runner-name
// prefix the launcher registers, and the slot count when the health variable doesn't say.

/** One self-hosted pool. */
export interface PoolDef {
  /** The short name (`mac-arm`): the card's title, and `alerts[].pool` in the health variable. */
  readonly id: string;
  /** The runs-on label (`denext-macos-arm64`). */
  readonly label: string;
  /** The runner-name prefix (`denext-mac-arm-`), for a running job whose labels say nothing. */
  readonly runnerPrefix: string;
  /** The slot count when the health variable is missing. */
  readonly slots: number;
}

/** The pools, in card order. */
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
];

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

/** The pool a runs-on label names, by label. */
const BY_LABEL = new Map(POOLS.map((p) => [p.label, p]));

/** The pool for a runs-on label, or `undefined` for a label that isn't one of ours. */
export function poolByLabel(label: string): PoolDef | undefined {
  return BY_LABEL.get(label);
}

/** The short name for a pool label (`denext-macos-arm64` → `mac-arm`); an unknown label as is. */
export function poolIdOfLabel(label: string): string {
  return BY_LABEL.get(label)?.id ?? label;
}

/**
 * The pool a set of runs-on labels targets: the first `denext-*` label (known pools first), or
 * `null` when none is ours.
 */
export function poolFromLabels(labels: readonly string[]): string | null {
  for (const label of labels) {
    const known = BY_LABEL.get(label);
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
  let best: PoolDef | undefined;
  for (const p of POOLS) {
    if (
      name.startsWith(p.runnerPrefix) && (!best || p.runnerPrefix.length > best.runnerPrefix.length)
    ) {
      best = p;
    }
  }
  return best?.id ?? null;
}
