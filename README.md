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

Four more sections are file-only, kept as they are by the UI:

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
  [pool controls](#controls); `configHelper`: the runner settings; `routingHelper`: the
  [routing rules](#machines-and-routing)). Inactive unless configured.
- `integrations.machines`: a machines service ([Machines](#machines-and-routing)),
  `{ url, tokenFile }`. Inactive unless configured; picked up without a restart.

**A machine's own config.** When there is no settings file yet and `fleet-local-config.json` (a
complete settings document) sits beside it in the data folder, Fleet starts from it, marked set up,
and writes `fleet-settings.json` from it: no wizard. That is how a team ships its integrations to
its own machines without putting them in this repo. A settings file that doesn't parse is reported
in the console and never overwritten until new settings are saved. Paths in the settings may start
with `~/`.

## Tray behaviour

- **A Dock icon only while the window is open, never in the recent apps** (macOS):
  `desktop.app.dock: "while-window-open"`. Fleet itself is accessory from the first frame to quit;
  while its window is open, denext's Dock helper (a small app Fleet copies into its data folder,
  outside /Applications) holds the Dock icon and the Cmd-Tab entry, and clicking it or switching to
  it brings the window up. Its Quit (the Dock menu, Cmd-Q while it is in front) closes the window
  and Fleet keeps running in the tray; the tray menu's Quit quits Fleet. Fleet never switches to
  "regular": an app that was ever regular gets a tile in the Dock's recent apps whenever its running
  Dock tile goes away (on quit, or on going back to accessory), and macOS has no opt-out. Opening
  brings the window to the front and makes it key through the window's `focus()`, which activates
  the app ignoring other apps without changing the policy.
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
- **What opens it**: the tray (a click, or Open Fleet), a click on its Dock icon (the Dock helper's,
  while the window is open), opening Fleet again from Finder or Launchpad, launching it again
  (single instance), or a click on one of Fleet's notifications (also the click that launched it).
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
  poll is overdue or webhooks went quiet with jobs active and no poll has reconciled since), where
  the data comes from (`live · watch + webhooks` with the safety poll's interval secondary, the same
  as `via …` beside the live label, or `every 15 s` when only polling), API requests left (amber
  below 1,500, red below 800), the webhook state (`hooks: live`, `live (via receiver)`,
  `stale (last delivery N min ago)` while jobs are active, `quiet (…)` with nothing running, or
  `off`; hidden while the live label shows, whose tooltip then carries the delivery details),
  Refresh and Settings. With webhooks live, empty Running and Queued lanes carry a green live dot.
- **Pool cards**: one card per runner pool, then GitHub-hosted. The list follows the live data,
  rebuilt on every poll: without a pool-health variable, the organizations' self-hosted runners
  grouped by their custom labels (ok while one runner is online); with one
  ([docs/pool-health.md](docs/pool-health.md)), its per-host `hosts` map (the runner scheduler
  integration's local health file merged in when fresher; its folder is watched, so a scheduler tick
  reaches the cards within a second, with no poll), else its labels plus the registered runners. The
  scheduler integration's declared pools are only the first render's, before any data arrives; a
  pool that leaves the data leaves the cards. Each card: slots as pips (filled = busy), a state chip
  with its reason: ok, busy (blue: every slot busy, jobs queued), blocked (amber: a free slot, a
  gate holds the launch), Paused (amber: paused by hand), unhealthy (red: a real failure, the host
  unreachable, registration failing, not clean) or no health (`lib/pool-status.ts`), and the oldest
  queued wait, red past 15 min (amber when every slot is busy: the jobs are waiting for capacity,
  not faulting). Hosts that share a runs-on label (`win-x64` and `win-x64-pc` on
  `denext-windows-x64`) each show their own numbers; a running job is placed by its runner's name,
  and a queued job of a shared label sits on that label's first card (its label can't say which host
  will take it). A long pool name truncates with "…" (full name on hover); the state chip stays on
  its line. A self-hosted card is compact; when its pool has running jobs, its `busy/slots` count is
  a toggle that widens the card to two columns and lists the busy runners.
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
- **Zoom** (larger text): View → Zoom In (Cmd/Ctrl + or =), Zoom Out (Cmd/Ctrl −) and Actual Size
  (Cmd/Ctrl 0), 80% to 200% in 10% steps. The keys work in the window itself too (where a menu
  accelerator doesn't reach). The level is kept in `fleet-view.json` ([Data files](#data-files)),
  every window opens at it, and a change in one reaches the others. Fleet's page scales itself (CSS
  `zoom`; at the larger levels the narrow window layouts take over), and the in-app GitHub browser's
  page follows through the web view's own page zoom where its engine has one.
- **Side**: the pool-health variable's recent alerts (each clamped to three lines; a click expands
  it, the full text is also the tooltip), and jobs finished in the last 30 min with ✓ / ✕ / ⊘.
- A click on a run or job opens it on github.com: in the in-app GitHub browser where the window can
  host embedded web views, else in the system browser (see below). Links from the wizard, the
  Settings view and the token screen always open in the system browser. Only `https://github.com/`
  links open at all.
- A click on a pool card (or its name, a button) or on the GitHub-hosted panel opens that pool's
  [detail screen](#pool-detail-screens).

### In-app GitHub browser

A GitHub link opens in a panel that covers the main view instead of leaving Fleet. It runs on
denext's embedded web view (`createWebView` / `attachWebView` from `denext/desktop/window`, denext
4.18 and its desktop runtime). Fleet checks at run time: on an engine that doesn't report
`webViewCapabilities().supported`, or if the view can't be created, the link opens in the system
browser instead.

- **GitHub only**: `desktop.webViews.allowedOrigins` in `denext.config.ts` is `https://github.com`,
  so the only pages Fleet itself loads in the view are on github.com (GitHub's sign-in, two-factor
  and passkey pages are there too). Links you follow stay in the view on GitHub's own site
  (github.com and its subdomains, such as docs.github.com, over https). A link to another site (a
  README's link, a redirect such as an organization's SAML sign-in) is stopped and opened in the
  system browser; if it had already loaded, the view returns to the GitHub page you were on. The
  view is another site's page: it never gets Fleet's desktop bridge, Fleet's storage or its
  settings.
- **Toolbar**: Back, Forward, Reload, **Fleet** (back to the main view), the page's title and URL,
  and **Open in browser** (the current page in the system browser). A bar under the toolbar shows
  while a page loads; a failed load shows its error there.
- **Never blank**: the view stays hidden until the link's page has loaded; meanwhile the panel shows
  its own loading state (a spinner and the page's URL). A new link in the reused view hides it
  first, so neither a blank page nor the previous link's page shows.
- **Back to Fleet**: Back (the button, Cmd+[ or the Go menu) on the link's own page closes the panel
  and returns to the screen the link was clicked on: the dashboard or that pool's detail screen,
  with its range, tab and scroll position. Further in, Back steps through GitHub's pages as usual.
  Esc and **Fleet** return to the same screen.
- **One view, kept**: every GitHub link uses the same view. Leaving the panel hides the view without
  closing it; it closes when the window does. The view is hidden while the wizard, the Settings view
  or the token screen replaces the main view (a native view draws above all of the page's HTML).
- **Reopen where you left it**: clicking the same link again reopens the panel at once on the page
  and history you were on (Back then returns to the screen you clicked from this time). A hidden
  page can miss live updates, so it reloads in place (same URL, `#step` links included, history
  kept; the loading bar only if the reload is slow) when Fleet's data says the run or job is still
  queued or running, or finished while the panel was hidden. A finished run or job reopens as it
  was. A page Fleet knows no status for reloads if the panel was hidden for more than 30 seconds.
  Another link always starts fresh.
- **Session**: the view keeps its cookies in its own persistent storage partition (`fleet-github`,
  apart from Fleet's page), so a GitHub sign-in survives restarts. Pop-ups open in the same view,
  downloads go to the system browser, and camera, microphone, location and notification prompts are
  refused.
- **Keys** (Ctrl instead of Cmd on Windows and Linux): Cmd+[ and Cmd+] go back and forward whether
  the keyboard is in GitHub's page or in Fleet's toolbar (as app-menu items while GitHub's page has
  it). Esc returns to Fleet only while the keyboard is in Fleet's own part of the panel (click the
  toolbar first): in GitHub's page, Esc stays with GitHub's own menus and dialogs. Fleet sets its
  app menu (Edit, View and Go, the editing items kept) when the window opens; on Windows and Linux
  that menu is a menu bar in the window.

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

## Machines and routing

With a machines service configured (`integrations.machines`: its address and the file holding its
read token; [docs/machines.md](docs/machines.md) has the API a service must serve), the header gets
a **Machines** button. The screen has one card per **physical machine**, with the machine's pools
nested inside:

- CPU, memory, swap and network, each with the current value and a sparkline of the last 15 minutes
  (hover any point for its value and time); per-core bars; free disk per volume; temperature and GPU
  where the machine reports them; whether its readings are live and where they come from.
- Its pools: state, busy slots, and the pool's share of the machine right now (a VM that is always
  up counts with no job running). Under each pool its jobs: slot, job and repo, phase and how long,
  CPU (in cores) and memory. A machine that hosts a pool's VM beside another pool shows both on the
  one card.
- Every VM, container and runner process tree on the machine, with CPU and memory (collapsed).
- **1 h / 24 h / 7 d**: per machine the history as charts (CPU average and peak, memory, swap,
  network, free disk, CPU per pool), drawn with the pool detail's charts (hover, keyboard, a data
  table). **Compare machines** puts every machine on one chart: CPU, memory, swap or network.

Fleet reads the service's live stream (reconnecting by itself, asking for what it missed) and writes
`machines.json` for agents (`fleet_machines`). Nothing is collected by Fleet itself.

**Routing** (a second tab; only with the runner scheduler's routing helper,
`integrations.runnerScheduler.controls.routingHelper`): which pool takes which job, as a form.

- The form is built from the helper's JSON Schema at run time: job classes in order (a job belongs
  to the first class that matches it: a runs-on label, a job-name pattern, a repository, a workflow
  file), each with the pools that serve it as a ranked list (move up / down, add, remove;
  GitHub-hosted only as the last entry, or not at all), per pool "only while these pools are idle"
  and "never takes jobs named like", per machine "jobs at once, at most". Every field is a typed
  widget; there is no raw text box for the document.
- Every edit is checked by the helper (after 0.4 s) and previewed: **"With these rules, the next
  Windows job goes to: …"** per class, with why each pool can or cannot take it right now.
- **Save…** asks in the OS dialog (what changes, where the next jobs go), then hands the helper the
  draft with Fleet's caller token on stdin. The helper validates, writes the file and its audit
  entry; the scheduler reads it at its next tick. The newest change can be reverted. Each save and
  refusal is in the event log, marked "you". No pool, label or class name is built into Fleet.

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

### Fleet Notifier (macOS)

The macOS package embeds a helper app, `Contents/Helpers/Fleet Notifier.app` (bundle id Fleet's +
`.notifier`, Fleet's icon, no Dock icon, never a window), so shell scripts can post a notification
whose click opens Fleet (an `osascript` notification belongs to Script Editor, and its click opens
an untitled script). The runner watchdog's `alert_notify` uses it:

```sh
"…/Fleet.app/Contents/Helpers/Fleet Notifier.app/Contents/MacOS/fleet-notify" \
  --title T --body B [--subtitle S] [--id KEY] [--url fleet:LINK] [--dry-run]
```

**First run: allow its notifications.** After installing a new Fleet, open Fleet once. It registers
the helper with LaunchServices (a `ditto` or Finder copy registers only Fleet.app itself, and the
notification center refuses an unregistered helper with no prompt), then starts the helper through
LaunchServices to ask: macOS asks whether **Fleet Notifier** may send notifications. Choose
**Allow** (to change it later: System Settings > Notifications > Fleet Notifier). Only an instance
LaunchServices starts gets that prompt; a post exec'd from a shell while permission is undetermined
starts one the same way (`open -n -g -a "…/Fleet Notifier.app" --args --request-authorization`) and
waits up to 60 s for the answer. Until it is allowed, every post exits 3. The helper carries Fleet's
icon as an `.icns` and, when Xcode's `actool` is there at packaging, as an asset catalog
(`Assets.car`, `CFBundleIconName`) too.

`--id` replaces an earlier notification with the same id (the watchdog passes its condition key). It
exits once the post is accepted, within 2 s once allowed (the first run waits up to 60 s for the
permission prompt's answer): 0 posted, 1 not accepted, 3 not authorized (denied, or the prompt not
answered in time), 4 bad arguments. `--dry-run` validates and prints the notification as JSON,
posting nothing. A click runs `open -b <Fleet's id> --args --show-window`: a running Fleet opens its
window (a reopen), a stopped one starts with it shown. Fleet has no deep links yet, so `--url` is
kept in the notification but not acted on.

Where the watchdog notifies through the helper (the runner scheduler integration is configured and
this bundle embeds it), Fleet leaves out its own "queued over 15 min" notice for a self-hosted
pool's job: that is the watchdog's `stuck:<pool>` alert, shown once. Sources: `notifier/` (Swift),
`tools/notifier.ts` (build + embed, called by `scripts/package-macos.ts` before signing),
`lib/notifier.ts`.

## The shared rate limit

Fleet usually runs on the same gh token as other tools (a runner scheduler, CI watchers), and so
shares one 5,000-an-hour REST budget with them. If Fleet starved it, queued jobs would go unseen and
a scheduler would stop launching runners. So (`lib/budget.ts`):

- every request is conditional (`If-None-Match`): an unchanged list is a free 304 (the ETag cache is
  an LRU of 2,000 URLs, and a run's URLs leave it once the run leaves the agents' 2 h window);
- below 1,500 remaining it polls at 60 s even with the window visible;
- below 800, every 5 min, with the banner "Rate limit low: slowed down to protect the runner
  scheduler.";
- below 300, not at all until the reset (once the reset time passes, that figure is forgotten and
  polling resumes: the budget has refilled);
- past 1,200 counted (non-304) requests in Fleet's own last hour, every 5 min.

What it polls, per round (every 15 s visible, 60 s hidden, unless the budget slows it; with webhooks
on, only the safety net's rounds: see [Webhooks](#webhooks)):

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
to the console, and the next one goes ahead. A 403 / 429 with a rate-limit signal (no requests left,
a `Retry-After` in seconds or as a date, or GitHub's message naming a secondary rate limit) backs
off until the reset or `Retry-After` (else 1 min, doubling to 15 min; never over an hour), then
polls at the normal interval again. A 403 that is a permission refusal (no admin read on runners,
say) skips only that endpoint, retried every 10 min, while the others keep polling; the status names
it (`no access (403)` banner, `poll.forbidden` in `snapshot.json`). While polls fail and the last
good one is over 5 min old, the pool cards and lanes are dimmed and marked stale, and
`snapshot.json` says `poll.stale` (and `stale` on each pool).

## Webhooks

Optional. With GitHub's `workflow_job` / `workflow_run` webhook delivered to this machine, changes
arrive in seconds and the REST poll is only a safety net: every 15 min, once when deliveries have
been quiet for 5 min (a missed delivery or a dead tunnel shows then), and on Refresh; so a missed
delivery costs a few minutes of freshness, not correctness. Without webhooks Fleet polls (the header
says `hooks: off`).

- **The receiver** listens on `127.0.0.1` (loopback only, port `webhooks.port`, 8789 by default) and
  accepts only `POST /github/hooks`: `application/json` (else 415), at most 1 MiB (else 413), and a
  valid `X-Hub-Signature-256` HMAC under the webhook secret, checked before anything is parsed (else
  401). `ping` → 200; `workflow_job` / `workflow_run` → 202, de-duplicated on `X-GitHub-Delivery`
  (the last 10,000, kept across restarts) and dropped as a replay (202 `stale`) when the event's
  newest timestamp is over 10 min old. Payloads are data only.
- **Fleet or `hooks-only.ts`.** Fleet listens itself (`hooks: live`), unless the standalone receiver
  (`denext task hooks`, or the same as a background service) already holds the port; then Fleet
  tails its spool (`hooks: live (via receiver)`): the spool's folder is watched, so each delivery is
  read within ~50 ms, with a 15 s re-read as a safety net. Port taken and no spool: polling only.
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

| Tool                 | Arguments                                                                           | Returns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fleet_status`       | none                                                                                | pools and hosts (health, slots, busy, paused), queue counts and the oldest wait, rate budget, webhooks, the watchdog's `health.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `fleet_runs`         | `repo?`, `branch?`, `sha?` (prefix), `status?`, `limit?`                            | runs newest first, each with its jobs' counts and failed jobs (name + failed step)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `fleet_jobs`         | `run_id?`, `repo?`, `status?`, `conclusion?`, `pool?`, `limit?`                     | jobs; steps for failed jobs, and for every job when `run_id` is given; `conclusion: "failed"` = failure, timed_out, startup_failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `fleet_events`       | `since_seq?`, `kinds?`, `repo?`, `limit?`                                           | `{ events, next_seq, has_more }`: pass `next_seq` back as `since_seq` for only what's new                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fleet_wait`         | `run_ids?`, `job_ids?`, `until`, `timeout_s?` (≤ 1800, default 600)                 | blocks until `any_failure` / `completed` / `first_event`, then `{ triggered, runs, failed_jobs, jobs, events, next_seq }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `fleet_pool_health`  | `pool?`                                                                             | WHY a pool is not starting jobs: per pool its start `state` (`healthy` / `degraded` = every slot busy / `blocked` = a free slot, a gate holds the launch / `down` / `paused`), a `code`, the `reason` in plain words with the numbers, `since` / `for_s`, slots / busy / free, each busy slot's phase, and the queued jobs it cannot start with their wait; `status` is the badge Fleet shows (`ok` / `busy` / `blocked` / `paused` / `unhealthy`); `unhealthy` lists the pools to look at, worst first. From a runner scheduler's `pool-state.json` beside `--health-file` (name that file in `--allow-read` too), else the snapshot's `hosts[].start`, else the watchdog's health (`source`) |
| `fleet_pool_history` | `pool` (a pool, `github`, `github:<image>`), `range?` (`1h` / `24h` / `7d` / `30d`) | the pool's bucketed usage (≤ 168 points: busy, slots, utilization, queue, longest wait, jobs by conclusion, minutes, median / p90), totals, the duration histogram, its 20 latest jobs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `fleet_machines`     | `machine?` (id or name), `detail?` (default true)                                   | per physical machine (the machines integration): CPU total / per core / load, memory used / available / pressure, swap, free disk per volume, network rates, temperatures, GPU, the VMs and containers on it, and its pools with each running job's pool, slot, name, CPU and memory; `stale` when Fleet is not connected to the service or the file is older than a minute                                                                                                                                                                                                                                                                                                                    |
| `fleet_runner_log`   | `job_id` or `pool` + `file`, `tail?` (≤ 2000, default 200)                          | a launcher log's last lines (≤ 256 KB), redacted; only when the server runs with `--logs-dir`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**Why a pool is not starting jobs.** A runner scheduler that writes `pool-state.json` beside its
health file (settings `integrations.runnerScheduler.localHealthFile`) says, per pool, whether it can
START jobs and why not; Fleet never guesses it. A pool whose job runs fine but which cannot start
the next one is `degraded`, `blocked`, `paused` or `down`, not healthy. The pool's card badge
follows it (degraded is "busy", down is "unhealthy", a watchdog report of a paused pool is "Paused",
never "unhealthy") with the scheduler's reason line ("waiting for RAM: 12 of 16 GB in use by …,
needs 8", the state's duration and the waiting jobs in its tooltip), the pool's detail page repeats
it, and the summary (the tray's tooltip) names a pool blocked with a free slot and waiting jobs for
15 minutes (amber); a down host is red at once. The file's schema and states: `lib/pool-state.ts`.

`repo` takes `owner/name` or just `name`; `status` also takes `active` (anything not completed).
`fleet_wait` is event-driven: it watches Fleet's `snapshot.json` and journal and the webhook spool
(by name, within ~50 ms of a write; a 15 s re-read is only a safety net, 2 s when a folder can't be
watched), returns at once when the state is already there, and `triggered` says why it returned:
`failure`, `completed`, `event`, `timeout` or `stale`. Agents use it instead of polling `gh` (a
`gh run watch`, a loop of `gh run view`): it costs no API budget. `fleet_status` is read at the
call: Fleet rewrites `snapshot.json` on every delivery and scheduler change, and each pool gets its
`start` from the scheduler's `pool-state.json` directly. Example, instead of a watch script:

```text
fleet_runs({ repo: "denext", branch: "development", status: "active" })   → run 43194560988
fleet_wait({ run_ids: [43194560988], until: "any_failure", timeout_s: 1800 })
  → { triggered: "failure", failed_jobs: [{ name: "windows-tests", failed_step: "Run tests", … }] }
fleet_jobs({ run_id: 43194560988, conclusion: "failed" })                  → steps + annotation
fleet_events({ since_seq: <next_seq>, kinds: ["finished", "run-completed"] })  → what changed since
```

**Freshness.** Every answer carries `as_of` (Fleet's last poll or webhook update), `age_s`,
`written_at`, `fleet_running` (written in the last 2 min) and `stale`. It is stale when Fleet hasn't
written for 5 min (not running), its polls have been failing for over 5 min (`poll.stale`, live
webhooks or not: nothing reconciles missed deliveries or the pools), or its data is older than what
refreshes it: over 5 min when only polling, over the safety poll's interval plus 5 min with webhooks
on but quiet; with live webhooks a quiet fleet is current however old `as_of` is. A stale answer
says so in `warning`, and `fleet_wait` returns at once with `triggered: "stale"`: the agent then
falls back to `gh`. Runs that finished over 2 h ago are not in the snapshot (a waited-for id that
isn't is listed under `missing`). With no `snapshot.json` yet (Fleet not running, or an older Fleet
build), every answer is `stale: true`, and events come from `fleet-events.json`.

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

## The `ci` MCP server (dispatch contract)

`mcp/fleet-mcp.ts` only reads. `mcp/ci-mcp.ts` is the second server, `ci`: the one way agents touch
GitHub Actions, so the rules live in the tool instead of in every agent's brief. It reads Fleet's
cache first (`snapshot.json`) and GitHub for the rest, and its mutations are guarded and audited.
Like the read-only server it is zero-dependency MCP over stdio; unlike it, it talks to GitHub
(`api.github.com` and the job-log hosts) with the GitHub CLI's token (or `GH_TOKEN` / `GITHUB_TOKEN`
when granted) and writes exactly four files: the ledger beside the runner scheduler's health file.

**Nothing blocks.** Every tool answers within 60 s (a call that runs longer is cut off and says so),
except `ci_wait`, which waits at most 300 s and then answers `still_running`. `ci_watch` answers at
once with a watch id; the outcome arrives later.

| Tool          | Arguments                                                                                                  | Does                                                                                                                                                                                                                                      |
| ------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ci_status`   | `run_id`, `repo?`                                                                                          | the run live: status, conclusion, `protected`, `owner` / `purpose`, job counts, every job with runner, pool, `queue_wait_s`, `duration_s`, `picker`, and for a failure `failed_step` plus its check-run annotations (failures first, ≤ 5) |
| `ci_logs`     | `job_id`, `repo?`, `grep?`, `case_sensitive?`, `context?` (≤ 10), `tail?` (≤ 1000), `max_matches?` (≤ 200) | a redacted log excerpt: the last lines, or the numbered matches with context; `available: false` and when it will be while GitHub won't serve it (before the job completes)                                                               |
| `ci_capacity` | none                                                                                                       | per pool: health, slots, busy, free, queued, oldest wait; GitHub-hosted families (macos / ubuntu / windows) with `saturated` (a job queued ≥ 3 min); the shared VM budget (`--shared-budget`); the scheduler's health. No GitHub call     |
| `ci_watch`    | `run_ids`, `owner`, `repo?`, `until?` (`any_failure` / `completed`), `notify?`, `expires_in_s?` (≤ 24 h)   | returns `watch_id` at once; at the first failure (or completion) sends `notifications/message` (logger `ci`) and writes a notice Fleet logs as an event `ci[<owner>] watch <id>: run N failed: <jobs>`                                    |
| `ci_wait`     | `run_ids` or `watch_id`, `repo?`, `until?`, `timeout_s?` (≤ 300, default 120)                              | `triggered: failure / completed` with the runs, or `still_running`                                                                                                                                                                        |
| `ci_dispatch` | `repo`, `workflow`, `ref`, `expect_sha`, `purpose`, `owner`, `inputs?`, `unlisted_ref_ok?`                 | dispatches a workflow, guarded (below); returns `run_id` (GitHub's `return_run_details`, else found by SHA), or `deduped: true` with the in-flight run's id                                                                               |
| `ci_rerun`    | `run_id`, `owner`, `repo?`, `jobs?` (`"failed"` or ids), `reroute?` (default `true`), `purpose?`           | re-runs a finished run; with `reroute` and a `pick runners` job, re-runs the picker (GitHub then re-runs every job that needs it, routed afresh) and says how many passing jobs re-run                                                    |
| `ci_cancel`   | `run_id`, `reason`, `owner`, `repo?`, `superseded_by?`                                                     | cancels a run, guarded (below)                                                                                                                                                                                                            |

`purpose` is `pre-test`, `release-gate`, `diagnostic` or `rerun`; `owner` is the agent's id. The
guards:

- **No stale head.** `ci_dispatch` resolves `ref` (a branch, else a tag, annotated tags followed) on
  GitHub and refuses unless it is at `expect_sha`: a push that didn't land is never dispatched.
- **No [skip ci] release gate.** With `purpose: "release-gate"` a head commit carrying `[skip ci]`
  (or `[ci skip]`, `[no ci]`, `[skip actions]`, `skip-checks: true`) is refused.
- **The runner allowlist, read-only.** With `--allowlist` (the scheduler's `allowlist.json`), a ref
  that is not the default branch, a tag or a listed `refs` entry is refused when any pool label is
  outside `widened_labels` (that pool's vetter refuses the job and the pool closes); the refusal
  names the accepted prefixes and a suggestion (`pretest/<name>`). `unlisted_ref_ok: true` passes it
  for a workflow none of whose jobs can reach those pools.
- **No duplicates.** An identical dispatch (repo, workflow, ref, SHA, inputs) whose run hasn't
  completed is answered with that run (`deduped: true`, `dispatched_by`); nothing new is queued.
- **Protected runs.** A run on the repo's default branch or a branch Fleet's `branches.rules`
  protect (never a fork's or a PR's) is never cancelled, and its passing jobs are never re-run:
  `reroute` is skipped there (re-running the picker would re-run them) and a passing job id is
  refused.
- **Ownership.** `ci_cancel` refuses a run another agent dispatched (the ledger says who) unless
  `superseded_by` names the run that replaces it.

**The ledger.** Every mutation, refused ones included, appends a line to `ci-audit.log` in the
runner folder (`--runners-dir`; JSONL
`{ v: 1, kind: "audit", at, op, ok, owner, purpose, repo,
run_id, workflow?, ref?, sha?, inputs?, deduped?, jobs?, reroute?, reason?, superseded_by?,
refused?, url? }`,
0600, one write per line so several agents' servers never interleave, rotated to `.1` past 8 MB);
watch outcomes go to `ci-notices.jsonl`. The ledger is also how separate agents' servers agree on
ownership and in-flight dispatches. Without `--runners-dir` the reads work and every mutation is
refused. Fleet (with the runner scheduler integration) tails both files beside its local health
file: each new line is an event (kind `action`; a refusal warns, a failed watch is `bad`, so
`fleet-stream --kinds problems` carries it to the owner's monitor), and a run dispatched or re-run
through `ci` shows its owner and purpose on its card.

**Register it** for agents with the line the server prints for your paths (every grant least
privilege: reads only its files, writes only the four ledger files, network only GitHub's API and
log hosts, runs only `gh`):

```sh
deno run --no-config mcp/ci-mcp.ts --data-dir "<Fleet data dir>" --runners-dir "<runner folder>" \
  --allowlist "<allowlist.json>" --tunables "<tunables file>" \
  --shared-budget "<machine>:<pool>,<pool>:<KEY in the tunables file, or a number>" --print-command
```

It prints a JSON argv; put its first element as `command` and the rest as `args` in an `mcpServers`
entry named `ci` (`.mcp.json` in a project, or `~/.claude.json` for every project). Watches live in
the server process: a session that ends drops its watches.

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
| `fleet-view.json`                            | the window zoom (`{ version: 1, zoom }`, percent; [The window](#the-window)), written when it changes                                                               |
| `machines.json`                              | the machines integration's latest stats per machine and per-job usage, for agents (`fleet_machines`); rewritten at most every 10 s                                  |

`snapshot.json` is
`{ v: 1, updated_at, written_at, source: "poll" | "hook", auth, poll, rate, hooks, health, summary, pools, hosts, alerts, event_seq, clock_offset_ms, runs, jobs }`.
Runs and jobs are every active run plus those finished in the last 2 h (repo, run id, workflow,
branch, sha, event, actor, `head_repository`, `fork`, `untrusted`, status, conclusion, times,
`html_url`; jobs also name, labels, `runner_name`, pool, steps, and for a failure `failed_step` and
the first failure annotation). `clock_offset_ms` is GitHub's clock minus the Mac's.

Outside it, only where the settings say: a webhook spool outside the data folder
(`webhooks.spoolDir`). Fleet reads, never writes, the runner scheduler integration's local health
file and `paused-<pool>` files, and the `ci` server's ledger beside the health file (`ci-audit.log`,
`ci-notices.jsonl`).

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
scheduler integration's programs (`pausePool`, `watchdog`, the configuration and routing helpers,
`/bin/launchctl` with a `launchdLabel`), a webhook spool outside the data folder, and a connection
to the machines service's address (`lib/build-grants.ts`). It fails without a readable, valid local
config. A release build bakes none of it: no ops paths, no launchctl, nothing of the builder's home.
An internal build rewrites `.deno-desktop/config.json` with those grants: restore it
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
| `lib/machines.ts`, `deno-machines.ts`  | Machines: the service's documents parsed, the stream's state and trails, history; the stream client      |
| `lib/routing.ts`, `routing-runner.ts`  | Routing rules: the helper's answers, a draft; load / check / save / revert through the helper            |
| `lib/redact.ts`, `runner-logs.ts`      | Secrets out of log lines, ANSI; parsing launcher logs, scheduler lines, job log groups                   |
| `lib/deno-logs.ts`, `logs.ts`          | Bounded, redacted reads of the scheduler's logs; GitHub job logs (budgeted, cached)                      |
| `lib/notify.ts`                        | Which notifications to post, once each                                                                   |
| `lib/notifier.ts`, `tools/notifier.ts` | Fleet Notifier (macOS helper app in `notifier/`): where it lives, whether the watchdog uses it; build    |
| `lib/agent-snapshot.ts`                | The agents' `snapshot.json`, built from the poller's state                                               |
| `lib/agent-files.ts`                   | The agent files' names, shared with the MCP server                                                       |
| `lib/deno-host.ts`                     | gh, the data files, native notifications                                                                 |
| `lib/tray-driver.ts`                   | Tray, window manager (open / close / focus, never regular), start at login                               |
| `lib/quit-guard.ts`                    | Which quits quit: the tray's Quit and the session end; any other closes to the tray                      |
| `lib/shortcuts.ts`                     | Cmd+W / Cmd+Q in the window close it (an accessory app has no menu bar)                                  |
| `app/web-panel/`                       | The in-app GitHub browser: web view adapter, browser, reveal gate, history, reopen rule, panel, menu     |
| `lib/link-status.ts`                   | A run / job link's status from the snapshot (the panel's reopen rule)                                    |
| `lib/icons.ts`, `png.ts`               | The tray and app icons, drawn in code (`denext task icons`)                                              |
| `mcp/fleet-mcp.ts`, `mcp/queries.ts`   | The read-only MCP server for agents (stdio) and its tools' answers                                       |
| `mcp/ci-mcp.ts`, `ci-tools.ts`         | The `ci` MCP server: guarded dispatch / re-run / cancel, status, logs, capacity, watches                 |
| `mcp/ci-guards.ts`, `ci-github.ts`     | Its guards and plans (pure), its GitHub access                                                           |
| `lib/ci-ledger.ts`                     | The `ci` ledger (audit log, watch notices): records, events, run owners, the tail Fleet reads            |
| `lib/stream.ts`, `stream-format.ts`    | The loopback event stream (SSE / WebSocket): filters, replay, guards, backpressure; its wire messages    |
| `lib/deno-stream.ts`                   | The stream's token file, `fleet-stream.json`, the 127.0.0.1 listener                                     |
| `mcp/fleet-stream.ts`                  | `fleet-stream`: the stream as one line per event, reconnecting with `since_seq` (for monitors)           |
| `app/`                                 | The page: `fleet-app.tsx` (state), `fleet-view.tsx`, `event-log.tsx`, `controls.tsx`, `token-screen.tsx` |
| `app/pool-detail.tsx`, `charts.tsx`    | The pool detail screen and its hand-drawn SVG charts                                                     |
| `app/machines-view.tsx`                | The Machines screen: a card per machine, sparklines, history, the comparison                             |
| `app/routing-form.tsx`                 | The routing rules' form, built from the helper's JSON Schema                                             |
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
