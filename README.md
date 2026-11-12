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
denext task desktop:package:windows   # Windows x86_64: dist/Fleet-x64-windows.zip, from any host
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
a VM or deletes anything. For GUI tests, launching the app with `FLEET_CONTROLS_DRY_RUN=1` in its
environment makes every control show its dialog (saying it's a dry run) and send nothing, whichever
button is pressed. There the pool cards also use the watchdog's local
`~/.denext-runners/health.json` when it is fresher than the org variable.

## MCP for agents

Agents (Claude Code sessions and their subagents on the Mac mini) read CI state from Fleet's cache
instead of each polling the GitHub API: the 5,000-an-hour REST budget is shared with the runner
scheduler, and every agent watch loop spends it. `mcp/fleet-mcp.ts` is a zero-dependency MCP server
over stdio, **read-only** over files Fleet already keeps: no network, no GitHub API, no token, no
environment, no subprocess. It runs with exactly one grant:

```sh
deno run --no-config --no-prompt \
  "--allow-read=$HOME/Library/Application Support/dev.brainwires.fleet,$HOME/.denext-runners/hooks,$HOME/.denext-runners/health.json" \
  mcp/fleet-mcp.ts --data-dir "$HOME/Library/Application Support/dev.brainwires.fleet" \
  --hooks-dir "$HOME/.denext-runners/hooks" --health-file "$HOME/.denext-runners/health.json"
```

`deno task mcp` runs that. It is registered for Claude Code at user scope as `fleet`
(`claude mcp add --scope user fleet -- /opt/homebrew/bin/deno run …` with the same flags, absolute
paths), so every session on the mini has it.

What Fleet writes for it, in its data folder (never the token or any secret):

- `snapshot.json`, atomically (temp + rename) after every poll and every webhook update, and at
  least once a minute while Fleet runs (a heartbeat that bumps `written_at` only):
  `{ v: 1, updated_at, written_at, source: "poll" | "hook", auth, poll, rate, hooks, health, summary,
  pools, hosts, alerts, event_seq, runs, jobs }`.
  Runs and jobs are every active run plus those finished in the last 2 h (repo, run id, workflow,
  branch, sha, event, status, conclusion, times, `html_url`; jobs also name, labels, `runner_name`,
  pool, steps, and for a failure `failed_step` and the first failure annotation).
- `fleet-events.jsonl`, the event log as an append-only journal: one event a line, `seq` increasing
  across restarts (it never numbers below the journal's last line), `run_id` / `job_id` on job and
  run lines. Past 5 MB it rotates to `fleet-events.1.jsonl` (one kept). `fleet-events.json` stays
  the window's own copy (the last 2,000 lines and the tracker).

| Tool           | Arguments                                                           | Returns                                                                                                                              |
| -------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `fleet_status` | none                                                                | pools and hosts (health, slots, busy, paused), queue counts and the oldest wait, rate budget, webhooks, the watchdog's `health.json` |
| `fleet_runs`   | `repo?`, `branch?`, `sha?` (prefix), `status?`, `limit?`            | runs newest first, each with its jobs' counts and failed jobs (name + failed step)                                                   |
| `fleet_jobs`   | `run_id?`, `repo?`, `status?`, `conclusion?`, `pool?`, `limit?`     | jobs; steps for failed jobs, and for every job when `run_id` is given; `conclusion: "failed"` = failure, timed_out, startup_failure  |
| `fleet_events` | `since_seq?`, `kinds?`, `repo?`, `limit?`                           | `{ events, next_seq, has_more }`: pass `next_seq` back as `since_seq` for only what's new                                            |
| `fleet_wait`   | `run_ids?`, `job_ids?`, `until`, `timeout_s?` (≤ 1800, default 600) | blocks until `any_failure` / `completed` / `first_event`, then `{ triggered, runs, failed_jobs, jobs, events, next_seq }`            |

`repo` takes `Brainwires/denext` or `denext`; `status` also takes `active` (anything not completed).
`fleet_wait` watches the data folder and the webhook spool's folder (plus a 2 s re-read), returns at
once when the state is already there, and `triggered` says why it returned: `failure`, `completed`,
`event`, `timeout` or `stale`. Example, instead of a watch script:

```text
fleet_runs({ repo: "denext", branch: "development", status: "active" })   → run 43194560988
fleet_wait({ run_ids: [43194560988], until: "any_failure", timeout_s: 1800 })
  → { triggered: "failure", failed_jobs: [{ name: "windows-tests", failed_step: "Run tests", … }] }
fleet_jobs({ run_id: 43194560988, conclusion: "failed" })                  → steps + annotation
fleet_events({ since_seq: <next_seq>, kinds: ["finished", "run-completed"] })  → what changed since
```

**Freshness.** Every answer carries `as_of` (Fleet's last poll or webhook update), `age_s`,
`written_at`, `fleet_running` (written in the last 2 min) and `stale`. It is stale when Fleet hasn't
written for 5 min (not running), or its data is over 5 min old without live webhooks (polls failing
or slowed); with live webhooks a quiet fleet is current however old `as_of` is. A stale answer says
so in `warning`, and `fleet_wait` returns at once with `triggered: "stale"`: the agent then falls
back to `gh`. Runs that finished over 2 h ago are not in the snapshot (a waited-for id that isn't is
listed under `missing`). A Fleet build from before these files answers with `stale: true` and the
events of `fleet-events.json`.

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
| `lib/agent-snapshot.ts`  | The agents' `snapshot.json` (runs, jobs, pools), built from the poller's state           |
| `mcp/fleet-mcp.ts`       | The read-only MCP server for agents (stdio); `mcp/queries.ts`, its tools' answers        |
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
