"use client";
// Runner settings: the scheduler's tunable values as a form built from its configuration helper's
// schema (typed widgets: a number field with its range and unit, an on / off switch), a diff
// preview with the same checks the helper runs, then Check (the helper's own), Apply (the OS dialog,
// then the helper verifies the scheduler picked it up) with its status followed every 2 s, and the
// newest changes with Revert on the newest. Presentational: the calls come in as props (the tests
// render it with fakes). The values, the change and its verification are the helper's; Fleet never
// writes the settings itself.

import { useEffect, useRef, useState } from "denext";
import {
  type ChangeRecord,
  checkDraft,
  type ConfigSchema,
  type ConfigShow,
  diffConfig,
  type Knob,
  knobPlace,
  shownValue,
  type ValueChange,
} from "../lib/runner-config.ts";
import type { ConfigLoad } from "./fleet-client.ts";
import type { ConfigResult } from "../lib/config-runner.ts";

/** What the form calls. */
export interface ConfigApi {
  configLoad(): Promise<ConfigLoad>;
  configCheck(args: { changes: ValueChange[] }): Promise<
    { ok: boolean; errors: string[]; warnings: string[] }
  >;
  configApply(args: { generation: string; changes: ValueChange[] }): Promise<ConfigResult>;
  configRevert(args: { id: string; generation: string }): Promise<ConfigResult>;
  configStatus(args: { id: string }): Promise<ChangeRecord | null>;
}

/** States after which the helper is done with a change. */
const FINAL = new Set(["applied", "rolled-back", "rollback-failed", "failed"]);
const POLL_MS = 2000;

const errText = (e: unknown): string =>
  typeof (e as { message?: unknown })?.message === "string"
    ? (e as { message: string }).message
    : String(e);

/** One knob's widget: a number field (range, unit) or an on / off switch. */
function KnobField(
  props: {
    knob: Knob;
    value: string;
    live: string;
    error?: string;
    disabled: boolean;
    onChange: (v: string) => void;
  },
) {
  const k = props.knob;
  const id = `rc-${k.key}`;
  const hintId = `${id}-hint`;
  const changed = props.value !== props.live;
  const hint = [
    k.help,
    k.type === "int" ? `${k.min}–${k.max}${k.unit ? ` ${k.unit}` : ""}` : "",
    changed ? `now ${shownValue(k, props.live)}` : "",
  ].filter(Boolean).join(" · ");
  return (
    <div class={`set-field rc-field${changed ? " is-changed" : ""}${props.error ? " is-bad" : ""}`}>
      {k.type === "bool"
        ? (
          <label class="set-check" for={id}>
            <input
              id={id}
              type="checkbox"
              checked={props.value === "1"}
              disabled={props.disabled}
              aria-describedby={hintId}
              onChange={(e) => props.onChange((e.target as HTMLInputElement).checked ? "1" : "0")}
            />
            <span>{k.title}</span>
          </label>
        )
        : (
          <>
            <label for={id}>{k.title}</label>
            <span class="rc-number">
              <input
                id={id}
                type="number"
                inputMode="numeric"
                min={k.min}
                max={k.max}
                step={1}
                value={props.value}
                disabled={props.disabled}
                aria-invalid={props.error ? true : undefined}
                aria-describedby={hintId}
                onInput={(e) => props.onChange((e.target as HTMLInputElement).value)}
              />
              {k.unit ? <span class="rc-unit">{k.unit}</span> : null}
            </span>
          </>
        )}
      <p class="set-hint" id={hintId}>
        {props.error ? <strong class="rc-bad">{props.error}.</strong> : null}
        {hint}
      </p>
    </div>
  );
}

/** A change record's one line. */
function changeSummary(schema: ConfigSchema, c: ChangeRecord): string {
  const byKey = new Map(schema.knobs.map((k) => [k.key, k]));
  return c.changes.map((v) => {
    const k = byKey.get(v.key);
    return `${k ? k.title : v.key} ${shownValue(k, v.from)} → ${shownValue(k, v.to)}`;
  }).join(", ");
}

/** The runner settings form; `pool` limits it to that pool's own settings. */
export function RunnerConfigForm(props: { api: ConfigApi; pool?: string }) {
  const { api } = props;
  const [load, setLoad] = useState<ConfigLoad | null>(null);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [check, setCheck] = useState<
    { key: string; ok: boolean; errors: string[]; warnings: string[] } | null
  >(null);
  const [status, setStatus] = useState<ChangeRecord | null>(null);
  const [watching, setWatching] = useState<string | null>(null);
  const alive = useRef(true);

  const reload = async () => {
    try {
      const r = await api.configLoad();
      if (!alive.current) return;
      setLoad(r);
      if (r.ok) setDraft({ ...(r.show.values ?? {}) });
      setCheck(null);
    } catch (e) {
      if (alive.current) setLoad({ ok: false, message: errText(e) });
    }
  };
  useEffect(() => {
    alive.current = true;
    void reload();
    return () => {
      alive.current = false;
    };
  }, []);

  // Follow a change the helper is verifying, every 2 s, until it is final; then reload the values.
  useEffect(() => {
    if (!watching) return;
    let stop = false;
    const tick = async () => {
      try {
        const s = await api.configStatus({ id: watching });
        if (stop || !alive.current) return;
        if (s) setStatus(s);
        if (s && FINAL.has(s.state)) {
          setWatching(null);
          setNote({
            ok: s.state === "applied",
            text: s.state === "applied"
              ? `${s.id}: applied — the scheduler picked it up.`
              : `${s.id}: ${s.state}. ${s.result}`,
          });
          await reload();
        }
      } catch (e) {
        if (!stop) setNote({ ok: false, text: errText(e) });
      }
    };
    void tick();
    const t = setInterval(() => void tick(), POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [watching]);

  if (!load) return <p class="set-status">Loading the runner settings…</p>;
  if (!load.ok) {
    return (
      <div class="set-errors" role="alert">
        <p>{load.message}</p>
        <button type="button" class="btn" onClick={() => void reload()}>Try again</button>
      </div>
    );
  }
  const { schema, show, history } = load as {
    schema: ConfigSchema;
    show: ConfigShow;
    history: ChangeRecord[];
  };
  const live = show.values ?? {};
  const knobs = schema.knobs.filter((k) =>
    props.pool ? k.scope === "pool" && k.pool === props.pool : true
  );
  if (props.pool && knobs.length === 0) {
    return <p class="set-hint">This pool has no settings of its own here.</p>;
  }
  const readOnly = show.values === null || busy || watching !== null;
  const changes = diffConfig(schema, live, draft).filter((c) => knobs.some((k) => k.key === c.key));
  const full = { ...live, ...Object.fromEntries(changes.map((c) => [c.key, c.to])) };
  const local = checkDraft(schema, full);
  const diffKey = JSON.stringify(changes);
  const checked = check?.key === diffKey && check.ok;
  const byPlace = new Map<string, Knob[]>();
  for (const k of knobs) {
    const p = knobPlace(schema, k);
    byPlace.set(p, [...(byPlace.get(p) ?? []), k]);
  }
  const newestApplied = history.find((c) => c.state === "applied");
  const canRevert = newestApplied && newestApplied.generationAfter === show.generation;

  const doCheck = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.configCheck({ changes });
      setCheck({ key: diffKey, ...r });
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const doApply = async () => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.configApply({ generation: show.generation, changes });
      setNote({ ok: r.ok, text: r.message });
      if (r.ok && r.id) {
        setStatus(null);
        setWatching(r.id);
      } else if (r.ok) await reload();
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  const doRevert = async (id: string) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.configRevert({ id, generation: show.generation });
      setNote({ ok: r.ok, text: r.message });
      if (r.ok && r.id) {
        setStatus(null);
        setWatching(r.id);
      }
    } catch (e) {
      setNote({ ok: false, text: errText(e) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="rc-form">
      {show.values === null
        ? (
          <div class="set-errors" role="alert">
            <p>The live settings file is invalid; fix it by hand first:</p>
            <ul>{show.errors.map((e) => <li key={e}>{e}</li>)}</ul>
          </div>
        )
        : null}
      {[...byPlace.entries()].map(([place, ks]) => (
        <fieldset class="set-group rc-group" key={place}>
          <legend>{place}</legend>
          <div class="set-grid">
            {ks.map((k) => (
              <KnobField
                key={k.key}
                knob={k}
                value={draft[k.key] ?? live[k.key] ?? ""}
                live={live[k.key] ?? ""}
                error={local.fields[k.key]}
                disabled={readOnly}
                onChange={(v) => setDraft((d) => ({ ...d, [k.key]: v }))}
              />
            ))}
          </div>
        </fieldset>
      ))}

      <section class="rc-review" aria-label="Review">
        {changes.length === 0 ? <p class="set-hint">No changes.</p> : (
          <>
            <h3 class="rc-h">Changes</h3>
            <ul class="rc-diff">
              {changes.map((c) => {
                const k = schema.knobs.find((x) => x.key === c.key);
                return (
                  <li key={c.key}>
                    {k ? `${knobPlace(schema, k)}: ${k.title}` : c.key}{" "}
                    <span class="rc-from">{shownValue(k, c.from)}</span> →{" "}
                    <span class="rc-to">{shownValue(k, c.to)}</span>
                  </li>
                );
              })}
            </ul>
          </>
        )}
        {local.errors.length
          ? (
            <div class="set-errors" role="alert">
              <ul>{local.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )
          : null}
        {[...local.warnings, ...(check?.key === diffKey ? check.warnings : [])].length
          ? (
            <ul class="set-warn">
              {[...new Set([...local.warnings, ...(check?.key === diffKey ? check.warnings : [])])]
                .map((w) => <li key={w}>{w}</li>)}
            </ul>
          )
          : null}
        {check && check.key === diffKey && !check.ok
          ? (
            <div class="set-errors" role="alert">
              <p>The helper refused it:</p>
              <ul>{check.errors.map((e) => <li key={e}>{e}</li>)}</ul>
            </div>
          )
          : null}
        <div class="rc-actions">
          <button
            type="button"
            class="btn"
            disabled={readOnly || changes.length === 0 || !local.ok}
            onClick={() => void doCheck()}
          >
            Check
          </button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={readOnly || changes.length === 0 || !local.ok || !checked}
            title={checked ? undefined : "Check the change first"}
            onClick={() => void doApply()}
          >
            Apply settings
          </button>
          <button
            type="button"
            class="btn"
            disabled={busy || changes.length === 0}
            onClick={() => setDraft({ ...live })}
          >
            Discard
          </button>
          <button type="button" class="btn" disabled={busy} onClick={() => void reload()}>
            Reload
          </button>
        </div>
        {watching
          ? (
            <p class="set-status" role="status" aria-live="polite">
              {status ? `${status.id}: ${status.state}…` : `${watching}: verifying…`}{" "}
              Fleet checks that the scheduler picked it up (up to two ticks).
            </p>
          )
          : null}
        {note
          ? <p class={note.ok ? "set-saved" : "set-errors"} role="status">{note.text}</p>
          : null}
      </section>

      {!props.pool && history.length
        ? (
          <section class="rc-history" aria-label="Recent changes">
            <h3 class="rc-h">Recent changes</h3>
            <ul>
              {history.slice(0, 8).map((c) => (
                <li key={c.id}>
                  <span class="mono">{c.id}</span> · {c.time} · {c.actor || "?"} via {c.via || "?"}
                  {" "}
                  · {c.state || "?"}
                  {c.revertOf ? ` (revert of ${c.revertOf})` : ""}
                  <br />
                  <span class="set-hint">{changeSummary(schema, c)}</span>
                  {canRevert && c.id === newestApplied!.id
                    ? (
                      <button
                        type="button"
                        class="btn rc-revert"
                        disabled={readOnly}
                        onClick={() => void doRevert(c.id)}
                      >
                        Revert
                      </button>
                    )
                    : null}
                </li>
              ))}
            </ul>
          </section>
        )
        : null}
      <p class="set-hint rc-gen">
        Settings generation <span class="mono">{show.generation.slice(0, 12)}</span>
      </p>
    </div>
  );
}
