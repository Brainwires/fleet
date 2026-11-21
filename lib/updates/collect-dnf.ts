// Fedora's status document (the gate's `status` verb on a dnf host), parsed. Untrusted text: every
// name clamped, every list capped (lib/updates/model.ts).
//
// The document: `{"os":"fedora","checkUpdate":"<dnf -q check-update>","security":"<dnf -q
// updateinfo list --security>","needsRestartingCode":<exit of dnf needs-restarting -r>,
// "needsRestarting":"<its output>","indexStamp":<epoch s>|null}`.
//
// Security = a pending package named in an advisory of type security. A reboot is required when
// `needs-restarting -r` exits 1; its output names the packages.

import {
  type CollectResult,
  epochSecondsToMs,
  hostStatus,
  outputLines,
  parseJsonObject,
  type PendingItem,
} from "./model.ts";

const ARCHES = new Set([
  "noarch",
  "x86_64",
  "aarch64",
  "i686",
  "armv7hl",
  "ppc64le",
  "s390x",
  "riscv64",
  "src",
]);

/** `name.arch  version  repo` (check-update); the obsoletes section and notes are skipped. */
const PKG_LINE = /^([A-Za-z0-9_][\w+.-]*)\.([\w]+)\s+(\S+)\s+(\S+)\s*$/;

/** The name of a NEVRA (`kernel-core-6.11.4-301.fc41.x86_64` → `kernel-core`). */
export function nevraName(nevra: string): string | null {
  let s = nevra.trim();
  const dot = s.lastIndexOf(".");
  if (dot > 0 && ARCHES.has(s.slice(dot + 1))) s = s.slice(0, dot);
  const parts = s.split("-");
  if (parts.length < 3) return null;
  const name = parts.slice(0, -2).join("-");
  return /^[A-Za-z0-9_][\w+.-]*$/.test(name) ? name : null;
}

/** The pending names in `dnf check-update` output. */
export function parseCheckUpdate(text: unknown): string[] {
  const out: string[] = [];
  for (const line of outputLines(text)) {
    if (/^(Obsoleting|Security:|Last metadata)/i.test(line.trim())) {
      if (/^Obsoleting/i.test(line.trim())) break;
      continue;
    }
    const m = line.match(PKG_LINE);
    if (m && ARCHES.has(m[2])) out.push(m[1]);
  }
  return out;
}

/**
 * The package names in `dnf updateinfo list --security` output (dnf 4: `ADVISORY  Severity/Sec.
 * NEVRA`; dnf 5: `ADVISORY  security  Severity  NEVRA  [date]`): the NEVRA is the field after the
 * type or severity.
 */
export function parseSecurityList(text: unknown): Set<string> {
  const out = new Set<string>();
  for (const line of outputLines(text)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || !/^[A-Z][\w.:-]*-\d/.test(f[0])) continue;
    for (const cand of f.slice(2)) {
      const n = nevraName(cand);
      if (n && /\d/.test(cand)) {
        out.add(n);
        break;
      }
    }
  }
  return out;
}

/** The packages `needs-restarting -r` lists (`  * kernel`). */
function restartPackages(text: unknown): string[] {
  return outputLines(text).map((l) => l.match(/^\s*\*\s+(\S+)/)?.[1] ?? "").filter(Boolean);
}

/** Parse a Fedora status document. */
export function parseDnfStatus(text: string): CollectResult {
  const doc = parseJsonObject(text);
  if (!doc || doc.os !== "fedora") return { ok: false, error: "not a Fedora status document" };
  if (typeof doc.checkUpdate !== "string") return { ok: false, error: "no check-update output" };
  const security = parseSecurityList(doc.security);
  const items: PendingItem[] = parseCheckUpdate(doc.checkUpdate).map((name) => ({
    name,
    security: security.has(name),
  }));
  const required = doc.needsRestartingCode === 1;
  return {
    ok: true,
    status: hostStatus(
      items,
      { required, since: null, packages: restartPackages(doc.needsRestarting) },
      epochSecondsToMs(doc.indexStamp),
    ),
  };
}
