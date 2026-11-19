// Routing rules: WHICH pool takes WHICH job. The scheduler's routing helper (settings
// `integrations.runnerScheduler.controls.routingHelper`) owns the rules, their JSON Schema, the
// check, the preview and every save; Fleet shows a form built from that schema, checks a draft with
// the helper, and reads its JSON answers. Pure: no I/O here (lib/routing-runner.ts runs the helper;
// app/routing-form.tsx renders the form). No pool, label or class name lives in this file.

/** A class of jobs and the pools that serve it, most preferred first. */
export interface RouteClass {
  id: string;
  title?: string;
  match: { labels?: string[]; job?: string; repo?: string; workflow?: string };
  order: string[];
}

/** The rules document (the helper's schema says exactly what is valid). */
export interface RoutingRules {
  version: number;
  note?: string;
  classes: RouteClass[];
  pools?: Record<string, { onlyWhenIdle?: string[]; never?: string[] }>;
  machines?: Record<string, { pools: string[]; maxJobs?: number }>;
}

/** A node of the helper's JSON Schema (the subset the form reads). */
export interface SchemaNode {
  readonly type?: string;
  readonly title?: string;
  readonly description?: string;
  readonly const?: unknown;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly required?: readonly string[];
  readonly properties?: Readonly<Record<string, SchemaNode>>;
  readonly additionalProperties?: SchemaNode | boolean;
  readonly propertyNames?: SchemaNode;
  readonly items?: SchemaNode;
  readonly anyOf?: readonly SchemaNode[];
  readonly $ref?: string;
  readonly "x-widget"?: string;
}

/** A pool the form can offer. */
export interface PoolChoice {
  readonly name: string;
  readonly label: string;
  readonly labels: readonly string[];
  readonly slots: number;
}

/** The helper's `--schema` answer. */
export interface RoutingSchema {
  readonly schema: SchemaNode & { readonly $defs?: Readonly<Record<string, SchemaNode>> };
  readonly pools: readonly PoolChoice[];
}

/** The helper's `--show` answer. */
export interface RoutingShow {
  readonly file: string;
  readonly isDefault: boolean;
  readonly generation: string;
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly rules: RoutingRules | null;
}

/** Where a class's next job goes, and why each place can or cannot take it. */
export interface PreviewClass {
  readonly classId: string;
  readonly title: string;
  /** A pool, `github`, or `null`: it waits for one of our pools. */
  readonly next: string | null;
  readonly github: boolean;
  readonly candidates: readonly {
    readonly target: string;
    readonly ok: boolean;
    readonly why: string;
  }[];
  readonly note: string | null;
}

/** The helper's `--preview` answer (also the check: `ok`, `errors`, `warnings`). */
export interface RoutingPreview {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly classes: readonly PreviewClass[];
}

/** One saved change. */
export interface RoutingChange {
  readonly id: string;
  readonly at: string;
  readonly actor: string;
  readonly via: string;
  readonly kind: string;
  readonly summary: string;
}

/** The most a draft may weigh on its way to the helper (its own limit is 64 KiB). */
export const MAX_DRAFT_BYTES = 60_000;
const CHANGE_ID = /^rt-\d{8}-\d{6}-[0-9a-f]{4,8}$/;
const SHA = /^[0-9a-f]{64}$/;

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number): string =>
  // deno-lint-ignore no-control-regex
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
const texts = (v: unknown, max: number, each: number): string[] =>
  Array.isArray(v) ? v.slice(0, max).map((x) => text(x, each)).filter(Boolean) : [];

export const validGeneration = (v: unknown): v is string => typeof v === "string" && SHA.test(v);
export const validRoutingId = (v: unknown): v is string =>
  typeof v === "string" && CHANGE_ID.test(v);

/** The helper's `--schema` answer, or `null`. */
export function parseRoutingSchema(raw: unknown): RoutingSchema | null {
  const r = obj(raw);
  const schema = obj(r.schema);
  if (r.ok !== true || schema.type !== "object" || !Array.isArray(r.pools)) return null;
  // A schema is plain JSON; cap its size rather than walk it (the form reads known keys only).
  if (JSON.stringify(schema).length > 100_000) return null;
  const pools = r.pools.slice(0, 100).map(obj).map((p) => ({
    name: text(p.name, 64),
    label: text(p.label, 100),
    labels: texts(p.labels, 16, 100),
    slots: typeof p.slots === "number" && Number.isFinite(p.slots)
      ? Math.max(0, Math.min(64, p.slots))
      : 1,
  })).filter((p) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(p.name));
  return { schema: schema as RoutingSchema["schema"], pools };
}

/** A rules document's shape, kept as given (the helper validates; this only bounds it). */
export function draftOf(raw: unknown): RoutingRules | null {
  const r = obj(raw);
  if (!Array.isArray(r.classes)) return null;
  let size: number;
  try {
    size = JSON.stringify(r).length;
  } catch {
    return null;
  }
  return size <= MAX_DRAFT_BYTES ? r as unknown as RoutingRules : null;
}

/** The helper's `--show` answer, or `null`. */
export function parseRoutingShow(raw: unknown): RoutingShow | null {
  const r = obj(raw);
  if (r.ok !== true || !validGeneration(r.generation)) return null;
  return {
    file: text(r.file, 400),
    isDefault: r.is_default === true,
    generation: r.generation,
    valid: r.valid === true,
    errors: texts(r.errors, 20, 300),
    warnings: texts(r.warnings, 20, 300),
    rules: r.rules ? draftOf(r.rules) : null,
  };
}

/** The helper's `--preview` answer, or `null` when it isn't one. */
export function parseRoutingPreview(raw: unknown): RoutingPreview | null {
  const r = obj(raw);
  if (typeof r.ok !== "boolean") return null;
  return {
    ok: r.ok,
    errors: texts(r.errors, 20, 300),
    warnings: texts(r.warnings, 20, 300),
    classes: (Array.isArray(r.classes) ? r.classes.slice(0, 60) : []).map(obj).map((c) => ({
      classId: text(c.class, 40),
      title: text(c.title, 80) || text(c.class, 40),
      next: typeof c.next === "string" ? text(c.next, 64) : null,
      github: c.github === true,
      candidates: (Array.isArray(c.candidates) ? c.candidates.slice(0, 12) : []).map(obj).map((
        x,
      ) => ({
        target: text(x.target, 64),
        ok: x.ok === true,
        why: text(x.why, 240),
      })),
      note: typeof c.note === "string" ? text(c.note, 240) : null,
    })).filter((c) => c.classId),
  };
}

/** The helper's `--history` answer (newest first). */
export function parseRoutingHistory(raw: unknown): RoutingChange[] {
  return (Array.isArray(raw) ? raw.slice(0, 100) : []).map(obj).filter((c) => validRoutingId(c.id))
    .map((c) => ({
      id: c.id as string,
      at: text(c.at, 40),
      actor: text(c.actor, 40),
      via: text(c.via, 16),
      kind: text(c.kind, 16),
      summary: text(c.summary, 600),
    }));
}

/** Where the next job of each class goes, one line each ("Windows → win-pc"). */
export function previewLines(p: RoutingPreview, max = 12): string[] {
  return p.classes.slice(0, max).map((c) =>
    `${c.title} → ${
      c.next === null ? "waits for our pools" : c.next === "github" ? "GitHub-hosted" : c.next
    }`
  );
}

/** A helper exit code in plain words. */
export function routingExitText(code: number): string {
  switch (code) {
    case 0:
      return "done";
    case 2:
      return "refused: not valid";
    case 3:
      return "refused: the rules changed since they were read (reload and try again)";
    case 8:
      return "busy: another routing change holds the lock (try again shortly)";
    case 9:
      return "refused: the helper accepts changes only from Fleet or a terminal";
    case -1:
      return "the routing helper could not be started";
    default:
      return `the routing helper failed (exit ${code})`;
  }
}
