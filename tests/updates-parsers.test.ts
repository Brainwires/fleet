// Machine updates: the four status parsers over trimmed recorded output (tests/fixtures/updates),
// hostile host text clamped, the severity table with its day thresholds, and the host documents
// (`result`, `verify`, `boot-id`). Nothing here runs a command.

import { assert, assertEquals, assertFalse } from "@std/assert";
import { parseStatusDocument } from "../lib/updates/collect.ts";
import { parseAptList } from "../lib/updates/collect-apt.ts";
import { nevraName } from "../lib/updates/collect-dnf.ts";
import { parseSoftwareUpdate } from "../lib/updates/collect-macos.ts";
import {
  clampText,
  emptyStatus,
  type HostStatus,
  MAX_NAME_LEN,
  MAX_NAMES,
  parseBootId,
  parseResultDoc,
  parseVerifyDoc,
  severity,
  withCheck,
  withCheckError,
} from "../lib/updates/model.ts";

const fixture = (name: string) =>
  Deno.readTextFileSync(new URL(`./fixtures/updates/${name}`, import.meta.url));

const NOW = Date.parse("2026-11-21T12:00:00Z");
const S = NOW / 1000;
const H = 3_600_000;
const D = 24 * H;

function ok(r: ReturnType<typeof parseStatusDocument>): HostStatus {
  if (!r.ok) throw new Error(r.error);
  return r.status;
}

Deno.test("apt: counts, the -security pockets (ESM included), reboot-required and the index stamp", () => {
  const doc = JSON.stringify({
    os: "ubuntu",
    apt: fixture("apt-list.txt"),
    rebootRequired: S - 3600,
    rebootPkgs: "linux-image-6.8.0-49-generic\nlinux-base\n",
    indexStamp: S - 7200,
  });
  const s = ok(parseStatusDocument("ubuntu", doc));
  assertEquals(s.pending.total, 5);
  assertEquals(s.pending.security, 3);
  assertEquals(s.pending.securityNames, ["libssl3t64", "openssl", "curl"]);
  assertEquals(s.pending.names.slice(0, 3), ["libssl3t64", "openssl", "curl"], "security first");
  assertEquals(s.reboot, {
    required: true,
    since: NOW - H,
    packages: ["linux-image-6.8.0-49-generic", "linux-base"],
  });
  assertEquals(s.indexAt, NOW - 2 * H);
  // No reboot file: not required, no packages.
  const none = ok(parseStatusDocument("ubuntu", JSON.stringify({ os: "ubuntu", apt: "" })));
  assertEquals([none.pending.total, none.reboot.required, none.indexAt], [0, false, null]);
  assertEquals(parseAptList("Listing... Done\nWARNING: apt does not have a stable CLI\n"), []);
});

Deno.test("apt: the script warning on stderr is skipped; phased updates count as pending", () => {
  // What the gate captures on a real host (stderr first, then the buffered stdout).
  const apt =
    "\nWARNING: apt does not have a stable CLI interface. Use with caution in scripts.\n\n" +
    "Listing...\n" +
    // A phased update (apt-get upgrade defers it; Fleet's install-all includes it).
    "ubuntu-drivers-common/noble-updates 1:0.9.7.6ubuntu3.2 amd64 [upgradable from: 1:0.9.7.6ubuntu3.1]\n" +
    "libssl3t64/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]\n";
  const items = parseAptList(apt);
  assertEquals(items.map((i) => i.name), ["ubuntu-drivers-common", "libssl3t64"]);
  const s = ok(parseStatusDocument("ubuntu", JSON.stringify({ os: "ubuntu", apt })));
  assertEquals([s.pending.total, s.pending.security], [2, 1]);
});

Deno.test("dnf: check-update names, the security advisories' packages, needs-restarting", () => {
  const doc = JSON.stringify({
    os: "fedora",
    checkUpdate: fixture("dnf-check-update.txt"),
    security: fixture("dnf-security.txt"),
    needsRestartingCode: 1,
    needsRestarting: fixture("dnf-needs-restarting.txt"),
  });
  const s = ok(parseStatusDocument("fedora", doc));
  assertEquals(s.pending.total, 3, "the obsoletes section is not counted");
  assertEquals(s.pending.securityNames, ["kernel-core", "openssl-libs"]);
  assertEquals(s.reboot.required, true);
  assertEquals(s.reboot.packages, ["kernel", "systemd"]);
  assertEquals(nevraName("openssl-libs-1:3.2.2-9.fc41.aarch64"), "openssl-libs");
  assertEquals(nevraName("kernel-core-6.11.4-301.fc41.x86_64"), "kernel-core");
  const clean = ok(
    parseStatusDocument(
      "fedora",
      JSON.stringify({ os: "fedora", checkUpdate: "", needsRestartingCode: 0 }),
    ),
  );
  assertEquals([clean.pending.total, clean.reboot.required], [0, false]);
});

Deno.test("macOS: labels, macOS version updates count as security, Action: restart means a reboot", () => {
  const doc = JSON.stringify({ os: "macos", softwareupdate: fixture("softwareupdate-l.txt") });
  const s = ok(parseStatusDocument("macos", doc));
  assertEquals(s.pending.total, 3);
  assertEquals(s.pending.securityNames, ["macOS Sequoia 15.1.1-24B91"]);
  assertEquals(s.reboot.required, true);
  assertEquals(s.reboot.packages, ["macOS Sequoia 15.1.1-24B91"]);
  assertEquals(s.indexAt, null);
  const ups = parseSoftwareUpdate(fixture("softwareupdate-l.txt"));
  assertEquals(ups.map((u) => [u.title, u.restart]), [
    ["macOS Sequoia 15.1.1", true],
    ["Safari", false],
    ["Command Line Tools for Xcode", false],
  ]);
  const none = ok(
    parseStatusDocument(
      "macos",
      JSON.stringify({
        os: "macos",
        softwareupdate:
          "Software Update Tool\n\nFinding available software\nNo new software available.\n",
      }),
    ),
  );
  assertEquals([none.pending.total, none.reboot.required], [0, false]);
});

Deno.test("Windows: Security Updates or an MSRC severity is security; the reboot keys", () => {
  const s = ok(parseStatusDocument("windows", fixture("windows-scan.json")));
  assertEquals(s.pending.total, 3);
  assertEquals(s.pending.security, 1);
  assert(s.pending.securityNames[0].includes("KB5046617"));
  assert(s.pending.names.some((n) => n.endsWith("(KB2267602)")), "a bare KB number is prefixed");
  assertEquals(s.reboot.required, true);
  assertEquals(s.reboot.packages, ["RebootPending"]);
  // ConvertTo-Json flattens a one-element list to an object.
  const one = ok(
    parseStatusDocument(
      "windows",
      JSON.stringify({
        os: "windows",
        updates: { title: "Update A", categories: "Security Updates", msrcSeverity: "" },
      }),
    ),
  );
  assertEquals([one.pending.total, one.pending.security], [1, 1]);
  const clean = ok(
    parseStatusDocument("windows", JSON.stringify({ os: "windows", updates: null })),
  );
  assertEquals([clean.pending.total, clean.reboot.required], [0, false]);
});

Deno.test("parsers: the wrong OS or garbage is an error, never a guess", () => {
  for (const os of ["ubuntu", "fedora", "macos", "windows"] as const) {
    assertFalse(parseStatusDocument(os, "not json").ok);
    assertFalse(parseStatusDocument(os, "[]").ok);
    assertFalse(parseStatusDocument(os, JSON.stringify({ os: "plan9" })).ok);
    assertFalse(parseStatusDocument(os, "x".repeat(1_000_001)).ok);
  }
});

Deno.test("hostile host text: control and bidi characters out, names capped, lists capped", () => {
  const evil = "pkg\u202e\u0007\u001b[31mred\u2028$(reboot)";
  const longName = "a".repeat(5000);
  const lines = [
    `${longName}/noble-security 1 amd64 [upgradable from: 0]`,
    ...Array.from({ length: 500 }, (_, i) => `p${i}/noble-security 1 amd64 [upgradable from: 0]`),
  ].join("\n");
  const s = ok(parseStatusDocument("ubuntu", JSON.stringify({ os: "ubuntu", apt: lines })));
  assertEquals(s.pending.total, 501);
  assertEquals(s.pending.security, 501);
  assertEquals(s.pending.names.length, MAX_NAMES);
  assert(s.pending.names.every((n) => n.length <= MAX_NAME_LEN));
  const mac = ok(
    parseStatusDocument(
      "macos",
      JSON.stringify({
        os: "macos",
        softwareupdate: `* Label: ${evil}\n\tTitle: x, Action: restart,\n`,
      }),
    ),
  );
  for (const n of [...mac.pending.names, ...mac.reboot.packages]) {
    // deno-lint-ignore no-control-regex
    assertFalse(/[\u0000-\u001f\u007f\u202a-\u202e\u2028\u2029]/.test(n), JSON.stringify(n));
  }
  assertEquals(clampText(evil), "pkg [31mred $(reboot)");
  const win = ok(
    parseStatusDocument(
      "windows",
      JSON.stringify({
        os: "windows",
        updates: Array.from(
          { length: 300 },
          (_, i) => ({ title: `${evil}${i}`, kb: "1; rm -rf /" }),
        ),
      }),
    ),
  );
  assertEquals(win.pending.total, 300);
  assertEquals(win.pending.names.length, MAX_NAMES);
  assertFalse(win.pending.names.some((n) => n.includes("rm -rf")), "a bad KB is dropped");
});

Deno.test("severity: the table, with the day thresholds and first-seen times", () => {
  const host = (
    p: Partial<HostStatus["pending"]>,
    reboot = false,
    indexAt: number | null = NOW,
  ) => ({
    pending: { total: 0, security: 0, names: [], securityNames: [], ...p },
    reboot: { required: reboot, since: null, packages: [] },
    indexAt,
  });
  const base = emptyStatus("m1");
  const lvl = (s: ReturnType<typeof withCheck>, at = NOW) => severity(s, at);

  assertEquals(lvl(withCheck(base, host({}), NOW)), { level: "ok", causes: [] });
  assertEquals(lvl(withCheck(base, host({ total: 4 }), NOW)).level, "info");
  assertEquals(lvl(withCheck(base, host({ total: 4, security: 1 }), NOW)).causes, [
    "security-pending",
  ]);
  assertEquals(lvl(withCheck(base, host({}, true), NOW)).level, "warn");
  // Index older than 24 h: warn.
  assertEquals(lvl(withCheck(base, host({}, false, NOW - 25 * H), NOW)).causes, ["index-stale"]);
  // Last check 25 h ago: warn; 72 h: bad; never: bad.
  assertEquals(lvl(withCheck(base, host({}), NOW - 25 * H)).causes, ["check-stale"]);
  assertEquals(lvl(withCheck(base, host({}), NOW - 72 * H)).level, "bad");
  assertEquals(severity(base, NOW).causes, ["no-check"]);
  // A security update first seen 8 days ago, still pending: bad (first-seen is kept across checks).
  const first = withCheck(base, host({ total: 1, security: 1 }), NOW - 8 * D);
  const later = withCheck(first, host({ total: 1, security: 1 }), NOW);
  assertEquals(later.firstSeen.security, NOW - 8 * D);
  assertEquals(lvl(later).causes, ["security-old"]);
  // 6 days: still warn.
  const six = withCheck(
    withCheck(base, host({ security: 1, total: 1 }), NOW - 6 * D),
    host({ security: 1, total: 1 }),
    NOW,
  );
  assertEquals(lvl(six).level, "warn");
  // Cleared, then back: the clock restarts.
  const cleared = withCheck(later, host({}), NOW);
  assertEquals(cleared.firstSeen.security, null);
  // A reboot the host dates 8 days back: bad.
  const rb = withCheck(base, {
    ...host({}),
    reboot: { required: true, since: NOW - 8 * D, packages: [] },
  }, NOW);
  assertEquals(lvl(rb).causes, ["reboot-old"]);
  // A failed run's pools still held: bad.
  assertEquals(
    severity({ ...withCheck(base, host({}), NOW), heldPools: ["p1"] }, NOW).level,
    "bad",
  );
  // A failed check keeps the last findings; its age decides.
  const err = withCheckError(
    withCheck(base, host({ total: 2 }), NOW - 30 * H),
    "ssh: timeout\u0007",
    NOW,
  );
  assertEquals(err.error, "ssh: timeout");
  assertEquals(severity(err, NOW).causes, ["check-stale", "updates-pending"]);
  // Thresholds from config.
  assertEquals(
    severity(later, NOW, { securityDays: 10, rebootDays: 7, staleHours: 24, noCheckHours: 72 })
      .level,
    "warn",
  );
});

Deno.test("host documents: result, verify, boot-id parsed defensively", () => {
  assertEquals(
    parseResultDoc(
      JSON.stringify({
        state: "succeeded",
        startedAt: S,
        exitCode: 0,
        rebootRequired: true,
        tail: "ok\u0007\n",
      }),
    ),
    { state: "succeeded", startedAt: NOW, exitCode: 0, rebootRequired: true, tail: "ok \n" },
  );
  assertEquals(parseResultDoc(JSON.stringify({ state: "rm -rf" })), null);
  assertEquals(parseResultDoc("garbage"), null);
  const v = parseVerifyDoc(JSON.stringify({
    system: "degraded",
    failedUnits: ["a.service", "a.service", "b\u202e.service"],
    docker: "weird",
    mounts: ["/", "/srv/data", 7],
    checks: [{ name: "mailcow", ok: true }, { name: "samba", ok: "yes" }, "junk"],
    xcodePlatforms: null,
    freeDiskMb: -5,
  }))!;
  assertEquals(v.failedUnits, ["a.service", "b .service"]);
  assertEquals(v.docker, "absent");
  assertEquals(v.mounts, ["/", "/srv/data"]);
  assertEquals(v.checks, [{ name: "mailcow", ok: true }, { name: "samba", ok: false }]);
  assertEquals(v.freeDiskMb, 0);
  assertEquals(
    parseBootId("3f1c2b7a-9a1e-4d1b-8c55-0f0e2b3c4d5e\n"),
    "3f1c2b7a-9a1e-4d1b-8c55-0f0e2b3c4d5e",
  );
  assertEquals(parseBootId("a b"), null);
  assertEquals(parseBootId("$(reboot)"), null);
});
