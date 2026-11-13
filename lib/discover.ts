// What the first-run wizard and the Settings view ask GitHub: who the token belongs to, its scopes
// (read vs write), the organizations it can see, and an owner's repos with their default branches.
// Each answer is a handful of requests through the same client (ETag cache, rate limit), only when
// the user opens those steps. No token ever leaves the backend: only these facts do.

import { type GitHubClient, GitHubError } from "./github.ts";
import type { GhRepo } from "./github-types.ts";

/** The kind of token, from its prefix (the prefix only: the token never leaves the service). */
export type TokenKind = "classic" | "fine-grained" | "oauth" | "app" | "unknown" | "none";

/** What the token can do, as far as GitHub says. */
export interface TokenInfo {
  readonly kind: TokenKind;
  /** The account it belongs to, or `null` (none, or GitHub didn't answer). */
  readonly login: string | null;
  /** Its OAuth scopes (classic and OAuth tokens), or `null` (fine-grained: not reported). */
  readonly scopes: readonly string[] | null;
  /**
   * Whether it can use the controls (cancel, re-run, dispatch need Actions write): `yes` with the
   * `repo` / `public_repo` scope, `no` for a classic or OAuth token without it, `unknown` for a
   * fine-grained token (its permissions aren't reported: Actions must be "Read and write").
   */
  readonly write: "yes" | "no" | "unknown";
  /** The organizations it can see (owners to offer). */
  readonly orgs: readonly string[];
  /** Why something couldn't be read, or `""`. */
  readonly message: string;
}

/** A repo as the wizard lists it. */
export interface RepoChoice {
  readonly fullName: string;
  readonly defaultBranch: string | null;
  readonly private: boolean;
  readonly archived: boolean;
}

/** A token's kind from its prefix. */
export function tokenKind(token: string | null): TokenKind {
  if (!token) return "none";
  if (token.startsWith("github_pat_")) return "fine-grained";
  if (token.startsWith("ghp_")) return "classic";
  if (token.startsWith("gho_")) return "oauth";
  if (token.startsWith("ghu_") || token.startsWith("ghs_")) return "app";
  return "unknown";
}

/** Whether a scope list allows Actions writes. */
export function scopesCanWrite(
  scopes: readonly string[] | null,
  kind: TokenKind,
): TokenInfo["write"] {
  if (scopes === null) return kind === "classic" || kind === "oauth" ? "no" : "unknown";
  return scopes.includes("repo") || scopes.includes("public_repo") ? "yes" : "no";
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** Who the token is, its scopes and its organizations. */
export async function discoverToken(
  client: GitHubClient | null,
  kind: TokenKind,
): Promise<TokenInfo> {
  if (!client || kind === "none") {
    return { kind: "none", login: null, scopes: null, write: "no", orgs: [], message: "" };
  }
  let login: string | null = null;
  let message = "";
  try {
    const me = (await client.get<{ login?: unknown }>("/user")).body;
    if (typeof me.login === "string" && LOGIN.test(me.login)) login = me.login;
  } catch (err) {
    message = err instanceof GitHubError ? `couldn't read the account: ${err.message}` : "error";
  }
  const orgs: string[] = [];
  try {
    const list = (await client.get<{ login?: unknown }[]>("/user/orgs?per_page=100")).body;
    for (const o of list) {
      if (typeof o.login === "string" && LOGIN.test(o.login)) orgs.push(o.login);
    }
  } catch {
    // A token that can't list its orgs: the user types the owner instead.
  }
  const scopes = client.scopes();
  return { kind, login, scopes, write: scopesCanWrite(scopes, kind), orgs, message };
}

/** An owner's repos (at most 1,000), archived ones included and marked. */
export async function listOwnerRepos(
  client: GitHubClient,
  owner: string,
  kind: "org" | "user",
): Promise<RepoChoice[]> {
  if (!LOGIN.test(owner)) return [];
  const pages = async (first: string) => {
    const out: GhRepo[] = [];
    let url: string | null = first;
    for (let page = 0; url && page < 10; page++) {
      const r: { body: GhRepo[]; next: string | null } = await client.get<GhRepo[]>(url);
      out.push(...r.body);
      url = r.next;
    }
    return out;
  };
  let repos: GhRepo[];
  if (kind === "org") {
    repos = await pages(`/orgs/${owner}/repos?per_page=100&type=all`);
  } else {
    const lower = owner.toLowerCase();
    repos = (await pages("/user/repos?per_page=100&affiliation=owner"))
      .filter((r) => r.full_name.toLowerCase().startsWith(`${lower}/`));
    if (repos.length === 0) repos = await pages(`/users/${owner}/repos?per_page=100&type=owner`);
  }
  return repos
    .filter((r) => typeof r.full_name === "string")
    .map((r) => ({
      fullName: r.full_name,
      defaultBranch: r.default_branch ?? null,
      private: r.private === true,
      archived: r.archived === true,
    }))
    .sort((a, b) => a.fullName.localeCompare(b.fullName));
}
