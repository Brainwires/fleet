# Fleet

A tray app that shows GitHub Actions jobs and self-hosted runner pools for the organizations and
accounts you choose, live: a menu-bar / tray icon with a summary, and a window with every running
and queued job, a card per runner pool, an event log and the controls. A first-run wizard sets it up
(who to watch, protected branches, start at login, integrations); nothing about any one team's
infrastructure is built in.

A denext desktop app on the Deno Desktop runtime. The backend is a desktop extension
(`desktop/fleet.ts`) that runs in the app's own Deno process, holds the GitHub token, polls the API,
receives webhooks and hands the page a plain snapshot. The page never sees the token.

## Install and run

macOS (the normal way):

1. `denext task desktop:package` writes `dist/Fleet.app` and `dist/Fleet.dmg` (see
   [Packaging and signing](#packaging-and-signing)).
2. Open the `.dmg` and drag Fleet to `/Applications` (or copy `dist/Fleet.app` there).
3. The app is Developer ID-signed, notarized and stapled when packaged with `DENEXT_NOTARY_PROFILE`
   (see below), so Gatekeeper opens it on any Mac. A build without it is only signed: open it once
   with right-click → Open (or System Settings → Privacy & Security → Open Anyway).

The first launch shows the setup wizard ([Settings](#settings-and-the-first-run-wizard)); after that
Fleet starts in the tray, with no window. Start at login is off until you turn it on.

From source, without installing:

```sh
denext task desktop            # export + build + open Fleet from this folder
denext task dev                # the page alone in a browser (no backend: no data)
```

Windows x86_64: `denext task desktop:package:windows` cross-packages `dist/Fleet-x64-windows.zip`
from any host (a `.zip`, not an `.msi`: WiX runs on Windows only). Unzip it anywhere and run
`Fleet-x64.exe`. It is unsigned unless a certificate is configured (see the header of
`scripts/package-windows.ts`).

`deno task …` runs the same tasks with Deno installed. Automated GUI checks use the
[dry-run mode](#dry-run-mode) on a test host, never a machine someone is working on.

## GitHub token

1. On startup the backend runs `gh auth token`, from a fixed path only (`/opt/homebrew/bin/gh` or
   `/usr/local/bin/gh` on macOS, `/usr/bin/gh` or `/usr/local/bin/gh` on Linux,
   `C:\Program Files\GitHub CLI\gh.exe` on Windows; never a `gh` from PATH). So `gh auth login` once
   and Fleet needs nothing else.
2. Else a token pasted earlier, from the extension's own secure-store namespace
   (`dev.brainwires.fleet/ext/fleet` in the OS keychain; no page can read it).
3. Else the sign-in step (the wizard's first, or the token screen once set up): run `gh auth login`
   and press "try the GitHub CLI again", or paste a fine-grained token for the owners you watch with
   read access to Actions, Administration (the organizations' self-hosted runners) and, with a
   pool-health variable, Variables. Actions "Read and write" enables the controls. It is checked
   with `GET /rate_limit` before it is stored. The wizard then shows the token's account, its scopes
   (classic and OAuth tokens) and whether the controls will work. The token screen comes back if
   GitHub later refuses the stored token.
4. "Continue without a token" runs on public data only: the pinned and allowed repos, no runners or
   pool health, GitHub controls refused, polled every 60 s visible / 5 min hidden to fit the
   60-an-hour unauthenticated limit.

The token is never logged, rendered, written to a file, or returned to the page.

## Settings and the first-run wizard

Fleet's settings are one typed, versioned JSON document, `fleet-settings.json` in the app's data
folder (0600, written atomically), validated on every read and save (`lib/settings.ts`). The first
launch shows a wizard in the window; afterwards the same sections are in the Settings view (the
header's Settings button, or Settings… in the tray menu), where "Run setup again" re-runs the
wizard. Both are keyboard-navigable (every control labelled, focus moved to each step's heading),
and follow the light and dark themes.

| Wizard step             | Settings                                                                                                                                                                                                                                                 |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign in                 | (the token; see [GitHub token](#github-token))                                                                                                                                                                                                           |
| Owners and repos        | `owners` (organizations or users, several allowed); `repos.allow` (only these; empty: all of the owners'), `repos.deny`, `repos.pinned` (polled every round, listed first)                                                                               |
| Protected branches      | `branches.rules`: each `{ branch, repo?, cancel, duplicateDispatch }`, `branch` being `:default` (each repo's default branch, from the API), a name or a `*` pattern; `warn` or `refuse`. `branches.otherDuplicateDispatch`: `allow` / `warn` / `refuse` |
| Start and notifications | `startAtLogin` (opt-in), `notifications.poolUnhealthy` / `queuedLong` / `protectedFailure`                                                                                                                                                               |
| Integrations            | `webhooks` ([docs/webhooks.md](docs/webhooks.md)), `pools.healthVariable` ([docs/pool-health.md](docs/pool-health.md)), and the MCP registration command for this machine                                                                                |

The defaults watch nobody (the wizard asks), protect each repo's default branch with `warn`, group
pools from the runners, and leave webhooks, start at login and every integration off.

Three more sections are file-only, kept as they are by the UI:

- `stream`: the [realtime event stream](#realtime-stream),
  `{ enabled, port, heartbeatSeconds,
  maxClients }` (on, 8790, 60, 8 by default).

- `runnerHosts`: [runner-host workflows](#runner-host-jobs),
  `{ repo, workflow, runnerPrefix, pool }`.
- `integrations.runnerScheduler`: a self-hosted runner scheduler Fleet works with: its declared
  `pools` (`{ id, label, runnerPrefix?, slots?, host? }`, the first render's list; pools with the
  same `host` share one machine, and their detail screens add a combined usage chart),
  `runnerNamePrefix` (runner names `<prefix><pool>-<slot>-<epoch>`), `labelPrefix`, the watchdog's
  `localHealthFile` and `pausedDir`, `logsDir` (the scheduler's log folder, read-only: the
  [Logs tab](#pool-detail-screens)), and `controls` (`pausePool`, `watchdog`, `launchdLabel`: the
  [pool controls](#controls)). Inactive unless configured.

**A machine's own config.** When there is no settings file yet and `fleet-local-config.json` (a
complete settings document) sits beside it in the data folder, Fleet starts from it, marked set up,
and writes `fleet-settings.json` from it: no wizard. That is how a team ships its integrations to
its own machines without putting them in this repo. A settings file that doesn't parse is reported
in the console and never overwritten until new settings are saved. Paths in the settings may start
with `~/`.

## Tray behaviour

- **The Dock icon depends on where Fleet is installed** (macOS). The Dock adds an unpinned app to
  "Recent applications" when its running Dock tile goes away (on quit, or on going back to
  accessory), but only when the app bundle's resolved path is under `/Applications` (measured on
  macOS 15 and 26; Apple documents none of it, and there is no opt-out). So at launch Fleet resolves
  its bundle's real path (`lib/dock-policy.ts`):
  - **Outside `/Applications`** (for example `~/Applications/Fleet.app`, the recommended place):
    Fleet goes "regular" just before its window opens (a Dock icon, Cmd-Tab, the host's app menu)
    and back to "accessory" once the window closes. Nothing is left in Recents.
  - **Under `/Applications`** (a symlink into it counts): accessory from the first frame to quit,
    with the window open or not, so it never lands in Recents. Opening brings the window to the
    front and makes it key through the window's `focus()`, which activates the app without changing
    the policy.

  A separate window-helper app (denext's macOS window helper, in progress) will give a Dock icon
  with the window open wherever Fleet is installed.
- **Quit means "close to the tray"** unless Fleet asks for it: the Dock's Quit, Cmd+Q (the app menu
  or the window), and `osascript -e 'quit app "Fleet"'` close Fleet's window and leave it running in
  the tray (accessory again). It is a `DesktopRuntime.onBeforeQuit` guard (`lib/quit-guard.ts`) that
  refuses those quits. Only the tray's **Quit Fleet** ends Fleet, and logging out, restarting or
  shutting down always quits (the guard reads the quit's `reason` and lets `"session-end"` go).
- **Shortcuts**: while accessory there is no menu bar, so the window answers Cmd+W and Cmd+Q itself
  (both close the window, `lib/shortcuts.ts`); the editing shortcuts (Cmd+C / Cmd+V / Cmd+X / Cmd+A
  / Cmd+Z) go through the runtime host's built-in Edit menu.
- **Closing the window closes it**: the window is destroyed, not hidden, and Fleet keeps running in
  the tray (`desktop.app.keepAlive`). Polling, the webhook listener, the MCP files, the event log
  and notifications go on with no window (at the hidden poll rate). Opening Fleet again makes a
  fresh window that rebuilds everything from the backend's snapshot and log, at the size and place
  the last one had (`desktop.window.key` / `windows.open({ key: "fleet" })`, saved in the app's
  `windows.json`). Opening while a window is open brings that one to the front, never a second.
- **What opens it**: the tray (a click, or Open Fleet), a click on its Dock icon (outside
  `/Applications`), opening Fleet again from Finder or Launchpad, launching it again (single
  instance), or a click on one of Fleet's notifications (also the click that launched it).
- **Quit** only through the tray's Quit Fleet, or the OS's logout / restart / shut down.
- **The icon**: a macOS template icon (status by shape) or colour art on Windows / Linux; red when a
  pool is unhealthy or a job has been queued over 15 min (a wait on a pool with every slot busy
  doesn't count, see Queued lanes). The tooltip is "N running · M queued" plus the reasons. A click
  opens the window, or closes it while it shows.
- **The menu**: Open / Close Fleet, the summary (disabled), Settings…, Pause notifications, Start at
  login, Refresh now, Quit Fleet.
- **Start at login** is opt-in: set from the wizard, the Settings view or the menu (which keeps the
  setting in step); Fleet never turns it on by itself.
- With no tray host (stock GNOME without an AppIndicator extension) the window shows instead and is
  the only way in; closing it quits, and so does any quit.

## The window

- **Header**: a 3 px severity stripe (grey, amber, red), the watched owners, running and queued
  counts, why it isn't green, how current the data is (`live · last event 2m ago` while webhooks are
  live, else `updated N ago` from the later of the last poll and the last delivery, muted when a
  poll is overdue or webhooks went quiet with jobs active), the poll interval, API requests left
  (amber below 1,500, red below 800), the webhook state (`hooks: live`, `live (via receiver)`,
  `stale (last delivery N min ago)` while jobs are active, `quiet (…)` with nothing running, or
  `off`; hidden while the live label shows, whose tooltip then carries the delivery details),
  Refresh and Settings. With webhooks live, empty Running and Queued lanes carry a green live dot.
- **Pool cards**: one card per runner pool, then GitHub-hosted. The list follows the live data,
  rebuilt on every poll: without a pool-health variable, the organizations' self-hosted runners
  grouped by their custom labels (ok while one runner is online); with one
  ([docs/pool-health.md](docs/pool-health.md)), its per-host `hosts` map (the runner scheduler
  integration's local health file merged in when fresher), else its labels plus the registered
  runners. The scheduler integration's declared pools are only the first render's, before any data
  arrives; a pool that leaves the data leaves the cards. Each card: slots as pips (filled = busy), a
  state chip (ok / paused / unhealthy / no health) with its reason, and the oldest queued wait, red
  past 15 min (amber when every slot is busy: the jobs are waiting for capacity, not faulting).
  Hosts that share a runs-on label (`win-x64` and `win-x64-brain` on `denext-windows-x64`) each show
  their own numbers; a running job is placed by its runner's name, and a queued job of a shared
  label sits on that label's first card (its label can't say which host will take it). A long pool
  name truncates with "…" (full name on hover); the state chip stays on its line. A self-hosted card
  is compact; when its pool has running jobs, its `busy/slots` count is a toggle that widens the
  card to two columns and lists the busy runners.
- **GitHub-hosted panel**: a wider card beside the self-hosted grid (stacked below it under 1000
  px), as tall as the cards and scrolling inside, with one row per running job's runner: the image
  label from the job's runs-on labels (`macos-15-intel`, `ubuntu-22.04`) and the short runner id
  (`#1000058781`, full name on hover), its state (running / over usual), elapsed, and the job (repo
  · workflow · job, a link to it). Self-hosted cards use the same rows when opened.
- **Running / Queued lanes**: repo → run (workflow, branch, short SHA, event) → job (name, pool
  chip, runner, elapsed or waited, ticking each second while the window shows (the clock stops while
  it is hidden); `/ ~usual` once three successful runs of that job were seen). A protected branch
  (the settings' `branches.rules`) gets a violet left rule and a ◆ branch chip, but only a run of
  the repo's own commit that isn't a PR: a fork PR (or any PR) from a branch named `main` isn't the
  protected branch, and a fork PR shows "fork PR from <owner>" instead. Ages (waited, elapsed,
  finished N min ago) are reckoned on GitHub's clock, from the API's `Date` headers, so a skewed
  local clock doesn't fake or hide a late job. A job queued over 15 min turns red, unless its pool
  is ok with every slot busy: that is a capacity wait, shown amber as "waiting for a free slot (pool
  full)" and counted in the header as "N waiting for capacity" (a free slot, a paused, unhealthy or
  no-health pool stay red); one running past 1.5× its usual length (and at least 3 min over) turns
  amber. A queued run GitHub hasn't expanded into jobs shows "queued, no jobs yet" for its first 10
  min; past that it is GitHub's stale status (the jobs list never fills) and is left out. The job
  name takes a row's spare width; the runner (`#id` for GitHub's) is capped and gives way first. A
  long branch moves to its own header line before it truncates. With nothing queued, the Queued lane
  shrinks to a narrow column and Running takes the width.
- **Side**: the pool-health variable's recent alerts (each clamped to three lines; a click expands
  it, the full text is also the tooltip), and jobs finished in the last 30 min with ✓ / ✕ / ⊘.
- A click on a run or job opens it on github.com in the system browser.
- A click on a pool card (or its name, a button) or on the GitHub-hosted panel opens that pool's
  [detail screen](#pool-detail-screens).

## Pool detail screens

Self-hosted runners are ephemeral (a new runner name per job), so history is kept per pool, the
cards' unit. A pool's screen (Back or Esc returns; every control is keyboard-reachable; both themes)
has a header (name, state and reason, labels, slots, the machine, busy and queued now with the
oldest wait, the pause controls) and two tabs.

**Usage**: a range picker (1 h / 24 h / 7 d / 30 d: 1-minute, 15-minute, 1-hour and 6-hour points),
a summary row (share of slot time busy, jobs finished, failed / cancelled, median and p90 length,
the longest wait, the average queue wait), then the charts. Each is hand-drawn SVG with one y scale,
labelled axes, a faint grid, the latest point marked, a tooltip with the bucket's exact values on
hover or keyboard focus (arrow keys move it), a legend when it has more than one series, a "Show as
a table" view, and an empty state when the range has no data:

- **Utilization**: average busy slots per point (filled area) against the pool's capacity (dashed
  line), in slots; the subtitle gives the share of slot time busy. For pools that share a machine
  (the settings' `host`), a second chart adds their busy slots and capacities together.
- **Queue length** (average jobs waiting per point) and **Oldest wait** (the longest any queued job
  had waited, in minutes): two charts, since they don't share a unit.
- **Throughput**: jobs finished per point, stacked by conclusion (succeeded green, failed red,
  cancelled grey, other light grey).
- **Job duration**: the median and p90 length of the jobs finished per point (minutes), and a
  **duration distribution** histogram of the whole range with the median and p90 marked.
- GitHub-hosted: **running jobs by image** (stacked areas, the five busiest runs-on images and
  "other") instead of utilization, and **minutes used** per point (each job rounded up to a whole
  minute, as billed).

Below the charts: the pool's recent jobs (finish time, repo · workflow · job linking to GitHub,
runner, duration, conclusion, "View log") and its recent events.

**Logs**: GitHub's log of any recent job, fetched on demand
(`GET
/repos/{repo}/actions/jobs/{id}/logs`, one request of the shared budget, refused while fewer
than 1,500 remain, at most 30 an hour, finished jobs cached in memory) and shown in the log viewer
with its `##[group]` steps folding. With the runner scheduler's `logsDir` configured, also: the
pool's launcher logs `jobs/<pool>-<slot>-<epoch>.log` newest first (start, slot, runner, the job and
run it took, result `rc`, duration, disk before → after, from the log's own markers and the
scheduler's `job done` lines), each opening in the viewer (a running job's log can be followed
live), a "Runner log" button per recent job, and the scheduler's and the watchdog's lines about the
pool (`scheduler.log`, `alerts.log`, refreshed every 5 s while the tab shows).

The viewer is monospace and virtualized (only the visible rows are in the page), with search (next /
previous), copy, follow for a live log, and ANSI colours. Logs are read-only and bounded: a file's
last 512 KB at a time ("Load earlier lines" pages back), a GitHub log's last 4 MB, at most 60,000
lines in the page. **Secrets never reach the page**: every line is redacted in the backend first
(`lib/redact.ts`): `--jitconfig` values and JIT configs, GitHub tokens (`ghp_` / `ghs_` / … /
`github_pat_`), bearer / basic credentials, JWTs, credentials in URLs, signed-URL signatures, values
of secret-named keys, and any long token-shaped string (git SHAs and paths are kept).

**The history** lives in `fleet-history.json` ([Data files](#data-files)): per pool (and per GitHub
image) 1-minute buckets for 24 h and 15-minute buckets for 30 days, each holding the pool samples
Fleet takes as it polls and receives webhooks (busy, capacity, queue, the oldest wait, paused /
unhealthy) and the jobs that started and finished in it (by conclusion, minutes, a fixed log-scale
duration histogram for the percentiles, queue waits); the last 200 finished jobs per pool. It is
written atomically every 2 minutes and at quit, pruned past each tier's retention, and capped (64
series, 16 GitHub images). On its first run Fleet back-fills it from the event journal
(`fleet-events.jsonl`) and the webhook spool (GitHub's own times), so the charts start with what
Fleet already saw; capacity for that past is today's slot count.

## Event log

The bottom pane: one line per event, newest at the bottom, following new lines unless you scrolled
up. Events: job queued / started (pool, runner) / finished (conclusion; for a failure the failed
step and the first failure annotation, except on a fork or `pull_request_target` run, whose text is
someone else's), STALLED (running past 75 min) and QUEUED-LONG (queued past 25 min with no runner;
logged as info and marked "capacity wait" when its pool is full), each repeated every 30 min while
it lasts, run completed, a burst of cancelled jobs from one run as one line ("run N cancelled (14
jobs)"), pool health changes, the health variable's alerts, and every control you used or that was
refused (marked "you").

Each line: local time, a severity glyph (✓ ✕ ▲ • ⊘, coloured too), repo, workflow / job (the wider
column), the text, a link. A start reads short, `started · GitHub #1000058781` or
`started · mac-arm
· denext-mac-arm-1-…`, the runner trimmed apart with its full name on hover (the
recorded text, for agents and the search, is unchanged: `started on <pool> on <runner>`). Filters:
all / problems, repo, search. The first poll only records the state (no flood). The log survives a
restart (see [Data files](#data-files)); state older than 15 min at a restart is re-seeded silently.
Where the webhook spool exists, startup back-fills the gap from it: the job queued / started /
finished lines and run completions received after the log's last line (the last 24 h, at most 500
lines), at their real times, marked ↺ ("while Fleet was closed"), never duplicated and never
notified (`lib/backfill.ts`).

## Notifications

Native, posted from the backend so they arrive with no window open (a click opens the window):

- a pool goes unhealthy (once per outage);
- a job passes 15 min queued (once per job; more than three at once become one summary; none for a
  wait on a full pool);
- a protected-branch job fails (once per job, only failures after Fleet started): the repo's own
  commit on the branch, not a PR (a fork PR from a branch named `main` notifies nothing).

Each kind can be turned off in the settings (`notifications`). Posted keys are kept for 48 h in
`fleet-state.json`, so a relaunch doesn't repeat them; a kind turned off is still marked, so turning
it back on doesn't replay the past. Pause notifications in the tray menu silences them all (the
setting persists).

## The shared rate limit

Fleet usually runs on the same gh token as other tools (a runner scheduler, CI watchers), and so
shares one 5,000-an-hour REST budget with them. If Fleet starved it, queued jobs would go unseen and
a scheduler would stop launching runners. So (`lib/budget.ts`):

- every request is conditional (`If-None-Match`): an unchanged list is a free 304 (the ETag cache is
  an LRU of 2,000 URLs, and a run's URLs leave it once the run leaves the agents' 2 h window);
- below 1,500 remaining it polls at 60 s even with the window visible;
- below 800, every 5 min, with the banner "Rate limit low: slowed down to protect the runner
  scheduler.";
- below 300, not at all until the reset;
- past 1,200 counted (non-304) requests in Fleet's own last hour, every 5 min.

What it polls, per round (every 15 s visible, 60 s hidden, unless the budget or webhooks slow it):

| What                    | Endpoint                                                           | When                                |
| ----------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| Owners' repos           | `GET /orgs/{org}/repos`, `GET /user/repos` (a user owner)          | every 10 min                        |
| Active runs             | `GET /repos/{repo}/actions/runs?status=queued/in_progress/waiting` | every round*                        |
| Jobs of each active run | `GET /repos/{repo}/actions/runs/{id}/jobs`                         | when the run's `updated_at` changed |
| Runners                 | `GET /orgs/{org}/actions/runners` (organization owners)            | every round                         |
| Pool health             | `GET /orgs/{org}/actions/variables/{name}` (when configured)       | every round                         |

\*The pinned repos, any repo with an active run on one of its last 3 polls are polled every round; a
repo with no active run on its last 3 polls drops to every 5 min, and every other watched,
non-archived repo is covered by the 10-minute sweep.

Every request has a 20 s deadline: a hung connection fails that round as a timeout (retried on the
next), never a poll stuck forever; and a poll still running after 2 min (a bug) is dropped, logged
to the console, and the next one goes ahead. A 403 / 429 with a rate-limit signal backs off until
the reset or `Retry-After` (else 1 min, doubling to 15 min); a 403 that is a permission refusal (no
admin read on runners, say) is retried every 10 min.

## Webhooks

Optional. With GitHub's `workflow_job` / `workflow_run` webhook delivered to this machine, most
changes arrive in seconds and polling only reconciles every 5 min; with no delivery for 10 min while
runs are active, polling goes back to its normal rate, so a missed delivery or a dead tunnel costs
freshness, not correctness. Without webhooks Fleet polls (`hooks: off`).

- **The receiver** listens on `127.0.0.1` (loopback only, port `webhooks.port`, 8789 by default) and
  accepts only `POST /github/hooks`: `application/json` (else 415), at most 1 MiB (else 413), and a
  valid `X-Hub-Signature-256` HMAC under the webhook secret, checked before anything is parsed (else
  401). `ping` → 200; `workflow_job` / `workflow_run` → 202, de-duplicated on `X-GitHub-Delivery`
  (the last 10,000, kept across restarts) and dropped as a replay (202 `stale`) when the event's
  newest timestamp is over 10 min old. Payloads are data only.
- **Fleet or `hooks-only.ts`.** Fleet listens itself (`hooks: live`), unless the standalone receiver
  (`denext task hooks`, or the same as a background service) already holds the port; then Fleet
  tails its spool every 2 s (`hooks: live (via receiver)`). Port taken and no spool: polling only.
- **The spool**, `events.jsonl` in `webhooks.spoolDir` (default `hooks/` in the data folder; 0600 in
  a 0700 folder, rotated to `.1` at 20 MB), records every verified delivery; Fleet back-fills its
  event log from it at start.
- **Today** webhooks turn on only when enabled in the settings, on macOS, with the secret readable
  (the login keychain item the settings name, or Fleet's own secure store; at least 32 characters)
  and, when `webhooks.requireLaunchdJob` names one, the public endpoint's launchd job file present.
  `denext task hooks` runs the standalone receiver from the settings file (flags override it). Linux
  and Windows are planned.

**Setup, verification, troubleshooting and removal:** [docs/webhooks.md](docs/webhooks.md).

## Controls

GitHub controls go through the backend with the same token, never from page JS:

- per run (hover it): Cancel, Re-run failed jobs, Re-run all;
- per finished job that didn't succeed: Re-run;
- Dispatch…: repo → a workflow that declares `workflow_dispatch` → ref → its declared inputs (read
  from that block of the workflow YAML).

Pool controls, only with the runner scheduler integration (`integrations.runnerScheduler.controls`)
and its pause script present on this machine: per pool Pause (1m / 2m / 3m, a segmented group on the
card's last row; the script's own expiry still applies) and Resume, Restart scheduler
(`launchctl kickstart -k gui/<uid>/<launchdLabel>`, when a label is set) and Run watchdog pass now
(when a watchdog is set).

Guardrails, as code in `lib/controls.ts` (unit-tested):

- every control asks in the OS's own dialog, naming exactly what will happen (the run id, the full
  `owner/repo`, workflow, branch and job count, then who started it and whether it is a fork PR);
  run, job and branch names are quoted, stripped of control characters and newlines and capped at 80
  characters; the safe button is the default, and a runtime without native message boxes refuses
  rather than act unconfirmed;
- controls act on the watched repos only (the configured owners', past the allow / deny lists);
- Cancel on a protected branch warns or is refused, per its rule (`branches.rules`; by default each
  repo's own default branch, warn), with the reason shown: a run of the repo's own commit that isn't
  a PR (a fork PR from a branch named `main` is a plain cancel);
- Dispatch when the workflow already has a live run on that commit SHA warns or is refused per the
  protecting rule (else `branches.otherDuplicateDispatch`); if every such run was cancelled, it only
  notes it;
- a re-run on `rel/*` warns that a failed attempt on a release commit blocks its tag;
- pool commands run exact absolute paths with argv built in code (no shell, no free text), for known
  pools only; nothing restarts a VM or deletes anything;
- every action and every refusal goes to the event log, marked "you".

### Dry-run mode

Launch Fleet with `FLEET_CONTROLS_DRY_RUN=1` in its environment and every control shows its dialog
(saying it's a dry run) and sends nothing, whichever button is pressed. This is the mode for GUI
tests.

## MCP for agents

Agents (Claude Code sessions and their subagents) read CI state from Fleet's cache instead of each
polling the GitHub API: the REST budget is shared, and every agent watch loop spends it.
`mcp/fleet-mcp.ts` is a zero-dependency MCP server over stdio, **read-only** over files Fleet
already keeps: no network, no GitHub API, no token, no environment, no subprocess. It runs with
exactly one grant, the data folder (plus, when given, the webhook spool and a watchdog's local
health file):

```sh
deno run --no-config --no-prompt "--allow-read=<data dir>[,<spool>][,<health file>][,<logs>]" \
  mcp/fleet-mcp.ts --data-dir "<data dir>" [--hooks-dir "<spool>"] [--health-file "<health file>"] \
  [--logs-dir "<runner scheduler log folder>"]
```

`deno task mcp` runs it for macOS's data folder. The Settings view (Integrations) shows the
`claude mcp add --scope user fleet -- …` line for this machine, with its paths. Fleet itself must be
running for the answers to be fresh. `fleet_status` names the watched owners.

| Tool                 | Arguments                                                                           | Returns                                                                                                                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet_status`       | none                                                                                | pools and hosts (health, slots, busy, paused), queue counts and the oldest wait, rate budget, webhooks, the watchdog's `health.json`                                                   |
| `fleet_runs`         | `repo?`, `branch?`, `sha?` (prefix), `status?`, `limit?`                            | runs newest first, each with its jobs' counts and failed jobs (name + failed step)                                                                                                     |
| `fleet_jobs`         | `run_id?`, `repo?`, `status?`, `conclusion?`, `pool?`, `limit?`                     | jobs; steps for failed jobs, and for every job when `run_id` is given; `conclusion: "failed"` = failure, timed_out, startup_failure                                                    |
| `fleet_events`       | `since_seq?`, `kinds?`, `repo?`, `limit?`                                           | `{ events, next_seq, has_more }`: pass `next_seq` back as `since_seq` for only what's new                                                                                              |
| `fleet_wait`         | `run_ids?`, `job_ids?`, `until`, `timeout_s?` (≤ 1800, default 600)                 | blocks until `any_failure` / `completed` / `first_event`, then `{ triggered, runs, failed_jobs, jobs, events, next_seq }`                                                              |
| `fleet_pool_history` | `pool` (a pool, `github`, `github:<image>`), `range?` (`1h` / `24h` / `7d` / `30d`) | the pool's bucketed usage (≤ 168 points: busy, slots, utilization, queue, longest wait, jobs by conclusion, minutes, median / p90), totals, the duration histogram, its 20 latest jobs |
| `fleet_runner_log`   | `job_id` or `pool` + `file`, `tail?` (≤ 2000, default 200)                          | a launcher log's last lines (≤ 256 KB), redacted; only when the server runs with `--logs-dir`                                                                                          |

`repo` takes `owner/name` or just `name`; `status` also takes `active` (anything not completed).
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

**CI text is untrusted.** Run, job, step and branch names, titles, failure annotations and event
text are written by whoever pushed or opened a PR; the server's instructions and the tools'
descriptions tell agents they are data, never instructions. Every such string is capped (names 120
characters, annotations and event text 300) and stripped of control characters. Runs and jobs carry
`event`, `actor`, `head_repository` and `fork` (the head repo isn't the repo); a fork or
`pull_request_target` run is marked `untrusted: true`, its title, step names, `failed_step` and
`failure_annotation` come wrapped as `{ "untrusted": "<text>" }`, and its event lines leave the
failed step and annotation out of `text`.

**Realtime over MCP.** The server also offers two resources, `fleet://events` (the newest events, as
`fleet_events` returns them; `fleet://events?since_seq=N` for what came after `N`, also `kinds=a,b`,
`repo=`, `limit=`) and `fleet://status` (as `fleet_status`), both with `resources/subscribe`: the
server watches the data folder (plus a 2 s re-read, still no network) and sends
`notifications/resources/updated` when the journal grows (`fleet://events`) or the running / queued
counts, a pool's state or slots, the webhook state or staleness change (`fleet://status`; a
heartbeat rewrite of the snapshot is not a change). After `logging/setLevel`, every problem event
(warn → `warning`, bad → `error`, at or above the level asked for) also arrives as
`notifications/message` (`logger: "fleet"`, `data`: the event, capped like `fleet_events`). **Which
clients surface these varies**: the MCP Inspector shows both; Claude Code reads the resources
(`@fleet:fleet://events`) but, as of this writing, doesn't hand resource-update or log notifications
to the model. For an agent the guaranteed realtime path is the [event stream](#realtime-stream)
through `fleet-stream` under a Monitor.

## Realtime stream

The Fleet app pushes its events to agents and monitors as they happen, so nothing polls: a loopback
HTTP endpoint (`lib/stream.ts`), on by default, **bound to 127.0.0.1 only**.

| Endpoint         | What                                             |
| ---------------- | ------------------------------------------------ |
| `GET /events`    | Server-Sent Events (`text/event-stream`)         |
| `GET /events/ws` | a WebSocket; one text message per stream message |

**Messages.** One per Fleet event: the journal's events exactly as `fleet_events` returns them (job
queued / started / finished with the failed step, STALLED, QUEUED-LONG including capacity waits, run
completed / cancelled, pool health changes, alerts, your actions), plus `pool` on job lines; `hooks`
when the webhook state changes (live / stale / off; not journaled, no `seq`); and a compact `status`
heartbeat every `stream.heartbeatSeconds` (default 60: running / queued counts, severity, each
pool's state and `busy/slots`, webhooks, `last_seq`), so a quiet stream still shows Fleet is alive.
A connection starts with `hello` (`last_seq`, `heartbeat_s`) and a `status`. Over SSE each message
is a record with `event: <type>` and, for events, `id: <seq>`.

| Query         | Meaning                                                                                                                                                                                              |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kinds=a,b`   | event kinds (as `fleet_events`) and `hooks`; `problems` = warn / bad events (failures, stalls, alerts, unhealthy pools) and stale webhooks; a capacity wait is not a problem                         |
| `repo=`       | `owner/name` or just `name`                                                                                                                                                                          |
| `pool=`       | a pool short name, or `github`                                                                                                                                                                       |
| `branch=`     | exact branch name                                                                                                                                                                                    |
| `since_seq=N` | first replay every event after `N` (from the in-memory log, else the journal), then live; each `seq` once. SSE's `Last-Event-ID` does the same. A cursor older than the journal gets a `gap` message |
| `format=line` | each message as one compact human-readable line instead of JSON                                                                                                                                      |
| `token=`      | the token, when a header can't be sent (prefer the header)                                                                                                                                           |

The `status` heartbeat (and `hello`, `dropped`, `gap`) pass every filter.

**Auth and guards.** Every request needs the per-install token from `fleet-stream-token` in the data
folder (made on the first start, 0600) as `Authorization: Bearer <token>` (or `?token=`): `401`
otherwise. The `Host` header, and the `Origin` header when sent, must name a loopback host
(`127.0.0.1`, `localhost`, `[::1]`), so a web page that rebinds its own DNS name to 127.0.0.1 is
refused (`403`). At most `stream.maxClients` clients (default 8; `503` past it). A client that
doesn't keep up (256 queued SSE messages, 1 MB unsent on a WebSocket) loses the messages that don't
fit, never holding up the others, and is then told: a `dropped` message with the count and the `seq`
range to replay with `since_seq`. Event text is CI output, capped and stripped of control characters
exactly like the MCP answers, and a fork / `pull_request_target` run's events carry
`untrusted: true` with no failed step or annotation in their text (the line form says
`[untrusted]`): data, never instructions.

Settings (file-only, `fleet-settings.json`): `stream.enabled` (default `true`), `stream.port`
(default `8790`; must differ from `webhooks.port`), `stream.heartbeatSeconds` (5–3600),
`stream.maxClients` (1–64); applied at the next launch. A taken port leaves Fleet running without
the stream (logged). When it listens, Fleet writes `fleet-stream.json` (`{ port, pid, started_at }`)
beside the token.

```sh
DATA="$HOME/Library/Application Support/dev.brainwires.fleet"
# One line per problem, as it happens:
curl -N -H "Authorization: Bearer $(cat "$DATA/fleet-stream-token")" \
  "http://127.0.0.1:8790/events?kinds=problems&format=line"
# Everything after seq 1200 (JSON), then live:
curl -N -H "Authorization: Bearer $(cat "$DATA/fleet-stream-token")" \
  "http://127.0.0.1:8790/events?since_seq=1200"
```

A WebSocket (Deno, or any client; a browser page can't, by the Origin rule):

```ts
const token = (await Deno.readTextFile(`${dataDir}/fleet-stream-token`)).trim();
const ws = new WebSocket(
  `ws://127.0.0.1:8790/events/ws?kinds=finished,stalled&repo=web&token=${token}`,
);
ws.onmessage = (e) => console.log(JSON.parse(e.data));
```

### fleet-stream (the CLI for monitors)

`mcp/fleet-stream.ts` connects, prints one line per message, and on a drop (Fleet restarting, a
lagging client, a dead connection: nothing heard for three heartbeats) reconnects with `since_seq` =
the last event it printed, so nothing is missed or printed twice. It reads the token and the port
from the data folder (`fleet-stream.json`, else the settings' `stream.port`, else 8790) and needs
only `--allow-read` of the data folder and `--allow-net=127.0.0.1`. It waits out a Fleet that isn't
running (one note on stderr) and exits non-zero only on a configuration or auth error: `2` (no token
file, a bad argument or filter), `3` (the token refused).

```sh
deno run --no-config --no-prompt "--allow-read=<data dir>" --allow-net=127.0.0.1 \
  <path to fleet>/mcp/fleet-stream.ts --data-dir "<data dir>" \
  [--kinds problems] [--repo r] [--pool p] [--branch b] [--since-seq N] [--json] [--no-status] [--port N]
deno task stream --kinds problems     # the same, for macOS's data folder, from a checkout
```

`--json` prints the messages as JSON lines; `--no-status` stops printing the heartbeat (it still
checks the connection). Output lines look like:

```text
#812 14:02:11Z ✕ finished acme/web · CI / windows-tests: finished: failure at step "Run tests" https://github.com/…
#813 14:02:40Z ▲ stalled acme/web · CI / e2e: STALLED: running 76 min on linux-x64 https://github.com/…
· status 14:03:00Z running=3 queued=1 severity=ok hooks=live pools: mac-arm ok 2/4 q0, linux-x64 ok 1/3 q1
```

**From a Claude Code session**, run it under the Monitor tool, which hands the agent each line as it
is printed (the command, with this machine's paths; `--no-status` keeps a quiet stream quiet):

```sh
deno run --no-config --no-prompt "--allow-read=$HOME/Library/Application Support/dev.brainwires.fleet" \
  --allow-net=127.0.0.1 <path to fleet>/mcp/fleet-stream.ts \
  --data-dir "$HOME/Library/Application Support/dev.brainwires.fleet" --kinds problems --no-status
```

Narrow it to the work at hand (`--repo denext --branch development`), or drop `--kinds` to hear
every job start and finish.

## Data files

In the app's data folder (on macOS `~/Library/Application Support/dev.brainwires.fleet`, made 0700),
never the GitHub token or any GitHub secret (only the local event stream's own token); every file is
0600, and the JSON files are written to a random temp name and renamed over:

| File                                         | What                                                                                                                                                                |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet-settings.json`                        | the settings ([Settings](#settings-and-the-first-run-wizard))                                                                                                       |
| `fleet-local-config.json`                    | optional, never written by Fleet: a machine's own settings, read once when there is no settings file                                                                |
| `fleet-state.json`                           | usual job lengths (the last 10 successful runs per job), posted notification keys (48 h), prefs (first launch done, start at login defaulted, notifications paused) |
| `fleet-events.json`                          | the window's event log: the last 2,000 lines and the tracker, rewritten whole                                                                                       |
| `fleet-events.jsonl`, `fleet-events.1.jsonl` | the event log as an append-only journal for agents: one event a line, `seq` increasing across restarts, `run_id` / `job_id` on job and run lines; rotated at 5 MB   |
| `fleet-history.json`                         | the usage history per pool ([Pool detail screens](#pool-detail-screens)): two bucket tiers, 24 h and 30 days, and the last 200 jobs per pool; rewritten every 2 min |
| `snapshot.json`                              | the agents' snapshot, written atomically after every poll and webhook update and at least once a minute (a heartbeat that bumps `written_at` only)                  |
| `fleet-stream-token`                         | the [event stream](#realtime-stream)'s bearer token: random per install, made on the first start (the one secret here; 0600)                                        |
| `fleet-stream.json`                          | where the event stream listens (`{ port, pid, started_at }`), written when it starts                                                                                |

`snapshot.json` is
`{ v: 1, updated_at, written_at, source: "poll" | "hook", auth, poll, rate, hooks, health, summary, pools, hosts, alerts, event_seq, clock_offset_ms, runs, jobs }`.
Runs and jobs are every active run plus those finished in the last 2 h (repo, run id, workflow,
branch, sha, event, actor, `head_repository`, `fork`, `untrusted`, status, conclusion, times,
`html_url`; jobs also name, labels, `runner_name`, pool, steps, and for a failure `failed_step` and
the first failure annotation). `clock_offset_ms` is GitHub's clock minus the Mac's.

Outside it, only where the settings say: a webhook spool outside the data folder
(`webhooks.spoolDir`). Fleet reads, never writes, the runner scheduler integration's local health
file and `paused-<pool>` files.

## Permissions

Baked into the binary from `denext.config.ts` (least privilege, derived by the package scripts):
`--allow-net` connect to `api.github.com`, plus the hosts its job-log downloads redirect to
(`productionresultssa0`–`19.blob.core.windows.net`, `pipelines.actions.githubusercontent.com`:
fetched without the token, any other redirect refused), plus the loopback listen every desktop app
has (the webhook port and the event stream's port are inside it); `--allow-run` only the `gh` paths
above and `/usr/bin/security` (a keychain webhook secret); `--allow-write` only the app's data
folder. denext adds its baseline read / env grants and the unscoped `--allow-sys` that the secure
store, notifications and start at login need.

**An internal build** (`FLEET_INTERNAL=1`, `denext task desktop:package:internal`) also bakes what
the build machine's `fleet-local-config.json` (or `$FLEET_LOCAL_CONFIG`) calls for: the runner
scheduler integration's programs (`pausePool`, `watchdog`, `/bin/launchctl` with a `launchdLabel`)
and a webhook spool outside the data folder (`lib/build-grants.ts`). It fails without a readable,
valid local config. A release build bakes none of it: no ops paths, no launchctl, nothing of the
builder's home. An internal build rewrites `.deno-desktop/config.json` with those grants: restore it
(`git checkout .deno-desktop/config.json`) rather than commit it.

## Development

```sh
denext task test      # data layer, settings, wizard, view, controls, tray, hooks and MCP tests (no network, gh or keychain)
denext task check     # deno fmt --check (Markdown included), deno lint, the tests
denext task icons     # redraw the icons/ and public/ art from lib/icons.ts
denext task export    # the static page export → out/
```

Run `denext task check` before every commit. Test fixtures are trimmed recorded API responses; no
credentials.

### Packaging and signing

```sh
DENEXT_CODESIGN_IDENTITY="Developer ID Application: <name> (<team id>)" \
  denext task desktop:package               # dist/Fleet.app + dist/Fleet.dmg, signed (release)
DENEXT_CODESIGN_IDENTITY="…" DENEXT_NOTARY_PROFILE=<profile> \
  denext task desktop:package:internal      # the same, with the local config's grants baked in
denext task desktop:package:windows         # dist/Fleet-x64-windows.zip
```

Without `DENEXT_CODESIGN_IDENTITY` the macOS app is ad-hoc signed (local use only). Setting
`DENEXT_NOTARY_PROFILE` (a `notarytool` keychain profile) as well notarizes it; the release build is
signed, notarized and stapled (`spctl` reports "Notarized Developer ID"; the `.dmg` around it is not
itself signed). Credentials come from the environment and the keychain only, never from a file in
this repo.

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
| `lib/deno-hooks.ts`                    | Webhooks per the settings: enable check, secret, listener, `events.jsonl`, spool tailing                 |
| `hooks-only.ts`                        | The receiver without a window (a background service, `denext task hooks`)                                |
| `lib/settings.ts`                      | The settings: schema, validation, versions, startup (file → local config → defaults), the active ones    |
| `lib/branches.ts`                      | Protected-branch rules and the repos' default branches                                                   |
| `lib/discover.ts`                      | The wizard's questions to GitHub: the token's account, scopes and orgs; an owner's repos                 |
| `lib/build-grants.ts`                  | The internal build's extra permissions, from the local config                                            |
| `lib/controls.ts`                      | The controls' guardrails and pool commands (pure)                                                        |
| `lib/control-runner.ts`                | Controls end to end: guardrails → OS dialog → GitHub or the pool script → event log                      |
| `lib/deno-pools.ts`, `local-health.ts` | The runner scheduler integration: pool commands, the watchdog's local health merged over the variable    |
| `lib/health.ts`                        | The pool-health variable's parser (`pools` by label, `hosts` by pool; docs/pool-health.md)               |
| `lib/pools.ts`                         | The pool list (grouped from runners, or from the variable), labels, runner prefixes, runner hosts        |
| `lib/classify.ts`                      | Job classification, queue ages, warnings, lane grouping                                                  |
| `lib/snapshot.ts`                      | Pool cards, summary, the page's snapshot                                                                 |
| `lib/history.ts`, `history-sources.ts` | The usage history (tiers, samples, jobs, percentiles, back-fill) and where its data comes from           |
| `lib/pool-detail.ts`                   | A pool detail screen's data: history over a range, shared machine, recent jobs and events                |
| `lib/redact.ts`, `runner-logs.ts`      | Secrets out of log lines, ANSI; parsing launcher logs, scheduler lines, job log groups                   |
| `lib/deno-logs.ts`, `logs.ts`          | Bounded, redacted reads of the scheduler's logs; GitHub job logs (budgeted, cached)                      |
| `lib/notify.ts`                        | Which notifications to post, once each                                                                   |
| `lib/agent-snapshot.ts`                | The agents' `snapshot.json`, built from the poller's state                                               |
| `lib/agent-files.ts`                   | The agent files' names, shared with the MCP server                                                       |
| `lib/deno-host.ts`                     | gh, the data files, native notifications                                                                 |
| `lib/tray-driver.ts`                   | Tray, window manager (open / close / focus, the Dock icon following it), start at login                  |
| `lib/dock-policy.ts`                   | Whether the Dock icon follows the window (macOS: not when installed under `/Applications`)               |
| `lib/quit-guard.ts`                    | Which quits quit: the tray's Quit and the session end; any other closes to the tray                      |
| `lib/shortcuts.ts`                     | Cmd+W / Cmd+Q in the window close it (an accessory app has no menu bar)                                  |
| `lib/icons.ts`, `png.ts`               | The tray and app icons, drawn in code (`denext task icons`)                                              |
| `mcp/fleet-mcp.ts`, `mcp/queries.ts`   | The read-only MCP server for agents (stdio) and its tools' answers                                       |
| `lib/stream.ts`, `stream-format.ts`    | The loopback event stream (SSE / WebSocket): filters, replay, guards, backpressure; its wire messages    |
| `lib/deno-stream.ts`                   | The stream's token file, `fleet-stream.json`, the 127.0.0.1 listener                                     |
| `mcp/fleet-stream.ts`                  | `fleet-stream`: the stream as one line per event, reconnecting with `since_seq` (for monitors)           |
| `app/`                                 | The page: `fleet-app.tsx` (state), `fleet-view.tsx`, `event-log.tsx`, `controls.tsx`, `token-screen.tsx` |
| `app/pool-detail.tsx`, `charts.tsx`    | The pool detail screen and its hand-drawn SVG charts                                                     |
| `app/log-viewer.tsx`                   | The virtualized log viewer                                                                               |
| `app/settings-view.tsx`                | The first-run wizard and the Settings view                                                               |
| `public/fonts/`                        | IBM Plex Sans / Mono (OFL), bundled                                                                      |
| `scripts/package-*.ts`                 | The packaging scripts denext generated                                                                   |
| `tests/`                               | Unit and view tests over trimmed recorded API responses                                                  |

## Known limits

- The macOS `.dmg` itself is unsigned (the app inside is signed and notarized).
- Windows: the build packages and launches, but the tray menu and Quit Fleet have not been verified
  by automation; check them by hand after a change there.
- Webhooks work only on macOS for now (see [docs/webhooks.md](docs/webhooks.md)); everywhere else
  Fleet polls. The secure-store secret can't be set from the UI yet.
- Pool controls exist only with the runner scheduler integration on the machine that runs it.
- A user owner's repo-level runners aren't listed (only organizations' runners make pools).
- Runs that finished over 2 h ago are not in the agents' snapshot; older history is GitHub's.
- Usage history starts when Fleet first runs (plus what the journal and spool held); gaps while
  Fleet was closed show as gaps. A back-filled past uses today's slot counts.
- GitHub keeps job logs for its log retention (90 days by default); an older one answers 404.

## Runner-host jobs

Some GitHub-hosted jobs exist only to host a self-hosted runner for a while: for example a
`helper / helper (N)` workflow whose GitHub-hosted job registers an ephemeral runner
`gh-helper-<slot>-<ts>` and waits for one job. They are long-lived by design, so Fleet never raises
STALLED, "over usual" or a notification for them. The lanes and the GitHub-hosted panel show
`hosting gh-helper-1 · idle`, or `hosting gh-helper-1 · running <repo> · <workflow> · <job>` when a
running job's runner is the one of that slot (`helper (1)` ↔ `gh-helper-1-…`). A job on such a
runner counts in the rule's pool, marked "(GitHub helper)". The rules are the settings'
`runnerHosts` (`{ repo, workflow, runnerPrefix, pool }`); add one for each workflow of this kind.

## License

Licensed under either of [Apache License, Version 2.0](LICENSE-APACHE) or [MIT license](LICENSE-MIT)
at your option.

## Contributing and security

See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and conventions, and [SECURITY.md](SECURITY.md) for
reporting a vulnerability privately.
