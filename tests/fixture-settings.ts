// The settings the recorded fixtures were taken under: one org with pinned repos, protected
// branches that refuse, a pool-health variable, a runner scheduler with eight declared pools and a
// runner-host workflow. Applied when this module loads (every test file imports it, directly or
// through helpers.ts), so the tests see the behaviour those recordings show; a test that needs
// other settings applies them and restores these with `withSettings`. Paths and labels here are
// made up: no machine's real config is in this repo.

import { applySettings, type FleetSettings, settings, validateSettings } from "../lib/settings.ts";
import { type PoolPaths, poolPaths } from "../lib/controls.ts";

/** The org's settings, as a settings document. */
export const ORG_SETTINGS_DOC = {
  v: 1,
  setupComplete: true,
  owners: [{ login: "Brainwires", kind: "org" }],
  repos: {
    allow: [],
    deny: [],
    pinned: ["Brainwires/deno", "Brainwires/denext", "Brainwires/laufey", "Brainwires/qutty"],
  },
  branches: {
    rules: [
      { branch: ":default", cancel: "refuse", duplicateDispatch: "refuse" },
      { branch: "development-denext", cancel: "refuse", duplicateDispatch: "refuse" },
      { branch: "development", cancel: "refuse", duplicateDispatch: "refuse" },
      { branch: "main", cancel: "refuse", duplicateDispatch: "refuse" },
    ],
    otherDuplicateDispatch: "refuse",
  },
  pools: { healthVariable: { org: "Brainwires", name: "DENEXT_POOL_HEALTH" } },
  runnerHosts: [
    {
      repo: "Brainwires/deno",
      workflow: "intel helper",
      runnerPrefix: "gh-intel-helper-",
      pool: "mac-x64",
    },
  ],
  notifications: { poolUnhealthy: true, queuedLong: true, protectedFailure: true },
  startAtLogin: true,
  webhooks: {
    enabled: true,
    port: 8789,
    spoolDir: "~/.test-runners/hooks",
    secret: { source: "macos-keychain", service: "test-hooks", account: "github-webhook-secret" },
    requireLaunchdJob: "org.example.hooks-tunnel",
  },
  integrations: {
    runnerScheduler: {
      pools: [
        { id: "mac-arm", label: "denext-macos-arm64", slots: 2 },
        { id: "mac-x64", label: "denext-macos-x64", slots: 1 },
        { id: "linux-x64", label: "denext-linux-x64", slots: 3 },
        { id: "linux-x64-2204", label: "denext-linux-x64-2204", slots: 3 },
        { id: "linux-x64-docker", label: "denext-linux-x64-docker", slots: 1 },
        { id: "win-arm64", label: "denext-windows-arm64", slots: 2 },
        { id: "win-x64", label: "denext-windows-x64", slots: 1 },
        { id: "win-x64-pc", label: "denext-windows-x64", slots: 1 },
      ],
      runnerNamePrefix: "denext-",
      labelPrefix: "denext-",
      localHealthFile: "~/.test-runners/health.json",
      pausedDir: "~/.test-runners",
      controls: {
        pausePool: "/opt/test-ops/pause-pool.sh",
        watchdog: "/opt/test-ops/watchdog.sh",
        launchdLabel: "org.example.runners",
      },
    },
  },
};

function parse(doc: unknown): FleetSettings {
  const r = validateSettings(doc);
  if (!r.ok) throw new Error(`fixture settings: ${r.errors.join("; ")}`);
  return r.settings;
}

/** The org's settings, validated. */
export const ORG_SETTINGS: FleetSettings = parse(ORG_SETTINGS_DOC);

applySettings(ORG_SETTINGS);

/** The org scheduler's pool commands (made-up paths, `~/` expanded under `/Users/me`). */
export const TEST_POOL_PATHS: PoolPaths = poolPaths(
  ORG_SETTINGS.integrations.runnerScheduler!.controls,
  "/Users/me",
)!;

/** Run `fn` under other settings, then put the previous ones back. */
export async function withSettings<T>(
  s: FleetSettings,
  fn: () => T | Promise<T>,
): Promise<T> {
  const before = settings();
  applySettings(s);
  try {
    return await fn();
  } finally {
    applySettings(before);
  }
}
