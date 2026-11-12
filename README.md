# Fleet

The Brainwires org's GitHub Actions jobs and our self-hosted runner pools, live, in one desktop
window plus a tray icon. Internal only: it names our infrastructure (pool labels, runner names).

A denext desktop app (Deno Desktop runtime). The backend is a desktop extension that runs in the
app's own Deno process, holds the GitHub token, polls the API, and hands the page a plain snapshot.
The page never sees the token.

## Run it

```sh
denext task desktop            # export + open the window (denext's pinned Deno Desktop runtime)
denext task test               # data layer, view and route tests (no network, no gh, no keychain)
denext task check              # fmt --check, lint, tests
denext task desktop:package    # macOS: dist/Fleet.app + dist/Fleet.dmg (see Signing)
denext desktop package --target-os windows .   # Windows: dist/*.msi + .zip, from any host
```

`deno task …` runs the same tasks with Deno installed. Never run the GUI on the Mac mini.

## Token

1. On startup the backend runs `gh auth token` (only `/opt/homebrew/bin/gh` or `/usr/local/bin/gh`
   on macOS, `/usr/bin/gh` or `/usr/local/bin/gh` on Linux, `C:\Program Files\GitHub CLI\gh.exe` on
   Windows; never a `gh` from PATH).
2. Else a token pasted earlier, from the extension's own secure-store namespace
   (`dev.brainwires.fleet/ext/fleet` in the OS keychain; no page can read it).
3. Else the first-run screen: paste a fine-grained token (read: Actions, Administration for the
   self-hosted runners, Variables, on the Brainwires org). It is checked with `GET /rate_limit`
   before it is stored. "Continue without a token" runs on public data only (the core repos, no
   runners or pool health, polled at 60 s / 5 min to fit the 60-an-hour limit).

The token is never logged, rendered, written to a file, or returned to the page.

## The shared rate limit

Fleet uses the user's gh token, and so shares one 5,000-an-hour REST budget with the runner
scheduler, the watchdog and the CI watchers. If Fleet starved it, queued jobs would go unseen and
runners would stop launching. So (`lib/budget.ts`): every request is conditional (ETag; unchanged
lists are free 304s); below 1,500 remaining it polls at 60 s even with the window visible; below 800
every 5 min with a banner "Rate limit low: slowed down to protect the runner scheduler"; below 300
not at all until the reset; over 1,200 counted (non-304) requests in Fleet's last hour, every 5 min.
Job lists are read only for runs whose `updated_at` changed; repos with no active run on the last 3
polls are polled every 5 min; the org repo list every 10 min. The remaining budget is in the status
line (amber below 1,500, red below 800).

## Webhooks (the Mac mini only)

On the machine that runs the Cloudflare tunnel (`com.brainwires.denext-ci-hooks-tunnel`) and holds
the webhook secret (keychain item `denext-ci-hooks` / `github-webhook-secret`), Fleet listens on
`127.0.0.1:8789` for `POST /github/hooks` (anything else: 404). In order:
`content-type:
application/json` (else 415), at most 1 MiB (else 413; a large Content-Length is
refused unread), then `X-Hub-Signature-256` checked with a constant-time compare before anything is
parsed (else 401 "rejected signature"). `ping` → 200; `workflow_job` / `workflow_run` → 202,
de-duplicated on `X-GitHub-Delivery` (the last 10,000), applied after the response to the same state
and event log as polling, and appended to `~/.denext-runners/hooks/events.jsonl` (rotated at 20 MB,
two kept) for the runner scheduler. Payloads are data only: nothing from one is run or fetched.

With deliveries arriving, polling only reconciles every 5 min; with no delivery for 10 min while
runs are active it polls at the normal rate again. The status line shows `hooks: live`,
`stale (last delivery N min ago)` or `off`. Elsewhere the receiver is off and Fleet polls.

`denext task hooks` runs the receiver alone, without a window, for an end-to-end check of the tunnel
and the org webhook (one summary line per delivery, never the secret or a body). Don't run it beside
the app: only one can hold the port.

## What it polls

| What                    | Endpoint                                                           | When                         |
| ----------------------- | ------------------------------------------------------------------ | ---------------------------- |
| Org repos               | `GET /orgs/Brainwires/repos`                                       | every 10 min                 |
| Active runs             | `GET /repos/{repo}/actions/runs?status=queued/in_progress/waiting` | every round*                 |
| Jobs of each active run | `GET /repos/{repo}/actions/runs/{id}/jobs`                         | every round, once more after |
| Runners                 | `GET /orgs/Brainwires/actions/runners`                             | every round                  |
| Pool health             | `GET /orgs/Brainwires/actions/variables/DENEXT_POOL_HEALTH`        | every round                  |

A round is every 15 s while the window is visible and 60 s while hidden. \*The core repos (deno,
denext, laufey, qutty), any repo pushed in the last 24 h, and any repo that had an active run last
round are polled every round; every other non-archived repo once per 10-minute sweep.

Every request is conditional (`If-None-Match`), so an unchanged list is a free 304. 403 / 429 with a
rate-limit signal back off until the reset time or `Retry-After` (else 1 min, doubling to 15 min); a
403 that is a permission refusal (no admin read on runners, say) is retried every 10 min. The
remaining rate limit is in the header.

## The screen

- **Header**: a 3 px severity stripe (grey, amber, red), running and queued counts, why it isn't
  green, last poll, poll interval, API requests left, Refresh.
- **Pool strip**: one card per pool (mac-arm, mac-x64, linux-x64, linux-x64-2204, linux-x64-docker,
  win-arm64, win-x64, then GitHub-hosted). Slots as pips (filled = busy), state chip (ok / paused /
  unhealthy / no health) with its reason, and the oldest queued wait, red past 15 min. Slots and
  busy come from `DENEXT_POOL_HEALTH` when it is fresh; without it, the defaults from
  `ops/runners/runners.conf` and our running jobs.
- **Running / Queued lanes**: repo → run (workflow, branch, short SHA, event) → job (name, pool
  chip, runner, elapsed or waited, ticking each second; `/ ~usual` once three successful runs of
  that job were seen). A default branch (`development-denext`, `development`, `main`) gets a violet
  left rule and a ◆ branch chip. A job queued over 15 min turns red; one running past 1.5× its usual
  length (at least 3 min over) turns amber.
- **Side**: the variable's recent alerts, and jobs finished in the last 30 min with ✓ / ✕ / ⊘.
- A click on a run or job opens it on github.com in the system browser.

Tray-resident, like denext's examples/hangar: no Dock icon while only the tray runs
(`activationPolicy: "accessory"`; regular while the window shows). The window starts hidden (shown
on the first launch and when a token is needed); its close button hides it, and only a real quit
(Cmd+Q, the tray's Quit Fleet, logout) quits. A second launch shows the window. Polling and the
event log go on while hidden (60 s). Tray: tooltip "N running · M queued" plus the reasons, the icon
red when a pool is unhealthy or a job has been queued over 15 min; a click toggles the window; the
menu has Show / Hide Fleet, the summary (disabled), Pause notifications, Start at login (on at the
first run; your "off" sticks), Refresh now, Quit Fleet.

**Event log** (bottom pane): one line per event, newest at the bottom, following new lines unless
you scrolled up. Job queued / started (pool, runner) / finished (conclusion; for a failure the
failed step and the first failure annotation), STALLED (running past 75 min) and QUEUED-LONG (past
25 min with no runner), each again every 30 min, run completed, a burst of cancelled jobs from one
run as one line ("run N cancelled (14 jobs)"), pool health changes and the variable's alerts. Each
line: local time, a severity glyph (✓ ✕ ▲ • ⊘, coloured too), repo, workflow / job, the text, a
link. Filters: all / problems, repo, search. The first poll only records the state (no flood); the
last 2,000 lines and the tracker are kept in `fleet-events.json` in the app's data folder, so the
log survives a restart (state older than 15 min at a restart is re-seeded silently).

Notifications (native, from the backend so they arrive while the window is hidden): a pool goes
unhealthy (once per outage, keyed by its `since`), a job passes 15 min queued (once per job; more
than three at once become one summary), a default-branch job fails (once per job, only failures
after Fleet started). Posted keys are kept 48 h in `fleet-state.json` in the app's data folder, so a
relaunch doesn't repeat them.

## Controls

GitHub, through the backend with the same token (never from page JS): per run Cancel, Re-run failed
jobs, Re-run all (hover a run); Re-run on a finished job that didn't succeed; Dispatch… a workflow
(repo → a workflow that declares `workflow_dispatch` → ref → its declared inputs, read from that
block of the workflow YAML). Guardrails, as code in `lib/controls.ts` (unit-tested):

- every control asks in the OS's own dialog, naming exactly what will happen ("Cancel run
  43194560988, denext tests on rel/3.0.0-denext.21, 41 jobs?"); the safe button is the default;
- Cancel is refused outright on `development-denext`, `development`, `main` or the repo's own
  default branch, with the reason shown;
- Dispatch is refused when the workflow already has a run on that commit SHA, unless it was
  cancelled;
- a re-run on `rel/*` warns that a failed attempt on a release commit blocks its tag;
- every action (and every refusal) goes to the event log, marked YOU.

Pool controls, only where `~/Source/Brainwires/denext-internal/ops/runners/pause-pool.sh` exists
(the Mac mini): per pool Pause (60 / 120 / 180 s; the script's own expiry still applies) and Resume,
and Restart scheduler (`launchctl kickstart -k gui/<uid>/com.brainwires.denext-runners`) and Run
watchdog pass now. Exact programs and argv only (no shell); the same confirmation. Nothing restarts
a VM or deletes anything. There the pool cards also use the watchdog's local
`~/.denext-runners/health.json` when it is fresher than the org variable.

## Permissions (baked into the binary)

`--allow-net=127.0.0.1,localhost,api.github.com` (split into connect / listen on the pinned runtime;
the receiver's 127.0.0.1:8789 is inside the loopback listen grant), `--allow-run` only the gh paths
above and `/usr/bin/security` (the webhook secret), `--allow-write` only the app's data folder
(`$DENO_DESKTOP_DATA`) and `~/.denext-runners/hooks` (the build machine's home). denext adds the
baseline `--allow-read` and `--allow-env`, an unscoped `--allow-sys` (the secure store and
notifications need it on the pinned runtime), and on Windows `--allow-run=powershell.exe` (denext's
Windows secure store goes through Windows PowerShell).

## Signing (macOS)

```sh
DENEXT_CODESIGN_IDENTITY="Developer ID Application: Joshua Guyette (WT957SC7MJ)" \
DENEXT_NOTARY_PROFILE=denext-notary \
denext desktop package .
```

## Layout

| File                     | What                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| `desktop.ts`             | The entry: `runDesktop`, then the tray driven from the backend's snapshots               |
| `desktop/fleet.ts`       | The `fleet` desktop extension: the service, the page's methods                           |
| `lib/service.ts`         | Token lookup, scheduling (visible / hidden / back-off), notifications                    |
| `lib/poller.ts`          | One polling round over the GitHub client                                                 |
| `lib/github.ts`          | The client: ETag cache, rate limit, back-off, counted requests                           |
| `lib/budget.ts`          | The poll interval from the shared rate budget and the webhooks                           |
| `lib/events.ts`          | The event log: diffing successive observations, the bounded log                          |
| `lib/hooks.ts`           | The webhook handler (route, size, signature, dedupe)                                     |
| `lib/deno-hooks.ts`      | The receiver on the mini: enable check, secret, listener, JSONL sink                     |
| `hooks-only.ts`          | The receiver without a window (`denext task hooks`)                                      |
| `lib/classify.ts`        | Job classification, queue ages, warnings, lane grouping                                  |
| `lib/health.ts`          | The `DENEXT_POOL_HEALTH` parser                                                          |
| `lib/snapshot.ts`        | Pool cards, summary, the page's snapshot                                                 |
| `lib/notify.ts`          | Which notifications to post, once each                                                   |
| `lib/pools.ts`           | Pools, labels, runner prefixes, default branches                                         |
| `lib/deno-host.ts`       | gh, the state file, native notifications                                                 |
| `lib/tray-driver.ts`     | Tray, window manager, close guard, start at login                                        |
| `lib/icons.ts`, `png.ts` | The tray and app icons, drawn in code (`denext task icons`)                              |
| `app/`                   | The page: `fleet-app.tsx` (state), `fleet-view.tsx`, `event-log.tsx`, `token-screen.tsx` |
| `public/fonts/`          | IBM Plex Sans / Mono (OFL), bundled                                                      |
| `tests/`                 | Fixtures are trimmed recorded API responses; no credentials                              |
