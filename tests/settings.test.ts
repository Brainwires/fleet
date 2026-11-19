// Settings: validation and versioning, startup migration (file → local config → defaults), the
// protected-branch policies (warn / refuse) in the guardrails, pools grouped from runners, the
// notification prefs, the internal build's grants, the standalone receiver's config, and that no
// default names anyone's infrastructure. No network.

import { assert, assertEquals, assertFalse, assertStringIncludes, assertThrows } from "@std/assert";
import { ORG_SETTINGS, ORG_SETTINGS_DOC, withSettings } from "./fixture-settings.ts";
import {
  applySettings,
  DEFAULT_SETTINGS,
  type FleetSettings,
  LOCAL_CONFIG_FILE,
  repoWatched,
  settings,
  SETTINGS_FILE,
  startupSettings,
  validateSettings,
} from "../lib/settings.ts";
import {
  branchMatches,
  duplicateDispatchPolicy,
  forgetDefaultBranches,
  protectingRule,
  rememberDefaultBranches,
} from "../lib/branches.ts";
import { checkDispatch, checkRunControl, validRepo } from "../lib/controls.ts";
import {
  currentPools,
  groupRunners,
  indexRunners,
  poolFromLabels,
  poolFromRunnerName,
  seedPools,
  setPools,
} from "../lib/pools.ts";
import type { GhRunner } from "../lib/github-types.ts";
import { poolCards } from "../lib/snapshot.ts";
import { classifyJob } from "../lib/classify.ts";
import { pendingNotifications } from "../lib/notify.ts";
import type { Snapshot } from "../lib/model.ts";
import { grantsFromConfig, internalGrants } from "../lib/build-grants.ts";
import { receiverConfig } from "../hooks-only.ts";
import { createFleetService } from "../lib/service.ts";
import { scopesCanWrite, tokenKind } from "../lib/discover.ts";

/** Neutral settings for one org, nothing else configured. */
const ACME: FleetSettings = {
  ...DEFAULT_SETTINGS,
  setupComplete: true,
  owners: [{ login: "acme", kind: "org" }],
};

// ---- validation ----

Deno.test("settings: the defaults validate, and validation round-trips", () => {
  const r = validateSettings(DEFAULT_SETTINGS);
  assert(r.ok);
  assertEquals(r.settings, DEFAULT_SETTINGS);
  const org = validateSettings(JSON.parse(JSON.stringify(ORG_SETTINGS)));
  assert(org.ok);
  assertEquals(org.settings, ORG_SETTINGS);
  // A minimal document takes every default.
  const min = validateSettings({ v: 1, owners: [{ login: "acme", kind: "org" }] });
  assert(min.ok);
  assertEquals(min.settings.branches, DEFAULT_SETTINGS.branches);
  assertEquals(min.settings.webhooks.enabled, false);
  assertEquals(min.settings.startAtLogin, false);
});

Deno.test("settings: every bad field is reported with its path; nothing is guessed", () => {
  const r = validateSettings({
    v: 1,
    owners: [{ login: "-bad", kind: "org" }, { login: "ok", kind: "team" }],
    repos: { allow: ["no-slash", "a/../b"], deny: "x" },
    branches: { rules: [{ branch: "main", cancel: "maybe" }], otherDuplicateDispatch: "always" },
    pools: { healthVariable: { org: "acme", name: "has space" } },
    webhooks: { port: 80, spoolDir: "relative/dir", secret: { source: "macos-keychain" } },
    integrations: { runnerScheduler: { controls: { pausePool: "pause.sh" } } },
    startAtLogin: "yes",
  });
  assertFalse(r.ok);
  if (r.ok) return;
  const all = r.errors.join("\n");
  for (
    const path of [
      "owners[0].login",
      "owners[1].kind",
      "repos.allow[0]",
      "repos.allow[1]",
      "repos.deny",
      "branches.rules[0].cancel",
      "branches.otherDuplicateDispatch",
      "pools.healthVariable.name",
      "webhooks.port",
      "webhooks.spoolDir",
      "webhooks.secret.service",
      "integrations.runnerScheduler.controls.pausePool",
      "startAtLogin",
    ]
  ) assertStringIncludes(all, `${path}:`);
});

Deno.test("settings: versioned; a newer or unknown version is refused, never rewritten", () => {
  const newer = validateSettings({ v: 2 });
  assertFalse(newer.ok);
  if (!newer.ok) assertStringIncludes(newer.errors[0], "newer than this Fleet");
  assertFalse(validateSettings({ owners: [] }).ok);
  assertFalse(validateSettings("unreadable").ok);
  assertFalse(validateSettings(null).ok);
});

// ---- migration ----

Deno.test("startup: the settings file wins; else the local config is seeded (no wizard); else the wizard", () => {
  const file = startupSettings({ settingsRaw: ACME, localConfigRaw: ORG_SETTINGS_DOC });
  assertEquals(file.origin, "file");
  assertEquals(file.settings.owners, ACME.owners);
  assertFalse(file.write);

  // An existing install: no settings file yet, the machine's local config present.
  const seeded = startupSettings({
    settingsRaw: null,
    localConfigRaw: { ...ORG_SETTINGS_DOC, setupComplete: false },
  });
  assertEquals(seeded.origin, "local-config");
  assert(seeded.settings.setupComplete, "an existing install skips the wizard");
  assert(seeded.write, "and the settings file is written from it");
  assertEquals(seeded.settings.integrations, ORG_SETTINGS.integrations);

  // A fresh install.
  const fresh = startupSettings({ settingsRaw: null, localConfigRaw: null });
  assertEquals(fresh.origin, "defaults");
  assertFalse(fresh.settings.setupComplete);
  assertFalse(fresh.write);

  // A broken settings file: reported, never overwritten (the local config stands in unsaved).
  const broken = startupSettings({ settingsRaw: "unreadable", localConfigRaw: ORG_SETTINGS_DOC });
  assertEquals(broken.origin, "local-config");
  assertFalse(broken.write);
  assertStringIncludes(broken.problems[0], SETTINGS_FILE);
  const brokenAlone = startupSettings({
    settingsRaw: { v: 9 },
    localConfigRaw: { v: 1, owners: 3 },
  });
  assertEquals(brokenAlone.origin, "defaults");
  assertEquals(brokenAlone.problems.length, 2);
  assertStringIncludes(brokenAlone.problems[1], LOCAL_CONFIG_FILE);
});

Deno.test("service: an existing install starts with its local config and writes the settings file", async () => {
  const saved: FleetSettings[] = [];
  const before = settings();
  try {
    const s = createFleetService({
      ghToken: () => Promise.resolve(null),
      secrets: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      notify: () => {},
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      loadSettings: () => Promise.resolve({ settingsRaw: null, localConfigRaw: ORG_SETTINGS_DOC }),
      saveSettings: (x) => Promise.resolve(void saved.push(x)),
      warn: () => {},
    });
    await s.start();
    assertEquals(saved.length, 1);
    assert(s.snapshot().setupComplete);
    assertEquals(s.snapshot().owners, ["Brainwires"]);
    s.stop();

    // A fresh install: the wizard (setupComplete false), nothing written.
    applySettings(ORG_SETTINGS);
    const fresh = createFleetService({
      ghToken: () => Promise.resolve(null),
      secrets: {
        get: () => Promise.resolve(null),
        set: () => Promise.resolve(),
        delete: () => Promise.resolve(),
      },
      notify: () => {},
      load: () => Promise.resolve(null),
      save: () => Promise.resolve(),
      loadSettings: () => Promise.resolve({ settingsRaw: null, localConfigRaw: null }),
      saveSettings: (x) => Promise.resolve(void saved.push(x)),
      warn: () => {},
    });
    await fresh.start();
    assertEquals(saved.length, 1);
    assertEquals(fresh.snapshot().setupComplete, false);
    assertEquals(fresh.snapshot().owners, []);

    // Saving: invalid settings change nothing; valid ones are written, applied and announced.
    const heard: string[] = [];
    fresh.onSettings((next, prev) => heard.push(`${prev.startAtLogin}->${next.startAtLogin}`));
    const bad = await fresh.saveSettings({ ...ACME, owners: [{ login: "", kind: "org" }] });
    assertFalse(bad.ok);
    assertEquals(saved.length, 1);
    const good = await fresh.saveSettings({ ...ACME, startAtLogin: true });
    assert(good.ok);
    assertEquals(saved.length, 2);
    assertEquals(settings().owners, ACME.owners);
    assertEquals(heard, ["false->true"]);
    assert(fresh.snapshot().setupComplete);
    fresh.stop();
  } finally {
    applySettings(before);
  }
});

// ---- watched repos and protected branches ----

Deno.test("repos: owners, then allow / deny; pinned always; case-insensitive", () => {
  const s: FleetSettings = {
    ...ACME,
    owners: [{ login: "Acme", kind: "org" }, { login: "jo", kind: "user" }],
    repos: { allow: [], deny: ["acme/secret"], pinned: ["other/tool"] },
  };
  assert(repoWatched("acme/app", s));
  assert(repoWatched("ACME/app", s));
  assert(repoWatched("jo/dots", s));
  assertFalse(repoWatched("acme/secret", s));
  assertFalse(repoWatched("evil/app", s));
  assert(repoWatched("other/tool", s), "a pinned repo of another owner");
  const only = { ...s, repos: { ...s.repos, allow: ["acme/app"] } };
  assert(repoWatched("acme/app", only));
  assertFalse(repoWatched("acme/web", only));
  assertFalse(repoWatched("acme/../x", s));
});

Deno.test("branches: :default from the API, names, patterns, repo-scoped rules", () => {
  forgetDefaultBranches();
  const s: FleetSettings = {
    ...ACME,
    branches: {
      rules: [
        { branch: ":default", cancel: "warn", duplicateDispatch: "warn" },
        { branch: "rel/*", cancel: "refuse", duplicateDispatch: "refuse" },
        { branch: "deploy", repo: "acme/site", cancel: "refuse", duplicateDispatch: "warn" },
      ],
      otherDuplicateDispatch: "allow",
    },
  };
  assertEquals(
    protectingRule("acme/app", "trunk", undefined, s),
    undefined,
    "default not known yet",
  );
  rememberDefaultBranches([["acme/app", "trunk"]]);
  assertEquals(protectingRule("acme/app", "trunk", undefined, s)?.cancel, "warn");
  assertEquals(
    protectingRule("acme/app", "trunk", "main", s),
    undefined,
    "the caller's default wins",
  );
  assertEquals(protectingRule("acme/app", "rel/1.2", undefined, s)?.cancel, "refuse");
  assertEquals(protectingRule("acme/app", "deploy", undefined, s), undefined);
  assertEquals(protectingRule("acme/site", "deploy", undefined, s)?.cancel, "refuse");
  assertEquals(duplicateDispatchPolicy("acme/app", "feature", undefined, s), "allow");
  assertEquals(duplicateDispatchPolicy("acme/site", "deploy", undefined, s), "warn");
  assert(branchMatches("rel/*", "rel/a/b"));
  assertFalse(branchMatches("rel/*", "release"));
  assertFalse(branchMatches("ma.n", "main"), "a dot is a dot");
  forgetDefaultBranches();
});

const RUN = { id: 7, workflow: "CI", branch: "main", sha: "a".repeat(40), jobs: 3, event: "push" };

Deno.test("policy: warn asks with a warning, refuse refuses (cancel and duplicate dispatch)", async () => {
  const rules = (cancel: "warn" | "refuse", dup: "warn" | "refuse") => ({
    ...ACME,
    branches: {
      rules: [{ branch: "main", cancel, duplicateDispatch: dup }],
      otherDuplicateDispatch: "warn" as const,
    },
  });
  const cancel = { kind: "cancel-run" as const, repo: "acme/app", runId: 7 };
  await withSettings(rules("warn", "warn"), () => {
    const c = checkRunControl(cancel, RUN);
    assert(c.allowed);
    assertStringIncludes(c.warnings.join(" "), "protected branch");
    // A fork PR from a branch named main isn't protected.
    const fork = checkRunControl(cancel, { ...RUN, fork: true, event: "pull_request" });
    assert(fork.allowed);
    assertEquals(fork.warnings, []);
    const d = checkDispatch(
      { kind: "dispatch", repo: "acme/app", workflowId: 1, ref: "main", inputs: {} },
      {
        workflow: "CI",
        ref: "main",
        sha: "b".repeat(40),
        sameShaRuns: [{ id: 9, status: "completed", conclusion: "success" }],
      },
    );
    assert(d.allowed);
    assertStringIncludes(d.warnings[0], "already has run 9");
  });
  await withSettings(rules("refuse", "refuse"), () => {
    const c = checkRunControl(cancel, RUN);
    assertFalse(c.allowed);
    assertStringIncludes(c.refusal!, "must stay green");
    const d = checkDispatch(
      { kind: "dispatch", repo: "acme/app", workflowId: 1, ref: "main", inputs: {} },
      {
        workflow: "CI",
        ref: "main",
        sha: "b".repeat(40),
        sameShaRuns: [{ id: 9, status: "in_progress", conclusion: null }],
      },
    );
    assertFalse(d.allowed);
    // A branch no rule protects: the other-branches policy (warn).
    const other = checkDispatch(
      { kind: "dispatch", repo: "acme/app", workflowId: 1, ref: "topic", inputs: {} },
      {
        workflow: "CI",
        ref: "topic",
        sha: "b".repeat(40),
        sameShaRuns: [{ id: 9, status: "in_progress", conclusion: null }],
      },
    );
    assert(other.allowed);
    assertEquals(other.warnings.length, 1);
    // Cancel on an unprotected branch: plain.
    assertEquals(checkRunControl(cancel, { ...RUN, branch: "topic" }).warnings, []);
  });
  // The defaults: each repo's default branch warns (once known).
  await withSettings(ACME, () => {
    forgetDefaultBranches();
    assertEquals(checkRunControl(cancel, RUN).warnings, []);
    rememberDefaultBranches([["acme/app", "main"]]);
    const c = checkRunControl(cancel, RUN);
    assert(c.allowed);
    assertEquals(c.warnings.length, 1);
    forgetDefaultBranches();
  });
});

Deno.test("controls: only the watched owners' repos", async () => {
  await withSettings(ACME, () => {
    assert(validRepo("acme/app"));
    assertFalse(validRepo("Brainwires/denext"));
  });
  await withSettings(DEFAULT_SETTINGS, () => assertFalse(validRepo("acme/app")));
});

// ---- pools from runners ----

const runner = (
  id: number,
  name: string,
  labels: [string, string?][],
  over: Partial<GhRunner> = {},
): GhRunner => ({
  id,
  name,
  status: "online",
  busy: false,
  labels: labels.map(([n, type]) => ({ name: n, type: type ?? "custom" })),
  ...over,
});

const RUNNERS: GhRunner[] = [
  runner(1, "box-a", [["self-hosted", "read-only"], ["Linux", "read-only"], ["gpu"]], {
    busy: true,
  }),
  runner(2, "box-b", [["self-hosted", "read-only"], ["Linux", "read-only"], ["gpu"]]),
  runner(
    3,
    "mac-1",
    [["self-hosted", "read-only"], ["macOS", "read-only"], ["ARM64", "read-only"]],
    {
      status: "offline",
    },
  ),
  runner(4, "big-1", [["self-hosted", "read-only"], ["linux", "read-only"], ["large"], ["docker"]]),
];

Deno.test("pools: grouped from the runners by their custom labels; jobs and runners find them", async () => {
  await withSettings(ACME, () => {
    const defs = groupRunners(RUNNERS)!;
    assertEquals(defs.map((d) => [d.id, d.slots]), [["docker+large", 1], ["gpu", 2], [
      "macOS+ARM64",
      1,
    ]]);
    assertEquals(groupRunners(null), null);
    setPools(defs);
    indexRunners(RUNNERS, defs);
    try {
      assertEquals(poolFromRunnerName("box-b"), "gpu");
      assertEquals(poolFromRunnerName("mac-1"), "macOS+ARM64");
      assertEquals(poolFromLabels(["self-hosted", "gpu"]), "gpu");
      assertEquals(poolFromLabels(["self-hosted", "large", "docker"]), "docker+large");
      assertEquals(
        poolFromLabels(["self-hosted", "large"]),
        null,
        "every label of a pool is needed",
      );
      assertEquals(poolFromLabels(["ubuntu-latest"]), null);
      // A running job on a registered runner is self-hosted, whatever its runner group.
      const job = {
        id: 1,
        run_id: 1,
        name: "train",
        status: "in_progress",
        created_at: "2026-11-11T00:00:00Z",
        labels: ["self-hosted", "gpu"],
        runner_name: "box-a",
      };
      assertEquals(classifyJob(job), { lane: "running", target: "pool", pool: "gpu" });
      // A pool's state, with no health variable, is its runners': all offline is unhealthy.
      const cards = poolCards([], [], { state: "unavailable", message: "" }, RUNNERS);
      const by = (id: string) => cards.find((c) => c.id === id)!;
      assertEquals([by("gpu").state, by("gpu").busy, by("gpu").slots], ["ok", 1, 2]);
      assertEquals([by("macOS+ARM64").state, by("macOS+ARM64").reason], [
        "unhealthy",
        "no runner online",
      ]);
    } finally {
      setPools(seedPools());
      indexRunners(null);
    }
  });
  assertEquals(currentPools(), seedPools());
});

// ---- notifications ----

Deno.test("notifications: a kind turned off is marked seen but not posted", () => {
  const snap = {
    at: 1_000_000,
    clockOffsetMs: 0,
    health: { state: "ok" },
    pools: [{
      id: "gpu",
      title: "gpu",
      label: "gpu",
      state: "unhealthy",
      reason: "down",
      since: 5,
    }],
    queued: [],
    finished: [{
      id: 3,
      repo: "acme/app",
      branch: "main",
      workflow: "CI",
      name: "test",
      conclusion: "failure",
      defaultBranch: true,
      completedAt: 1_000_000,
    }],
  } as unknown as Snapshot;
  const seen = new Map<string, number>();
  const off = { poolUnhealthy: false, queuedLong: true, protectedFailure: false };
  assertEquals(pendingNotifications(snap, seen, 0, off), []);
  assertEquals([...seen.keys()].sort(), ["fail:3", "pool:gpu:5"]);
  // Turned back on: the past isn't replayed.
  assertEquals(pendingNotifications(snap, seen, 0, DEFAULT_SETTINGS.notifications), []);
  assertEquals(pendingNotifications(snap, new Map(), 0, DEFAULT_SETTINGS.notifications).length, 2);
});

// ---- the wizard's token facts ----

Deno.test("token: kind from the prefix; write from the scopes", () => {
  assertEquals(tokenKind("github_pat_x"), "fine-grained");
  assertEquals(tokenKind("ghp_x"), "classic");
  assertEquals(tokenKind("gho_x"), "oauth");
  assertEquals(tokenKind(null), "none");
  assertEquals(scopesCanWrite(["repo", "read:org"], "oauth"), "yes");
  assertEquals(scopesCanWrite(["read:org"], "classic"), "no");
  assertEquals(scopesCanWrite(null, "fine-grained"), "unknown");
  assertEquals(scopesCanWrite(null, "classic"), "no");
});

// ---- the internal build ----

Deno.test("build: a release build bakes no internal grants; an internal one bakes its local config's", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  assertEquals(internalGrants(env({ HOME: "/Users/me" }), () => "{}"), {
    run: [],
    write: [],
    net: [],
  });
  const g = internalGrants(
    env({ FLEET_INTERNAL: "1", HOME: "/Users/me" }),
    (p) => {
      assertEquals(
        p,
        `/Users/me/Library/Application Support/dev.brainwires.fleet/${LOCAL_CONFIG_FILE}`,
      );
      return JSON.stringify(ORG_SETTINGS_DOC);
    },
  );
  assertEquals(g.run, [
    "/opt/test-ops/pause-pool.sh",
    "/opt/test-ops/watchdog.sh",
    "/bin/launchctl",
  ]);
  assertEquals(g.write, ["/Users/me/.test-runners/hooks"]);
  assertThrows(
    () =>
      internalGrants(env({ FLEET_INTERNAL: "1", HOME: "/Users/me" }), () => {
        throw new Deno.errors.NotFound("x");
      }),
    Error,
    "can't read the local config",
  );
  assertThrows(() => grantsFromConfig({ v: 1, owners: 1 }, "/h"), Error, "isn't valid");
  assertEquals(grantsFromConfig(DEFAULT_SETTINGS, "/h"), { run: [], write: [], net: [] });
});

// ---- the standalone receiver ----

Deno.test("receiver: flags, or a settings file's webhooks; flags win; keychain only", async () => {
  const files: Record<string, string> = {
    "/data/fleet-settings.json": JSON.stringify(ORG_SETTINGS_DOC),
    "/data/neutral.json": JSON.stringify({ v: 1 }),
  };
  const read = (p: string) =>
    p in files ? Promise.resolve(files[p]) : Promise.reject(new Deno.errors.NotFound(p));
  const flags = await receiverConfig([
    "--spool-dir",
    "/var/hooks",
    "--keychain-service",
    "svc",
    "--keychain-account",
    "acct",
    "--require-launchd-job=org.example.tunnel",
  ], read);
  assert(typeof flags !== "string");
  assertEquals(flags.cfg.spoolDir, "/var/hooks");
  assertEquals(flags.cfg.secret, { source: "macos-keychain", service: "svc", account: "acct" });
  assertEquals(flags.cfg.requireLaunchdJob, "org.example.tunnel");
  assertEquals(flags.cfg.port, 8789);
  const file = await receiverConfig(
    ["--settings", "/missing.json", "--settings", "/data/fleet-settings.json", "--port", "9000"],
    read,
  );
  assert(typeof file !== "string");
  assertEquals(file.cfg.port, 9000);
  assertEquals(file.cfg.spoolDir, "~/.test-runners/hooks");
  // The secure store is Fleet's own: the standalone receiver can't read it.
  const neutral = await receiverConfig(["--settings", "/data/neutral.json"], read);
  assertEquals(typeof neutral, "string");
  assertEquals(
    typeof (await receiverConfig(["--port", "80", "--spool-dir", "/x"], read)),
    "string",
  );
});

// ---- nobody's infrastructure in the defaults ----

/** What identifies one particular setup: never in the defaults or the app's code. */
const OURS = [
  /Brainwires/,
  /denext-internal/,
  /com\.brainwires\./,
  /\.denext-runners/,
  /gh-intel-helper/,
  /DENEXT_POOL_HEALTH/,
  /ci-hooks\.denext\.dev/,
  /denext-ci-hooks/,
  /\bbiscuits\b/,
  /\bbrain\b/,
  /\bmacbook\b/i,
  /\bpeachy\b/,
  /\bMac mini\b/,
  /\/Users\/[a-z]/,
  /\bops\/runners\b/,
  /192\.168\./,
];

/** The project's own home URL (a link to the docs), the one place its owner's name may appear. */
const HOME_URL = "https://github.com/Brainwires/fleet";

/** The `.ts` / `.tsx` / `.json` files under `root` (relative to this file), at any depth. */
async function sourcesUnder(root: string): Promise<string[]> {
  const out: string[] = [];
  for await (const e of Deno.readDir(new URL(root, import.meta.url))) {
    if (e.isDirectory) out.push(...await sourcesUnder(`${root}${e.name}/`));
    else if (e.isFile && /\.(ts|tsx|json)$/.test(e.name)) out.push(`${root}${e.name}`);
  }
  return out;
}

Deno.test("defaults: no owner, no pools, no paths, nothing of any one setup", async () => {
  const text = JSON.stringify(DEFAULT_SETTINGS);
  for (const re of OURS) assertFalse(re.test(text), `defaults match ${re}`);
  assertEquals(DEFAULT_SETTINGS.owners, []);
  assertEquals(DEFAULT_SETTINGS.integrations.runnerScheduler, null);
  assertEquals(DEFAULT_SETTINGS.pools.healthVariable, null);
  assertEquals(DEFAULT_SETTINGS.runnerHosts, []);
  assertFalse(DEFAULT_SETTINGS.startAtLogin);
  assertFalse(DEFAULT_SETTINGS.webhooks.enabled);
  // Under the defaults nothing is seeded.
  await withSettings(DEFAULT_SETTINGS, () => assertEquals(seedPools(), []));
  // And the code that ships: the app, the backend, the MCP server, the build config, and the
  // tracked generated config (an internal package run writes local paths there:
  // scripts/package-internal.ts restores it), every directory walked to the bottom.
  const roots = ["../lib/", "../app/", "../desktop/", "../mcp/", "../scripts/"];
  const files = [
    "../desktop.ts",
    "../hooks-only.ts",
    "../denext.config.ts",
    "../deno.json",
    "../.deno-desktop/config.json",
  ];
  for (const root of roots) files.push(...await sourcesUnder(root));
  for (const f of files) {
    const src = (await Deno.readTextFile(new URL(f, import.meta.url))).replaceAll(HOME_URL, "");
    for (const re of OURS) assertFalse(re.test(src), `${f} matches ${re}`);
  }
});
