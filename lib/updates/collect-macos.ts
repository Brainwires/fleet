// macOS's status document (`softwareupdate -l`, no root), parsed. Untrusted text: every name
// clamped, every list capped (lib/updates/model.ts).
//
// The document: `{"os":"macos","softwareupdate":"<softwareupdate -l, stdout and stderr>"}`.
//
// Each update is a `* Label: …` line and its `Title: …, Version: …, Size: …, Recommended: YES,
// Action: restart,` line. Security = a title with "Security" in it, or any macOS version update.
// A reboot is required when an update's action is restart (it can't install without one).

import {
  type CollectResult,
  hostStatus,
  outputLines,
  parseJsonObject,
  type PendingItem,
} from "./model.ts";

/** One update `softwareupdate -l` lists. */
export interface MacUpdate {
  readonly label: string;
  readonly title: string;
  readonly recommended: boolean;
  readonly restart: boolean;
}

/** The updates in `softwareupdate -l` output (the modern `Label:` / `Title:` layout). */
export function parseSoftwareUpdate(text: unknown): MacUpdate[] {
  const out: MacUpdate[] = [];
  let label: string | null = null;
  for (const line of outputLines(text)) {
    const lm = line.match(/^\s*\*\s*Label:\s*(.+?)\s*$/);
    if (lm) {
      label = lm[1];
      continue;
    }
    const tm = line.match(/^\s*Title:\s*(.*)$/);
    if (tm && label !== null) {
      const fields = new Map<string, string>();
      for (const part of tm[1].split(/,\s*/)) {
        const i = part.indexOf(":");
        if (i > 0) fields.set(part.slice(0, i).trim().toLowerCase(), part.slice(i + 1).trim());
      }
      const title = tm[1].split(",")[0].trim();
      out.push({
        label,
        title,
        recommended: /^yes$/i.test(fields.get("recommended") ?? ""),
        restart: /restart/i.test(fields.get("action") ?? ""),
      });
      label = null;
    }
  }
  return out;
}

/** Whether a macOS update is a security one (a "Security" title, or an OS version update). */
export function macSecurity(u: MacUpdate): boolean {
  return /security/i.test(u.title) || /security/i.test(u.label) || /^macOS\b/i.test(u.title) ||
    /^macOS\b/i.test(u.label);
}

/** Parse a macOS status document. */
export function parseMacStatus(text: string): CollectResult {
  const doc = parseJsonObject(text);
  if (!doc || doc.os !== "macos") return { ok: false, error: "not a macOS status document" };
  if (typeof doc.softwareupdate !== "string") {
    return { ok: false, error: "no softwareupdate output" };
  }
  const updates = parseSoftwareUpdate(doc.softwareupdate);
  const items: PendingItem[] = updates.map((u) => ({ name: u.label, security: macSecurity(u) }));
  const restart = updates.filter((u) => u.restart).map((u) => u.label);
  return {
    ok: true,
    status: hostStatus(
      items,
      { required: restart.length > 0, since: null, packages: restart },
      null,
    ),
  };
}
