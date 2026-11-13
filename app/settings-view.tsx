"use client";
// The first-run wizard and the Settings view: one set of sections (sign in, owners and repos,
// protected branches, start and notifications, integrations) over a draft of the settings. The
// wizard walks them one step at a time and finishes by saving with `setupComplete`; the Settings
// view shows them all with Save. The backend validates every save (lib/settings.ts) and answers
// with the problems, shown here as they come. Presentational: data and calls come in as props, so
// the tests render it with fakes. Sections the form doesn't edit (the runner scheduler integration,
// runner-host rules) are kept exactly as they are.

import { type ReactNode, useEffect, useRef, useState } from "denext";
import {
  type BranchRule,
  DEFAULT_BRANCH_TOKEN,
  type FleetSettings,
  type OwnerSetting,
  type SettingsResult,
} from "../lib/settings.ts";
import type { RepoChoice, TokenInfo } from "../lib/discover.ts";
import type { AuthState } from "../lib/model.ts";
import { TokenForm, type TokenScreenProps } from "./token-screen.tsx";

/** What this machine looks like to the Settings view (paths for the MCP snippet). */
export interface MachineInfo {
  readonly dataDir: string;
  readonly spoolDir: string | null;
  readonly healthFile: string | null;
  readonly os: string;
}

/** What the sections ask of the backend. */
export interface SettingsApi {
  readonly save: (s: FleetSettings) => Promise<SettingsResult>;
  readonly tokenInfo: () => Promise<TokenInfo>;
  readonly ownerRepos: (owner: string, kind: "org" | "user") => Promise<RepoChoice[]>;
  readonly onOpen: (url: string) => void;
}

/** The props both screens take. */
export interface SettingsScreenProps {
  readonly settings: FleetSettings;
  readonly machine: MachineInfo;
  readonly auth: AuthState;
  readonly api: SettingsApi;
  /** Signing in (the wizard's first step, and the Settings view's account section). */
  readonly signIn: Omit<TokenScreenProps, "auth" | "onOpen">;
}

/** Fleet's documentation (the project's home). */
export const DOCS_URL = "https://github.com/Brainwires/fleet/blob/master/docs";

/** A list typed as text: one entry per comma, space or line. */
export function splitList(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** The `claude mcp add` line for this machine (Fleet's MCP server runs from a Fleet checkout). */
export function mcpCommand(m: MachineInfo, checkout = "<path to fleet>"): string {
  const reads = [
    m.dataDir,
    ...(m.spoolDir ? [m.spoolDir] : []),
    ...(m.healthFile ? [m.healthFile] : []),
  ];
  const q = (s: string) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
  return [
    "claude mcp add --scope user fleet --",
    "deno run --no-config --no-prompt",
    q(`--allow-read=${reads.join(",")}`),
    `${checkout}/mcp/fleet-mcp.ts`,
    "--data-dir",
    q(m.dataDir),
    ...(m.spoolDir ? ["--hooks-dir", q(m.spoolDir)] : []),
    ...(m.healthFile ? ["--health-file", q(m.healthFile)] : []),
  ].join(" ");
}

type Draft = FleetSettings;

/** Move focus to a heading (where the DOM can: a test DOM has no focus()). */
function focus(el: HTMLElement | null): void {
  if (el && typeof el.focus === "function") el.focus();
}
type SetDraft = (fn: (d: Draft) => Draft) => void;

/** A labelled section with a heading the wizard focuses on arrival. */
function Section(
  props: { id: string; title: string; lead?: ReactNode; focus?: boolean; children: ReactNode },
) {
  const h = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => {
    if (props.focus) focus(h.current);
  }, [props.focus]);
  return (
    <section class="set-section" aria-labelledby={`${props.id}-h`}>
      <h2 class="set-title" id={`${props.id}-h`} tabIndex={-1} ref={h}>{props.title}</h2>
      {props.lead ? <p class="set-lead">{props.lead}</p> : null}
      {props.children}
    </section>
  );
}

function Check(
  props: { id: string; checked: boolean; onChange: (v: boolean) => void; children: ReactNode },
) {
  return (
    <label class="set-check" for={props.id}>
      <input
        id={props.id}
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange((e.target as HTMLInputElement).checked)}
      />
      <span>{props.children}</span>
    </label>
  );
}

function TextField(
  props: {
    id: string;
    label: string;
    value: string;
    onInput: (v: string) => void;
    hint?: string;
    placeholder?: string;
    multiline?: boolean;
    mono?: boolean;
  },
) {
  const hint = props.hint ? `${props.id}-hint` : undefined;
  const common = {
    id: props.id,
    value: props.value,
    placeholder: props.placeholder,
    spellcheck: false,
    autocomplete: "off",
    "aria-describedby": hint,
    class: props.mono ? "mono" : undefined,
  };
  const onInput = (e: { target: EventTarget | null }) =>
    props.onInput((e.target as HTMLInputElement).value);
  return (
    <div class="set-field">
      <label for={props.id}>{props.label}</label>
      {props.multiline
        ? <textarea rows={3} {...common} onInput={onInput} />
        : <input type="text" {...common} onInput={onInput} />}
      {props.hint ? <p class="set-hint" id={hint}>{props.hint}</p> : null}
    </div>
  );
}

function PolicySelect(
  props: {
    id: string;
    label: string;
    value: string;
    options: readonly string[];
    onChange: (v: string) => void;
  },
) {
  return (
    <select
      id={props.id}
      aria-label={props.label}
      onChange={(e) => props.onChange((e.target as HTMLSelectElement).value)}
    >
      {props.options.map((o) => <option key={o} value={o} selected={o === props.value}>{o}
      </option>)}
    </select>
  );
}

// ---- sections ----

function AccountSection(
  props: SettingsScreenProps & { focus?: boolean; info: TokenInfo | null; loadInfo: () => void },
) {
  const { auth, info } = props;
  const signedIn = auth === "gh" || auth === "stored";
  return (
    <Section
      id="set-account"
      title="Sign in to GitHub"
      focus={props.focus}
      lead="Fleet reads GitHub with a token that never leaves its backend: the GitHub CLI's when gh is signed in, else one you paste (kept in the system keychain)."
    >
      <p class="set-status" role="status">
        {auth === "gh"
          ? "Signed in with the GitHub CLI."
          : auth === "stored"
          ? "Using the token you saved."
          : auth === "public"
          ? "No token: public repositories only, no runners, no controls."
          : auth === "invalid"
          ? "GitHub refused the token Fleet had."
          : "No token yet."}
      </p>
      {signedIn || auth === "public"
        ? (
          <div class="set-token">
            {info
              ? (
                <dl class="set-facts">
                  <dt>Account</dt>
                  <dd>{info.login ?? "unknown"}</dd>
                  <dt>Token</dt>
                  <dd>{info.kind}</dd>
                  <dt>Scopes</dt>
                  <dd>
                    {info.scopes === null
                      ? "not reported (fine-grained tokens list permissions on GitHub)"
                      : info.scopes.length
                      ? info.scopes.join(", ")
                      : "none"}
                  </dd>
                  <dt>Controls</dt>
                  <dd class={info.write === "no" ? "set-warn" : undefined}>
                    {info.write === "yes"
                      ? "available: the token can write Actions (cancel, re-run, dispatch)"
                      : info.write === "no"
                      ? "read only: cancel, re-run and dispatch need the repo scope (or Actions: Read and write)"
                      : "check on GitHub: controls need Actions: Read and write"}
                  </dd>
                </dl>
              )
              : (
                <button type="button" class="btn" onClick={props.loadInfo}>
                  Check the token
                </button>
              )}
            <p class="set-hint">
              Reading needs Actions (read); the organizations' self-hosted runners need
              Administration (read, an organization admin's token). Controls need Actions write.
            </p>
          </div>
        )
        : null}
      {!signedIn
        ? <TokenForm {...props.signIn} auth={auth} onOpen={props.api.onOpen} idPrefix="set" />
        : null}
    </Section>
  );
}

function OwnersSection(
  props: {
    draft: Draft;
    set: SetDraft;
    focus?: boolean;
    info: TokenInfo | null;
    api: SettingsApi;
  },
) {
  const { draft, set, info } = props;
  const [owner, setOwner] = useState("");
  const [kind, setKind] = useState<"org" | "user">("org");
  const [repos, setRepos] = useState<RepoChoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [pick, setPick] = useState(draft.repos.allow.length > 0);
  const selected = pick;
  const has = (login: string) =>
    draft.owners.some((o) => o.login.toLowerCase() === login.toLowerCase());
  const offered: OwnerSetting[] = [
    ...(info?.login ? [{ login: info.login, kind: "user" as const }] : []),
    ...(info?.orgs ?? []).map((login) => ({ login, kind: "org" as const })),
    ...draft.owners,
  ].filter((o, i, all) =>
    all.findIndex((x) => x.login.toLowerCase() === o.login.toLowerCase()) === i
  );
  const toggle = (o: OwnerSetting, on: boolean) =>
    set((d) => ({
      ...d,
      owners: on
        ? [...d.owners.filter((x) => x.login.toLowerCase() !== o.login.toLowerCase()), o]
        : d.owners.filter((x) => x.login.toLowerCase() !== o.login.toLowerCase()),
    }));
  const load = async () => {
    setLoading(true);
    try {
      const lists = await Promise.all(
        draft.owners.map((o) => props.api.ownerRepos(o.login, o.kind)),
      );
      setRepos(lists.flat().filter((r) => !r.archived));
    } finally {
      setLoading(false);
    }
  };
  return (
    <Section
      id="set-owners"
      title="Owners and repositories"
      focus={props.focus}
      lead="The organizations or accounts whose GitHub Actions Fleet watches. Every repository of theirs is watched unless you pick some."
    >
      <fieldset class="set-group">
        <legend>Owners</legend>
        {offered.length === 0
          ? <p class="set-hint">No organizations found for the token: add one below.</p>
          : null}
        {offered.map((o) => (
          <Check
            key={o.login}
            id={`set-owner-${o.login}`}
            checked={has(o.login)}
            onChange={(on) => toggle(o, on)}
          >
            {o.login} <span class="muted">({o.kind === "org" ? "organization" : "user"})</span>
          </Check>
        ))}
        <div class="set-inline">
          <label for="set-owner-new" class="sr-only">Owner to add</label>
          <input
            id="set-owner-new"
            type="text"
            placeholder="organization or user"
            value={owner}
            spellcheck={false}
            autocomplete="off"
            onInput={(e) => setOwner((e.target as HTMLInputElement).value.trim())}
          />
          <PolicySelect
            id="set-owner-kind"
            label="Owner kind"
            value={kind}
            options={["org", "user"]}
            onChange={(v) => setKind(v === "user" ? "user" : "org")}
          />
          <button
            type="button"
            class="btn"
            disabled={!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(owner)}
            onClick={() => {
              toggle({ login: owner, kind }, true);
              setOwner("");
            }}
          >
            Add owner
          </button>
        </div>
      </fieldset>
      <fieldset class="set-group">
        <legend>Repositories</legend>
        <label class="set-check" for="set-repos-all">
          <input
            id="set-repos-all"
            type="radio"
            name="set-repos"
            checked={!selected}
            onChange={() => {
              setPick(false);
              set((d) => ({ ...d, repos: { ...d.repos, allow: [] } }));
            }}
          />
          <span>All of the owners' repositories</span>
        </label>
        <label class="set-check" for="set-repos-some">
          <input
            id="set-repos-some"
            type="radio"
            name="set-repos"
            checked={selected}
            onChange={() => {
              setPick(true);
              if (repos === null && draft.owners.length > 0) void load();
            }}
          />
          <span>Only the ones I pick</span>
        </label>
        {selected
          ? (
            <div class="set-repos" role="group" aria-label="Repositories to watch">
              {loading ? <p class="set-hint" aria-busy="true">Loading repositories…</p> : null}
              {(repos ?? draft.repos.allow.map((fullName) => ({ fullName } as RepoChoice))).map((
                r,
              ) => (
                <Check
                  key={r.fullName}
                  id={`set-repo-${r.fullName}`}
                  checked={draft.repos.allow.includes(r.fullName)}
                  onChange={(on) =>
                    set((d) => ({
                      ...d,
                      repos: {
                        ...d.repos,
                        allow: on
                          ? [...d.repos.allow.filter((x) => x !== r.fullName), r.fullName]
                          : d.repos.allow.filter((x) => x !== r.fullName),
                      },
                    }))}
                >
                  {r.fullName}
                  {r.private ? <span class="muted">· private</span> : null}
                </Check>
              ))}
              {repos === null && !loading
                ? (
                  <button
                    type="button"
                    class="btn"
                    disabled={draft.owners.length === 0}
                    onClick={load}
                  >
                    Load repositories
                  </button>
                )
                : null}
            </div>
          )
          : null}
        <TextField
          id="set-repos-deny"
          label="Never watch"
          value={draft.repos.deny.join(", ")}
          placeholder="owner/name, owner/other"
          mono
          onInput={(v) => set((d) => ({ ...d, repos: { ...d.repos, deny: splitList(v) } }))}
        />
        <TextField
          id="set-repos-pinned"
          label="Always poll (listed first)"
          value={draft.repos.pinned.join(", ")}
          placeholder="owner/name"
          hint="Polled every round even when quiet, and first in the lanes, in this order."
          mono
          onInput={(v) => set((d) => ({ ...d, repos: { ...d.repos, pinned: splitList(v) } }))}
        />
      </fieldset>
    </Section>
  );
}

function BranchesSection(props: { draft: Draft; set: SetDraft; focus?: boolean }) {
  const { draft, set } = props;
  const rules = draft.branches.rules;
  const update = (i: number, patch: Partial<BranchRule>) =>
    set((d) => ({
      ...d,
      branches: {
        ...d.branches,
        rules: d.branches.rules.map((r, j) => {
          if (j !== i) return r;
          const next = { ...r, ...patch };
          if (patch.repo === "") delete (next as { repo?: string }).repo;
          return next;
        }),
      },
    }));
  return (
    <Section
      id="set-branches"
      title="Protected branches"
      focus={props.focus}
      lead={
        <>
          Branches whose runs should stay green. A rule names <code>{DEFAULT_BRANCH_TOKEN}</code>
          {" "}
          (each repository's default branch, from GitHub), a branch, or a pattern with{" "}
          <code>*</code>; warn asks you to confirm with a warning, refuse blocks the control. A fork
          pull request's branch is never protected.
        </>
      }
    >
      <table class="set-rules">
        <thead>
          <tr>
            <th scope="col">Branch</th>
            <th scope="col">Repository</th>
            <th scope="col">Cancel</th>
            <th scope="col">Duplicate dispatch</th>
            <th scope="col">
              <span class="sr-only">Remove</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r, i) => (
            <tr key={i}>
              <td>
                <input
                  type="text"
                  class="mono"
                  aria-label={`Rule ${i + 1} branch`}
                  value={r.branch}
                  spellcheck={false}
                  onInput={(e) =>
                    update(i, { branch: (e.target as HTMLInputElement).value.trim() })}
                />
              </td>
              <td>
                <input
                  type="text"
                  class="mono"
                  aria-label={`Rule ${i + 1} repository (empty: all)`}
                  placeholder="all"
                  value={r.repo ?? ""}
                  spellcheck={false}
                  onInput={(e) => update(i, { repo: (e.target as HTMLInputElement).value.trim() })}
                />
              </td>
              <td>
                <PolicySelect
                  id={`set-rule-${i}-cancel`}
                  label={`Rule ${i + 1} cancel`}
                  value={r.cancel}
                  options={["warn", "refuse"]}
                  onChange={(v) => update(i, { cancel: v === "refuse" ? "refuse" : "warn" })}
                />
              </td>
              <td>
                <PolicySelect
                  id={`set-rule-${i}-dup`}
                  label={`Rule ${i + 1} duplicate dispatch`}
                  value={r.duplicateDispatch}
                  options={["warn", "refuse"]}
                  onChange={(v) =>
                    update(i, { duplicateDispatch: v === "refuse" ? "refuse" : "warn" })}
                />
              </td>
              <td>
                <button
                  type="button"
                  class="ctl"
                  aria-label={`Remove rule ${i + 1}`}
                  onClick={() =>
                    set((d) => ({
                      ...d,
                      branches: {
                        ...d.branches,
                        rules: d.branches.rules.filter((_, j) => j !== i),
                      },
                    }))}
                >
                  Remove
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p class="set-inline">
        <button
          type="button"
          class="btn"
          onClick={() =>
            set((d) => ({
              ...d,
              branches: {
                ...d.branches,
                rules: [...d.branches.rules, {
                  branch: "",
                  cancel: "warn",
                  duplicateDispatch: "warn",
                }],
              },
            }))}
        >
          Add rule
        </button>
        <label for="set-other-dup">Duplicate dispatch on other branches</label>
        <PolicySelect
          id="set-other-dup"
          label="Duplicate dispatch on other branches"
          value={draft.branches.otherDuplicateDispatch}
          options={["allow", "warn", "refuse"]}
          onChange={(v) =>
            set((d) => ({
              ...d,
              branches: {
                ...d.branches,
                otherDuplicateDispatch: v === "allow" || v === "refuse" ? v : "warn",
              },
            }))}
        />
      </p>
    </Section>
  );
}

function StartSection(props: { draft: Draft; set: SetDraft; focus?: boolean }) {
  const { draft, set } = props;
  const n = draft.notifications;
  const note = (k: keyof typeof n) => (v: boolean) =>
    set((d) => ({ ...d, notifications: { ...d.notifications, [k]: v } }));
  return (
    <Section id="set-start" title="Start and notifications" focus={props.focus}>
      <Check
        id="set-login"
        checked={draft.startAtLogin}
        onChange={(v) => set((d) => ({ ...d, startAtLogin: v }))}
      >
        Start Fleet at login <span class="muted">(off unless you turn it on)</span>
      </Check>
      <fieldset class="set-group">
        <legend>Notify me when</legend>
        <Check id="set-n-pool" checked={n.poolUnhealthy} onChange={note("poolUnhealthy")}>
          a runner pool turns unhealthy
        </Check>
        <Check id="set-n-queued" checked={n.queuedLong} onChange={note("queuedLong")}>
          a job waits over 15 minutes for a runner
        </Check>
        <Check id="set-n-fail" checked={n.protectedFailure} onChange={note("protectedFailure")}>
          a job fails on a protected branch
        </Check>
      </fieldset>
    </Section>
  );
}

function IntegrationsSection(
  props: { draft: Draft; set: SetDraft; focus?: boolean; machine: MachineInfo; api: SettingsApi },
) {
  const { draft, set, machine } = props;
  const w = draft.webhooks;
  const hv = draft.pools.healthVariable;
  const sched = draft.integrations.runnerScheduler;
  const setW = (patch: Partial<typeof w>) =>
    set((d) => ({ ...d, webhooks: { ...d.webhooks, ...patch } }));
  const docs = (page: string) => (e: { preventDefault(): void }) => {
    e.preventDefault();
    props.api.onOpen(`${DOCS_URL}/${page}`);
  };
  return (
    <Section
      id="set-integrations"
      title="Integrations (optional)"
      focus={props.focus}
      lead="Everything here is optional: Fleet works by polling GitHub alone."
    >
      <fieldset class="set-group">
        <legend>Webhooks</legend>
        <p class="set-hint">
          With GitHub's workflow webhooks delivered to this machine, changes arrive in seconds and
          polling slows down. Setup:{" "}
          <a href={`${DOCS_URL}/webhooks.md`} onClick={docs("webhooks.md")}>docs/webhooks.md</a>.
          Changes here apply the next time Fleet starts.
        </p>
        <Check id="set-hooks" checked={w.enabled} onChange={(v) => setW({ enabled: v })}>
          Receive webhooks on this machine
        </Check>
        {w.enabled
          ? (
            <div class="set-grid">
              <TextField
                id="set-hooks-port"
                label="Port (loopback)"
                value={String(w.port)}
                onInput={(v) => setW({ port: Number(v) || 0 })}
              />
              <TextField
                id="set-hooks-spool"
                label="Spool folder"
                value={w.spoolDir}
                placeholder="(Fleet's data folder)"
                mono
                onInput={(v) => setW({ spoolDir: v.trim() })}
              />
              <div class="set-field">
                <label for="set-hooks-secret">Secret</label>
                <PolicySelect
                  id="set-hooks-secret"
                  label="Secret"
                  value={w.secret.source}
                  options={["macos-keychain", "secure-store"]}
                  onChange={(v) =>
                    setW({
                      secret: v === "macos-keychain"
                        ? {
                          source: "macos-keychain",
                          service: "fleet-webhooks",
                          account: "github-webhook-secret",
                        }
                        : { source: "secure-store" },
                    })}
                />
              </div>
              {w.secret.source === "macos-keychain"
                ? (
                  <>
                    <TextField
                      id="set-hooks-service"
                      label="Keychain service"
                      value={w.secret.service}
                      mono
                      onInput={(v) =>
                        setW({ secret: { ...w.secret, service: v.trim() } as typeof w.secret })}
                    />
                    <TextField
                      id="set-hooks-account"
                      label="Keychain account"
                      value={(w.secret as { account: string }).account}
                      mono
                      onInput={(v) =>
                        setW({ secret: { ...w.secret, account: v.trim() } as typeof w.secret })}
                    />
                  </>
                )
                : (
                  <p class="set-hint">
                    The secure-store secret is set from the command line for now (docs/webhooks.md).
                  </p>
                )}
              <TextField
                id="set-hooks-launchd"
                label="Require launchd job (macOS)"
                value={w.requireLaunchdJob}
                placeholder="none"
                hint="Turn webhooks on only while this launchd job's file is installed (the endpoint's tunnel)."
                mono
                onInput={(v) => setW({ requireLaunchdJob: v.trim() })}
              />
            </div>
          )
          : null}
      </fieldset>
      <fieldset class="set-group">
        <legend>Pool health variable</legend>
        <p class="set-hint">
          Without one, pools are grouped from the organizations' self-hosted runners by their custom
          labels. A runner watchdog can publish an Actions variable instead (schema:{" "}
          <a href={`${DOCS_URL}/pool-health.md`} onClick={docs("pool-health.md")}>
            docs/pool-health.md
          </a>).
        </p>
        <div class="set-grid">
          <TextField
            id="set-hv-org"
            label="Organization"
            value={hv?.org ?? ""}
            onInput={(v) =>
              set((d) => ({
                ...d,
                pools: {
                  healthVariable: v.trim() || hv?.name
                    ? { org: v.trim(), name: hv?.name ?? "" }
                    : null,
                },
              }))}
          />
          <TextField
            id="set-hv-name"
            label="Variable"
            value={hv?.name ?? ""}
            mono
            onInput={(v) =>
              set((d) => ({
                ...d,
                pools: {
                  healthVariable: v.trim() || hv?.org
                    ? { org: hv?.org ?? "", name: v.trim() }
                    : null,
                },
              }))}
          />
        </div>
      </fieldset>
      {sched || draft.runnerHosts.length
        ? (
          <fieldset class="set-group">
            <legend>Runner scheduler</legend>
            <p class="set-hint">
              Configured in the settings file:{" "}
              {sched ? `${sched.pools.length} declared pools` : "no scheduler"}
              {sched?.controls ? ", pool controls" : ""}
              {sched?.localHealthFile ? ", local health file" : ""}
              {draft.runnerHosts.length ? `, ${draft.runnerHosts.length} runner-host rules` : ""}.
              Kept as they are.
            </p>
          </fieldset>
        )
        : null}
      <fieldset class="set-group">
        <legend>MCP server for agents</legend>
        <p class="set-hint">
          Agents can read CI state from Fleet's cache instead of polling GitHub. Register Fleet's
          read-only MCP server (from a Fleet checkout) with:
        </p>
        <pre
          class="set-code"
          tabIndex={0}
          aria-label="MCP registration command"
        >{mcpCommand(machine)}</pre>
      </fieldset>
    </Section>
  );
}

// ---- the screens ----

/** The wizard's steps, in order. */
export const WIZARD_STEPS = [
  { id: "account", title: "Sign in" },
  { id: "owners", title: "Owners and repos" },
  { id: "branches", title: "Protected branches" },
  { id: "start", title: "Start and notifications" },
  { id: "integrations", title: "Integrations" },
] as const;

function useDraft(initial: FleetSettings): [Draft, SetDraft] {
  const [draft, setDraft] = useState<Draft>(initial);
  return [draft, (fn) => setDraft((d) => fn(d))];
}

function useTokenInfo(api: SettingsApi, auth: AuthState) {
  const [info, setInfo] = useState<TokenInfo | null>(null);
  const load = () => void api.tokenInfo().then(setInfo).catch(() => {});
  useEffect(() => {
    if (auth === "gh" || auth === "stored") load();
    else setInfo(null);
  }, [auth]);
  return [info, load] as const;
}

function Errors({ errors }: { errors: readonly string[] }) {
  if (!errors.length) return null;
  return (
    <div class="set-errors" role="alert">
      <p>These settings can't be saved yet:</p>
      <ul>{errors.map((e) => <li key={e}>{e}</li>)}</ul>
    </div>
  );
}

/** The first-run wizard (also "Run setup again" from the Settings view). */
export function SetupWizard(props: SettingsScreenProps & { readonly onDone?: () => void }) {
  const [draft, set] = useDraft(props.settings);
  const [step, setStep] = useState(0);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [busy, setBusy] = useState(false);
  const [info, loadInfo] = useTokenInfo(props.api, props.auth);
  const signedIn = props.auth === "gh" || props.auth === "stored" || props.auth === "public";
  const last = step === WIZARD_STEPS.length - 1;
  const canNext = step === 0
    ? signedIn
    : step === 1
    ? draft.owners.length > 0 || draft.repos.pinned.length > 0
    : true;
  const finish = async () => {
    setBusy(true);
    try {
      const r = await props.api.save({ ...draft, setupComplete: true });
      if (r.ok) {
        setErrors([]);
        props.onDone?.();
      } else setErrors(r.errors);
    } finally {
      setBusy(false);
    }
  };
  const id = WIZARD_STEPS[step].id;
  return (
    <div class="setup">
      <div class="setup-card">
        <header class="setup-head">
          <h1 class="signin-title">Set up Fleet</h1>
          <ol class="setup-steps" aria-label="Setup steps">
            {WIZARD_STEPS.map((s, i) => (
              <li
                key={s.id}
                class={i === step ? "on" : i < step ? "done" : undefined}
                aria-current={i === step ? "step" : undefined}
              >
                <span class="num">{i + 1}</span> {s.title}
              </li>
            ))}
          </ol>
        </header>
        <form
          class="setup-body"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canNext || busy) return;
            if (last) void finish();
            else setStep(step + 1);
          }}
        >
          {id === "account"
            ? <AccountSection {...props} focus info={info} loadInfo={loadInfo} />
            : id === "owners"
            ? <OwnersSection draft={draft} set={set} focus info={info} api={props.api} />
            : id === "branches"
            ? <BranchesSection draft={draft} set={set} focus />
            : id === "start"
            ? <StartSection draft={draft} set={set} focus />
            : (
              <IntegrationsSection
                draft={draft}
                set={set}
                focus
                machine={props.machine}
                api={props.api}
              />
            )}
          <Errors errors={errors} />
          <div class="setup-nav">
            <button
              type="button"
              class="btn"
              disabled={step === 0 || busy}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
            <span class="muted small">Step {step + 1} of {WIZARD_STEPS.length}</span>
            <button type="submit" class="btn btn-primary" disabled={!canNext || busy}>
              {last ? (busy ? "Saving…" : "Finish") : "Next"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** The Settings view: every section, Save and Close; "Run setup again" re-opens the wizard. */
export function SettingsView(
  props: SettingsScreenProps & { readonly onClose: () => void; readonly onRerun: () => void },
) {
  const [draft, set] = useDraft(props.settings);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [info, loadInfo] = useTokenInfo(props.api, props.auth);
  const dirty = JSON.stringify(draft) !== JSON.stringify(props.settings);
  const head = useRef<HTMLHeadingElement | null>(null);
  useEffect(() => focus(head.current), []);
  const change: SetDraft = (fn) => {
    setSaved(false);
    set(fn);
  };
  return (
    <div class="settings">
      <header class="settings-head">
        <h1 class="signin-title" tabIndex={-1} ref={head}>Settings</h1>
        <nav aria-label="Settings sections" class="settings-nav">
          {[
            ["set-account", "Account"],
            ["set-owners", "Owners"],
            ["set-branches", "Branches"],
            ["set-start", "Start"],
            ["set-integrations", "Integrations"],
          ].map(([id, label]) => <a key={id} href={`#${id}-h`}>{label}</a>)}
        </nav>
        <div class="settings-actions">
          <button type="button" class="btn" onClick={props.onRerun}>Run setup again</button>
          <button type="button" class="btn" onClick={props.onClose}>Close</button>
          <button
            type="button"
            class="btn btn-primary"
            disabled={!dirty || busy}
            onClick={async () => {
              setBusy(true);
              try {
                const r = await props.api.save(draft);
                if (r.ok) {
                  setErrors([]);
                  setSaved(true);
                } else setErrors(r.errors);
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Saving…" : "Save"}
          </button>
        </div>
      </header>
      <div class="settings-body">
        <Errors errors={errors} />
        {saved && !dirty ? <p class="set-saved" role="status">Saved.</p> : null}
        <AccountSection {...props} info={info} loadInfo={loadInfo} />
        <OwnersSection draft={draft} set={change} info={info} api={props.api} />
        <BranchesSection draft={draft} set={change} />
        <StartSection draft={draft} set={change} />
        <IntegrationsSection draft={draft} set={change} machine={props.machine} api={props.api} />
      </div>
    </div>
  );
}
