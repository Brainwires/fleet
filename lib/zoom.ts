// The window's zoom (View → Zoom In / Zoom Out / Actual Size, Cmd/Ctrl + = - 0): 80% to 200% in
// 10% steps, 100% by default. denext has no page-zoom API for an app's own window (only an embedded
// web view's `setZoom`), so the page scales itself with CSS `zoom` (app/zoom-dom.ts, the "zoom"
// block of public/styles.css). The level is one number the backend keeps in a small preference
// file in the data folder (`fleet-view.json`, lib/deno-host.ts) and pushes to every page on a
// change. No Deno or DOM APIs here: the tests call it with plain objects.

import type { AppMenuItem, AppSubmenu } from "denext/desktop/app";
import type { ShortcutKey } from "./shortcuts.ts";

/** The smallest, largest and default level, and the step (percent). */
export const ZOOM_MIN = 80;
export const ZOOM_MAX = 200;
export const ZOOM_DEFAULT = 100;
export const ZOOM_STEP = 10;

/** The preference file's name in the app's data folder. */
export const ZOOM_FILE = "fleet-view.json";
/** The `fleet` extension's event carrying a new level to every page (`{ zoom }`). */
export const ZOOM_EVENT = "zoom";

/** What a key press or a View menu item asks. */
export type ZoomAction = "in" | "out" | "reset";

/** A level as a whole step between the bounds; anything that isn't a finite number is the default. */
export function clampZoom(pct: unknown): number {
  if (typeof pct !== "number" || !Number.isFinite(pct)) return ZOOM_DEFAULT;
  const stepped = Math.round(pct / ZOOM_STEP) * ZOOM_STEP;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, stepped));
}

/** The level after `action` from `pct`. */
export function stepZoom(pct: number, action: ZoomAction): number {
  if (action === "reset") return ZOOM_DEFAULT;
  return clampZoom(clampZoom(pct) + (action === "in" ? ZOOM_STEP : -ZOOM_STEP));
}

/** The preference file's document. */
export interface ZoomPrefs {
  readonly version: 1;
  readonly zoom: number;
}

/** The level a preference file holds (the default for a missing, unreadable or foreign file). */
export function parseZoomPrefs(raw: unknown): number {
  if (typeof raw !== "object" || raw === null) return ZOOM_DEFAULT;
  const doc = raw as Record<string, unknown>;
  return doc.version === 1 ? clampZoom(doc.zoom) : ZOOM_DEFAULT;
}

/** The preference file's document for `pct`. */
export function zoomPrefs(pct: number): ZoomPrefs {
  return { version: 1, zoom: clampZoom(pct) };
}

/**
 * The zoom action a key press is: Cmd (macOS) or Ctrl (elsewhere) with `+` or `=` (Zoom In, with or
 * without Shift, and the keypad's `+`), `-` (Zoom Out, also the keypad's) or `0` (Actual Size).
 * Alt, or the other platform's modifier, makes it none.
 */
export function zoomShortcut(e: ShortcutKey, mac: boolean): ZoomAction | null {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!mod || e.altKey) return null;
  switch (e.key) {
    case "+":
    case "=":
      return "in";
    case "-":
    case "_":
      return "out";
    case "0":
      return e.shiftKey ? null : "reset";
    default:
      return null;
  }
}

export const MENU_ZOOM_IN = "fleet-zoom-in";
export const MENU_ZOOM_OUT = "fleet-zoom-out";
export const MENU_ZOOM_RESET = "fleet-zoom-reset";

/** A View menu item's action, or `null` for another id. */
export function zoomMenuAction(id: string): ZoomAction | null {
  return id === MENU_ZOOM_IN
    ? "in"
    : id === MENU_ZOOM_OUT
    ? "out"
    : id === MENU_ZOOM_RESET
    ? "reset"
    : null;
}

/**
 * The View submenu at `pct`. Accelerators name physical keys (the runtime's syntax has no "Plus"),
 * so Zoom In's is Cmd/Ctrl+=; the page takes Cmd/Ctrl++ (Shift+=) itself. An item at its bound is
 * disabled, so its key does nothing.
 */
export function zoomMenu(pct: number): AppSubmenu {
  const z = clampZoom(pct);
  const items: AppMenuItem[] = [
    {
      id: MENU_ZOOM_RESET,
      label: "Actual Size",
      accelerator: "CommandOrControl+0",
      disabled: z === ZOOM_DEFAULT,
    },
    {
      id: MENU_ZOOM_IN,
      label: "Zoom In",
      accelerator: "CommandOrControl+=",
      disabled: z >= ZOOM_MAX,
    },
    {
      id: MENU_ZOOM_OUT,
      label: "Zoom Out",
      accelerator: "CommandOrControl+-",
      disabled: z <= ZOOM_MIN,
    },
  ];
  return { label: "View", submenu: items };
}

/** The effective layout width under which the zoomed page takes each narrower layout. */
export const ZOOM_WIDTHS = { mid: 1080, narrow: 1000, tiny: 720 } as const;

/** What the page sets on its root element for a level in a viewport (app/zoom-dom.ts). */
export interface ZoomLayout {
  /** CSS custom properties (`--fleet-zoom`, its inverse, the viewport height in zoomed px). */
  readonly vars: Readonly<Record<string, string>>;
  /** `data-*` attributes on the root: present (`""`) or absent (`null`). */
  readonly attrs: Readonly<Record<string, "" | null>>;
}

/**
 * The root's properties for `pct` in a `width` × `height` viewport (CSS px). The window's media
 * queries see the real width, not the zoomed one, so a zoomed page whose effective width (the width
 * divided by the zoom) falls under a breakpoint is told so by attribute, and the stylesheet's zoom
 * block repeats those breakpoints' rules under it. Viewport units scale differently per engine under
 * CSS `zoom`, so the zoomed page reads its height from `--fleet-vh` (px, which every engine scales).
 */
export function zoomLayout(pct: number, width: number, height: number): ZoomLayout {
  const z = clampZoom(pct);
  const factor = z / 100;
  const zoomed = z > ZOOM_DEFAULT;
  const effective = width / factor;
  const vh = Math.max(0, height) / factor;
  const flag = (on: boolean): "" | null => (zoomed && on ? "" : null);
  return {
    vars: {
      "--fleet-zoom": String(factor),
      "--fleet-zoom-inv": String(Math.round((1 / factor) * 1e6) / 1e6),
      "--fleet-vh": `${Math.round(vh * 100) / 100}px`,
    },
    attrs: {
      "data-fleet-zoomed": z === ZOOM_DEFAULT ? null : "",
      "data-fleet-mid": flag(effective <= ZOOM_WIDTHS.mid),
      "data-fleet-narrow": flag(effective <= ZOOM_WIDTHS.narrow),
      "data-fleet-tiny": flag(effective <= ZOOM_WIDTHS.tiny),
    },
  };
}

/** The page's zoom: the level it shows, from the backend, and its own key presses / menu items. */
export interface ZoomControllerDeps {
  /** Show `pct` (app/zoom-dom.ts). */
  apply(pct: number): void;
  /** Ask the backend to keep `pct` (it answers the level it kept, or rejects off desktop). */
  save(pct: number): Promise<number>;
  now?(): number;
}

/** How long a second press of the same action from the other source counts as the same press. */
export const ZOOM_ECHO_MS = 250;

/**
 * The page side of the zoom: `zoom(action, source)` steps from the level shown, applies it at once
 * and saves it (the backend's answer and its event to every page settle the level); `set(pct)` takes
 * a level from the backend. A key press the page handled and the menu accelerator for the same key
 * (an engine that hands both the page and the menu one press) step once.
 */
export class ZoomController {
  #deps: ZoomControllerDeps;
  #level = ZOOM_DEFAULT;
  #listeners = new Set<(pct: number) => void>();
  #last: { action: ZoomAction; source: "page" | "menu"; at: number } | null = null;
  /** This page's saves still unanswered, and the newest one's number. */
  #inFlight = 0;
  #seq = 0;

  constructor(deps: ZoomControllerDeps) {
    this.#deps = deps;
  }

  get level(): number {
    return this.#level;
  }

  /** Hear each level change; returns the unsubscribe. */
  subscribe(fn: (pct: number) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  /**
   * A level from the backend (the saved one, another window's change). Ignored while this page's
   * own saves are unanswered: their events would step a quick run of presses back and forth.
   */
  set(pct: unknown): void {
    if (this.#inFlight === 0) this.#show(pct);
  }

  #show(pct: unknown): void {
    const z = clampZoom(pct);
    if (z === this.#level) return;
    this.#level = z;
    this.#deps.apply(z);
    for (const fn of [...this.#listeners]) fn(z);
  }

  /** A key press or a View menu item: step, show it, keep it. */
  zoom(action: ZoomAction, source: "page" | "menu"): void {
    const now = this.#deps.now?.() ?? Date.now();
    const last = this.#last;
    this.#last = { action, source, at: now };
    if (last && last.action === action && last.source !== source && now - last.at < ZOOM_ECHO_MS) {
      return;
    }
    const next = stepZoom(this.#level, action);
    this.#show(next);
    const seq = ++this.#seq;
    this.#inFlight++;
    let saved: Promise<number>;
    try {
      saved = this.#deps.save(next);
    } catch (err) {
      saved = Promise.reject(err);
    }
    void saved.then((kept) => {
      this.#inFlight--;
      // The newest save's answer is the level (the backend clamps it); older ones are passed.
      if (seq === this.#seq) this.#show(kept);
    }, () => {
      // Off desktop (`denext task dev`): the level holds for this page only.
      this.#inFlight--;
    });
  }
}

/** The backend's zoom: the level from the preference file, every change saved and pushed. */
export interface ZoomStore {
  /** The level (the default until the file is read). */
  level(): number;
  /** Resolves once the file is read. */
  ready(): Promise<void>;
  /** Keep `pct` (clamped): saved, pushed to every page when it changed; resolves to the level kept. */
  set(pct: unknown): Promise<number>;
}

/** What the zoom store reads, writes and tells. */
export interface ZoomStoreDeps {
  load(): Promise<number>;
  save(pct: number): Promise<void>;
  /** A new level, for every page (the extension's event). */
  onChange(pct: number): void;
}

/**
 * The backend's zoom. Writes go one at a time, each writing the level current when it starts, so a
 * quick run of changes ends with the newest on disk; a failed write is logged and the level kept.
 */
export function createZoomStore(deps: ZoomStoreDeps): ZoomStore {
  let level = ZOOM_DEFAULT;
  const loaded = deps.load().then((pct) => void (level = clampZoom(pct)), () => {});
  let writes: Promise<void> = Promise.resolve();
  return {
    level: () => level,
    ready: () => loaded,
    async set(pct) {
      const next = clampZoom(pct);
      await loaded;
      if (next === level) return level;
      level = next;
      deps.onChange(level);
      writes = writes.then(() => deps.save(level)).catch((err) => {
        console.error("fleet: zoom:", err instanceof Error ? err.name : "error");
      });
      await writes;
      return level;
    },
  };
}
