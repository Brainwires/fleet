// Which quits quit Fleet. Fleet is a tray app: a quit it didn't ask for — the Dock's Quit, Cmd+Q
// through the host's app menu, `osascript -e 'quit app "Fleet"'` — closes Fleet's window and leaves
// it in the tray (accessory, no Dock icon) instead of ending the process. Only Fleet's own quits go
// through: the tray's "Quit Fleet", and closing the window when there is no tray to come back to.
// The OS's session end (logout, restart, shut down) always goes through.
//
// It is a `DesktopRuntime.onBeforeQuit` guard (denext asks it before any page, for every quit, the
// session end included: a `false` there would ask the OS to stop the logout). The guard itself is
// given no reason, so desktop.ts also listens to the runtime's `beforequit` (added before
// runDesktop, so it runs first) and hands each event's `reason` to `noteQuitEvent`; the guard reads
// it after a microtask, so it is there even if that listener ran second in the same dispatch.
// `DesktopRuntime.quit()` already skips desktop.ts's own guards; the intended-quit flag also covers
// a runtime without it (`Deno.desktop.quit()`).
//
// No Deno or DOM APIs: the tests drive it with fakes.

/** What the guard needs from the app. */
export interface QuitGuardDeps {
  /** Close Fleet's window (the app drops back to accessory once it closed). */
  closeWindows(): void;
  /** Whether a tray is there to come back to (without one, every quit goes through). */
  hasTray(): boolean;
  /**
   * Run `fn` on a later task (`setTimeout(fn, 0)`): a window closed in the same task as the
   * `beforequit` would count as closed by the quit.
   */
  later(fn: () => void): void;
}

/** What one quit request turned into. */
export type QuitDecision = "quit" | "close-to-tray";

/** The quit guard. */
export interface QuitGuard {
  /** A `beforequit` event's `reason` (`"session-end"` for logout / restart / shut down). */
  noteQuitEvent(reason: unknown): void;
  /** Fleet itself is quitting now (the tray's Quit): the next quit goes through. */
  beginIntendedQuit(): void;
  /** Fleet's own quit didn't happen (refused or held elsewhere): back to guarding. */
  endIntendedQuit(): void;
  /** The `onBeforeQuit` guard: `true` lets the quit go on. */
  guard(): Promise<boolean>;
  /** What the guard decided last (`null` before any quit). */
  readonly last: QuitDecision | null;
}

/** Create the quit guard. */
export function createQuitGuard(deps: QuitGuardDeps): QuitGuard {
  let intended = false;
  let reason: unknown = undefined;
  let last: QuitDecision | null = null;
  const decide = (): QuitDecision => {
    if (intended || reason === "session-end" || !deps.hasTray()) return "quit";
    return "close-to-tray";
  };
  return {
    noteQuitEvent(r) {
      reason = r;
    },
    beginIntendedQuit() {
      intended = true;
    },
    endIntendedQuit() {
      intended = false;
    },
    async guard() {
      // The `beforequit` listener may run after denext's in the same dispatch: its reason first.
      await Promise.resolve();
      const d = decide();
      reason = undefined;
      last = d;
      if (d === "quit") return true;
      deps.later(() => deps.closeWindows());
      return false;
    },
    get last() {
      return last;
    },
  };
}
