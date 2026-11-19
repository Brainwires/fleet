"use client";
// The routing rules' form: WHICH pool takes WHICH job. Built from the routing helper's JSON Schema
// at run time (lib/routing.ts): every field is a typed widget chosen by its schema node (an ordered
// pool list, pool and label pickers, pattern lists, numbers with their range, text with its
// pattern), never a raw text box for the document. The helper checks each draft as it is edited and
// says where the next job of every class would go; Save asks in the OS dialog, and the helper
// writes the file with an audit entry. No pool, label or class name is built in here.

import { type ReactNode, useCallback, useEffect, useRef, useState } from "denext";
import type {
  PoolChoice,
  RoutingPreview,
  RoutingRules,
  RoutingSchema,
  SchemaNode,
} from "../lib/routing.ts";
import type { RoutingLoad, RoutingResult } from "../lib/routing-runner.ts";

/** What the form needs from the backend. */
export interface RoutingApi {
  load(): Promise<RoutingLoad>;
  check(draft: RoutingRules): Promise<RoutingPreview>;
  apply(generation: string, draft: RoutingRules): Promise<RoutingResult>;
  revert(id: string, generation: string): Promise<RoutingResult>;
}

const GITHUB = "github";
type Json = unknown;
const isObj = (v: Json): v is Record<string, Json> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

interface Ctx {
  readonly root: RoutingSchema["schema"];
  readonly pools: readonly PoolChoice[];
  readonly labels: readonly string[];
}

/** A node with its `$ref` followed (`#/$defs/<name>` only: the helper's schema is one document). */
export function resolve(node: SchemaNode | undefined, root: RoutingSchema["schema"]): SchemaNode {
  let n = node ?? {};
  for (let i = 0; i < 8 && n.$ref; i++) {
    const m = /^#\/\$defs\/([\w-]+)$/.exec(n.$ref);
    const target = m ? root.$defs?.[m[1]] : undefined;
    if (!target) break;
    const { $ref: _r, ...own } = n;
    n = { ...target, ...own };
  }
  return n;
}

/** A value a schema node starts with (a new list item, a new map entry). */
export function blank(node: SchemaNode, root: RoutingSchema["schema"]): Json {
  const n = resolve(node, root);
  if (n.const !== undefined) return n.const;
  if (n.type === "array") return [];
  if (n.type === "integer" || n.type === "number") return n.minimum ?? 0;
  if (n.type === "object") {
    const out: Record<string, Json> = {};
    for (const k of n.required ?? []) out[k] = blank(n.properties?.[k] ?? {}, root);
    return out;
  }
  return "";
}

/** Why a text does not fit its node, or `""`. */
export function textProblem(n: SchemaNode, v: string): string {
  if (n.minLength !== undefined && v.length < n.minLength) {
    return v ? `at least ${n.minLength} characters` : "required";
  }
  if (n.maxLength !== undefined && v.length > n.maxLength) {
    return `at most ${n.maxLength} characters`;
  }
  if (n["x-widget"] === "regex") {
    try {
      new RegExp(v);
    } catch {
      return "not a regular expression";
    }
  }
  if (n.pattern) {
    try {
      if (!new RegExp(n.pattern).test(v)) {
        return n.description ? `expected: ${n.description}` : "not in the expected form";
      }
    } catch {
      return "";
    }
  }
  return "";
}

const move = <T,>(xs: readonly T[], i: number, by: number): T[] => {
  const out = [...xs];
  const j = i + by;
  if (j < 0 || j >= out.length) return out;
  [out[i], out[j]] = [out[j], out[i]];
  return out;
};

function Hint({ text }: { text?: string }) {
  return text ? <p class="rf-hint muted small">{text}</p> : null;
}

/** An ordered list of pools ("github" kept last): most preferred first. */
function OrderWidget(
  props: { value: readonly string[]; onChange: (v: string[]) => void; ctx: Ctx; label: string },
) {
  const { value, onChange, ctx } = props;
  const pools = value.filter((v) => v !== GITHUB);
  const github = value.includes(GITHUB);
  const emit = (ps: string[], gh: boolean) => onChange(gh ? [...ps, GITHUB] : ps);
  const rest = ctx.pools.filter((p) => !pools.includes(p.name));
  return (
    <div class="rf-order" role="group" aria-label={props.label}>
      <ol class="rf-order-list">
        {pools.map((p, i) => {
          const known = ctx.pools.find((x) => x.name === p);
          return (
            <li key={p} class="rf-order-item">
              <span class="rf-rank">{i + 1}</span>
              <span
                class="rf-pool"
                title={known ? known.labels.join(", ") : "not a pool of this fleet"}
              >
                {p}
                {known ? "" : " (unknown)"}
              </span>
              <button
                type="button"
                class="btn rf-mini"
                disabled={i === 0}
                onClick={() => emit(move(pools, i, -1), github)}
                aria-label={`Move ${p} up`}
              >
                ↑
              </button>
              <button
                type="button"
                class="btn rf-mini"
                disabled={i === pools.length - 1}
                onClick={() => emit(move(pools, i, 1), github)}
                aria-label={`Move ${p} down`}
              >
                ↓
              </button>
              <button
                type="button"
                class="btn rf-mini"
                onClick={() => emit(pools.filter((x) => x !== p), github)}
                aria-label={`Remove ${p}`}
              >
                ✕
              </button>
            </li>
          );
        })}
        {github
          ? (
            <li class="rf-order-item rf-order-gh">
              <span class="rf-rank">{pools.length + 1}</span>
              <span class="rf-pool">GitHub-hosted (the backup, always last)</span>
            </li>
          )
          : null}
      </ol>
      <div class="rf-order-add">
        <select
          aria-label={`Add a pool to ${props.label}`}
          onChange={(e) => {
            const el = e.target as HTMLSelectElement;
            const v = el.value;
            el.value = "";
            if (v) emit([...pools, v], github);
          }}
        >
          <option value="">Add a pool…</option>
          {rest.map((p) => (
            <option key={p.name} value={p.name}>{p.name} ({p.labels.join(", ")})</option>
          ))}
        </select>
        <label class="rf-check">
          <input
            type="checkbox"
            checked={github}
            onChange={(e) => emit(pools, (e.target as HTMLInputElement).checked)}
          />
          GitHub-hosted as the backup
        </label>
      </div>
    </div>
  );
}

/** A set of choices as checkboxes (pools, labels). */
function PickWidget(
  props: {
    value: readonly string[];
    choices: readonly { value: string; hint?: string }[];
    onChange: (v: string[]) => void;
    label: string;
    exclude?: string;
  },
) {
  const all = [
    ...props.choices,
    ...props.value.filter((v) => !props.choices.some((c) => c.value === v)).map((v) => ({
      value: v,
      hint: "not known here",
    })),
  ];
  return (
    <div class="rf-pick" role="group" aria-label={props.label}>
      {all.filter((c) => c.value !== props.exclude).map((c) => (
        <label key={c.value} class="rf-check" title={c.hint}>
          <input
            type="checkbox"
            checked={props.value.includes(c.value)}
            onChange={(e) =>
              props.onChange(
                (e.target as HTMLInputElement).checked
                  ? [...props.value, c.value]
                  : props.value.filter((v) =>
                    v !== c.value
                  ),
              )}
          />
          {c.value}
        </label>
      ))}
    </div>
  );
}

/** A list of patterns, each its own checked text field. */
function TextListWidget(
  props: {
    value: readonly string[];
    item: SchemaNode;
    onChange: (v: string[]) => void;
    label: string;
    max?: number;
  },
) {
  return (
    <div class="rf-list" role="group" aria-label={props.label}>
      {props.value.map((v, i) => {
        const bad = textProblem(props.item, v);
        return (
          <div key={i} class="rf-list-row">
            <input
              type="text"
              class={`rf-text rf-mono${bad ? " is-bad" : ""}`}
              value={v}
              spellcheck={false}
              aria-label={`${props.label} ${i + 1}`}
              aria-invalid={bad ? "true" : undefined}
              onInput={(e) =>
                props.onChange(
                  props.value.map((x, k) => (k === i ? (e.target as HTMLInputElement).value : x)),
                )}
            />
            <button
              type="button"
              class="btn rf-mini"
              onClick={() => props.onChange(props.value.filter((_, k) => k !== i))}
              aria-label={`Remove pattern ${i + 1}`}
            >
              ✕
            </button>
            {bad ? <span class="rf-problem" role="alert">{bad}</span> : null}
          </div>
        );
      })}
      <button
        type="button"
        class="btn rf-add"
        disabled={props.max !== undefined && props.value.length >= props.max}
        onClick={() => props.onChange([...props.value, ""])}
      >
        Add a pattern
      </button>
    </div>
  );
}

interface FieldProps {
  readonly node: SchemaNode;
  readonly value: Json;
  readonly onChange: (v: Json) => void;
  readonly ctx: Ctx;
  readonly name: string;
  /** The key of a map entry this field's value sits under (a pool's own name is left out of its pickers). */
  readonly self?: string;
}

/** One field, by its schema node. */
export function SchemaField(props: FieldProps): ReactNode {
  const { ctx, onChange } = props;
  const n = resolve(props.node, ctx.root);
  const label = n.title ?? props.name;
  const widget = n["x-widget"];
  if (n.const !== undefined) return null;

  if (n.type === "array") {
    const value = Array.isArray(props.value) ? props.value as Json[] : [];
    const item = resolve(n.items, ctx.root);
    const strings = value.filter((v): v is string => typeof v === "string");
    if (widget === "order") {
      return <OrderWidget value={strings} onChange={onChange} ctx={ctx} label={label} />;
    }
    if (widget === "pools") {
      return (
        <PickWidget
          value={strings}
          choices={ctx.pools.map((p) => ({ value: p.name, hint: p.labels.join(", ") }))}
          onChange={onChange}
          label={label}
          exclude={props.self}
        />
      );
    }
    if (widget === "labels") {
      return (
        <PickWidget
          value={strings}
          choices={ctx.labels.map((l) => ({ value: l }))}
          onChange={onChange}
          label={label}
        />
      );
    }
    if (item.type === "string") {
      return (
        <TextListWidget
          value={strings}
          item={item}
          onChange={onChange}
          label={label}
          max={n.maxItems}
        />
      );
    }
    // A list of objects: one card each, in order.
    return (
      <div class="rf-items">
        {value.map((v, i) => {
          const o = isObj(v) ? v : {};
          const heading = String(o.title || o.id || `${label} ${i + 1}`);
          return (
            <fieldset key={i} class="rf-item">
              <legend class="rf-item-head">
                <span class="rf-rank">{i + 1}</span>
                <span class="rf-item-title">{heading}</span>
                <button
                  type="button"
                  class="btn rf-mini"
                  disabled={i === 0}
                  onClick={() => onChange(move(value, i, -1))}
                  aria-label={`Move ${heading} up`}
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="btn rf-mini"
                  disabled={i === value.length - 1}
                  onClick={() => onChange(move(value, i, 1))}
                  aria-label={`Move ${heading} down`}
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="btn rf-mini"
                  onClick={() => onChange(value.filter((_, k) => k !== i))}
                  aria-label={`Remove ${heading}`}
                >
                  ✕
                </button>
              </legend>
              <SchemaField
                node={item}
                value={v}
                onChange={(nv) => onChange(value.map((x, k) => (k === i ? nv : x)))}
                ctx={ctx}
                name={heading}
              />
            </fieldset>
          );
        })}
        <button
          type="button"
          class="btn rf-add"
          disabled={n.maxItems !== undefined && value.length >= n.maxItems}
          onClick={() => onChange([...value, blank(item, ctx.root)])}
        >
          Add
        </button>
      </div>
    );
  }

  if (n.type === "object") {
    const value = isObj(props.value) ? props.value : {};
    if (n.properties) {
      const required = n.required ?? [];
      return (
        <div class="rf-object">
          {Object.entries(n.properties).map(([key, child]) => {
            const c = resolve(child, ctx.root);
            if (c.const !== undefined || key === "$schema") return null;
            const set = (nv: Json) => {
              const next = { ...value };
              const empty = nv === undefined || nv === "" ||
                (Array.isArray(nv) && nv.length === 0) ||
                (isObj(nv) && Object.keys(nv).length === 0);
              if (empty && !required.includes(key)) delete next[key];
              else next[key] = nv;
              onChange(next);
            };
            return (
              <div key={key} class={`rf-field rf-field-${c.type ?? "text"}`}>
                <div class="rf-label">
                  {c.title ?? key}
                  {required.includes(key) ? null : <span class="muted small">(optional)</span>}
                </div>
                <div class="rf-control">
                  <SchemaField
                    node={child}
                    value={value[key]}
                    onChange={set}
                    ctx={ctx}
                    name={c.title ?? key}
                    self={props.self}
                  />
                  <Hint text={c.description} />
                </div>
              </div>
            );
          })}
        </div>
      );
    }
    // A map: one entry per key (a pool's conditions, a machine's pools).
    const child = typeof n.additionalProperties === "object" ? n.additionalProperties : {};
    const keyNode = resolve(n.propertyNames, ctx.root);
    const poolKeys = keyNode["x-widget"] === "pool";
    const free = ctx.pools.filter((p) => !(p.name in value));
    return (
      <MapField
        label={label}
        value={value}
        onChange={onChange}
        child={child}
        ctx={ctx}
        poolKeys={poolKeys}
        free={free}
        keyNode={keyNode}
      />
    );
  }

  if (n.type === "integer" || n.type === "number") {
    const v = typeof props.value === "number" ? props.value : "";
    return (
      <input
        type="number"
        class="rf-num"
        aria-label={label}
        min={n.minimum}
        max={n.maximum}
        step={1}
        value={v}
        onInput={(e) => {
          const t = (e.target as HTMLInputElement).value;
          const x = Number(t);
          onChange(
            t === "" || !Number.isFinite(x)
              ? undefined
              : Math.max(n.minimum ?? -Infinity, Math.min(n.maximum ?? Infinity, Math.round(x))),
          );
        }}
      />
    );
  }

  const v = typeof props.value === "string" ? props.value : "";
  const bad = v ? textProblem(n, v) : "";
  return (
    <>
      <input
        type="text"
        class={`rf-text${widget === "regex" ? " rf-mono" : ""}${bad ? " is-bad" : ""}`}
        aria-label={label}
        aria-invalid={bad ? "true" : undefined}
        spellcheck={false}
        maxLength={n.maxLength}
        value={v}
        onInput={(e) => onChange((e.target as HTMLInputElement).value)}
      />
      {bad ? <span class="rf-problem" role="alert">{bad}</span> : null}
    </>
  );
}

function MapField(
  props: {
    label: string;
    value: Record<string, Json>;
    onChange: (v: Json) => void;
    child: SchemaNode;
    ctx: Ctx;
    poolKeys: boolean;
    free: readonly PoolChoice[];
    keyNode: SchemaNode;
  },
) {
  const { value, onChange, ctx } = props;
  const [key, setKey] = useState("");
  const bad = !props.poolKeys && key
    ? (textProblem(props.keyNode, key) || (key in value ? "already listed" : ""))
    : "";
  const add = (k: string) => {
    if (!k || k in value) return;
    onChange({ ...value, [k]: blank(props.child, ctx.root) });
    setKey("");
  };
  return (
    <div class="rf-items">
      {Object.entries(value).map(([k, v]) => (
        <fieldset key={k} class="rf-item">
          <legend class="rf-item-head">
            <span class="rf-item-title">{k}</span>
            <button
              type="button"
              class="btn rf-mini"
              aria-label={`Remove ${k}`}
              onClick={() => {
                const next = { ...value };
                delete next[k];
                onChange(next);
              }}
            >
              ✕
            </button>
          </legend>
          <SchemaField
            node={props.child}
            value={v}
            onChange={(nv) => onChange({ ...value, [k]: nv })}
            ctx={ctx}
            name={k}
            self={k}
          />
        </fieldset>
      ))}
      <div class="rf-order-add">
        {props.poolKeys
          ? (
            <select
              aria-label={`Add to ${props.label}`}
              onChange={(e) => {
                const el = e.target as HTMLSelectElement;
                const v = el.value;
                el.value = "";
                add(v);
              }}
            >
              <option value="">Add a pool…</option>
              {props.free.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
            </select>
          )
          : (
            <>
              <input
                type="text"
                class={`rf-text rf-key${bad ? " is-bad" : ""}`}
                aria-label={`A new name for ${props.label}`}
                placeholder="name"
                value={key}
                spellcheck={false}
                onInput={(e) => setKey((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                class="btn rf-add"
                disabled={!key || !!bad}
                onClick={() => add(key)}
              >
                Add
              </button>
              {bad ? <span class="rf-problem" role="alert">{bad}</span> : null}
            </>
          )}
      </div>
    </div>
  );
}

/** "With these rules, the next <class> job goes to: <where>". */
export function PreviewPanel({ preview, busy }: { preview: RoutingPreview | null; busy: boolean }) {
  if (!preview) return <p class="muted" aria-busy={busy}>Checking…</p>;
  return (
    <div class="rf-preview" aria-busy={busy}>
      {preview.errors.length
        ? (
          <ul class="rf-errors" role="alert">
            {preview.errors.map((e, i) => <li key={i}>{e}</li>)}
          </ul>
        )
        : null}
      {preview.warnings.length
        ? <ul class="rf-warnings">{preview.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul>
        : null}
      {preview.ok
        ? (
          <table class="rf-next">
            <caption>With these rules, the next job goes to</caption>
            <tbody>
              {preview.classes.map((c) => (
                <tr key={c.classId}>
                  <th scope="row">
                    {c.title}
                    {c.note ? <span class="muted small">({c.note})</span> : null}
                  </th>
                  <td
                    class={`rf-target${
                      c.next === null ? " is-wait" : c.next === GITHUB ? " is-gh" : ""
                    }`}
                  >
                    {c.next === null
                      ? "waits for our pools"
                      : c.next === GITHUB
                      ? "GitHub-hosted"
                      : c.next}
                  </td>
                  <td class="muted small">
                    {c.candidates.map((x) =>
                      `${x.target === GITHUB ? "GitHub" : x.target}: ${x.why}`
                    ).join(" · ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
        : null}
    </div>
  );
}

export function RoutingForm({ api }: { api: RoutingApi }) {
  const [load, setLoad] = useState<RoutingLoad | null>(null);
  const [draft, setDraft] = useState<RoutingRules | null>(null);
  const [preview, setPreview] = useState<RoutingPreview | null>(null);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(async () => {
    setMessage("");
    const l = await api.load().catch(() => ({
      ok: false as const,
      message: "The routing helper couldn't be run.",
    }));
    setLoad(l);
    if (l.ok) {
      setDraft(l.show.rules ? structuredClone(l.show.rules) : null);
      setPreview(l.preview);
    }
  }, [api]);
  useEffect(() => void reload(), [reload]);

  const saved = load?.ok ? JSON.stringify(load.show.rules) : "";
  const dirty = draft !== null && JSON.stringify(draft) !== saved;

  // Every edit is checked by the helper (debounced), which also previews it.
  useEffect(() => {
    if (!draft || !dirty) return;
    const mine = ++seq.current;
    setChecking(true);
    const t = setTimeout(() => {
      void api.check(draft).then((p) => {
        if (seq.current === mine) setPreview(p);
      }).catch(() => {}).finally(() => {
        if (seq.current === mine) setChecking(false);
      });
    }, 400);
    return () => clearTimeout(t);
  }, [draft, dirty, api]);

  if (!load) return <p class="muted" aria-busy="true">Loading the routing rules…</p>;
  if (!load.ok) return <p class="m-error" role="alert">{load.message}</p>;
  const { schema, show, history } = load;
  const ctx: Ctx = {
    root: schema.schema,
    pools: schema.pools,
    labels: [...new Set(schema.pools.flatMap((p) => p.labels))].sort(),
  };
  const act = async (fn: () => Promise<RoutingResult>) => {
    setSaving(true);
    try {
      const r = await fn();
      if (r.ok) await reload();
      setMessage(r.message);
    } catch {
      setMessage("The routing helper couldn't be run.");
    } finally {
      setSaving(false);
    }
  };
  const newest = history[0];
  return (
    <div class="routing">
      <div class="rf-top">
        <div>
          <h2 class="rf-title">Routing rules</h2>
          <p class="muted small">
            Which pool takes which job. A job belongs to the first class that matches it; the class
            lists the pools that serve it, most preferred first, and a pool takes a job only while
            no pool before it can.
            {show.isDefault
              ? " These are the built-in defaults: saving writes your own rules file."
              : ""}
          </p>
          <p class="muted small rf-file" title={show.file}>{show.file}</p>
        </div>
        <div class="rf-actions">
          <button
            type="button"
            class="btn"
            disabled={!dirty || saving}
            onClick={() => {
              setDraft(show.rules ? structuredClone(show.rules) : null);
              setPreview(load.preview);
              setMessage("");
            }}
          >
            Discard changes
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={!dirty || saving || checking || !preview?.ok}
            onClick={() => draft && void act(() => api.apply(show.generation, draft))}
          >
            Save…
          </button>
        </div>
      </div>
      {!show.valid
        ? (
          <p class="m-error" role="alert">
            The rules file is not valid ({show.errors.slice(0, 2).join("; ")}): the scheduler keeps
            its last good rules. Fix the file, or save new rules from here once it loads.
          </p>
        )
        : null}
      {message ? <p class="rf-message" role="status">{message}</p> : null}
      <div class="rf-cols">
        <div class="rf-form">
          {draft
            ? (
              <SchemaField
                node={schema.schema}
                value={draft}
                onChange={(v) => setDraft(v as RoutingRules)}
                ctx={ctx}
                name="Routing rules"
              />
            )
            : null}
        </div>
        <aside class="rf-side" aria-label="Preview">
          <h3 class="rf-side-title">{dirty ? "Preview of your changes" : "Right now"}</h3>
          <PreviewPanel preview={preview} busy={checking} />
          <h3 class="rf-side-title">Changes</h3>
          {history.length === 0
            ? <p class="muted small">No change yet.</p>
            : (
              <ul class="rf-history">
                {history.slice(0, 8).map((h, i) => (
                  <li key={h.id}>
                    <span class="muted small">
                      {h.at.replace("T", " ").replace("Z", " UTC")} · {h.actor}
                      {h.kind === "revert" ? " · revert" : ""}
                    </span>
                    <span>{h.summary}</span>
                    {i === 0 && newest
                      ? (
                        <button
                          type="button"
                          class="btn rf-mini"
                          disabled={dirty || saving}
                          onClick={() => void act(() => api.revert(newest.id, show.generation))}
                        >
                          Revert…
                        </button>
                      )
                      : null}
                  </li>
                ))}
              </ul>
            )}
        </aside>
      </div>
    </div>
  );
}
