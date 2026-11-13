// The in-app GitHub browser: one native web view (app/web-panel/engine.ts) shown in a panel over
// Fleet's main view, reused for every GitHub link, its session kept in a persistent partition. No
// DOM or JSX here (the panel, app/web-panel/github-panel.tsx, renders it), so the tests drive it with
// a fake handle.
//
// Visibility: while the panel shows, `attachWebView` glues the view to the panel's placeholder (and
// owns its visibility). Leaving the panel (Home, Esc) or covering it (the Settings view, the wizard,
// the token screen) stops following and hides the view, which stays open for a quick reopen, on the
// page it was on. `dispose` closes it.

import {
  nativeWebViews,
  type WebViewAnchor,
  type WebViewApi,
  type WebViewHandle,
} from "./engine.ts";

/** Only these URLs open at all (Fleet's links are GitHub's). */
export const GITHUB_PREFIX = "https://github.com/";
/** The storage partition: persistent (not "ephemeral…"), so the GitHub sign-in survives launches. */
export const GITHUB_PARTITION = "fleet-github";
/** The same command from the page and the app menu this close together is one key press. */
const DUPLICATE_MS = 300;

/** Whether Fleet may open `url` (its GitHub allowlist). */
export function isGitHubUrl(url: string): boolean {
  return url.startsWith(GITHUB_PREFIX);
}

/** What the panel shows. */
export interface BrowserState {
  /** The panel is showing (or would be, once nothing covers it). */
  readonly open: boolean;
  readonly url: string;
  readonly title: string;
  readonly loading: boolean;
  /** The last failed load's message, until the next load starts. */
  readonly error: string | null;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  /** The native view has the keyboard (Fleet's page gets no keys then). */
  readonly viewFocused: boolean;
}

/** A toolbar / keyboard / menu command. */
export type BrowserCommand = "back" | "forward" | "reload" | "home" | "external";

/** Where a link went. */
export type OpenOutcome = "panel" | "browser" | "refused";

export interface GitHubBrowserDeps {
  /** The system browser (denext/mobile `openExternal`). */
  openExternal(url: string): Promise<unknown>;
  /** The web view API, or `null` without one (default: feature-detected). */
  webViews?: () => Promise<WebViewApi | null>;
  /** The view lost the keyboard: the page should take it back (focus its own element). */
  onViewBlur?: () => void;
  now?: () => number;
}

const CLOSED_STATE: BrowserState = {
  open: false,
  url: "",
  title: "",
  loading: false,
  error: null,
  canGoBack: false,
  canGoForward: false,
  viewFocused: false,
};

export class GitHubBrowser {
  #deps: GitHubBrowserDeps;
  #state: BrowserState = CLOSED_STATE;
  #listeners = new Set<(s: BrowserState) => void>();
  #api: Promise<WebViewApi | null> | null = null;
  #view: WebViewHandle | null = null;
  #creating: Promise<WebViewHandle | null> | null = null;
  #anchor: WebViewAnchor | null = null;
  #detach: (() => void) | null = null;
  #covered = false;
  #last: { cmd: BrowserCommand; source: "page" | "menu"; at: number } | null = null;

  constructor(deps: GitHubBrowserDeps) {
    this.#deps = deps;
  }

  get state(): BrowserState {
    return this.#state;
  }

  /** The panel is on screen: open, and no other screen of Fleet's covers it. */
  get showing(): boolean {
    return this.#state.open && !this.#covered;
  }

  /** Hear every state change; returns the unsubscribe. */
  subscribe(fn: (s: BrowserState) => void): () => void {
    this.#listeners.add(fn);
    return () => void this.#listeners.delete(fn);
  }

  #set(patch: Partial<BrowserState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const fn of [...this.#listeners]) fn(this.#state);
  }

  #webViews(): Promise<WebViewApi | null> {
    this.#api ??= (this.#deps.webViews ?? (() => nativeWebViews()))().catch(() => null);
    return this.#api;
  }

  #external(url: string): void {
    void this.#deps.openExternal(url).catch((err) =>
      console.error("fleet: open:", err instanceof Error ? err.message : String(err))
    );
  }

  /**
   * Open a GitHub link: in the panel when this window hosts web views (navigating the one view when
   * it is already open), else in the system browser. Anything off GitHub is refused.
   */
  async open(url: string): Promise<OpenOutcome> {
    if (!isGitHubUrl(url)) return "refused";
    const api = await this.#webViews();
    if (!api) {
      this.#external(url);
      return "browser";
    }
    const existing = this.#view;
    if (existing) {
      this.#set({ open: true, url, error: null });
      this.#show();
      void existing.navigate(url).catch((err) => this.#failed(err));
      return "panel";
    }
    const view = await this.#create(api, url);
    if (!view) {
      this.#external(url);
      return "browser";
    }
    this.#set({ open: true, url, error: null, loading: true });
    this.#show();
    return "panel";
  }

  /** The view, created once (a second open while it is being created waits for the same one). */
  #create(api: WebViewApi, url: string): Promise<WebViewHandle | null> {
    this.#creating ??= api.createWebView({
      url,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      // Shown by `attachWebView` once it has measured the placeholder.
      visible: false,
      partition: GITHUB_PARTITION,
      allowPopups: "same-view",
      downloads: "browser",
      permissions: "deny",
    }).then((view) => {
      this.#view = view;
      this.#listen(view);
      return view;
    }, (err) => {
      // `unsupported` (or anything else): this engine has no views after all; the system browser
      // takes GitHub links from now on.
      console.error("fleet: web view:", err instanceof Error ? err.message : String(err));
      this.#api = Promise.resolve(null);
      return null;
    }).finally(() => {
      this.#creating = null;
    });
    return this.#creating;
  }

  #listen(view: WebViewHandle): void {
    view.on("title", ({ title }) => this.#set({ title }));
    view.on(
      "url",
      ({ url, canGoBack, canGoForward }) => this.#set({ url, canGoBack, canGoForward }),
    );
    view.on("load", ({ state, error }) => {
      if (state === "loading") this.#set({ loading: true, error: null });
      else if (state === "failed") {
        this.#set({ loading: false, error: error?.message || "The page did not load." });
      } else if (state === "complete") this.#set({ loading: false });
    });
    view.on("focus-change", ({ focused }) => {
      this.#set({ viewFocused: focused });
      if (!focused) this.#deps.onViewBlur?.();
    });
    view.on("closed", () => {
      if (this.#view !== view) return;
      this.#view = null;
      this.#detach = null;
      this.#set(CLOSED_STATE);
    });
  }

  #failed(err: unknown): void {
    this.#set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }

  /** Follow the placeholder while the panel shows and nothing covers it. */
  #show(): void {
    const view = this.#view;
    if (!view || !this.#anchor || !this.#state.open || this.#covered || this.#detach) return;
    // The API is known here: the view came from it.
    void this.#webViews().then((api) => {
      if (!api || this.#view !== view || this.#detach || !this.#anchor) return;
      if (!this.#state.open || this.#covered) return;
      this.#detach = api.attachWebView(view, this.#anchor);
    });
  }

  /** Stop following and hide the view (it stays open). */
  #hide(): void {
    this.#detach?.();
    this.#detach = null;
    void this.#view?.setVisible(false).catch(() => {});
  }

  /** The panel's placeholder mounted (the view follows it) or unmounted (`null`: hidden). */
  setAnchor(anchor: WebViewAnchor | null): void {
    if (anchor === this.#anchor) return;
    this.#hide();
    this.#anchor = anchor;
    this.#show();
  }

  /** An HTML screen of Fleet's covers the panel: the native view (drawn above HTML) hides. */
  setCovered(covered: boolean): void {
    if (covered === this.#covered) return;
    this.#covered = covered;
    if (covered) this.#hide();
    else this.#show();
  }

  /**
   * Run a command. The page's keydown and the app menu's accelerator can both see one key press;
   * the second within a moment of the first, from the other source, is dropped.
   */
  command(cmd: BrowserCommand, source: "page" | "menu" = "page"): void {
    const at = (this.#deps.now ?? Date.now)();
    const last = this.#last;
    if (last && last.cmd === cmd && last.source !== source && at - last.at < DUPLICATE_MS) return;
    this.#last = { cmd, source, at };
    const view = this.#view;
    if (cmd === "home") return this.home();
    if (cmd === "external") {
      const url = this.#state.url;
      if (url.startsWith("https://") || url.startsWith("http://")) this.#external(url);
      return;
    }
    if (!view || !this.#state.open) return;
    const call = cmd === "back" ? view.back() : cmd === "forward" ? view.forward() : view.reload();
    void call.catch((err) => this.#failed(err));
  }

  /** Back to Fleet's own view: the panel closes and the view hides, kept for the next link. */
  home(): void {
    if (!this.#state.open) return;
    this.#hide();
    this.#set({ open: false, viewFocused: false });
  }

  /** Close the view for good (Fleet's page unmounting). */
  dispose(): void {
    this.#detach?.();
    this.#detach = null;
    const view = this.#view;
    this.#view = null;
    this.#set(CLOSED_STATE);
    void view?.close().catch(() => {});
  }
}
