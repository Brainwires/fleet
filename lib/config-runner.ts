// Runner settings (lib/runner-config.ts) end to end on Fleet's side: read the helper's schema and
// values, check a draft locally and with the helper, ask in the OS dialog, then hand the helper the
// change with Fleet's token on stdin; follow its status; revert the newest change. Machine access is
// injected (the helper run, the token, the dialog, the event log), so the tests run it with fakes.
// Nothing is applied before the user confirmed, and a test build (dry run) never applies.

import type { ConfirmFn, ControlResult } from "./control-runner.ts";
import type { NewEvent } from "./events.ts";
import type { JsonRun } from "./deno-config.ts";
import {
  applyArgs,
  type ChangeRecord,
  checkArgs,
  checkDraft,
  type ConfigSchema,
  type ConfigShow,
  confirmText,
  exitText,
  parseChange,
  parseHistory,
  parseSchema,
  parseShow,
  revertArgs,
  validChangeId,
  validChanges,
  validGeneration,
  type ValueChange,
} from "./runner-config.ts";

/** What the runner settings need. */
export interface ConfigDeps {
  /** Run the helper with argv (and stdin when given). */
  run(args: readonly string[], input?: string): Promise<JsonRun>;
  /** Fleet's caller token (made on first use), or `null` when it can't be had. */
  token(): string | null;
  confirm: ConfirmFn;
  log(e: Omit<NewEvent, "at" | "user">): Promise<void>;
  /** Who acts, for the helper's audit (a login name). */
  actor: string;
  dryRun?: boolean;
}

/** A change's outcome: a control result, plus the change id the helper accepted. */
export type ConfigResult = ControlResult & { readonly id?: string };

const DRY = "Dry run (test build): nothing will be applied, whichever button you press.";
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const firstMessage = (r: JsonRun): string => {
  const j = obj(r.json);
  const m = typeof j.message === "string" ? j.message : "";
  const e = Array.isArray(j.errors) ? obj(j.errors[0]).message : undefined;
  return String(m || e || r.err || "").replace(/\s+/g, " ").slice(0, 240);
};

/** The schema, or why not. */
export async function configSchema(
  deps: ConfigDeps,
): Promise<{ ok: true; schema: ConfigSchema } | { ok: false; message: string }> {
  const r = await deps.run(["--schema"]);
  const schema = r.code === 0 ? parseSchema(r.json) : null;
  return schema
    ? { ok: true, schema }
    : { ok: false, message: `The configuration helper gave no schema (${exitText(r.code)}).` };
}

/** The live values, or why not. */
export async function configShow(
  deps: ConfigDeps,
): Promise<{ ok: true; show: ConfigShow } | { ok: false; message: string }> {
  const r = await deps.run(["--show"]);
  const show = parseShow(r.json);
  return show
    ? { ok: true, show }
    : { ok: false, message: `The configuration helper gave no values (${exitText(r.code)}).` };
}

/** The helper's own check of a change (no lock, nothing written). */
export async function configCheck(
  deps: ConfigDeps,
  raw: unknown,
): Promise<{ ok: boolean; errors: string[]; warnings: string[] }> {
  const s = await configSchema(deps);
  if (!s.ok) return { ok: false, errors: [s.message], warnings: [] };
  const v = validChanges(s.schema, obj(raw).changes);
  if (!v.ok) return { ok: false, errors: [v.message], warnings: [] };
  const r = await deps.run(checkArgs(v.changes));
  const j = obj(r.json);
  const msgs = (x: unknown) =>
    Array.isArray(x) ? x.map((e) => String(obj(e).message ?? "")).filter(Boolean).slice(0, 10) : [];
  if (r.code === 0 && j.ok === true) return { ok: true, errors: [], warnings: msgs(j.warnings) };
  const errors = msgs(j.errors);
  return {
    ok: false,
    errors: errors.length ? errors : [firstMessage(r) || exitText(r.code)],
    warnings: msgs(j.warnings),
  };
}

async function logIt(deps: ConfigDeps, ok: boolean, text: string): Promise<void> {
  await deps.log({
    repo: "",
    workflow: "runner settings",
    job: null,
    url: null,
    sev: ok ? "info" : "bad",
    kind: "action",
    text,
  });
}

const changeLine = (cs: readonly ValueChange[]) =>
  cs.map((c) => `${c.key} ${c.from}→${c.to}`).join(", ").slice(0, 300);

/** Apply a change: the guardrails, the OS dialog, then the helper (asynchronous: it verifies). */
export async function runConfigApply(deps: ConfigDeps, raw: unknown): Promise<ConfigResult> {
  const r = obj(raw);
  if (!validGeneration(r.generation)) return { ok: false, message: "No settings generation." };
  const s = await configSchema(deps);
  if (!s.ok) return { ok: false, message: s.message };
  const v = validChanges(s.schema, r.changes);
  if (!v.ok) return { ok: false, refused: true, message: v.message };
  const shown = await configShow(deps);
  if (!shown.ok) return { ok: false, message: shown.message };
  if (shown.show.generation !== r.generation) {
    return {
      ok: false,
      refused: true,
      message: "The runner settings changed since this form was loaded. Reload them and try again.",
    };
  }
  if (!shown.show.values) {
    return {
      ok: false,
      refused: true,
      message: "The live settings file is invalid: fix it first.",
    };
  }
  // The changes' "from" are the live values (never the page's word for them).
  const changes = v.changes.map((c) => ({ ...c, from: shown.show.values![c.key] ?? "" }));
  const draft: Record<string, string> = { ...shown.show.values };
  for (const c of changes) draft[c.key] = c.to;
  const local = checkDraft(s.schema, draft);
  if (!local.ok) {
    const why = [...Object.entries(local.fields).map(([k, m]) => `${k}: ${m}`), ...local.errors];
    return { ok: false, refused: true, message: `Not valid: ${why.slice(0, 3).join("; ")}` };
  }
  const check = await configCheck(deps, { changes });
  if (!check.ok) {
    return { ok: false, refused: true, message: `Refused: ${check.errors.slice(0, 3).join("; ")}` };
  }
  const text = confirmText(s.schema, changes);
  const warn = check.warnings.length ? [`Warnings: ${check.warnings.join("; ")}`] : [];
  const yes = await deps.confirm({
    title: "Fleet",
    message: text.message,
    detail: [text.detail, ...warn, ...(deps.dryRun ? [DRY] : [])].join("\n\n"),
    buttons: ["Apply settings", "Don't"],
    defaultId: 1,
    cancelId: 1,
    kind: "warning",
  });
  if (yes !== 0) return { ok: false, cancelled: true, message: "Not done." };
  if (deps.dryRun) return { ok: false, message: "Dry run: nothing was applied." };
  const token = deps.token();
  if (!token) {
    return { ok: false, message: "Fleet couldn't make its caller token in its data folder." };
  }
  const out = await deps.run(applyArgs(r.generation, changes, deps.actor), `${token}\n`);
  const j = obj(out.json);
  const id = validChangeId(j.id) ? j.id : undefined;
  if (out.code === 0 && j.accepted === true && id) {
    await logIt(deps, true, `runner settings ${id} accepted: ${changeLine(changes)}`);
    return {
      ok: true,
      id,
      message: `Accepted (${id}); the scheduler picks it up at its next tick.`,
    };
  }
  if (out.code === 0 && j.changed === false) {
    return { ok: true, message: "Nothing to change: the values are already these." };
  }
  const why = firstMessage(out);
  await logIt(
    deps,
    false,
    `runner settings refused: ${exitText(out.code)}${why ? ` (${why})` : ""}`,
  );
  return { ok: false, message: `${exitText(out.code)}${why ? `: ${why}` : ""}` };
}

/** Revert the newest applied change: the OS dialog, then the helper. */
export async function runConfigRevert(deps: ConfigDeps, raw: unknown): Promise<ConfigResult> {
  const r = obj(raw);
  if (!validChangeId(r.id)) return { ok: false, message: "No change to revert." };
  if (!validGeneration(r.generation)) return { ok: false, message: "No settings generation." };
  const st = await configStatus(deps, { id: r.id });
  const what = st ? changeLine(st.changes) : "";
  const yes = await deps.confirm({
    title: "Fleet",
    message: `Revert runner settings change ${r.id}?${what ? ` It puts back: ${what}.` : ""}`,
    detail: [
      "The previous values are written back the same way (checked, applied at the next tick, " +
      "verified). Only the newest change can be reverted.",
      ...(deps.dryRun ? [DRY] : []),
    ].join("\n\n"),
    buttons: ["Revert", "Don't"],
    defaultId: 1,
    cancelId: 1,
    kind: "warning",
  });
  if (yes !== 0) return { ok: false, cancelled: true, message: "Not done." };
  if (deps.dryRun) return { ok: false, message: "Dry run: nothing was reverted." };
  const token = deps.token();
  if (!token) {
    return { ok: false, message: "Fleet couldn't make its caller token in its data folder." };
  }
  const out = await deps.run(revertArgs(r.id, r.generation, deps.actor), `${token}\n`);
  const j = obj(out.json);
  const id = validChangeId(j.id) ? j.id : undefined;
  if (out.code === 0 && j.accepted === true && id) {
    await logIt(deps, true, `runner settings ${r.id} reverted as ${id}`);
    return { ok: true, id, message: `Revert accepted (${id}).` };
  }
  const why = firstMessage(out);
  await logIt(deps, false, `runner settings revert refused: ${exitText(out.code)}`);
  return { ok: false, message: `${exitText(out.code)}${why ? `: ${why}` : ""}` };
}

/** One change's status (the page polls it while the helper verifies), or `null`. */
export async function configStatus(deps: ConfigDeps, raw: unknown): Promise<ChangeRecord | null> {
  const id = obj(raw).id;
  if (!validChangeId(id)) return null;
  const r = await deps.run(["--status", id]);
  return r.code === 0 ? parseChange(r.json) : null;
}

/** The newest changes (newest first). */
export async function configHistory(deps: ConfigDeps): Promise<ChangeRecord[]> {
  const r = await deps.run(["--history", "--limit", "20"]);
  return r.code === 0 ? parseHistory(r.json) : [];
}
