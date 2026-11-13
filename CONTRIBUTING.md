# Contributing to Fleet

Fleet is a denext desktop app. Thank you for helping; this page covers the setup and the rules for a
change.

## Setup

Install the `denext` CLI (<https://denext.dev/docs/install>): it brings its own Deno, so no Deno
install is needed (with Deno installed, `deno task <name>` runs the same tasks). Then, from the
repository root:

```sh
denext task check     # deno fmt --check, deno lint, then the tests
denext task test      # the tests alone (no network, gh or keychain needed)
denext task dev       # the page alone in a browser (no backend, no data)
denext task desktop   # export + build + open the app from this folder
```

Run one test file, or one test by name:

```sh
denext test tests/pools.test.ts
denext test tests/pools.test.ts --filter "name of the test"
```

Packaging (unsigned unless credentials are set; see the README):

```sh
denext task desktop:package            # macOS: dist/Fleet.app + dist/Fleet.dmg
denext task desktop:package:windows    # Windows x86_64: dist/Fleet-x64-windows.zip
denext run -A scripts/package-linux.ts # Linux: tar.gz and deb in dist/
```

Credentials come from the environment and the keychain only; never commit a token, secret, key or
certificate, and never paste one into an issue or a log.

## Code style

- Formatting is `deno fmt` (line width 100, 2 spaces, semicolons, double quotes) and applies to
  Markdown too. Run `denext fmt` before committing.
- Lint is `deno lint` with the denext plugin; its rules are correctness rules with no auto-fix.
- Follow denext conventions: import from `denext`, not `react`; hooks and handlers live in
  `"use client"` files.

## Tests

A change comes with tests: a bug fix with a test that fails without it, a feature with tests for its
behavior. Tests use trimmed recorded fixtures (`tests/fixtures`); they never touch the network, the
`gh` CLI or the keychain. `denext task check` must pass before you push.

## Commits and pull requests

- Branch from `master`; open a pull request against `master`.
- Commit messages are short and imperative, with a scope prefix when useful (`fix(controls): ...`,
  `docs: ...`). Keep a commit to one change.
- A pull request says what changed and why, how you tested it, and notes any user-visible change.
  Fill in the pull request template.
- Security problems go through [SECURITY.md](SECURITY.md), not a public issue.

## Docs

User documentation is the [README](README.md) and the guides in [docs/](docs/) (for example
[docs/webhooks.md](docs/webhooks.md)). Update them in the same change as the behavior.

## Checking the GUI safely

Launch Fleet with `FLEET_CONTROLS_DRY_RUN=1` in its environment: every control shows its dialog and
sends nothing, so you can exercise the window without dispatching, re-running or cancelling
anything. See "Dry-run mode" in the README.

## License

By contributing you agree that your contribution is licensed under the project's terms: MIT OR
Apache-2.0.
