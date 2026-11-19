# Machines

The Machines screen shows hardware telemetry per **physical machine** that hosts runner pools: one
card per machine, its pools nested inside with the jobs on them, live sparklines, and history. Fleet
does not collect any of it. It reads a **machines service** you run, over HTTP with a bearer token:

```json
"integrations": {
  "machines": { "url": "http://127.0.0.1:3900", "tokenFile": "~/.config/my-service/read.token" }
}
```

`url` is the service's origin (no path). `tokenFile` holds its read token (`~/` allowed, 32 to 256
characters of `A-Z a-z 0-9 _ -`); Fleet reads the file each time it connects and never copies the
token into its settings, a log, the snapshot or `machines.json`. The section is file-only (edit
`fleet-settings.json`); a change is picked up without a restart. A release build may connect only to
GitHub: an internal build bakes the service's address from the build machine's local config (README,
Permissions).

## What the service must serve

Every request carries `Authorization: Bearer <token>`. Anything else is the service's own business.

### `GET /api/telemetry/stream[?since=<epoch ms>]`

Server-Sent Events, held open:

- `event: machines`: the whole machines document (below), at once and then at least every 30 s
  (Fleet treats 45 s of silence as a dead stream and reconnects).
- `event: samples`: `{ "host": "<machine id>", "samples": [sample, …] }` as readings arrive.

On a reconnect Fleet sends `since` = the newest sample time it has; the service replays what was
missed, so the sparklines have no hole.

### `GET /api/telemetry/machines`

The machines document on its own (Fleet uses the stream; this is for scripts).

```jsonc
{
  "at": 1795098039495, // epoch ms, everywhere
  "machines": [{
    "id": "laptop", // [\w.+-]{1,100}
    "name": "The laptop",
    "info": {
      "os": "macOS 15",
      "arch": "x86_64",
      "cpuModel": "…",
      "host": "…",
      "bootAt": 1795000000000
    },
    "source": "agent", // where the readings come from, shown as a hint
    "lastAt": 1795098039495,
    "online": true, // false: the card says "No live stats" with the last sample's age
    "latest": {/* a sample */},
    "pools": [{
      "name": "win-vm",
      "label": "acme-windows",
      "slots": 1,
      "busy": 1,
      "state": "healthy", // healthy | degraded | blocked | paused | down
      "reason": "",
      "use": { "cpuPct": 390, "rssMb": 8192 }, // the pool's share of the machine now, or null
      "jobs": [{
        "pool": "win-vm",
        "slot": 1,
        "phase": "running",
        "since": 1795097739495,
        "job": { "repo": "acme/web", "runId": 1, "jobId": 2, "name": "windows-tests" },
        "runner": "r-win-vm-1-1795097700",
        "cpuPct": 390,
        "rssMb": 8192, // what the job's sandbox uses now, or null
        "sandbox": "Windows"
      }]
    }]
  }]
}
```

A sample:

```jsonc
{
  "t": 1795098039495,
  "cpu": { "pct": 56.5, "cores": [96.3, 24.4], "load": [5.86, 5.5, 4.74] }, // load: null on Windows
  "mem": { "totalMb": 16384, "usedMb": 14283, "availMb": 2101, "pressure": 75 }, // pressure: 0-100 or null
  "swap": { "usedMb": 144, "totalMb": 1024 },
  "disk": [{ "name": "root", "mount": "/", "totalGb": 233.5, "freeGb": 74.0 }],
  "net": { "rxBps": 4840, "txBps": 5272 },
  "temps": [{ "name": "cpu", "c": 71.2 }],
  "gpu": { "pct": 12 }, // or null
  "sandboxes": [{ "kind": "qemu", "name": "Windows", "cpuPct": 390.5, "rssMb": 16756.2 }],
  "pools": { "win-vm": { "cpuPct": 390.5, "rssMb": 16756.2 } }
}
```

`cpuPct` of a sandbox, a pool or a job is percent of **one** core (390 is 3.9 cores), shown as
cores.

### `GET /api/telemetry/history?host=<id>&range=1h|24h|7d`

One machine's history as columns aligned with `t`:
`{ host, range, stepMs, from, to, t[], cpu[], cpuMax[], load1[], memUsedMb[], memTotalMb, swapUsedMb[], rxBps[], txBps[], tempMaxC[], gpu[], disk: { <volume>: [] }, pools: { <pool>: { cpuPct[], rssMb[] } } }`.
Nulls are gaps. At most 2,000 points are drawn.

## What Fleet does with it

- **The screen** (the header's Machines button): per machine CPU, memory, swap and network with a
  sparkline of the last 15 minutes (hover a line for any point's value and time), per-core bars,
  free disk per volume, temperature and GPU where the machine reports them, then its pools (state,
  busy slots, share of the machine) and under each the running jobs with slot, job, phase, CPU and
  memory. Range **1 h / 24 h / 7 d** adds charts per machine (CPU average and peak, memory, swap,
  network, disk free, CPU per pool); **Compare machines** draws every machine on one chart (CPU,
  memory, swap or network).
- **Everything the service says is another program's word**: every number is clamped, every list
  capped (32 machines, 32 pools and 64 jobs per machine, 64 sandboxes, 256 cores), every text
  stripped of control characters, before it is kept or shown (`lib/machines.ts`).
- **`machines.json`** in the data folder (0600), rewritten at most every 10 s: the latest stats per
  machine and per-job usage for agents (the MCP's `fleet_machines`).
- A service that is down, or a refused token, shows as "reconnecting" with the reason; the cards
  keep the last readings, marked with their age.
