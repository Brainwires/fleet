# Security policy

## Reporting a vulnerability

Please report vulnerabilities privately. Do not open a public issue, pull request or discussion for
one.

Use GitHub's private vulnerability reporting: on the repository page, open **Security** →
**Advisories** → **Report a vulnerability** (Brainwires/fleet). The report goes only to the
maintainers.

Include what you found, the Fleet version and OS, the steps to reproduce it, and what an attacker
gains. Do not include real tokens, webhook secrets or other credentials in a report; redact them.

## Supported versions

Only the latest release (and the current `master`) receives security fixes. Please check that the
problem still reproduces on the latest build before reporting it.

## Scope

In scope:

- **GitHub token handling.** How Fleet stores, reads and sends the token (keychain / environment),
  and anything that lets the page, a log, the event log, an error message or a data file see it.
- **The webhook receiver and its secret.** Signature verification, replay handling, the local
  listener and tunnel setup, and storage of the secret.
- **Controls.** The actions that dispatch, re-run or cancel workflows and the pool commands: any way
  to run something other than the fixed, allow-listed commands, or to act on a repository or pool
  outside the intended set.
- **The MCP server.** Anything that lets an MCP client read more than the documented read-only
  snapshot, write, or reach files outside its allowed paths.
- **Local data files.** Permissions, contents and integrity of the files Fleet writes in its data
  directory.

Out of scope: vulnerabilities in GitHub, the Deno Desktop runtime or denext themselves (report those
to the respective projects), attacks that already require control of the user's account or machine,
and issues in unreleased forks.

## Response

We aim to acknowledge a report within 5 working days and to share an assessment or a fix plan within
30 days. We will keep you informed, credit you in the advisory if you wish, and ask that you give us
reasonable time to release a fix before disclosing the issue publicly.
