"use client";
// The controls' page side: small buttons that ask the backend, which applies the guardrails and asks
// for confirmation in the OS's own dialog before anything happens. The page never talks to GitHub.

import { useState } from "denext";
import type { DispatchInput } from "../lib/controls.ts";
import { shortRepo } from "../lib/format.ts";

/** A GitHub control as the page asks for it. */
export type ControlRequest =
  | { kind: "cancel-run" | "rerun-failed" | "rerun-all"; repo: string; runId: number }
  | { kind: "rerun-job"; repo: string; runId: number; jobId: number }
  | {
    kind: "dispatch";
    repo: string;
    workflowId: number;
    ref: string;
    inputs: Record<string, string>;
  };

/** A pool control as the page asks for it. */
export type PoolRequest =
  | { kind: "pause"; pool: string; seconds: number }
  | { kind: "resume"; pool: string }
  | { kind: "restart-scheduler" }
  | { kind: "watchdog-pass" };

/** The control handlers the view gets (absent: no controls shown). */
export interface ControlHandlers {
  readonly onControl: (c: ControlRequest) => void;
  /** Present only on the machine with the runner scheduler. */
  readonly onPool?: (c: PoolRequest) => void;
  readonly onDispatch?: () => void;
  /** The last control's outcome. */
  readonly message?: { readonly ok: boolean; readonly text: string } | null;
}

/** A run's buttons. */
export function RunControls(
  { repo, runId, c }: { repo: string; runId: number; c: ControlHandlers },
) {
  return (
    <span class="ctl-group">
      <button
        type="button"
        class="ctl"
        title="Re-run the failed jobs"
        onClick={() => c.onControl({ kind: "rerun-failed", repo, runId })}
      >
        Re-run failed
      </button>
      <button
        type="button"
        class="ctl"
        title="Re-run every job"
        onClick={() => c.onControl({ kind: "rerun-all", repo, runId })}
      >
        Re-run all
      </button>
      <button
        type="button"
        class="ctl ctl-danger"
        title="Cancel the run (refused on a default branch)"
        onClick={() => c.onControl({ kind: "cancel-run", repo, runId })}
      >
        Cancel
      </button>
    </span>
  );
}

/** A pool card's buttons (the Mac mini only). */
export function PoolControls(
  { pool, paused, onPool }: { pool: string; paused: boolean; onPool: (c: PoolRequest) => void },
) {
  const [seconds, setSeconds] = useState(180);
  return paused
    ? (
      <span class="ctl-group">
        <button type="button" class="ctl" onClick={() => onPool({ kind: "resume", pool })}>
          Resume
        </button>
      </span>
    )
    : (
      <span class="ctl-group">
        <button
          type="button"
          class="ctl"
          title="Pause launches (the script's own expiry still applies)"
          onClick={() => onPool({ kind: "pause", pool, seconds })}
        >
          Pause
        </button>
        {[60, 120, 180].map((s) => (
          <button
            key={s}
            type="button"
            class={`ctl ctl-dur${seconds === s ? " is-on" : ""}`}
            aria-pressed={seconds === s}
            onClick={() => setSeconds(s)}
          >
            {s}s
          </button>
        ))}
      </span>
    );
}

/** What the dispatch form needs. */
export interface DispatchApi {
  readonly repos: readonly string[];
  readonly workflows: (repo: string) => Promise<
    readonly { id: number; name: string; inputs: readonly DispatchInput[] }[]
  >;
  readonly submit: (c: Extract<ControlRequest, { kind: "dispatch" }>) => void;
  readonly close: () => void;
}

/** The dispatch form: repo → workflow (only those with workflow_dispatch) → ref → its inputs. */
export function DispatchPanel({ api }: { api: DispatchApi }) {
  const [repo, setRepo] = useState("");
  const [workflows, setWorkflows] = useState<
    readonly { id: number; name: string; inputs: readonly DispatchInput[] }[]
  >([]);
  const [wfId, setWfId] = useState(0);
  const [ref, setRef] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const wf = workflows.find((w) => w.id === wfId);
  const pickRepo = async (r: string) => {
    setRepo(r);
    setWfId(0);
    setWorkflows([]);
    if (!r) return;
    setLoading(true);
    try {
      setWorkflows(await api.workflows(r));
    } finally {
      setLoading(false);
    }
  };
  return (
    <section class="dispatch" aria-label="Dispatch a workflow">
      <header class="dispatch-head">
        <h2 class="lane-title">Dispatch a workflow</h2>
        <button type="button" class="ctl" onClick={api.close}>Close</button>
      </header>
      <form
        class="dispatch-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!wf || !ref.trim()) return;
          api.submit({
            kind: "dispatch",
            repo,
            workflowId: wf.id,
            ref: ref.trim(),
            inputs: values,
          });
        }}
      >
        <label class="field">
          <span>Repository</span>
          <select onChange={(e) => void pickRepo((e.target as HTMLSelectElement).value)}>
            <option value="">Choose…</option>
            {api.repos.map((r) => <option key={r} value={r}>{shortRepo(r)}</option>)}
          </select>
        </label>
        <label class="field">
          <span>Workflow</span>
          <select
            disabled={!workflows.length}
            onChange={(e) => {
              setWfId(Number((e.target as HTMLSelectElement).value));
              setValues({});
            }}
          >
            <option value="0">{loading ? "Loading…" : "Choose…"}</option>
            {workflows.map((w) => <option key={w.id} value={String(w.id)}>{w.name}</option>)}
          </select>
        </label>
        <label class="field">
          <span>Ref</span>
          <input
            type="text"
            placeholder="branch or tag"
            value={ref}
            onInput={(e) => setRef((e.target as HTMLInputElement).value)}
          />
        </label>
        {wf?.inputs.map((i) => (
          <label class="field" key={i.name} title={i.description}>
            <span>
              {i.name}
              {i.required ? " *" : ""}
            </span>
            {i.type === "choice"
              ? (
                <select
                  onChange={(e) =>
                    setValues({ ...values, [i.name]: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">{i.default ? `default: ${i.default}` : "Choose…"}</option>
                  {i.options.map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              )
              : i.type === "boolean"
              ? (
                <select
                  onChange={(e) =>
                    setValues({ ...values, [i.name]: (e.target as HTMLSelectElement).value })}
                >
                  <option value="">{`default: ${i.default || "false"}`}</option>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </select>
              )
              : (
                <input
                  type="text"
                  placeholder={i.default}
                  value={values[i.name] ?? ""}
                  onInput={(e) =>
                    setValues({ ...values, [i.name]: (e.target as HTMLInputElement).value })}
                />
              )}
          </label>
        ))}
        <button type="submit" class="btn btn-primary" disabled={!wf || !ref.trim()}>
          Dispatch…
        </button>
      </form>
      <p class="muted small">
        Fleet asks you to confirm in a system dialog. A commit that already has a run of this
        workflow is refused.
      </p>
    </section>
  );
}
