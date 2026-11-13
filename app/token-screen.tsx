"use client";
// Signing Fleet in: no GitHub CLI token was found (or the stored one was refused). The pasted token
// goes straight to the backend, which checks it, keeps it in the extension's own secure store and
// never sends it back; this page clears its field either way. `TokenForm` is the body, shared with
// the first-run wizard's sign-in step; `TokenScreen` is the full-window card shown when a set-up
// Fleet loses its token.

import { useState } from "denext";
import type { AuthState } from "../lib/model.ts";
import type { TokenCheck } from "../lib/service.ts";

/** What signing in asks of the backend. */
export interface TokenScreenProps {
  readonly auth: AuthState;
  readonly submit: (token: string) => Promise<TokenCheck>;
  readonly retryGh: () => Promise<boolean>;
  readonly usePublic: () => Promise<void>;
  readonly onOpen: (url: string) => void;
}

export const NEW_TOKEN_URL = "https://github.com/settings/personal-access-tokens/new";

/** The ways in: the GitHub CLI, a pasted token, or public data only. */
export function TokenForm(props: TokenScreenProps & { readonly idPrefix?: string }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const id = `${props.idPrefix ?? "signin"}-token`;

  const run = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMessage("");
    try {
      setMessage(await fn());
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <ol class="signin-steps">
        <li>
          Either run <code>gh auth login</code>, then{" "}
          <button
            type="button"
            class="linkish"
            disabled={busy}
            onClick={() =>
              run(async () => (await props.retryGh()) ? "" : "Still no token from the GitHub CLI.")}
          >
            try the GitHub CLI again
          </button>
          ,
        </li>
        <li>
          or{" "}
          <a
            href={NEW_TOKEN_URL}
            onClick={(e) => {
              e.preventDefault();
              props.onOpen(NEW_TOKEN_URL);
            }}
          >
            create a fine-grained token
          </a>{" "}
          for the organizations or account you want to watch, and paste it here. Read access to
          Actions shows the jobs; Administration (read) adds the organizations' self-hosted runners;
          Actions "Read and write" is needed for the controls (cancel, re-run, dispatch). It is kept
          in your system keychain.
        </li>
      </ol>
      <form
        class="signin-form"
        onSubmit={(e) => {
          e.preventDefault();
          const token = value;
          setValue("");
          void run(async () => {
            const r = await props.submit(token);
            return r.ok ? "" : r.message;
          });
        }}
      >
        <label class="field" for={id}>
          <span>Token</span>
          <input
            id={id}
            type="password"
            name="token"
            autocomplete="off"
            spellcheck={false}
            value={value}
            onInput={(e) => setValue((e.target as HTMLInputElement).value)}
            placeholder="github_pat_…"
          />
        </label>
        <button type="submit" class="btn btn-primary" disabled={busy || value.trim() === ""}>
          {busy ? "Checking…" : "Save token"}
        </button>
      </form>
      {message ? <p class="signin-error" role="alert">{message}</p> : null}
      <p class="signin-foot">
        <button
          type="button"
          class="linkish"
          disabled={busy}
          onClick={() =>
            run(async () => {
              await props.usePublic();
              return "";
            })}
        >
          Continue without a token
        </button>{" "}
        <span class="muted">(public repos only; no runners or pool health)</span>
      </p>
    </>
  );
}

/** The full-window sign-in card. */
export function TokenScreen(props: TokenScreenProps) {
  return (
    <div class="signin">
      <div class="signin-card">
        <h1 class="signin-title">Connect Fleet to GitHub</h1>
        <p class="signin-lead">
          {props.auth === "invalid"
            ? "GitHub refused the token Fleet had. Paste a new one, or sign the GitHub CLI in again."
            : "Fleet reads the GitHub CLI's token when gh is installed and signed in. It found none."}
        </p>
        <TokenForm {...props} />
      </div>
    </div>
  );
}
