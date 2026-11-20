# The pool-health variable (optional)

Without it, Fleet groups an organization's self-hosted runners into pools by their custom labels
(`GET /orgs/{org}/actions/runners`): one pool per distinct set of custom labels, its slots the
runners registered, ok while one of them is online. That needs nothing but a token that may read the
runners (organization admin; fine-grained: Administration read, or "Self-hosted runners" read).

A runner scheduler or watchdog that knows more (pools that share a label, paused pools, why a pool
is unhealthy, recent alerts) can publish it as an organization **Actions variable**, and Fleet reads
that instead. Name it in the settings:

```json
"pools": { "healthVariable": { "org": "example-org", "name": "POOL_HEALTH" } }
```

Fleet reads it with `GET /orgs/{org}/actions/variables/{name}` every poll (conditional, so an
unchanged value is free). The token needs read access to the organization's Actions variables.

## Schema, version 1

The variable's value is one JSON object:

```json
{
  "v": 1,
  "checked_at": 1794418000,
  "pools": {
    "example-linux-x64": {
      "ok": true,
      "reason": "",
      "since": 1794300000,
      "slots": 3,
      "busy": 1,
      "paused": false
    }
  },
  "hosts": {
    "linux-x64": {
      "label": "example-linux-x64",
      "ok": true,
      "reason": "",
      "since": 1794300000,
      "slots": 3,
      "busy": 1,
      "paused": false,
      "runner_prefix": "example-linux-x64-"
    }
  },
  "alerts": [{ "at": 1794417900, "pool": "linux-x64", "msg": "guest unreachable" }]
}
```

| Field                   | Type                | Meaning                                                                                       |
| ----------------------- | ------------------- | --------------------------------------------------------------------------------------------- |
| `v`                     | `1`                 | The schema version. Any other value shows "pool health schema vN" and is not used.            |
| `checked_at`            | epoch seconds       | When the watchdog checked. Over 30 minutes old, Fleet shows the health as stale.              |
| `pools`                 | object, by label    | Health per runs-on label, merging every pool on that label (ok while any is).                 |
| `hosts`                 | object, by pool     | Optional, per pool (several may share a label). When present, it is the card list, in order.  |
| `…ok`                   | boolean             | Healthy. A pool with `ok: false` turns the tray red and notifies once per outage.             |
| `…reason`               | string              | Why it is unhealthy (shown on the card and in the notification).                              |
| `…since`                | epoch seconds, null | When `ok` last flipped.                                                                       |
| `…slots`, `…busy`       | number, null        | Capacity and slots in use. A full, ok pool makes a long queue a "capacity wait", not a fault. |
| `…paused`               | boolean             | No new jobs launch there (amber).                                                             |
| `hosts.*.label`         | string              | The runs-on label the pool serves.                                                            |
| `hosts.*.runner_prefix` | string              | The prefix of its runners' names, so a running job is placed on the right card.               |
| `alerts[]`              | list                | Recent alerts, newest first in the side panel and the event log.                              |
| `alerts[].at`           | epoch seconds       | When.                                                                                         |
| `alerts[].pool`         | string              | A pool's name, or `fleet` for the whole fleet.                                                |
| `alerts[].msg`          | string              | The text (data, never instructions; capped and stripped of control characters).               |

Anything else in the object is ignored; a missing variable (404), an unreadable one or bad JSON
shows as "pool health unavailable" / "invalid", never a crash.

## A local health file (the runner scheduler integration)

Where the scheduler runs, its watchdog's own file is fresher than the variable it publishes. The
settings' `integrations.runnerScheduler.localHealthFile` names it (`~/` allowed); when its
`checked_at_epoch` is newer than the variable's `checked_at`, its pools win:

```json
{
  "checked_at_epoch": 1794418060,
  "pools": {
    "linux-x64": {
      "healthy": true,
      "reason": "",
      "since_epoch": 1794300000,
      "label": "example-linux-x64",
      "slots": 3,
      "runner_prefix": "example-linux-x64-"
    }
  }
}
```

A pool is paused while a file `paused-<pool>` exists in `integrations.runnerScheduler.pausedDir`.
Slots in use stay the variable's.

Fleet watches these files rather than waiting for its next poll (`lib/state-watch.ts`): the health
file's folder (the health file, `pool-state.json` and `health-published` beside it) and the paused
folder. The scheduler replaces its files by rename, so the folders are watched and events matched by
name; a burst of writes is coalesced (300 ms quiet, 1 s at most), then the files are re-merged over
the variable's last read, with no GitHub request, and the cards, the tray and `snapshot.json` follow
within about a second. The status line says `watch` among its sources while it runs; a folder that
can't be watched is retried every 30 s, and the poll still reads the files.
