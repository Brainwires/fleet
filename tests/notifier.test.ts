// Fleet Notifier (notifier/, lib/notifier.ts, tools/notifier.ts): its core's checks (the command
// line, the exit codes, the authorization steps, the click's `open`), the built executable's exit
// codes under --dry-run only (nothing is ever posted and no window opens), the helper embedded in an
// app bundle and signed (`codesign --verify --strict --deep`), and Fleet's side of the dedupe: no
// "queued over 15 min" notice for a self-hosted pool while the watchdog notifies through the
// helper. The Swift parts run on macOS with swiftc only.

import "./fixture-settings.ts";

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  NOTIFIER_BUNDLE,
  notifierExecutableIn,
  notifierIdentifier,
  notifierStamp,
  type RegisterDeps,
  registerNotifier,
  watchdogNotifies,
} from "../lib/notifier.ts";
import { pendingNotifications } from "../lib/notify.ts";
import type { JobRow, Snapshot } from "../lib/model.ts";
import { buildNotifierExecutable, embedNotifier, notifierInfoPlist } from "../tools/notifier.ts";
import { NOW } from "./helpers.ts";

const SWIFT = Deno.build.os === "darwin" && (() => {
  try {
    return new Deno.Command("xcrun", { args: ["--find", "swiftc"], stdout: "null", stderr: "null" })
      .outputSync().success;
  } catch {
    return false;
  }
})();

async function run(cmd: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" })
    .output();
  const d = new TextDecoder();
  return { code: p.code, stdout: d.decode(p.stdout), stderr: d.decode(p.stderr) };
}

const SRC = (f: string) => new URL(`../notifier/${f}`, import.meta.url).pathname;

// ---- lib/notifier.ts ----

Deno.test("notifier: its bundle id and place in Fleet.app", () => {
  assertEquals(notifierIdentifier("dev.brainwires.fleet"), "dev.brainwires.fleet.notifier");
  assertEquals(
    notifierExecutableIn("/Users/u/Applications/Fleet.app"),
    "/Users/u/Applications/Fleet.app/Contents/Helpers/Fleet Notifier.app/Contents/MacOS/fleet-notify",
  );
});

Deno.test("notifier: the watchdog notifies here only beside the scheduler, from a bundle with it", () => {
  const exe = "/Users/u/Applications/Fleet.app/Contents/MacOS/laufey_webview";
  const helper = notifierExecutableIn("/Users/u/Applications/Fleet.app");
  const has = (p: string) => p === helper;
  assertEquals(watchdogNotifies(exe, true, has), true);
  assertEquals(watchdogNotifies(exe, false, has), false);
  assertEquals(watchdogNotifies(exe, true, () => false), false);
  // A dev run from a plain folder has no bundle; a failing stat counts as missing.
  assertEquals(watchdogNotifies("/tmp/denext-desktop/Fleet", true, () => true), false);
  assertEquals(
    watchdogNotifies(exe, true, () => {
      throw new Deno.errors.NotFound();
    }),
    false,
  );
});

// ---- registration with LaunchServices (lib/notifier.ts registerNotifier) ----

/** A fake machine: one helper build (mtime), a stamp file, the lsregister calls. */
function fakeMachine(over: Partial<RegisterDeps> & { mtimeMs?: number | null } = {}) {
  const calls: string[] = [];
  let stamp: string | null = null;
  const deps: RegisterDeps = {
    os: "darwin",
    execPath: "/Users/u/Applications/Fleet.app/Contents/MacOS/laufey_webview",
    mtime: () => Promise.resolve(over.mtimeMs === undefined ? 1000 : over.mtimeMs),
    readStamp: () => Promise.resolve(stamp),
    writeStamp: (s) => {
      stamp = s;
      return Promise.resolve();
    },
    lsregister: (b) => {
      calls.push(b);
      return Promise.resolve(true);
    },
    ...over,
  };
  return { deps, calls, stamp: () => stamp };
}

const HELPER = "/Users/u/Applications/Fleet.app/Contents/Helpers/Fleet Notifier.app";

Deno.test("notifier registration: lsregister -f once per helper build", async () => {
  const m = fakeMachine();
  assertEquals(await registerNotifier(m.deps), true);
  assertEquals(m.calls, [HELPER]);
  assertEquals(m.stamp(), notifierStamp(HELPER, 1000));
  // The next launch, same build: nothing.
  assertEquals(await registerNotifier(m.deps), false);
  assertEquals(m.calls.length, 1);
  // A new build (another mtime): registered again.
  const next = { ...m.deps, mtime: () => Promise.resolve(2000) };
  assertEquals(await registerNotifier(next), true);
  assertEquals(m.calls.length, 2);
  assertEquals(m.stamp(), notifierStamp(HELPER, 2000));
});

Deno.test("notifier registration: nothing off macOS, outside a bundle, or without the helper", async () => {
  for (
    const over of [
      { os: "linux" },
      { execPath: "/tmp/denext-desktop/Fleet" },
      { mtimeMs: null },
    ] as const
  ) {
    const m = fakeMachine(over);
    assertEquals(await registerNotifier(m.deps), false);
    assertEquals(m.calls, []);
  }
});

Deno.test("notifier registration: a failed lsregister writes no stamp (retried next launch)", async () => {
  const m = fakeMachine({ lsregister: () => Promise.resolve(false) });
  assertEquals(await registerNotifier(m.deps), false);
  assertEquals(m.stamp(), null);
});

// ---- Fleet's dedupe (lib/notify.ts) ----

const row = (id: number, target: "pool" | "github", pool: string): JobRow => ({
  id,
  name: `job ${id}`,
  url: null,
  lane: "queued",
  target,
  pool,
  runner: null,
  since: NOW - 20 * 60_000,
  usualMs: null,
});

const snapWith = (jobs: JobRow[]): Snapshot => ({
  at: NOW,
  auth: "gh",
  poll: {
    ok: true,
    message: "",
    lastSuccessAt: NOW,
    intervalMs: 15_000,
    backoffUntil: null,
    slow: null,
  },
  rate: null,
  health: { state: "ok", checkedAt: NOW, message: "" },
  pools: [],
  running: [],
  queued: [{
    repo: "Brainwires/denext",
    runs: [{
      id: 1,
      repo: "Brainwires/denext",
      workflow: "CI",
      title: "",
      branch: "x",
      sha: "abcdef0",
      event: "push",
      url: "https://github.com/Brainwires/denext/actions/runs/1",
      defaultBranch: false,
      pendingJobs: false,
      jobs,
    }],
  }],
  finished: [],
  alerts: [],
  summary: { running: 0, queued: 0, severity: "ok", reasons: [] },
  repos: [],
  eventSeq: 0,
  notificationsPaused: false,
  hooks: { state: "off", lastDeliveryAt: null },
});

const PREFS = { poolUnhealthy: true, queuedLong: true, protectedFailure: true };

Deno.test("notify: with the watchdog notifying, a self-hosted pool's long wait is its alert alone", () => {
  const snap = snapWith([
    row(1, "pool", "mac-arm"),
    row(2, "pool", "linux-x64"),
    row(3, "github", "github"),
  ]);
  const seen = new Map<string, number>();
  const out = pendingNotifications(snap, seen, NOW, PREFS, { watchdogNotifies: true });
  // Only the GitHub-hosted job's notice; the pool jobs are marked seen (never shown later either).
  assertEquals(out.map((n) => n.key), ["queued:3"]);
  assert(seen.has("queued:1") && seen.has("queued:2"));
  assertEquals(pendingNotifications(snap, seen, NOW, PREFS, { watchdogNotifies: false }), []);
});

Deno.test("notify: without the watchdog notifying, Fleet posts every long wait as before", () => {
  const snap = snapWith([row(1, "pool", "mac-arm"), row(3, "github", "github")]);
  assertEquals(
    pendingNotifications(snap, new Map(), NOW, PREFS).map((n) => n.key),
    ["queued:1", "queued:3"],
  );
  assertEquals(
    pendingNotifications(snap, new Map(), NOW, PREFS, { watchdogNotifies: false }).map((n) =>
      n.key
    ),
    ["queued:1", "queued:3"],
  );
});

// ---- tools/notifier.ts ----

Deno.test("notifier: Info.plist is a UI element with Fleet's id, version and icon", () => {
  const p = notifierInfoPlist({
    fleetIdentifier: "dev.brainwires.fleet",
    version: "0.1.0",
    iconFile: "AppIcon",
  });
  assertStringIncludes(
    p,
    "<key>CFBundleIdentifier</key>\n\t<string>dev.brainwires.fleet.notifier</string>",
  );
  assertStringIncludes(p, "<key>FleetAppIdentifier</key>\n\t<string>dev.brainwires.fleet</string>");
  assertStringIncludes(p, "<key>LSUIElement</key>\n\t<true/>");
  assertStringIncludes(p, "<key>CFBundleExecutable</key>\n\t<string>fleet-notify</string>");
  assertStringIncludes(p, "<key>CFBundleIconFile</key>\n\t<string>AppIcon</string>");
  assertEquals(
    notifierInfoPlist({ fleetIdentifier: "a&b", version: "1" }).includes("CFBundleIconFile"),
    false,
  );
  assertStringIncludes(
    notifierInfoPlist({ fleetIdentifier: "a&b", version: "1" }),
    "a&amp;b.notifier",
  );
});

// ---- the Swift helper (macOS) ----

Deno.test({
  name: "notifier (swift): the core's checks pass (arguments, exit codes, authorization, click)",
  ignore: !SWIFT,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "fleet-notifier-test-" });
    try {
      const exe = `${dir}/core-tests`;
      const build = await run([
        "xcrun",
        "swiftc",
        "-swift-version",
        "5",
        "-o",
        exe,
        SRC("Sources/Core.swift"),
        SRC("Tests/main.swift"),
      ]);
      assertEquals(build.code, 0, build.stderr);
      const r = await run([exe]);
      assertEquals(r.code, 0, r.stdout);
      assertStringIncludes(r.stdout, "checks passed");
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

Deno.test({
  name: "notifier (swift): embedded in a bundle, signed, and its CLI's exit codes (--dry-run only)",
  ignore: !SWIFT,
  sanitizeResources: false,
  async fn() {
    const dir = await Deno.makeTempDir({ prefix: "fleet-notifier-pkg-" });
    try {
      // A stand-in Fleet.app: a real Mach-O main executable, Fleet's id, an icon file.
      const app = `${dir}/Fleet.app`;
      await Deno.mkdir(`${app}/Contents/MacOS`, { recursive: true });
      await Deno.mkdir(`${app}/Contents/Resources`, { recursive: true });
      await Deno.copyFile("/usr/bin/true", `${app}/Contents/MacOS/Fleet`);
      await Deno.writeTextFile(`${app}/Contents/Resources/AppIcon.icns`, "icns");
      await Deno.writeTextFile(
        `${app}/Contents/Info.plist`,
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleExecutable</key><string>Fleet</string>
<key>CFBundleIdentifier</key><string>dev.brainwires.fleet</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>0.1.0</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
      );
      const bin = `${dir}/fleet-notify`;
      await buildNotifierExecutable(bin);
      assertEquals((await run(["lipo", "-archs", bin])).stdout.trim().split(" ").sort(), [
        "arm64",
        "x86_64",
      ]);
      const helper = await embedNotifier(app, bin);
      assertEquals(helper, `${app}/Contents/Helpers/${NOTIFIER_BUNDLE}`);

      // Signed the way scripts/package-macos.ts sign() does it (ad-hoc here: no identity, no
      // keychain): nested code first (the helper's executable signs its bundle), then the bundle.
      const exe = notifierExecutableIn(app);
      for (const target of [exe, app]) {
        const s = await run([
          "codesign",
          "--force",
          "--timestamp=none",
          "--preserve-metadata=entitlements",
          "-s",
          "-",
          target,
        ]);
        assertEquals(s.code, 0, s.stderr);
      }
      const verify = await run(["codesign", "--verify", "--strict", "--deep", app]);
      assertEquals(verify.code, 0, verify.stderr);
      const info = await run(["codesign", "-dv", helper]);
      assertStringIncludes(info.stderr, "Identifier=dev.brainwires.fleet.notifier");
      const plist = `${helper}/Contents/Info.plist`;
      assertEquals(
        (await run(["plutil", "-extract", "LSUIElement", "raw", plist])).stdout.trim(),
        "true",
      );
      assertEquals(
        (await run(["plutil", "-extract", "CFBundleShortVersionString", "raw", plist])).stdout
          .trim(),
        "0.1.0",
      );
      await Deno.stat(`${helper}/Contents/Resources/AppIcon.icns`);

      // The CLI, inside its bundle: --dry-run validates and prints, posts nothing.
      const ok = await run([
        exe,
        "--title",
        "T",
        "--body",
        "B",
        "--id",
        "stuck:mac-arm",
        "--dry-run",
      ]);
      assertEquals(ok.code, 0, ok.stderr);
      assertEquals(JSON.parse(ok.stdout), { title: "T", body: "B", id: "stuck:mac-arm" });
      // Bad arguments exit 4 before anything is posted.
      for (
        const bad of [["--title", "T"], ["--title", "T", "--body", "B", "--bogus"], [
          "--title",
          "T",
          "--body",
          "B",
          "--url",
          "https://x.test",
        ]]
      ) {
        const r = await run([exe, ...bad, "--dry-run"]);
        assertEquals(r.code, 4, `${bad.join(" ")}: ${r.stderr}`);
      }
      assertEquals((await run([exe, "--help"])).code, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// A real package (`denext task desktop:package`, in dist/): the helper is in it and it verifies.
// Opt-in (FLEET_VERIFY_PACKAGE=1) after packaging: an older dist/ build has no helper.
const PACKAGED = `${new URL("..", import.meta.url).pathname}/dist/Fleet.app`;
const verifyPackage = (() => {
  try {
    return Deno.build.os === "darwin" && Deno.env.get("FLEET_VERIFY_PACKAGE") === "1";
  } catch {
    return false;
  }
})();

Deno.test({
  name: "notifier (package): dist/Fleet.app embeds the helper and verifies --strict --deep",
  ignore: !verifyPackage,
  async fn() {
    const exe = notifierExecutableIn(PACKAGED);
    assert((await Deno.stat(exe)).isFile, `${exe} is missing: package with the current script`);
    const verify = await run(["codesign", "--verify", "--strict", "--deep", PACKAGED]);
    assertEquals(verify.code, 0, verify.stderr);
    const info = await run(["codesign", "-dv", `${PACKAGED}/Contents/Helpers/${NOTIFIER_BUNDLE}`]);
    assertStringIncludes(info.stderr, "Identifier=dev.brainwires.fleet.notifier");
    const r = await run([exe, "--title", "T", "--body", "B", "--dry-run"]);
    assertEquals(r.code, 0, r.stderr);
  },
});
