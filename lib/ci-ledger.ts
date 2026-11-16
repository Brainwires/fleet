// The CI ledger: what the `ci` MCP server (mcp/ci-mcp.ts) writes beside the runner scheduler's
// health file (the scheduler's folder), and what the Fleet app reads back. Two append-only JSONL files:
//
// - `ci-audit.log`: one line per mutating call (dispatch, re-run, cancel), refused ones included,
//   with the agent that made it (`owner`) and why (`purpose`). It is also the ledger every `ci`
//   server process reads for ownership (who dispatched run N) and in-flight de-duplication, since
//   each agent runs its own server process.
// - `ci-notices.jsonl`: a watch's outcome (`ci_watch`), addressed to its owner.
//
// Fleet logs each new line as an event (kind `action`, so the event stream and fleet_events carry
// it to the owner's monitor) and shows a run's owner and purpose on its card. Pure apart from the
// file tail at the bottom. Owners, reasons and refusals are agent-written text: capped and stripped
// of control characters like every other free-text field Fleet shows.

import { capText } from "./agent-snapshot.ts";
import type { NewEvent } from "./events.ts";

/** The audit log's name in the runner scheduler's folder. */
export const CI_AUDIT_FILE = "ci-audit.log";
/** The watch notices' name in the same folder. */
export const CI_NOTICES_FILE = "ci-notices.jsonl";
/** Past this size a file is rotated to `<name>.1` (one kept) by the writer. */
export const CI_LEDGER_MAX_BYTES = 8 * 1024 * 1024;
/** A reader starting cold reads at most this much of a file's end. */
export const CI_LEDGER_READ_MAX = 2 * 1024 * 1024;

/** What a run was dispatched (or re-run) for. */
export const CI_PURPOSES = ["pre-test", "release-gate", "diagnostic", "rerun"] as const;
export type CiPurpose = typeof CI_PURPOSES[number];

/** An agent id: letters, digits and `._:@/-`, 1–64 characters. */
export const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,63}$/;

/** One audit line: a mutating call and its outcome. */
export interface CiAuditRecord {
  readonly v: 1;
  readonly kind: "audit";
  /** Epoch ms. */
  readonly at: number;
  readonly op: "dispatch" | "rerun" | "cancel";
  /** Done (`true`), or refused / failed (`false`, `refused` says why). */
  readonly ok: boolean;
  readonly owner: string;
  readonly purpose: string;
  readonly repo: string;
  /** The run it made or acted on (`null` when unknown, e.g. a refused dispatch). */
  readonly run_id: number | null;
  readonly workflow?: string;
  readonly ref?: string;
  readonly sha?: string;
  /** Dispatch: the inputs' canonical JSON (the de-duplication key's part). */
  readonly inputs?: string;
  /** Dispatch: answered with an in-flight run instead of a new one. */
  readonly deduped?: boolean;
  /** Re-run: what was asked and what GitHub was asked to do. */
  readonly jobs?: string;
  readonly reroute?: string;
  /** Cancel: why, and the run that replaces it. */
  readonly reason?: string;
  readonly superseded_by?: number | null;
  readonly refused?: string;
  readonly url?: string | null;
}

/** One notice line: a watch fired. */
export interface CiNoticeRecord {
  readonly v: 1;
  readonly kind: "notice";
  readonly at: number;
  readonly watch_id: string;
  readonly owner: string;
  readonly repo: string;
  readonly run_id: number;
  readonly outcome: "failure" | "completed" | "expired";
  readonly conclusion: string | null;
  readonly failed_jobs: readonly string[];
  readonly url?: string | null;
}

export type CiRecord = CiAuditRecord | CiNoticeRecord;

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" ? capText(v, max) : undefined;
const int = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : null;

/** The optional text fields of an audit line and their caps. */
const AUDIT_TEXT: readonly (readonly [keyof CiAuditRecord, number])[] = [
  ["workflow", 120],
  ["ref", 200],
  ["sha", 40],
  ["jobs", 300],
  ["reroute", 300],
  ["reason", 300],
  ["refused", 300],
  ["url", 300],
];

const OPS = new Set(["dispatch", "rerun", "cancel"]);
const OUTCOMES = new Set(["failure", "completed", "expired"]);

function auditOf(r: Record<string, unknown>, owner: string, repo: string): CiAuditRecord | null {
  if (!OPS.has(r.op as string)) return null;
  const out: Record<string, unknown> = {
    v: 1,
    kind: "audit",
    at: r.at,
    op: r.op,
    ok: r.ok === true,
    owner,
    purpose: str(r.purpose, 40) ?? "",
    repo,
    run_id: int(r.run_id),
  };
  for (const [k, max] of AUDIT_TEXT) {
    const v = str(r[k], max);
    if (v !== undefined) out[k] = v;
  }
  if (typeof r.inputs === "string") out.inputs = r.inputs.slice(0, 4000);
  if (r.deduped === true) out.deduped = true;
  if (r.superseded_by !== undefined) out.superseded_by = int(r.superseded_by);
  return out as unknown as CiAuditRecord;
}

function noticeOf(r: Record<string, unknown>, owner: string, repo: string): CiNoticeRecord | null {
  const runId = int(r.run_id);
  if (runId === null || typeof r.watch_id !== "string" || !OUTCOMES.has(r.outcome as string)) {
    return null;
  }
  const failed = Array.isArray(r.failed_jobs) ? r.failed_jobs : [];
  const url = str(r.url, 300);
  return {
    v: 1,
    kind: "notice",
    at: r.at as number,
    watch_id: capText(r.watch_id, 40),
    owner,
    repo,
    run_id: runId,
    outcome: r.outcome as CiNoticeRecord["outcome"],
    conclusion: str(r.conclusion, 40) ?? null,
    failed_jobs: failed.filter((x): x is string => typeof x === "string").slice(0, 10)
      .map((x) => capText(x, 120)),
    ...(url !== undefined ? { url } : {}),
  };
}

/** One line as a record, or `null` (garbled, another version, a field out of shape). */
export function parseCiLine(line: string): CiRecord | null {
  let r: unknown;
  try {
    r = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof r !== "object" || r === null || Array.isArray(r)) return null;
  const o = r as Record<string, unknown>;
  if (o.v !== 1 || typeof o.at !== "number" || !Number.isFinite(o.at)) return null;
  const owner = str(o.owner, 64);
  const repo = str(o.repo, 140);
  if (!owner || repo === undefined) return null;
  if (o.kind === "audit") return auditOf(o, owner, repo);
  return o.kind === "notice" ? noticeOf(o, owner, repo) : null;
}

/** Every record in a chunk of JSONL text (garbled lines skipped). */
export function parseCiText(text: string): CiRecord[] {
  const out: CiRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const r = parseCiLine(line);
    if (r) out.push(r);
  }
  return out;
}

const short = (sha: string | undefined) => (sha ? sha.slice(0, 7) : "");
const tail = (r: string) => r.split("/").pop() ?? r;

const NOTICE_SEV = { failure: "bad", expired: "muted" } as const;

function noticeEvent(r: CiNoticeRecord): NewEvent {
  const what = r.outcome === "failure"
    ? `failed${r.failed_jobs.length ? `: ${r.failed_jobs.join(", ")}` : ""}`
    : r.outcome === "expired"
    ? "watch expired before the run finished"
    : `completed${r.conclusion ? ` (${r.conclusion})` : ""}`;
  const sev = r.outcome === "completed"
    ? (r.conclusion === "success" ? "ok" : "warn")
    : NOTICE_SEV[r.outcome];
  return {
    at: r.at,
    sev,
    kind: "action",
    repo: r.repo,
    workflow: "",
    job: null,
    text: capText(`ci[${r.owner}] watch ${r.watch_id}: run ${r.run_id} ${what}`, 300),
    url: r.url ?? null,
    run_id: r.run_id,
  };
}

/** A successful dispatch's line. */
function dispatchText(r: CiAuditRecord, run: string): string {
  const what = `${tail(r.workflow ?? "")} on ${r.ref} @${short(r.sha)}`;
  return r.deduped
    ? `dispatch of ${what} joined in-flight${run} (${r.purpose})`
    : `dispatched ${what} (${r.purpose})${run ? ` →${run}` : ""}`;
}

/** What an audit line says, after `ci[<owner>]`. */
function auditText(r: CiAuditRecord): string {
  const run = r.run_id ? ` run ${r.run_id}` : "";
  if (!r.ok) return `${r.op} refused${run}${r.ref ? ` on ${r.ref}` : ""}: ${r.refused ?? "?"}`;
  if (r.op === "dispatch") return dispatchText(r, run);
  if (r.op === "rerun") return `re-ran${run} (${r.jobs ?? "failed"}; ${r.reroute ?? "no reroute"})`;
  const by = r.superseded_by ? ` (superseded by run ${r.superseded_by})` : "";
  return `cancelled${run}: ${r.reason ?? ""}${by}`;
}

/** A record as a Fleet event line (kind `action`; refusals warn, a failed watch is bad). */
export function ciEvent(r: CiRecord): NewEvent {
  if (r.kind === "notice") return noticeEvent(r);
  return {
    at: r.at,
    sev: r.ok ? "info" : "warn",
    kind: "action",
    repo: r.repo,
    workflow: r.workflow ? tail(r.workflow) : "",
    job: null,
    text: capText(`ci[${r.owner}] ${auditText(r)}`, 300),
    url: r.url ?? null,
    ...(r.run_id ? { run_id: r.run_id } : {}),
    ...(r.ref ? { branch: capText(r.ref, 120) } : {}),
  };
}

/** Who a run belongs to, as its card shows it. */
export interface CiOwnership {
  readonly owner: string;
  readonly purpose: string;
}

/**
 * Run id → owner and purpose: the latest successful dispatch / re-run naming the run (a re-run by
 * another agent takes it over; a de-duplicated dispatch, a cancel or a refusal changes nothing).
 */
export function ownershipOf(records: Iterable<CiRecord>): Map<number, CiOwnership> {
  const out = new Map<number, CiOwnership>();
  for (const r of records) {
    if (r.kind !== "audit" || !r.ok || r.run_id === null || r.deduped) continue;
    if (r.op !== "dispatch" && r.op !== "rerun") continue;
    out.set(r.run_id, { owner: r.owner, purpose: r.purpose });
  }
  return out;
}

// ---- the file tail (Deno I/O) ----

interface TailState {
  ino: number | null;
  offset: number;
}

/**
 * A reader over the ledger files in `dir` (the runner scheduler's folder): each call returns the
 * records appended since the previous one, oldest first; the first call returns what the files hold
 * (at most their last {@linkcode CI_LEDGER_READ_MAX} bytes each). A rotated or truncated file is
 * read again from its start. Missing files are nothing.
 */
export function ciLedgerTail(dir: string): () => Promise<CiRecord[]> {
  const states = new Map<string, TailState>();
  const one = async (name: string): Promise<CiRecord[]> => {
    const path = `${dir.replace(/\/$/, "")}/${name}`;
    let st: Deno.FileInfo;
    try {
      st = await Deno.stat(path);
    } catch {
      states.delete(name);
      return [];
    }
    let s = states.get(name);
    if (!s || s.ino !== st.ino || st.size < s.offset) {
      s = { ino: st.ino, offset: Math.max(0, st.size - CI_LEDGER_READ_MAX) };
    }
    if (st.size === s.offset) {
      states.set(name, s);
      return [];
    }
    const file = await Deno.open(path, { read: true });
    let bytes: Uint8Array;
    try {
      await file.seek(s.offset, Deno.SeekMode.Start);
      bytes = new Uint8Array(st.size - s.offset);
      let off = 0;
      while (off < bytes.length) {
        const n = await file.read(bytes.subarray(off));
        if (n === null) break;
        off += n;
      }
      bytes = bytes.subarray(0, off);
    } finally {
      file.close();
    }
    const end = bytes.lastIndexOf(0x0a);
    if (end < 0) {
      states.set(name, s);
      return [];
    }
    const text = new TextDecoder().decode(bytes.subarray(0, end));
    s = { ino: s.ino, offset: s.offset + end + 1 };
    states.set(name, s);
    return parseCiText(text);
  };
  return async () => {
    const out = [...await one(CI_AUDIT_FILE), ...await one(CI_NOTICES_FILE)];
    return out.sort((a, b) => a.at - b.at);
  };
}

/**
 * The ledger's folder: the runner scheduler's, i.e. the folder of its local health file (`~/` is
 * `home`); `null` without the integration.
 */
export function ciLedgerDir(
  healthFile: string | null | undefined,
  home: string | null,
): string | null {
  if (!healthFile) return null;
  const path = healthFile.startsWith("~/")
    ? (home ? `${home}/${healthFile.slice(2)}` : null)
    : healthFile;
  if (!path || !path.includes("/")) return null;
  return path.slice(0, path.lastIndexOf("/")) || null;
}

/** A tail that follows `dirOf()` (a settings change starts a new one); nothing while it's `null`. */
export function ciLedgerReader(dirOf: () => string | null): () => Promise<CiRecord[]> {
  let cur: { dir: string; read: () => Promise<CiRecord[]> } | null = null;
  return () => {
    const dir = dirOf();
    if (!dir) {
      cur = null;
      return Promise.resolve([]);
    }
    if (cur?.dir !== dir) cur = { dir, read: ciLedgerTail(dir) };
    return cur.read();
  };
}
