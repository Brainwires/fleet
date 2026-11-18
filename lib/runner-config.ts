// Runner scheduler configuration ("Level A"): the scheduler's own helper program (settings
// `integrations.runnerScheduler.controls.configHelper`) owns the values, their schema and every
// change; Fleet only shows them, checks a draft the same way, builds the helper's argv and reads its
// JSON answers. Pure: no I/O here (lib/control-runner.ts runs the helper; the page renders the form).
// No knob, pool or host name lives in this file: they all come from the helper's schema at run time.

/** A knob's value type. */
export type KnobType = "int" | "bool";

/** One editable value, as the helper's schema describes it. */
export interface Knob {
  readonly key: string;
  readonly title: string;
  /** `pool`: one pool's (see `pool`); `group` / `fleet`: shared (see `group`). */
  readonly scope: "pool" | "group" | "fleet";
  readonly pool: string;
  readonly group: string;
  readonly type: KnobType;
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly help: string;
  readonly needsIdle: boolean;
}

/** A rule operand: a number, a knob, a constant, or a sum / product / min / max of operands. */
export type Operand =
  | number
  | { readonly key: string }
  | { readonly const: string }
  | { readonly add: readonly Operand[] }
  | { readonly mul: readonly Operand[] }
  | { readonly min: readonly Operand[] }
  | { readonly max: readonly Operand[] };

/** A rule test (the helper's small grammar, so both sides evaluate it identically). */
export type RuleTest =
  | { readonly all: readonly RuleTest[] }
  | { readonly any: readonly RuleTest[] }
  | { readonly lt: readonly [Operand, Operand] }
  | { readonly le: readonly [Operand, Operand] }
  | { readonly ge: readonly [Operand, Operand] }
  | { readonly eq: readonly [Operand, Operand] };

/** A cross-field rule: `error` refuses a draft, `warn` is shown. */
export interface Rule {
  readonly id: string;
  readonly sev: "error" | "warn";
  readonly message: string;
  readonly test: RuleTest;
}

/** The helper's schema. */
export interface ConfigSchema {
  readonly knobs: readonly Knob[];
  readonly rules: readonly Rule[];
  readonly constants: Readonly<Record<string, number>>;
  readonly groups: Readonly<Record<string, { readonly title: string; readonly help: string }>>;
}

/** Caps on what Fleet accepts from the helper. */
export const MAX_KNOBS = 200;
export const MAX_RULES = 100;
const KEY = /^[A-Z][A-Z0-9_]{0,63}$/;
const ID = /^[\w.+-]{1,100}$/;
const CHANGE_ID = /^cfg-\d{8}-\d{6}-[0-9a-f]{4,8}$/;
const SHA = /^[0-9a-f]{64}$/;
/** At most this many values change at once (the helper's own limit). */
export const MAX_SETS = 40;

const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown, max: number): string =>
  // deno-lint-ignore no-control-regex
  typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : "";
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isSafeInteger(v) ? v : null;

function parseOperand(v: unknown, depth: number): Operand | null {
  if (depth > 8) return null;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const o = obj(v);
  if (typeof o.key === "string") return KEY.test(o.key) ? { key: o.key } : null;
  if (typeof o.const === "string") return KEY.test(o.const) ? { const: o.const } : null;
  for (const op of ["add", "mul", "min", "max"] as const) {
    if (Array.isArray(o[op])) {
      const xs = (o[op] as unknown[]).slice(0, 20).map((x) => parseOperand(x, depth + 1));
      if (xs.length === 0 || xs.some((x) => x === null)) return null;
      return { [op]: xs as Operand[] } as unknown as Operand;
    }
  }
  return null;
}

function parseTest(v: unknown, depth: number): RuleTest | null {
  if (depth > 8) return null;
  const o = obj(v);
  for (const op of ["all", "any"] as const) {
    if (Array.isArray(o[op])) {
      const xs = (o[op] as unknown[]).slice(0, 20).map((x) => parseTest(x, depth + 1));
      if (xs.length === 0 || xs.some((x) => x === null)) return null;
      return { [op]: xs as RuleTest[] } as unknown as RuleTest;
    }
  }
  for (const op of ["lt", "le", "ge", "eq"] as const) {
    const pair = o[op];
    if (Array.isArray(pair) && pair.length === 2) {
      const a = parseOperand(pair[0], depth + 1);
      const b = parseOperand(pair[1], depth + 1);
      if (a === null || b === null) return null;
      return { [op]: [a, b] } as unknown as RuleTest;
    }
  }
  return null;
}

/** The helper's `--schema` answer, or `null` when it isn't one. */
export function parseSchema(raw: unknown): ConfigSchema | null {
  const r = obj(raw);
  if (r.ok === false || !Array.isArray(r.knobs) || r.knobs.length === 0) return null;
  if (r.knobs.length > MAX_KNOBS || (Array.isArray(r.rules) && r.rules.length > MAX_RULES)) {
    return null;
  }
  const knobs: Knob[] = [];
  const seen = new Set<string>();
  for (const k of r.knobs) {
    const o = obj(k);
    const key = typeof o.key === "string" ? o.key : "";
    const type = o.type === "bool" ? "bool" : o.type === "int" ? "int" : null;
    const scope = o.scope === "pool" || o.scope === "group" || o.scope === "fleet" ? o.scope : null;
    if (!KEY.test(key) || seen.has(key) || !type || !scope) return null;
    const pool = typeof o.pool === "string" && ID.test(o.pool) ? o.pool : "";
    if (scope === "pool" && !pool) return null;
    const min = type === "bool" ? 0 : num(o.min);
    const max = type === "bool" ? 1 : num(o.max);
    if (min === null || max === null || min > max) return null;
    seen.add(key);
    knobs.push({
      key,
      title: text(o.title, 80) || key,
      scope,
      pool,
      group: typeof o.group === "string" && ID.test(o.group) ? o.group : "",
      type,
      min,
      max,
      unit: text(o.unit, 20),
      help: text(o.help, 400),
      needsIdle: o.needsIdle === true,
    });
  }
  const rules: Rule[] = [];
  for (const x of Array.isArray(r.rules) ? r.rules : []) {
    const o = obj(x);
    const test = parseTest(o.test, 0);
    const id = typeof o.id === "string" && ID.test(o.id) ? o.id : "";
    if (!id || !test) return null;
    rules.push({
      id,
      sev: o.sev === "warn" ? "warn" : "error",
      message: text(o.message, 300),
      test,
    });
  }
  const constants: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj(r.constants))) {
    if (KEY.test(k) && typeof v === "number" && Number.isFinite(v)) constants[k] = v;
  }
  const groups: Record<string, { title: string; help: string }> = {};
  for (const [k, v] of Object.entries(obj(r.groups))) {
    if (ID.test(k)) {
      groups[k] = { title: text(obj(v).title, 80) || k, help: text(obj(v).help, 400) };
    }
  }
  return { knobs, rules, constants, groups };
}

/** The helper's `--show` answer. */
export interface ConfigShow {
  readonly ok: boolean;
  /** The live file's sha256: every change must name it (a stale one is refused). */
  readonly generation: string;
  /** Values as the file has them (strings of digits), or `null` while the live file is invalid. */
  readonly values: Readonly<Record<string, string>> | null;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly lastChange: ChangeRecord | null;
}

/** One change of the helper's history (`--status`, `--history`, `last_change`). */
export interface ChangeRecord {
  readonly id: string;
  readonly time: string;
  readonly actor: string;
  readonly via: string;
  readonly changes: readonly ValueChange[];
  /** `verifying`, `applied`, `rolled-back`, `rollback-failed`, `failed`, or `""`. */
  readonly state: string;
  readonly result: string;
  readonly revertOf: string | null;
  readonly generationAfter: string;
}

/** One value's change. */
export interface ValueChange {
  readonly key: string;
  readonly from: string;
  readonly to: string;
}

const messages = (v: unknown): string[] =>
  Array.isArray(v)
    ? v.slice(0, 20).map((e) => text(obj(e).message, 300)).filter((s) => s !== "")
    : [];

function parseChanges(v: unknown): ValueChange[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, MAX_SETS).map(obj).filter((c) => typeof c.key === "string" && KEY.test(c.key))
    .map((c) => ({ key: c.key as string, from: text(c.from, 12), to: text(c.to, 12) }));
}

/** A history entry, or `null`. */
export function parseChange(raw: unknown): ChangeRecord | null {
  const r = obj(raw);
  const id = typeof r.id === "string" && CHANGE_ID.test(r.id) ? r.id : "";
  if (!id) return null;
  return {
    id,
    time: text(r.time, 40),
    actor: text(r.actor, 40),
    via: text(r.via, 20),
    changes: parseChanges(r.changes),
    state: text(r.state, 30),
    result: text(r.result, 300),
    revertOf: typeof r.revert_of === "string" && CHANGE_ID.test(r.revert_of) ? r.revert_of : null,
    generationAfter: typeof r.generation_after === "string" && SHA.test(r.generation_after)
      ? r.generation_after
      : "",
  };
}

/** The helper's `--show` answer, or `null` when it isn't one. */
export function parseShow(raw: unknown): ConfigShow | null {
  const r = obj(raw);
  const generation = typeof r.generation === "string" && SHA.test(r.generation) ? r.generation : "";
  if (!generation) return null;
  let values: Record<string, string> | null = null;
  if (r.values && typeof r.values === "object") {
    values = {};
    for (const [k, v] of Object.entries(obj(r.values))) {
      if (KEY.test(k) && typeof v === "string" && /^-?\d{1,7}$/.test(v)) values[k] = v;
    }
  }
  return {
    ok: r.ok === true,
    generation,
    values,
    errors: messages(r.errors),
    warnings: messages(r.warnings),
    lastChange: parseChange(r.last_change),
  };
}

/** The helper's `--history` answer (newest first). */
export function parseHistory(raw: unknown): ChangeRecord[] {
  return Array.isArray(raw)
    ? raw.slice(0, 100).map(parseChange).filter((c): c is ChangeRecord => c !== null)
    : [];
}

function operand(o: Operand, v: Readonly<Record<string, number>>, c: ConfigSchema): number {
  if (typeof o === "number") return o;
  if ("key" in o) {
    const x = v[o.key];
    if (x === undefined) throw new Error(`a rule names ${o.key}, which has no value`);
    return x;
  }
  if ("const" in o) {
    const x = c.constants[o.const];
    if (x === undefined) throw new Error(`a rule names the unknown constant ${o.const}`);
    return x;
  }
  if ("add" in o) return o.add.reduce<number>((s, x) => s + operand(x, v, c), 0);
  if ("mul" in o) return o.mul.reduce<number>((s, x) => s * operand(x, v, c), 1);
  if ("min" in o) return Math.min(...o.min.map((x) => operand(x, v, c)));
  return Math.max(...o.max.map((x) => operand(x, v, c)));
}

/** One rule test over numeric values. */
export function ruleHolds(
  t: RuleTest,
  v: Readonly<Record<string, number>>,
  c: ConfigSchema,
): boolean {
  if ("all" in t) return t.all.every((x) => ruleHolds(x, v, c));
  if ("any" in t) return t.any.some((x) => ruleHolds(x, v, c));
  const [op, pair] = "lt" in t
    ? ["lt", t.lt]
    : "le" in t
    ? ["le", t.le]
    : "ge" in t
    ? ["ge", t.ge]
    : ["eq", t.eq];
  const a = operand(pair[0], v, c);
  const b = operand(pair[1], v, c);
  return op === "lt" ? a < b : op === "le" ? a <= b : op === "ge" ? a >= b : a === b;
}

/** A draft's problems: per key (type / range) and per rule. */
export interface DraftCheck {
  readonly ok: boolean;
  readonly fields: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

/** Check a full set of values (strings, as the form holds them) against the schema. */
export function checkDraft(
  schema: ConfigSchema,
  values: Readonly<Record<string, string>>,
): DraftCheck {
  const fields: Record<string, string> = {};
  const nums: Record<string, number> = {};
  for (const k of schema.knobs) {
    const raw = (values[k.key] ?? "").trim();
    if (k.type === "bool") {
      if (raw !== "0" && raw !== "1") fields[k.key] = "on or off";
      else nums[k.key] = Number(raw);
      continue;
    }
    if (!/^-?\d{1,7}$/.test(raw)) {
      fields[k.key] = "a whole number";
      continue;
    }
    const n = Number(raw);
    if (n < k.min || n > k.max) fields[k.key] = `${k.min} to ${k.max}`;
    else nums[k.key] = n;
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  if (Object.keys(fields).length === 0) {
    for (const r of schema.rules) {
      let holds: boolean;
      try {
        holds = ruleHolds(r.test, nums, schema);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `rule ${r.id} could not be evaluated`);
        continue;
      }
      if (!holds) (r.sev === "error" ? errors : warnings).push(r.message || r.id);
    }
  }
  return { ok: Object.keys(fields).length === 0 && errors.length === 0, fields, errors, warnings };
}

/** The values that differ between the live ones and a draft, in the schema's order. */
export function diffConfig(
  schema: ConfigSchema,
  live: Readonly<Record<string, string>>,
  draft: Readonly<Record<string, string>>,
): ValueChange[] {
  const out: ValueChange[] = [];
  for (const k of schema.knobs) {
    const from = live[k.key] ?? "";
    const to = (draft[k.key] ?? from).trim();
    if (to !== from) out.push({ key: k.key, from, to });
  }
  return out;
}

/** A value as the form shows it. */
export function shownValue(k: Knob | undefined, v: string): string {
  if (!k) return v;
  if (k.type === "bool") return v === "1" ? "on" : v === "0" ? "off" : v;
  return k.unit ? `${v} ${k.unit}` : v;
}

/** Where a knob belongs, for headings: its pool, or its group's title. */
export function knobPlace(schema: ConfigSchema, k: Knob): string {
  if (k.scope === "pool") return k.pool;
  return schema.groups[k.group]?.title ?? (k.group || "shared");
}

/** The OS dialog's text for a change. */
export function confirmText(
  schema: ConfigSchema,
  changes: readonly ValueChange[],
): { message: string; detail: string } {
  const byKey = new Map(schema.knobs.map((k) => [k.key, k]));
  const parts = changes.slice(0, 12).map((c) => {
    const k = byKey.get(c.key);
    const name = k ? `${knobPlace(schema, k)}: ${k.title}` : c.key;
    return `${name} ${shownValue(k, c.from)} → ${shownValue(k, c.to)}`;
  });
  const more = changes.length > 12 ? ` · and ${changes.length - 12} more` : "";
  const n = changes.length;
  return {
    message: `Apply ${n} runner setting change${n === 1 ? "" : "s"}? ${parts.join(" · ")}${more}`,
    detail: "The scheduler re-reads its settings at its next tick: nothing restarts and running " +
      "jobs go on. Fleet then checks that the scheduler picked the change up; if it doesn't " +
      "within two ticks, the previous values are written back. The previous values are kept, " +
      "with a one-click revert.",
  };
}

/** The helper's argv for a check of a change. */
export function checkArgs(changes: readonly ValueChange[]): string[] {
  return ["--check", ...changes.flatMap((c) => ["--set", `${c.key}=${c.to}`])];
}

/** The helper's argv for applying a change (the token goes on stdin, never here). */
export function applyArgs(
  generation: string,
  changes: readonly ValueChange[],
  actor: string,
): string[] {
  return [
    "--apply",
    "--token-stdin",
    "--generation",
    generation,
    ...changes.flatMap((c) => ["--set", `${c.key}=${c.to}`]),
    ...(actor ? ["--actor", actor] : []),
  ];
}

/** The helper's argv for reverting a change. */
export function revertArgs(id: string, generation: string, actor: string): string[] {
  return [
    "--revert",
    id,
    "--token-stdin",
    "--generation",
    generation,
    ...(actor ? ["--actor", actor] : []),
  ];
}

/** Check a page's change list: keys the schema knows, values in its patterns, within the cap. */
export function validChanges(
  schema: ConfigSchema,
  raw: unknown,
): { ok: true; changes: ValueChange[] } | { ok: false; message: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, message: "nothing to change" };
  if (raw.length > MAX_SETS) return { ok: false, message: `at most ${MAX_SETS} values at once` };
  const keys = new Set(schema.knobs.map((k) => k.key));
  const out: ValueChange[] = [];
  const seen = new Set<string>();
  for (const x of raw) {
    const o = obj(x);
    const key = typeof o.key === "string" ? o.key : "";
    const to = typeof o.to === "string" ? o.to.trim() : "";
    const from = typeof o.from === "string" ? o.from : "";
    if (!keys.has(key)) return { ok: false, message: `"${key.slice(0, 64)}" is not a setting` };
    if (!/^-?\d{1,7}$/.test(to)) return { ok: false, message: `${key}: not a whole number` };
    if (seen.has(key)) return { ok: false, message: `${key} is set twice` };
    seen.add(key);
    out.push({ key, from, to });
  }
  return { ok: true, changes: out };
}

/** Whether a string is a change id the helper issues. */
export const validChangeId = (s: unknown): s is string =>
  typeof s === "string" && CHANGE_ID.test(s);
/** Whether a string is a generation (sha256 hex). */
export const validGeneration = (s: unknown): s is string => typeof s === "string" && SHA.test(s);

/** The helper's exit codes, as the page words them. */
export function exitText(code: number): string {
  switch (code) {
    case 0:
      return "done";
    case 2:
      return "refused: invalid";
    case 3:
      return "refused: the settings changed since they were read (reload and try again)";
    case 6:
      return "the scheduler didn't pick it up; the previous values were written back";
    case 7:
      return "the scheduler didn't pick it up and the write-back failed (alerted)";
    case 8:
      return "busy: another change or a deploy holds the lock (try again shortly)";
    case 9:
      return "refused: the helper didn't accept Fleet as the caller";
    default:
      return `failed (exit ${code})`;
  }
}
