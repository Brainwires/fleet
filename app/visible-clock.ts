// The page's 1 s clock for the ticking times, running only while the window shows: a hidden (or
// closed-to-tray) window neither wakes every second nor re-renders. The timers and the visibility
// test are injected, so the tests drive it without a DOM.

/** What the clock needs. */
export interface ClockDeps {
  readonly visible: () => boolean;
  readonly now?: () => number;
  readonly setInterval?: (fn: () => void, ms: number) => number;
  readonly clearInterval?: (id: number) => void;
}

/** The clock: call `update()` on every visibility change, `stop()` on unmount. */
export interface VisibleClock {
  /** Start or stop ticking for the current visibility (a start ticks once at once). */
  update(): void;
  stop(): void;
  /** Whether it is ticking (tests). */
  readonly running: boolean;
}

/** A clock that calls `onTick(now)` every second while `deps.visible()`. */
export function visibleClock(onTick: (now: number) => void, deps: ClockDeps): VisibleClock {
  const now = deps.now ?? Date.now;
  const setI = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms) as unknown as number);
  const clearI = deps.clearInterval ?? ((id) => clearInterval(id));
  let id: number | null = null;
  const set = (on: boolean) => {
    if (on && id === null) {
      onTick(now());
      id = setI(() => onTick(now()), 1000);
    } else if (!on && id !== null) {
      clearI(id);
      id = null;
    }
  };
  set(deps.visible());
  return {
    update: () => set(deps.visible()),
    stop: () => set(false),
    get running() {
      return id !== null;
    },
  };
}
