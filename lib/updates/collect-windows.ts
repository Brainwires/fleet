// Windows' status document (scan.ps1: the built-in Windows Update searcher and the reboot keys,
// read-only), parsed. Untrusted text: every name clamped, every list capped (lib/updates/model.ts).
//
// The document (ConvertTo-Json; a one-element list may arrive as an object):
// `{"os":"windows","updates":[{"title":…,"kb":…,"categories":[…],"msrcSeverity":…}],
// "rebootRequired":<WindowsUpdate\Auto Update\RebootRequired exists>,"rebootPending":<Component
// Based Servicing\RebootPending exists>,"pendingFileRename":<PendingFileRenameOperations set>}`.
//
// Security = category "Security Updates" or a non-empty MsrcSeverity.

import {
  type CollectResult,
  hostStatus,
  MAX_COUNT,
  parseJsonObject,
  type PendingItem,
} from "./model.ts";

/** A list ConvertTo-Json may have flattened to its one element (or `null`). */
const asList = (v: unknown): unknown[] =>
  Array.isArray(v)
    ? v.slice(0, MAX_COUNT)
    : (v && typeof v === "object") || typeof v === "string"
    ? [v]
    : [];

/** One update's security verdict and display name. */
export function windowsItem(raw: unknown): PendingItem | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const title = typeof u.title === "string" ? u.title : "";
  if (!title) return null;
  const kb = typeof u.kb === "string" && /^(KB)?\d{4,8}$/i.test(u.kb)
    ? (u.kb.toUpperCase().startsWith("KB") ? u.kb.toUpperCase() : `KB${u.kb}`)
    : "";
  const categories = asList(u.categories).map((c) => (typeof c === "string" ? c : ""));
  const severity = typeof u.msrcSeverity === "string" ? u.msrcSeverity.trim() : "";
  const security = categories.some((c) => /^security updates$/i.test(c.trim())) || severity !== "";
  return { name: kb && !title.includes(kb) ? `${title} (${kb})` : title, security };
}

/** Parse a Windows status document. */
export function parseWindowsStatus(text: string): CollectResult {
  const doc = parseJsonObject(text);
  if (!doc || doc.os !== "windows") return { ok: false, error: "not a Windows status document" };
  if (doc.updates !== null && doc.updates !== undefined && typeof doc.updates !== "object") {
    return { ok: false, error: "no update list in the document" };
  }
  const items = asList(doc.updates).map(windowsItem).filter((x): x is PendingItem => x !== null);
  const keys = [
    doc.rebootRequired === true ? "RebootRequired" : "",
    doc.rebootPending === true ? "RebootPending" : "",
    doc.pendingFileRename === true ? "PendingFileRenameOperations" : "",
  ].filter(Boolean);
  return {
    ok: true,
    status: hostStatus(items, { required: keys.length > 0, since: null, packages: keys }, null),
  };
}
