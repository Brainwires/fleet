// Event-driven refresh of the files other programs write: the runner scheduler's state (its health
// file, `pool-state.json`, `health-published`, the `paused-<pool>` files) and the webhook spool.
// Each watched file's FOLDER is watched (`Deno.watchFs`, FSEvents on macOS), never the file: the
// scheduler replaces its files by rename (write a temp file, rename it over the old one), which
// gives the path a new inode, so a watch on the file itself would go deaf after the first write.
// Events are matched by base name, then coalesced: the scheduler writes several files per tick,
// so a burst becomes one call `debounceMs` after it goes quiet, and never later than `maxWaitMs`
// after its first event (a folder that never goes quiet still refreshes). A folder that can't be
// watched (not there yet, or the watch ends) is retried every `retryMs`; the caller's slow safety
// poll covers the gap. Everything that touches the machine is injectable, so the tests drive it
// with fakes.

/** One folder to watch and which of its entries count. */
export interface WatchTarget {
  readonly dir: string;
  /** Exact base names that count (`health.json`). */
  readonly names?: readonly string[];
  /** Base-name prefixes that count (`paused-`). */
  readonly prefixes?: readonly string[];
}

/** A file-system event, as `Deno.watchFs` yields it. */
export interface WatchEvent {
  readonly kind: string;
  readonly paths: readonly string[];
}

/** An open folder watch: async-iterable events, closable. */
export interface FolderWatch extends AsyncIterable<WatchEvent> {
  close(): void;
}

/** Opens a folder watch (throws when the folder can't be watched). */
export type WatchFn = (dir: string) => FolderWatch;

/** The default: a non-recursive `Deno.watchFs` on the folder. */
export const denoWatch: WatchFn = (dir) => Deno.watchFs(dir, { recursive: false });

/** Quiet time that ends a burst. */
export const WATCH_DEBOUNCE_MS = 300;
/** A burst is flushed at the latest this long after its first event. */
export const WATCH_MAX_WAIT_MS = 1_000;
/** A folder that can't be watched is tried again this often. */
export const WATCH_RETRY_MS = 30_000;

/** A path's last segment (either separator). */
export function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? path : path.slice(i + 1);
}

/** Whether a base name is one the target counts. */
export function nameMatches(name: string, t: WatchTarget): boolean {
  if (!name) return false;
  if (t.names?.includes(name)) return true;
  return (t.prefixes ?? []).some((p) => name.startsWith(p) && name.length > p.length);
}

/**
 * The base names in an event that the target counts (an access event never does). A rename names
 * the temp file, the destination or both, depending on the platform: any match counts.
 */
export function matchedNames(ev: WatchEvent, t: WatchTarget): string[] {
  if (ev.kind === "access") return [];
  const out: string[] = [];
  for (const p of ev.paths) {
    const name = baseName(p);
    if (nameMatches(name, t) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Timers, injectable. */
export interface Timers {
  readonly setTimeout: (fn: () => void, ms: number) => number;
  readonly clearTimeout: (id: number) => void;
  readonly now: () => number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

/** A trailing debounce with a ceiling, collecting the names seen in the burst. */
export interface Debouncer {
  /** Note a change (its names join the burst). */
  trigger(names?: Iterable<string>): void;
  /** Run now if a burst is pending. */
  flush(): void;
  /** Drop a pending burst. */
  cancel(): void;
  readonly pending: boolean;
}

/**
 * `fn` runs once per burst: `waitMs` after the last trigger, or `maxWaitMs` after the first one,
 * whichever comes first, with every name triggered in between.
 */
export function createDebouncer(
  fn: (names: ReadonlySet<string>) => void,
  opts: { waitMs: number; maxWaitMs: number; timers?: Timers },
): Debouncer {
  const t = opts.timers ?? realTimers;
  let timer: number | null = null;
  let first: number | null = null;
  let names = new Set<string>();
  const run = () => {
    if (timer !== null) t.clearTimeout(timer);
    timer = null;
    first = null;
    const got = names;
    names = new Set();
    try {
      fn(got);
    } catch {
      // The callback's failure is its own.
    }
  };
  return {
    trigger(more = []) {
      for (const n of more) names.add(n);
      const now = t.now();
      first ??= now;
      if (timer !== null) t.clearTimeout(timer);
      const wait = Math.max(0, Math.min(opts.waitMs, first + opts.maxWaitMs - now));
      timer = t.setTimeout(run, wait);
    },
    flush() {
      if (first !== null) run();
    },
    cancel() {
      if (timer !== null) t.clearTimeout(timer);
      timer = null;
      first = null;
      names = new Set();
    },
    get pending() {
      return first !== null;
    },
  };
}

/** The watcher's options. */
export interface StateWatchOptions {
  readonly targets: readonly WatchTarget[];
  /** Called once per burst with the base names that changed (empty after a re-armed watch). */
  readonly onChange: (names: ReadonlySet<string>) => void;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
  readonly retryMs?: number;
  readonly watch?: WatchFn;
  readonly timers?: Timers;
  /** Told when the number of folders being watched changes. */
  readonly onWatching?: (watched: number, of: number) => void;
}

/** A running watcher. */
export interface StateWatch {
  /** Folders being watched now. */
  readonly watching: number;
  stop(): void;
}

/**
 * Watch the targets' folders. Targets on one folder share a watch. The watches open synchronously
 * (so a folder that exists is watched when this returns); a failed one is retried every `retryMs`,
 * and a re-armed watch reports a change at once (anything may have changed while it was down).
 */
export function watchState(opts: StateWatchOptions): StateWatch {
  const timers = opts.timers ?? realTimers;
  const watch = opts.watch ?? denoWatch;
  const retryMs = opts.retryMs ?? WATCH_RETRY_MS;
  const byDir = new Map<string, WatchTarget[]>();
  for (const t of opts.targets) {
    if (!t.dir) continue;
    byDir.set(t.dir, [...(byDir.get(t.dir) ?? []), t]);
  }
  const debounce = createDebouncer(opts.onChange, {
    waitMs: opts.debounceMs ?? WATCH_DEBOUNCE_MS,
    maxWaitMs: opts.maxWaitMs ?? WATCH_MAX_WAIT_MS,
    timers,
  });
  const open = new Map<string, FolderWatch>();
  const retries = new Map<string, number>();
  let stopped = false;
  const report = () => opts.onWatching?.(open.size, byDir.size);

  const retry = (dir: string) => {
    if (stopped || retries.has(dir)) return;
    retries.set(
      dir,
      timers.setTimeout(() => {
        retries.delete(dir);
        if (arm(dir)) debounce.trigger();
      }, retryMs),
    );
  };

  const arm = (dir: string): boolean => {
    if (stopped || open.has(dir)) return false;
    let w: FolderWatch;
    try {
      w = watch(dir);
    } catch {
      retry(dir);
      return false;
    }
    open.set(dir, w);
    report();
    const targets = byDir.get(dir) ?? [];
    void (async () => {
      try {
        for await (const ev of w) {
          const names = targets.flatMap((t) => matchedNames(ev, t));
          if (names.length) debounce.trigger(names);
        }
      } catch {
        // The folder went away, or the watch was closed.
      } finally {
        if (open.get(dir) === w) {
          open.delete(dir);
          report();
          retry(dir);
        }
      }
    })();
    return true;
  };

  for (const dir of byDir.keys()) arm(dir);

  return {
    get watching() {
      return open.size;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      debounce.cancel();
      for (const id of retries.values()) timers.clearTimeout(id);
      retries.clear();
      const all = [...open.values()];
      open.clear();
      for (const w of all) {
        try {
          w.close();
        } catch {
          // Already closed.
        }
      }
      report();
    },
  };
}

/** The runner scheduler integration's files, as `lib/settings.ts` names them. */
export interface SchedulerFiles {
  /** Its health file (absolute; `~/` already expanded), or `null`. */
  readonly healthFile: string | null;
  /** Its `paused-<pool>` folder (absolute), or `null`. */
  readonly pausedDir: string | null;
}

/** Beside the health file: the scheduler's per-pool start states. */
export const POOL_STATE_FILE = "pool-state.json";
/** Beside the health file: what the scheduler last published to the org variable. */
export const HEALTH_PUBLISHED_FILE = "health-published";

/** The folder of a path (`""` for a bare name). */
export function dirName(path: string): string {
  const i = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return i < 0 ? "" : path.slice(0, i);
}

/**
 * What to watch for the scheduler: its health file's folder (the health file, `pool-state.json`,
 * `health-published`) and its paused folder (`paused-<pool>`). None without a health file.
 */
export function schedulerTargets(f: SchedulerFiles): WatchTarget[] {
  if (!f.healthFile) return [];
  const dir = dirName(f.healthFile);
  if (!dir) return [];
  const out: WatchTarget[] = [{
    dir,
    names: [baseName(f.healthFile), POOL_STATE_FILE, HEALTH_PUBLISHED_FILE],
  }];
  if (f.pausedDir) out.push({ dir: f.pausedDir, prefixes: ["paused-"] });
  return out;
}
