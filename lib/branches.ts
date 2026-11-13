// Protected branches: which rule (lib/settings.ts `branches.rules`) a repo's branch matches, and the
// repos' own default branches as the API reports them (the `:default` rule). Pure apart from the
// default-branch registry, which the poller fills from the owners' repo lists.

import {
  type BranchRule,
  DEFAULT_BRANCH_TOKEN,
  type FleetSettings,
  type OtherPolicy,
  settings,
} from "./settings.ts";

const defaults = new Map<string, string>();

/** Remember repos' default branches (`owner/name` → branch), from the owners' repo lists. */
export function rememberDefaultBranches(entries: Iterable<readonly [string, string]>): void {
  for (const [repo, branch] of entries) {
    if (branch) defaults.set(repo.toLowerCase(), branch);
  }
}

/** A repo's default branch, when the API told us. */
export function knownDefaultBranch(repo: string): string | null {
  return defaults.get(repo.toLowerCase()) ?? null;
}

/** Forget them all (tests). */
export function forgetDefaultBranches(): void {
  defaults.clear();
}

/** Whether `branch` matches a rule's pattern (`*` is any run of characters). */
export function branchMatches(pattern: string, branch: string): boolean {
  if (!pattern.includes("*")) return pattern === branch;
  const re = new RegExp(
    `^${pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`,
  );
  return re.test(branch);
}

/**
 * The first rule that protects `branch` of `repo`, or `undefined`. `repoDefault` is the repo's own
 * default branch when the caller knows it (else the registry's).
 */
export function protectingRule(
  repo: string,
  branch: string,
  repoDefault?: string | null,
  s: FleetSettings = settings(),
): BranchRule | undefined {
  if (!branch) return undefined;
  const lower = repo.toLowerCase();
  const def = repoDefault ?? knownDefaultBranch(repo);
  return s.branches.rules.find((r) => {
    if (r.repo && r.repo.toLowerCase() !== lower) return false;
    if (r.branch === DEFAULT_BRANCH_TOKEN) return def !== null && branch === def;
    return branchMatches(r.branch, branch);
  });
}

/** Whether a branch NAME is protected (provenance aside: see classify.ts `runProvenance`). */
export function isProtectedName(
  repo: string,
  branch: string,
  repoDefault?: string | null,
  s: FleetSettings = settings(),
): boolean {
  return protectingRule(repo, branch, repoDefault, s) !== undefined;
}

/** What a duplicate dispatch on `ref` meets: the protecting rule's policy, else the other one. */
export function duplicateDispatchPolicy(
  repo: string,
  ref: string,
  repoDefault?: string | null,
  s: FleetSettings = settings(),
): OtherPolicy {
  return protectingRule(repo, ref, repoDefault, s)?.duplicateDispatch ??
    s.branches.otherDuplicateDispatch;
}
