# Fleet

A tray app that shows the Brainwires org's GitHub Actions jobs and our self-hosted runner pools,
live: a menu-bar / tray icon with a summary, and a window with every running and queued job, a card
per runner host, an event log and the controls. Internal only: it names our infrastructure (pool
labels, runner names, hosts).

A denext desktop app on the Deno Desktop runtime. The backend is a desktop extension
(`desktop/fleet.ts`) that runs in the app's own Deno process, holds the GitHub token, polls the API,
receives webhooks and hands the page a plain snapshot. The page never sees the token.

## Install and run

macOS (the normal way):

1. `denext task desktop:package` writes `dist/Fleet.app` and `dist/Fleet.dmg` (see
   [Packaging and signing](#packaging-and-signing)).
2. Open the `.dmg` and drag Fleet to `/Applications` (or copy `dist/Fleet.app` there).
3. The build is Developer ID-signed but not notarized: on a machine that didn't build it, Gatekeeper
   refuses the first launch; open it once with right-click → Open (or System Settings → Privacy &
   Security → Open Anyway).

The first launch shows the window and turns on start at login; after that Fleet starts hidden, in
the tray.

From source, without installing:

```sh
denext task desktop            # export + build + open Fleet from this folder
denext task dev                # the page alone in a browser (no backend: no data)
```

Windows x86_64: `denext task desktop:package:windows` cross-packages `dist/Fleet-x64-windows.zip`
from any host (a `.zip`, not an `.msi`: WiX runs on Windows only). Unzip it anywhere and run
`Fleet-x64.exe`. It is unsigned unless a certificate is configured (see the header of
`scripts/package-windows.ts`).

`deno task …` runs the same tasks with Deno installed. Agents never launch Fleet's window on the Mac
mini: GUI checks use the [dry-run mode](#dry-run-mode) on a test host.

## GitHub token

1. On startup the backend runs `gh auth token`, from a fixed path only (`/opt/homebrew/bin/gh` or
   `/usr/local/bin/gh` on macOS, `/usr/bin/gh` or `/usr/local/bin/gh` on Linux,
   `C:\Program Files\GitHub CLI\gh.exe` on Windows; never a `gh` from PATH). So `gh auth login` once
   and Fleet needs nothing else.
2. Else a token pasted earlier, from the extension's own secure-store namespace
   (`dev.brainwires.fleet/ext/fleet` in the OS keychain; no page can read it).
3. Else the token screen: run `gh auth login` and press "try the GitHub CLI again", or paste a
   fine-grained token for the Brainwires org with read access to Actions, Administration (for the
   self-hosted runners) and Variables. It is checked with `GET /rate_limit` before it is stored. The
   same screen comes back if GitHub later refuses the stored token.
4. "Continue without a token" runs on public data only: the core repos, no runners or pool health,
   GitHub controls refused, polled every 60 s visible / 5 min hidden to fit the 60-an-hour
   unauthenticated limit.

The token is never logged, rendered, written to a file, or returned to the page.

## Tray behaviour

- **No Dock icon** while only the tray runs (`activationPolicy: "accessory"` from the first frame);
  Fleet becomes a regular app, with a Dock icon, while its window shows.
- **Close to tray**: the window's close button hides it. Polling, the event log and notifications go
  on while hidden (at the hidden poll rate).
- **Quit** only through a real quit: Cmd+Q, the tray's Quit Fleet, or logging out.
- **Single instance**: launching Fleet again shows the window.
- **The icon**: a macOS template icon (status by shape) or colour art on Windows / Linux; red when a
  pool is unhealthy or a job has been queued over 15 min (a wait on a pool with every slot busy
  doesn't count, see Queued lanes). The tooltip is "N running · M queued" plus the reasons. A click
  toggles the window.
- **The menu**: Show / Hide Fleet, the summary (disabled), Pause notifications, Start at login,
  Refresh now, Quit Fleet.
- **Start at login** is turned on at the first run; turning it off in the menu sticks.
- With no tray host (stock GNOME without an AppIndicator extension) the window shows instead and is
  the only way in.

## The window

- **Header**: a 3 px severity stripe (grey, amber, red), running and queued counts, why it isn't
  green, the last poll, the poll interval, API requests left (amber below 1,500, red below 800), the
  webhook state (`hooks: live`, `live (via receiver)`, `stale (last delivery N min ago)` or `off`),
  and Refresh.
- **Pool cards**: one card per runner host, then GitHub-hosted. The list follows the live data,
  rebuilt on every poll: the watchdog's per-host `hosts` map (from its local
  `~/.denext-runners/health.json` on the Mac mini when that is fresher, else from the
  `DENEXT_POOL_HEALTH` org variable), else an older variable's labels plus the org's registered
  runners. The built-in list in `lib/pools.ts` is only the first render's, before any data arrives;
  a host that leaves the data leaves the cards. Each card: slots as pips (filled = busy), a state
  chip (ok / paused / unhealthy / no health) with its reason, and the oldest queued wait, red past
  15 min (amber when every slot is busy: the jobs are waiting for capacity, not faulting). Hosts
  that share a runs-on label (`win-x64` and `win-x64-brain` on `denext-windows-x64`) each show their
  own numbers; a running job is placed by its runner's name, and a queued job of a shared label sits
  on that label's first card (its label can't say which host will take it).
- **Running / Queued lanes**: repo → run (workflow, branch, short SHA, event) → job (name, pool
  chip, runner, elapsed or waited, ticking each second; `/ ~usual` once three successful runs of
  that job were seen). A default branch (`development-denext`, `development`, `main`) gets a violet
  left rule and a ◆ branch chip. A job queued over 15 min turns red, unless its pool is ok with
  every slot busy: that is a capacity wait, shown amber as "waiting for a free slot (pool full)" and
  counted in the header as "N waiting for capacity" (a free slot, a paused, unhealthy or no-health
  pool stay red); one running past 1.5× its usual length (and at least 3 min over) turns amber. A
  queued run GitHub hasn't expanded into jobs shows "queued, no jobs yet" for its first 10 min; past
  that it is GitHub's stale status (the jobs list never fills) and is left out.
- **Side**: the health variable's recent alerts, and jobs finished in the last 30 min with ✓ / ✕ /
  ⊘.
- A click on a run or job opens it on github.com in the system browser.

## Event log

The bottom pane: one line per event, newest at the bottom, following new lines unless you scrolled
up. Events: job queued / started (pool, runner) / finished (conclusion; for a failure the failed
step and the first failure annotation), STALLED (running past 75 min) and QUEUED-LONG (queued past
25 min with no runner; logged as info and marked "capacity wait" when its pool is full), each
repeated every 30 min while it lasts, run completed, a burst of cancelled jobs from one run as one
line ("run N cancelled (14 jobs)"), pool health changes, the health variable's alerts, and every
control you used or that was refused (marked "you").

Each line: local time, a severity glyph (✓ ✕ ▲ • ⊘, coloured too), repo, workflow / job, the text, a
link. Filters: all / problems, repo, search. The first poll only records the state (no flood). The
log survives a restart (see [Data files](#data-files)); state older than 15 min at a restart is
re-seeded silently. Where the webhook spool exists, startup back-fills the gap from it: the job
queued / started / finished lines and run completions received after the log's last line (the last
24 h, at most 500 lines), at their real times, marked ↺ ("while Fleet was closed"), never duplicated
and never notified (`lib/backfill.ts`).

## Notifications

Native, posted from the backend so they arrive while the window is hidden:

- a pool goes unhealthy (once per outage);
- a job passes 15 min queued (once per job; more than three at once become one summary; none for a
  wait on a full pool);
- a default-branch job fails (once per job, only failures after Fleet started).

Posted keys are kept for 48 h in `fleet-state.json`, so a relaunch doesn't repeat them. Pause
notifications in the tray menu silences them (the setting persists).

## The shared rate limit

Fleet uses the same gh token as the runner scheduler, the watchdog and the CI watchers, and so
shares one 5,000-an-hour REST budget with them. If Fleet starved it, queued jobs would go unseen and
runners would stop launching. So (`lib/budget.ts`):

- every request is conditional (`If-None-Match`): an unchanged list is a free 304;
- below 1,500 remaining it polls at 60 s even with the window visible;
- below 800, every 5 min, with the banner "Rate limit low: slowed down to protect the runner
  scheduler.";
- below 300, not at all until the reset;
- past 1,200 counted (non-304) requests in Fleet's own last hour, every 5 min.

What it polls, per round (every 15 s visible, 60 s hidden, unless the budget or webhooks slow it):

| What                    | Endpoint                                                           | When                                |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| Org repos               | `GET /orgs/Brainwires/repos`                                       | every 10 min                        |
| Active runs             | `GET /repos/{repo}/actions/runs?status=queued/in_progress/waiting` | every round*                        |
| Jobs of each active run | `GET /repos/{repo}/actions/runs/{id}/jobs`                         | when the run's `updated_at` changed |
| Runners                 | `GET /orgs/Brainwires/actions/runners`                             | every round                         |
| Pool health             | `GET /orgs/Brainwires/actions/variables/DENEXT_POOL_HEALTH`        | every round                         |

\*The core repos (deno, denext, laufey, qutty), any repo pushed in the last 24 h and any repo with
an active run last round are polled every round; a repo with no active run on its last 3 polls drops
to every 5 min, and every other non-archived repo is covered by the 10-minute sweep.

A 403 / 429 with a rate-limit signal backs off until the reset or `Retry-After` (else 1 min,
doubling to 15 min); a 403 that is a permission refusal (no admin read on runners, say) is retried
every 10 min.

## Webhooks

On the Mac mini, GitHub's org webhook reaches Fleet through a Cloudflare tunnel
(`com.brainwires.denext-ci-hooks-tunnel`), so most changes arrive in seconds and polling only
reconciles.

- **The receiver service**, `com.brainwires.denext-ci-hooks-receiver` (a launchd agent, always on),
  runs `hooks-only.ts` on `127.0.0.1:8789`: only `POST /github/hooks` (anything else 404),
  `content-type: application/json` (else 415), at most 1 MiB (else 413; a large Content-Length is
  refused unread), then `X-Hub-Signature-256` checked with a constant-time compare against the
  keychain secret (item `denext-ci-hooks` / `github-webhook-secret`) before anything is parsed (else
  401). `ping` → 200; `workflow_job` / `workflow_run` → 202, de-duplicated on `X-GitHub-Delivery`
  (the last 10,000). Payloads are data only: nothing in one is run or fetched.
- **`events.jsonl`**: every verified delivery is appended to `~/.denext-runners/hooks/events.jsonl`
  (rotated to `events.jsonl.1` at 20 MB), which the runner scheduler reads too.
- **Fleet** finds the port taken by the receiver and tails that spool every 2 s instead
  (`hooks: live (via receiver)`), applying each delivery to the same state and event log as polling.
  The last delivery starts at the spool's newest line, so a restart in a quiet spell isn't "no
  delivery yet". Without the receiver running, Fleet listens on 8789 itself, with the same checks. A
  machine without the tunnel's launchd job and the keychain secret has no webhooks: `hooks: off`.
- **Polling as the fallback**: with deliveries arriving, polling only reconciles every 5 min; with
  no delivery for 10 min while runs are active it goes back to the normal rate, so a missed delivery
  or a dead tunnel costs freshness, not correctness.

`denext task hooks` runs the same receiver in a terminal, for an end-to-end check of the tunnel and
the org webhook: one summary line per delivery (event, action, repo, job or run name), never the
secret, headers or a body. Stop the launchd receiver first
(`launchctl bootout gui/$(id -u)/com.brainwires.denext-ci-hooks-receiver`): only one process can
hold the port.

## Controls

GitHub controls go through the backend with the same token, never from page JS:

- per run (hover it): Cancel, Re-run failed jobs, Re-run all;
- per finished job that didn't succeed: Re-run;
- Dispatch…: repo → a workflow that declares `workflow_dispatch` → ref → its declared inputs (read
  from that block of the workflow YAML).

Pool controls, only on the machine with the runner scheduler's ops checkout
(`~/Source/Brainwires/denext-internal/ops/runners/pause-pool.sh`, the Mac mini): per pool Pause (60
/ 120 / 180 s; the script's own expiry still applies) and Resume, Restart scheduler
(`launchctl kickstart -k gui/<uid>/com.brainwires.denext-runners`) and Run watchdog pass now.

Guardrails, as code in `lib/controls.ts` (unit-tested):

- every control asks in the OS's own dialog, naming exactly what will happen (the run id, workflow,
  branch and job count); the safe button is the default, and a runtime without native message boxes
  refuses rather than act unconfirmed;
- Cancel is refused outright on `development-denext`, `development`, `main` or the repo's own
  default branch, with the reason shown;
- Dispatch is refused when the workflow already has a run on that commit SHA, unless every such run
  was cancelled (then it warns);
- a re-run on `rel/*` warns that a failed attempt on a release commit blocks its tag;
- pool commands run exact absolute paths with argv built in code (no shell, no free text), for known
  pools only; nothing restarts a VM or deletes anything;
- every action and every refusal goes to the event log, marked "you".

### Dry-run mode

Launch Fleet with `FLEET_CONTROLS_DRY_RUN=1` in its environment and every control shows its dialog
(saying it's a dry run) and sends nothing, whichever button is pressed. This is the mode for GUI
tests.

## MCP for agents

Agents (Claude Code sessions and their subagents on the Mac mini) read CI state from Fleet's cache
instead of each polling the GitHub API: the REST budget is shared with the runner scheduler, and
every agent watch loop spends it. `mcp/fleet-mcp.ts` is a zero-dependency MCP server over stdio,
**read-only** over files Fleet already keeps: no network, no GitHub API, no token, no environment,
no subprocess. It runs with exactly one grant:

```sh
deno run --no-config --no-prompt \
  "--allow-read=$HOME/Library/Application Support/dev.brainwires.fleet,$HOME/.denext-runners/hooks,$HOME/.denext-runners/health.json" \
  mcp/fleet-mcp.ts --data-dir "$HOME/Library/Application Support/dev.brainwires.fleet" \
  --hooks-dir "$HOME/.denext-runners/hooks" --health-file "$HOME/.denext-runners/health.json"
```

`deno task mcp` runs that. It is registered for Claude Code at user scope as `fleet`
(`claude mcp add --scope user fleet -- /opt/homebrew/bin/deno run …` with the same flags and
absolute paths), so every session on the mini has it. Fleet itself must be running for the answers
to be fresh.

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
listed under `missing`). With no `snapshot.json` yet (Fleet not running, or an older Fleet build),
every answer is `stale: true`, and events come from `fleet-events.json`.

## Data files

In the app's data folder (on macOS `~/Library/Application Support/dev.brainwires.fleet`), never the
token or any secret:

| File                                         | What                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-state.json`                           | usual job lengths (the last 10 successful runs per job), posted notification keys (48 h), prefs (first launch done, start at login defaulted, notifications paused) |
| `fleet-events.json`                          | the window's event log: the last 2,000 lines and the tracker, rewritten whole                                                                                       |
| `fleet-events.jsonl`, `fleet-events.1.jsonl` | the event log as an append-only journal for agents: one event a line, `seq` increasing across restarts, `run_id` / `job_id` on job and run lines; rotated at 5 MB   |
| `snapshot.json`                              | the agents' snapshot, written atomically after every poll and webhook update and at least once a minute (a heartbeat that bumps `written_at` only)                  |

`snapshot.json` is
`{ v: 1, updated_at, written_at, source: "poll" | "hook", auth, poll, rate, hooks, health, summary, pools, hosts, alerts, event_seq, runs, jobs }`.
Runs and jobs are every active run plus those finished in the last 2 h (repo, run id, workflow,
branch, sha, event, status, conclusion, times, `html_url`; jobs also name, labels, `runner_name`,
pool, steps, and for a failure `failed_step` and the first failure annotation).

Outside it, only on the webhook machine: `~/.denext-runners/hooks/events.jsonl` (and `.1`). Fleet
reads, never writes, `~/.denext-runners/health.json` and the scheduler's `paused-<pool>` files.

## Permissions

Baked into the binary from `denext.config.ts` (least privilege, derived by the package scripts):
`--allow-net` connect to `api.github.com` only, plus the loopback listen every desktop app has (the
webhook port 8789 is inside it); `--allow-run` only the `gh` paths above, `/usr/bin/security` (the
webhook secret) and, where the ops checkout exists at build time, `pause-pool.sh`, `watchdog.sh` and
`/bin/launchctl`; `--allow-write` only the app's data folder and `~/.denext-runners/hooks`. denext
adds its baseline read / env grants and the unscoped `--allow-sys` that the secure store,
notifications and start at login need.

## Development

```sh
denext task test      # data layer, view, controls, tray, hooks and MCP tests (no network, gh or keychain)
denext task check     # deno fmt --check (Markdown included), deno lint, the tests
denext task icons     # redraw the icons/ and public/ art from lib/icons.ts
denext task export    # the static page export → out/
```

Run `denext task check` before every commit. Test fixtures are trimmed recorded API responses; no
credentials.

### Packaging and signing

```sh
DENEXT_CODESIGN_IDENTITY="Developer ID Application: <name> (<team id>)" \
  denext task desktop:package               # dist/Fleet.app + dist/Fleet.dmg, signed
denext task desktop:package:windows         # dist/Fleet-x64-windows.zip
```

Without `DENEXT_CODESIGN_IDENTITY` the macOS app is ad-hoc signed (local use only). Setting
`DENEXT_NOTARY_PROFILE` (a `notarytool` keychain profile) as well notarizes it; current builds are
signed but not notarized. Credentials come from the environment and the keychain only, never from a
file in this repo.

## Layout

| File                                   | What                                                                                                     |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `desktop.ts`                           | The entry: `runDesktop`, the window manager, the tray driven from the backend's snapshots                |
| `desktop/fleet.ts`                     | The `fleet` desktop extension: the service, webhooks, the page's methods and controls                    |
| `denext.config.ts`                     | Installers, tray, window, capabilities, the baked permissions                                            |
| `lib/service.ts`                       | Token lookup, scheduling (visible / hidden / back-off), notifications, persistence                       |
| `lib/poller.ts`                        | One polling round over the GitHub client; the live pool list                                             |
| `lib/github.ts`                        | The client: ETag cache, rate limit, back-off, counted requests                                           |
| `lib/backfill.ts`                      | The event log's back-fill from the webhook spool (what happened while Fleet was closed)                  |
| `lib/budget.ts`                        | The poll interval from the shared rate budget and the webhooks                                           |
| `lib/events.ts`                        | The event log: diffing successive observations, the bounded log                                          |
| `lib/hooks.ts`                         | The webhook handler (route, size, signature, dedupe) and the spool reader                                |
| `lib/deno-hooks.ts`                    | Webhooks on the mini: enable check, secret, listener, `events.jsonl`, spool tailing                      |
| `hooks-only.ts`                        | The receiver without a window (the launchd service, `denext task hooks`)                                 |
| `lib/controls.ts`                      | The controls' guardrails and pool commands (pure)                                                        |
| `lib/control-runner.ts`                | Controls end to end: guardrails → OS dialog → GitHub or the pool script → event log                      |
| `lib/deno-pools.ts`, `local-health.ts` | The ops checkout, the watchdog's local `health.json` merged over the variable                            |
| `lib/health.ts`                        | The `DENEXT_POOL_HEALTH` parser (`pools` by label, `hosts` by pool)                                      |
| `lib/pools.ts`                         | The first-render pool list, labels, runner prefixes, core repos, default branches                        |
| `lib/classify.ts`                      | Job classification, queue ages, warnings, lane grouping                                                  |
| `lib/snapshot.ts`                      | Pool cards, summary, the page's snapshot                                                                 |
| `lib/notify.ts`                        | Which notifications to post, once each                                                                   |
| `lib/agent-snapshot.ts`                | The agents' `snapshot.json`, built from the poller's state                                               |
| `lib/agent-files.ts`                   | The agent files' names, shared with the MCP server                                                       |
| `lib/deno-host.ts`                     | gh, the data files, native notifications                                                                 |
| `lib/tray-driver.ts`                   | Tray, window manager, close guard, start at login                                                        |
| `lib/icons.ts`, `png.ts`               | The tray and app icons, drawn in code (`denext task icons`)                                              |
| `mcp/fleet-mcp.ts`, `mcp/queries.ts`   | The read-only MCP server for agents (stdio) and its tools' answers                                       |
| `app/`                                 | The page: `fleet-app.tsx` (state), `fleet-view.tsx`, `event-log.tsx`, `controls.tsx`, `token-screen.tsx` |
| `public/fonts/`                        | IBM Plex Sans / Mono (OFL), bundled                                                                      |
| `scripts/package-*.ts`                 | The packaging scripts denext generated                                                                   |
| `tests/`                               | Unit and view tests over trimmed recorded API responses                                                  |

## Known limits

- macOS builds are not notarized: a first launch on another machine needs Open Anyway.
- Windows: the build packages and launches, but the tray menu and Quit Fleet have not been verified
  by automation; check them by hand after a change there.
- Webhooks exist only on the Mac mini (tunnel + keychain secret); everywhere else Fleet polls.
- Pool controls exist only where the ops checkout is (the Mac mini).
- Runs that finished over 2 h ago are not in the agents' snapshot; older history is GitHub's.
