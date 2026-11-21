// Ubuntu's status document (the gate's `status` verb on an apt host), parsed. Untrusted text: every
// name clamped, every list capped (lib/updates/model.ts).
//
// The document: `{"os":"ubuntu","apt":"<apt list --upgradable>","rebootRequired":<mtime of
// /var/run/reboot-required, epoch s>|null,"rebootPkgs":"<reboot-required.pkgs>","indexStamp":
// <mtime of /var/lib/apt/periodic/update-success-stamp, epoch s>|null}`.
//
// Security = an archive the package comes from ends in `-security` (the main pocket and the ESM
// `-infra-security` / `-apps-security` pockets): the origins unattended-upgrades allows by default.

import {
  type CollectResult,
  epochSecondsToMs,
  hostStatus,
  outputLines,
  parseJsonObject,
  type PendingItem,
} from "./model.ts";

/** One `apt list --upgradable` line: `name/archive[,archive…] version arch [upgradable from: …]`. */
const LINE = /^([a-z0-9][a-z0-9+.-]*)\/(\S+)\s+\S+\s+\S+\s+\[upgradable from:/;

/** The pending updates in `apt list --upgradable` output. */
export function parseAptList(text: unknown): PendingItem[] {
  const out: PendingItem[] = [];
  for (const line of outputLines(text)) {
    const m = line.trim().match(LINE);
    if (!m) continue;
    const archives = m[2].split(",");
    out.push({ name: m[1], security: archives.some((a) => a.endsWith("-security")) });
  }
  return out;
}

/** Parse an Ubuntu status document. */
export function parseAptStatus(text: string): CollectResult {
  const doc = parseJsonObject(text);
  if (!doc || doc.os !== "ubuntu") return { ok: false, error: "not an Ubuntu status document" };
  if (typeof doc.apt !== "string") return { ok: false, error: "no apt list in the document" };
  const since = epochSecondsToMs(doc.rebootRequired);
  const required = since !== null || doc.rebootRequired === true;
  const packages = outputLines(doc.rebootPkgs).map((l) => l.trim()).filter(Boolean);
  return {
    ok: true,
    status: hostStatus(
      parseAptList(doc.apt),
      { required, since, packages },
      epochSecondsToMs(doc.indexStamp),
    ),
  };
}
