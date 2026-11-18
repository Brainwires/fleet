// The in-app GitHub browser: one native web view (app/web-panel/engine.ts) shown in a panel over
// Fleet's main view, reused for every GitHub link, its session kept in a persistent partition. No
// DOM or JSX here (the panel, app/web-panel/github-panel.tsx, renders it), so the tests drive it with
// a fake handle.
//
// Visibility: while the panel shows, `attachWebView` glues the view to the panel's placeholder (and
// owns its visibility). Leaving the panel (Home, Esc) or covering it (the Settings view, the wizard,
// the token screen) stops following and hides the view, which stays open for a quick reopen, on the
// page it was on. `dispose` closes it.
//
// Never blank: the view shows only once the page a link asked for has loaded (reveal-gate.ts). A new
// view requests its page at creation, hidden; a reused one is hidden, then navigated. Until the
// load, the panel shows its own loading state (`waiting`) under the hidden view.
//
// Back to Fleet: each link opens with its origin (the Fleet screen it was clicked on). Back from the
// link's own page (panel-history.ts), like Esc and the Fleet button, closes the panel and hands the
// origin to `onReturn`, which restores that screen.
//
// Reopen where you left it: the same link again (after a return to Fleet) shows the view at once on
// the page and history the user left, with the new click's screen as Back's target. Whether that
// page reloads in place as it reappears follows the link's run / job status (reopen-policy.ts);
// a reload keeps the URL (a `#step:N:L` hash too) and the history, and shows the loading bar only
// if it takes longer than QUIET_RELOAD_MS. Another link always starts fresh.
//
// Staying on GitHub: denext's `desktop.webViews.allowedOrigins` (denext.config.ts) limits what Fleet
// itself loads (`createWebView`, `navigate`) to github.com, but not the links the user follows in the
// view. A main-frame load off GitHub's site (github.com and its subdomains, over https: a README's
// link, a redirect) is stopped and handed to the system browser; if it had already committed, the
// view goes back to the last GitHub page.

import {
  nativeWebViews,
  type WebViewAnchor,
  type WebViewApi,
  type WebViewEventMap,
  type WebViewHandle,
} from "./engine.ts";
import { PanelHistory } from "./panel-history.ts";
import { RevealGate } from "./reveal-gate.ts";
import { type LinkStatus, reloadOnReopen } from "./reopen-policy.ts";

/** Only these URLs open at all (Fleet's links are GitHub's). */
const GITHUB_PREFIX = "https://github.com/";
/** The storage partition: persistent (not "ephemeral…"), so the GitHub sign-in survives launches. */
export const GITHUB_PARTITION = "fleet-github";
/** The same command from the page and the app menu this close together is one key press. */
const DUPLICATE_MS = 300;
/** The longest a link's page may take to load before the view shows anyway. */
const REVEAL_FALLBACK_MS = 10_000;
/** A quiet reload shows the loading bar only after this long. */
const QUIET_RELOAD_MS = 300;

/** The site the view stays on: github.com (sign-in, 2FA and passkeys too) and its subdomains. */
const GITHUB_HOST = "github.com";

/** Whether Fleet may open `url` (its GitHub allowlist). */
export function isGitHubUrl(url: string): boolean {
  return url.startsWith(GITHUB_PREFIX);
}

/**
 * Whether the view may stay on `url`: GitHub's site over https (github.com, docs.github.com,
 * gist.github.com), or anything not a web page (about:blank).
 */
function staysInView(url: string): boolean {
  if (!url.startsWith("https://") && !url.startsWith("http://")) return true;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.port !== "" || u.username !== "") return false;
    return u.hostname === GITHUB_HOST || u.hostname.endsWith(`.${GITHUB_HOST}`);
  } catch {
    return true;
  }
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
  /** The view is hidden until the link's page loads (the panel shows its loading state). */
  readonly waiting: boolean;
  /** The panel has a Fleet screen to return to (Back from the link's own page goes there). */
  readonly canReturn: boolean;
}

/** A toolbar / keyboard / menu command. */
export type BrowserCommand = "back" | "forward" | "reload" | "home" | "external";

/** What the panel and the app menu drive (any origin type). */
export type BrowserControls = Pick<GitHubBrowser, "command" | "setAnchor" | "subscribe">;

/** Where a link went. */
export type OpenOutcome = "panel" | "browser" | "refused";

export interface GitHubBrowserDeps<O = unknown> {
  /** The system browser (denext/mobile `openExternal`). */
  openExternal(url: string): Promise<unknown>;
  /** The web view API, or `null` without one (default: feature-detected). */
  webViews?: () => Promise<WebViewApi | null>;
  /** The view lost the keyboard: the page should take it back (focus its own element). */
  onViewBlur?: () => void;
  /** The panel closed back to Fleet: restore the screen the link was opened from. */
  onReturn?: (origin: O) => void;
  /** At most this long hidden waiting for a page before the view shows anyway (0: no limit). */
  revealFallbackMs?: number;
  /** A link's run / job status from Fleet's snapshot (default: unknown). */
  linkStatus?: (url: string) => LinkStatus;
  /** How long a stale page's reload stays quiet before the loading bar shows. */
  quietReloadMs?: number;
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
  waiting: false,
  canReturn: false,
};

export class GitHubBrowser<O = unknown> {
  #deps: GitHubBrowserDeps<O>;
  #state: BrowserState = CLOSED_STATE;
  #listeners = new Set<(s: BrowserState) => void>();
  #api: Promise<WebViewApi | null> | null = null;
  #view: WebViewHandle | null = null;
  #creating: Promise<WebViewHandle | null> | null = null;
  #anchor: WebViewAnchor | null = null;
  #detach: (() => void) | null = null;
  #covered = false;
  #last: { cmd: BrowserCommand; source: "page" | "menu"; at: number } | null = null;
  /** The last github.com page the view committed (where a committed off-GitHub load returns). */
  #lastGitHub = "";
  /** The off-GitHub URL last handed to the system browser (its load and URL events are one hand-off). */
  #handedOff = "";
  /** The view committed an off-GitHub page and is on its way back (its title is not shown). */
  #offPage = false;
  /** The Fleet screen the open link came from. */
  #origin: { value: O } | null = null;
  #history = new PanelHistory();
  #gate: RevealGate;
  /** The link the current (or last) panel session opened. */
  #link = "";
  /** When the panel last went back to Fleet, and its link's status then. */
  #hiddenAt = 0;
  #statusAtHide: LinkStatus = null;
  /** A stale page's reload, quiet until its timer shows the loading bar. */
  #quiet: ReturnType<typeof setTimeout> | undefined;
  /** The window zoom (a factor, lib/zoom.ts) the GitHub page shows too. */
  #zoom = 1;

  constructor(deps: GitHubBrowserDeps<O>) {
    this.#deps = deps;
    this.#gate = new RevealGate({
      fallbackMs: deps.revealFallbackMs ?? REVEAL_FALLBACK_MS,
      onReveal: () => {
        this.#set({ waiting: false });
        this.#show();
      },
    });
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
  async open(url: string, ...origin: [O] | []): Promise<OpenOutcome> {
    if (!isGitHubUrl(url)) return "refused";
    const api = await this.#webViews();
    if (!api) {
      this.#external(url);
      return "browser";
    }
    const existing = this.#view;
    if (existing && url === this.#link && this.#gate.open && !this.#state.open) {
      this.#resume(existing, origin);
      return "panel";
    }
    if (existing) {
      // Hidden first, so neither the page it was on nor a blank one shows; shown on the new load.
      this.#hide();
      this.#gate.close(false);
      this.#begin(url, origin);
      void existing.navigate(url).catch((err) => this.#failed(err));
      return "panel";
    }
    const view = await this.#create(api, url);
    if (!view) {
      this.#external(url);
      return "browser";
    }
    this.#begin(url, origin);
    return "panel";
  }

  /** The same link again: the view as the user left it, shown at once (reloaded if stale). */
  #resume(view: WebViewHandle, origin: [O] | []): void {
    this.#origin = origin.length > 0 ? { value: origin[0] as O } : null;
    const stale = reloadOnReopen(
      this.#statusAtHide,
      this.#status(this.#link),
      this.#now() - this.#hiddenAt,
    );
    this.#set({ open: true, error: null, waiting: false, canReturn: this.#origin !== null });
    this.#show();
    if (!stale) return;
    this.#endQuiet();
    this.#quiet = setTimeout(() => {
      this.#quiet = undefined;
      this.#set({ loading: true });
    }, this.#deps.quietReloadMs ?? QUIET_RELOAD_MS);
    this.#history.expect("reload");
    void view.reload().catch((err) => this.#failed(err));
  }

  /** The quiet reload finished (or the panel moved on): no loading bar for it any more. */
  #endQuiet(): void {
    if (this.#quiet !== undefined) clearTimeout(this.#quiet);
    this.#quiet = undefined;
  }

  #status(url: string): LinkStatus {
    return this.#deps.linkStatus?.(url) ?? null;
  }

  #now(): number {
    return (this.#deps.now ?? Date.now)();
  }

  /** A link's panel session starts: its origin, its history, the toolbar waiting for its page. */
  #begin(url: string, origin: [O] | []): void {
    this.#endQuiet();
    this.#link = url;
    this.#origin = origin.length > 0 ? { value: origin[0] as O } : null;
    this.#history.reset();
    this.#set({
      open: true,
      url,
      title: "",
      error: null,
      loading: true,
      waiting: this.#gate.waiting,
      canReturn: this.#origin !== null,
    });
    this.#show();
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
      if (this.#zoom !== 1) this.#applyZoom(view);
      // The page was requested at creation (hidden); its "loading" may come before this listener.
      this.#gate.close(true);
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
    view.on("title", ({ title }) => {
      if (!this.#offPage) this.#set({ title });
    });
    view.on("url", ({ url, canGoBack, canGoForward }) => {
      if (!staysInView(url)) return this.#leaveGitHub(view, url, true, canGoBack);
      this.#history.committed();
      this.#lastGitHub = url;
      this.#handedOff = "";
      this.#offPage = false;
      this.#set({ url, canGoBack, canGoForward });
    });
    view.on("load", (e) => this.#onLoad(view, e));
    view.on("focus-change", ({ focused }) => {
      this.#set({ viewFocused: focused });
      if (!focused) this.#deps.onViewBlur?.();
    });
    view.on("closed", () => {
      if (this.#view !== view) return;
      this.#view = null;
      this.#detach = null;
      this.#gate.cancel();
      this.#endQuiet();
      this.#link = "";
      this.#set(CLOSED_STATE);
    });
  }

  /** A main-frame load event: the reveal gate, the loading bar (quiet for a reopen's reload). */
  #onLoad(view: WebViewHandle, { state, url, error }: WebViewEventMap["load"]): void {
    if (state !== "loading") return this.#loadEnded(state, error?.message);
    if (url && !staysInView(url)) return this.#leaveGitHub(view, url, false, false);
    this.#gate.load(state);
    if (this.#quiet === undefined) this.#set({ loading: true, error: null });
  }

  /** A load reached `state` (the page painted, finished or failed). */
  #loadEnded(state: "interactive" | "complete" | "failed", error: string | undefined): void {
    this.#gate.load(state);
    this.#endQuiet();
    if (state === "failed") {
      this.#set({ loading: false, waiting: false, error: error || "The page did not load." });
    } else if (state === "complete") this.#set({ loading: false });
  }

  /**
   * A main-frame load off github.com: the system browser takes it (once per URL), the view stops
   * it, and when it had committed (`committed`) the view returns to the last GitHub page.
   */
  #leaveGitHub(view: WebViewHandle, url: string, committed: boolean, canGoBack: boolean): void {
    if (this.#handedOff !== url) {
      this.#handedOff = url;
      this.#external(url);
    }
    void view.stop().catch(() => {});
    if (!committed) return;
    this.#offPage = true;
    this.#set({ loading: false });
    this.#history.expect("bounce");
    const back = canGoBack
      ? view.back()
      : this.#lastGitHub
      ? view.navigate(this.#lastGitHub)
      : Promise.resolve(this.home());
    void back.catch((err) => this.#failed(err));
  }

  #failed(err: unknown): void {
    this.#set({ loading: false, error: err instanceof Error ? err.message : String(err) });
  }

  /** Follow the placeholder while the panel shows and nothing covers it. */
  #show(): void {
    const view = this.#view;
    if (!view || !this.#anchor || !this.#state.open || this.#covered || this.#detach) return;
    // Never before the link's page has loaded: no blank view, no previous page.
    if (!this.#gate.open) return;
    // The API is known here: the view came from it.
    void this.#webViews().then((api) => {
      if (!api || this.#view !== view || this.#detach || !this.#anchor) return;
      if (!this.#state.open || this.#covered || !this.#gate.open) return;
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
    if (this.#echo(cmd, source)) return;
    if (cmd === "home") return this.home();
    if (cmd === "external") return this.#openCurrentExternally();
    const view = this.#view;
    if (!view || !this.#state.open) return;
    if (cmd === "back") return this.#back(view);
    if (cmd === "reload") return this.#reload(view);
    this.#history.expect("forward");
    void view.forward().catch((err) => this.#failed(err));
  }

  /** Reload; after a failed first load, the view waits for the reloaded page before showing. */
  #reload(view: WebViewHandle): void {
    if (!this.#gate.open) {
      this.#gate.close(false);
      this.#set({ waiting: true });
    }
    this.#history.expect("reload");
    void view.reload().catch((err) => this.#failed(err));
  }

  /** Back: within GitHub, or from the link's own page (or with no history) back to Fleet. */
  #back(view: WebViewHandle): void {
    const { canGoBack, canReturn } = this.#state;
    if ((this.#history.atStart || !canGoBack) && canReturn) return this.home();
    if (!canGoBack) return;
    this.#history.expect("back");
    void view.back().catch((err) => this.#failed(err));
  }

  /** Whether `cmd` repeats the other source's same command of a moment ago (records this one). */
  #echo(cmd: BrowserCommand, source: "page" | "menu"): boolean {
    const at = this.#now();
    const last = this.#last;
    if (last && last.cmd === cmd && last.source !== source && at - last.at < DUPLICATE_MS) {
      return true;
    }
    this.#last = { cmd, source, at };
    return false;
  }

  /** The panel's current page in the system browser. */
  #openCurrentExternally(): void {
    const url = this.#state.url;
    if (url.startsWith("https://") || url.startsWith("http://")) this.#external(url);
  }

  /** Back to Fleet's own view: the panel closes and the view hides, kept for the next link. */
  home(): void {
    if (!this.#state.open) return;
    this.#hide();
    // A load still pending keeps going hidden; the next link closes the gate again.
    const origin = this.#origin;
    this.#origin = null;
    this.#hiddenAt = this.#now();
    this.#statusAtHide = this.#status(this.#link);
    this.#endQuiet();
    this.#set({ open: false, viewFocused: false, waiting: false, canReturn: false });
    if (origin) this.#deps.onReturn?.(origin.value);
  }

  /**
   * The window zoom (a factor: 1.5 for 150%), for the GitHub page as well: the view's own page zoom
   * where its engine has one (`setZoom`, `webViewCapabilities().zoom`); elsewhere it stays at 100%.
   */
  setZoom(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0 || factor === this.#zoom) return;
    this.#zoom = factor;
    if (this.#view) this.#applyZoom(this.#view);
  }

  #applyZoom(view: WebViewHandle): void {
    const set = (view as { setZoom?: (factor: number) => Promise<void> }).setZoom;
    if (typeof set !== "function") return;
    void set.call(view, this.#zoom).catch(() => {
      // An engine without page zoom for its views: GitHub's page stays at 100%.
    });
  }

  /** Close the view for good (Fleet's page unmounting). */
  dispose(): void {
    this.#detach?.();
    this.#detach = null;
    const view = this.#view;
    this.#view = null;
    this.#gate.cancel();
    this.#endQuiet();
    this.#link = "";
    this.#set(CLOSED_STATE);
    void view?.close().catch(() => {});
  }
}
