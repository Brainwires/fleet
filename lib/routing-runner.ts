// Routing rules end to end on Fleet's side (lib/routing.ts has the model): read the helper's
// schema, the rules in force, the preview and the history; check a draft with the helper; ask in
// the OS dialog, naming what changes and where the next job of each class will go; then hand the
// helper the draft with Fleet's caller token on stdin. Machine access is injected (the helper run,
// the token, the dialog, the event log), so the tests run it with fakes. Nothing is saved before
// the user confirmed, and a test build (dry run) never saves.

import type { ConfirmFn, ControlResult } from "./control-runner.ts";
import type { JsonRun } from "./deno-config.ts";
import type { NewEvent } from "./events.ts";
import {
  draftOf,
  parseRoutingHistory,
  parseRoutingPreview,
  parseRoutingSchema,
  parseRoutingShow,
  previewLines,
  type RoutingChange,
  routingExitText,
  type RoutingPreview,
  type RoutingSchema,
  type RoutingShow,
  validGeneration,
  validRoutingId,
} from "./routing.ts";

/** What the routing rules need. */
export interface RoutingDeps {
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

/** The form's first load. */
export type RoutingLoad =
  | {
    ok: true;
    schema: RoutingSchema;
    show: RoutingShow;
    preview: RoutingPreview | null;
    history: RoutingChange[];
  }
  | { ok: false; message: string };

/** A save's outcome: a control result, plus the change id and the new generation. */
export type RoutingResult = ControlResult & { readonly id?: string; readonly generation?: string };

const DRY = "Dry run (test build): nothing will be saved, whichever button you press.";
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const firstMessage = (r: JsonRun): string => {
  const j = obj(r.json);
  const m = typeof j.message === "string" ? j.message : "";
  const e = Array.isArray(j.errors) ? j.errors[0] : undefined;
  return String(m || e || r.err || "").replace(/\s+/g, " ").slice(0, 240);
};

/** The schema, the rules in force, where each class's next job goes now, and the newest changes. */
export async function routingLoad(deps: RoutingDeps): Promise<RoutingLoad> {
  const [s, sh, pv, h] = await Promise.all([
    deps.run(["--schema"]),
    deps.run(["--show"]),
    deps.run(["--preview", "--live"]),
    deps.run(["--history", "--limit", "20"]),
  ]);
  const schema = s.code === 0 ? parseRoutingSchema(s.json) : null;
  if (!schema) {
    return {
      ok: false,
      message: `The routing helper gave no schema (${firstMessage(s) || routingExitText(s.code)}).`,
    };
  }
  const show = sh.code === 0 ? parseRoutingShow(sh.json) : null;
  if (!show) {
    return {
      ok: false,
      message: `The routing helper gave no rules (${
        firstMessage(sh) || routingExitText(sh.code)
      }).`,
    };
  }
  return {
    ok: true,
    schema,
    show,
    preview: parseRoutingPreview(pv.json),
    history: h.code === 0 ? parseRoutingHistory(h.json) : [],
  };
}

/** Check a draft and preview it: the helper's errors and warnings, and where the next job of each class would go. */
export async function routingCheck(deps: RoutingDeps, raw: unknown): Promise<RoutingPreview> {
  const draft = draftOf(obj(raw).draft);
  if (!draft) {
    return {
      ok: false,
      errors: ["The draft isn't a rules document (or is too large)."],
      warnings: [],
      classes: [],
    };
  }
  const r = await deps.run(["--preview"], JSON.stringify(draft));
  return parseRoutingPreview(r.json) ??
    { ok: false, errors: [firstMessage(r) || routingExitText(r.code)], warnings: [], classes: [] };
}

async function logIt(deps: RoutingDeps, ok: boolean, text: string): Promise<void> {
  await deps.log({
    repo: "",
    workflow: "routing rules",
    job: null,
    url: null,
    sev: ok ? "info" : "bad",
    kind: "action",
    text,
  });
}

/** Save a draft: the helper's check, the OS dialog (what changes; where the next jobs go), then the helper. */
export async function runRoutingApply(deps: RoutingDeps, raw: unknown): Promise<RoutingResult> {
  const r = obj(raw);
  if (!validGeneration(r.generation)) return { ok: false, message: "No rules generation." };
  const draft = draftOf(r.draft);
  if (!draft) {
    return {
      ok: false,
      refused: true,
      message: "The draft isn't a rules document (or is too large).",
    };
  }
  const body = JSON.stringify(draft);
  const preview = await routingCheck(deps, { draft });
  if (!preview.ok) {
    return {
      ok: false,
      refused: true,
      message: `Not valid: ${preview.errors.slice(0, 3).join("; ")}`,
    };
  }
  // What would change, in the helper's own words (nothing is written by a dry run).
  const plan = await deps.run([
    "--apply",
    "--generation",
    r.generation,
    "--actor",
    deps.actor,
    "--dry-run",
  ], body);
  const pj = obj(plan.json);
  if (plan.code !== 0) {
    return {
      ok: false,
      refused: plan.code === 2 || plan.code === 3,
      message: `${routingExitText(plan.code)}${
        firstMessage(plan) ? `: ${firstMessage(plan)}` : ""
      }`,
    };
  }
  if (pj.changed === false) {
    return { ok: true, message: "Nothing to change: the rules are already these." };
  }
  const summary = typeof pj.summary === "string"
    ? pj.summary.replace(/\s+/g, " ").slice(0, 600)
    : "";
  const yes = await deps.confirm({
    title: "Fleet",
    message: `Save the routing rules?${summary ? ` ${summary}.` : ""}`,
    detail: [
      "The scheduler reads them at the start of its next tick: jobs already running are not moved or stopped.",
      `With these rules, right now:\n${previewLines(preview).join("\n")}`,
      ...(preview.warnings.length ? [`Warnings: ${preview.warnings.join("; ")}`] : []),
      ...(deps.dryRun ? [DRY] : []),
    ].join("\n\n"),
    buttons: ["Save rules", "Don't"],
    defaultId: 1,
    cancelId: 1,
    kind: "warning",
  });
  if (yes !== 0) return { ok: false, cancelled: true, message: "Not done." };
  if (deps.dryRun) return { ok: false, message: "Dry run: nothing was saved." };
  const token = deps.token();
  if (!token) {
    return { ok: false, message: "Fleet couldn't make its caller token in its data folder." };
  }
  const out = await deps.run([
    "--apply",
    "--generation",
    r.generation,
    "--actor",
    deps.actor,
    "--token-stdin",
  ], `${token}\n${body}`);
  const j = obj(out.json);
  if (out.code === 0 && j.accepted === true && validRoutingId(j.id)) {
    await logIt(deps, true, `routing rules ${j.id} saved: ${summary || "changed"}`);
    return {
      ok: true,
      id: j.id,
      generation: validGeneration(j.generation) ? j.generation : undefined,
      message: `Saved (${j.id}); the scheduler uses them from its next tick.`,
    };
  }
  if (out.code === 0 && j.changed === false) {
    return { ok: true, message: "Nothing to change: the rules are already these." };
  }
  const why = firstMessage(out);
  await logIt(
    deps,
    false,
    `routing rules refused: ${routingExitText(out.code)}${why ? ` (${why})` : ""}`,
  );
  return { ok: false, message: `${routingExitText(out.code)}${why ? `: ${why}` : ""}` };
}

/** Revert the newest change: the OS dialog, then the helper. */
export async function runRoutingRevert(deps: RoutingDeps, raw: unknown): Promise<RoutingResult> {
  const r = obj(raw);
  if (!validRoutingId(r.id)) return { ok: false, message: "No change to revert." };
  if (!validGeneration(r.generation)) return { ok: false, message: "No rules generation." };
  const yes = await deps.confirm({
    title: "Fleet",
    message: `Revert routing change ${r.id}?`,
    detail: [
      "The rules it replaced are written back (checked the same way; the scheduler uses them from its next tick). Only the newest change can be reverted.",
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
  const out = await deps.run([
    "--revert",
    r.id,
    "--generation",
    r.generation,
    "--actor",
    deps.actor,
    "--token-stdin",
  ], `${token}\n`);
  const j = obj(out.json);
  if (out.code === 0 && j.accepted === true && validRoutingId(j.id)) {
    await logIt(deps, true, `routing rules ${r.id} reverted as ${j.id}`);
    return {
      ok: true,
      id: j.id,
      generation: validGeneration(j.generation) ? j.generation : undefined,
      message: `Reverted (${j.id}).`,
    };
  }
  const why = firstMessage(out);
  await logIt(deps, false, `routing revert refused: ${routingExitText(out.code)}`);
  return { ok: false, message: `${routingExitText(out.code)}${why ? `: ${why}` : ""}` };
}
