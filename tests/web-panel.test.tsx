// The in-app GitHub browser (app/web-panel/): GitHub links open in the panel where the window hosts
// web views and in the system browser otherwise (the API missing on this denext, an engine without
// views, `createWebView` refusing); one view reused; the toolbar against a fake web view; the
// keyboard (page keys, app-menu accelerators, no double steps); the view hidden while another
// screen covers the panel. No desktop runtime, no network.

import "./fixture-settings.ts";

import { assert, assertEquals, assertFalse } from "@std/assert";
import { render, type TestElement } from "denext/testing";
import { useEffect, useState } from "denext";
import * as desktopWindow from "denext/desktop/window";
import type { AppMenuItem } from "denext/desktop/app";
import {
  type CreateWebViewOptions,
  nativeWebViews,
  type WebViewAnchor,
  type WebViewApi,
  webViewApiOf,
  type WebViewEventMap,
  type WebViewHandle,
} from "../app/web-panel/engine.ts";
import {
  GITHUB_PARTITION,
  GitHubBrowser,
  type GitHubBrowserDeps,
} from "../app/web-panel/github-browser.ts";
import { GitHubPanel } from "../app/web-panel/github-panel.tsx";
import {
  browserMenu,
  connectBrowserMenu,
  MENU_BACK,
  MENU_FORWARD,
} from "../app/web-panel/browser-menu.ts";
import { browserShortcut, type ShortcutKey } from "../lib/shortcuts.ts";
import config from "../denext.config.ts";
import { panelCovered } from "../app/fleet-app.tsx";
import { captureScroll, type PanelOrigin, restoreOrigin } from "../app/web-panel/origin.ts";
import {
  type LinkStatus,
  reloadOnReopen,
  UNKNOWN_STALE_MS,
} from "../app/web-panel/reopen-policy.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** A web view that records its calls and fires events on demand. */
class FakeView implements WebViewHandle {
  readonly id = "1";
  calls: string[] = [];
  listeners = new Map<string, Set<(e: unknown) => void>>();
  setBounds() {
    this.calls.push("setBounds");
    return Promise.resolve();
  }
  setVisible(v: boolean) {
    this.calls.push(`setVisible:${v}`);
    return Promise.resolve();
  }
  navigate(url: string) {
    this.calls.push(`navigate:${url}`);
    return Promise.resolve();
  }
  back() {
    this.calls.push("back");
    return Promise.resolve();
  }
  forward() {
    this.calls.push("forward");
    return Promise.resolve();
  }
  reload() {
    this.calls.push("reload");
    return Promise.resolve();
  }
  stop() {
    this.calls.push("stop");
    return Promise.resolve();
  }
  focus() {
    this.calls.push("focus");
    return Promise.resolve();
  }
  close() {
    this.calls.push("close");
    return Promise.resolve();
  }
  on<K extends keyof WebViewEventMap>(event: K, fn: (e: WebViewEventMap[K]) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn as (e: unknown) => void);
    this.listeners.set(event, set);
    return () => void set.delete(fn as (e: unknown) => void);
  }
  emit<K extends keyof WebViewEventMap>(event: K, detail: WebViewEventMap[K]) {
    for (const fn of this.listeners.get(event) ?? []) fn(detail);
  }
}

/** A web view API over one FakeView, recording creates and attachments. */
function fakeApi(opts: { supported?: boolean; reject?: unknown } = {}) {
  const view = new FakeView();
  const created: CreateWebViewOptions[] = [];
  const attached: WebViewAnchor[] = [];
  let detached = 0;
  const api: WebViewApi = {
    webViewCapabilities: () => Promise.resolve({ supported: opts.supported !== false }),
    createWebView: (o) => {
      created.push(o);
      return opts.reject ? Promise.reject(opts.reject) : Promise.resolve(view);
    },
    attachWebView: (_h, el) => {
      attached.push(el);
      return () => void detached++;
    },
  };
  return { api, view, created, attached, detached: () => detached };
}

function browserWith<O = unknown>(
  api: WebViewApi | null,
  extra: Partial<GitHubBrowserDeps<O>> = {},
) {
  const external: string[] = [];
  let blurs = 0;
  const browser = new GitHubBrowser<O>({
    openExternal: (u) => {
      external.push(u);
      return Promise.resolve();
    },
    webViews: () => nativeWebViews(api ?? {}),
    onViewBlur: () => void blurs++,
    // No fallback timer in the tests (each says when the page loads).
    revealFallbackMs: 0,
    ...extra,
  });
  return { browser, external, blurs: () => blurs };
}

const ANCHOR: WebViewAnchor = {
  getBoundingClientRect: () => ({ left: 0, top: 48, width: 800, height: 600 }),
};

const RUN = "https://github.com/Brainwires/denext/actions/runs/1";

// --- routing --------------------------------------------------------------------------------

Deno.test("web panel: a GitHub link opens in the panel when the window hosts web views", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  assertEquals(await browser.open(RUN), "panel");
  assertEquals(external, []);
  assertEquals(f.created.length, 1);
  const o = f.created[0];
  assertEquals(o.url, RUN);
  assertEquals(o.partition, GITHUB_PARTITION);
  assertFalse(o.partition!.startsWith("ephemeral"), "the GitHub session persists");
  assertEquals(o.allowPopups, "same-view");
  assertEquals(o.downloads, "browser");
  assertEquals(o.permissions, "deny");
  assertEquals(o.visible, false, "shown once glued to the placeholder");
  assert(browser.state.open);
});

Deno.test("web panel: another GitHub link navigates the one open view", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  const next = "https://github.com/Brainwires/deno/pull/7";
  assertEquals(await browser.open(next), "panel");
  assertEquals(f.created.length, 1);
  assert(f.view.calls.includes(`navigate:${next}`));
});

Deno.test("web panel: the system browser when the engine has no web views", async () => {
  const f = fakeApi({ supported: false });
  const { browser, external } = browserWith(f.api);
  assertEquals(await browser.open(RUN), "browser");
  assertEquals(external, [RUN]);
  assertEquals(f.created.length, 0);
  assertFalse(browser.state.open);
});

Deno.test("web panel: the system browser when this denext has no web view API", async () => {
  assertEquals(await nativeWebViews({}), null);
  assertEquals(await nativeWebViews({ createWebView: () => {} }), null);
  // The pinned denext (4.18+) exports the API; off desktop there are no views.
  assert(webViewApiOf(desktopWindow), "denext/desktop/window exports the web view API");
  assertEquals(await nativeWebViews(desktopWindow), null);
  const external: string[] = [];
  const browser = new GitHubBrowser({
    openExternal: (u) => {
      external.push(u);
      return Promise.resolve();
    },
  });
  assertEquals(await browser.open(RUN), "browser");
  assertEquals(external, [RUN]);
});

Deno.test("web panel: createWebView refusing `unsupported` falls back, for later links too", async () => {
  const f = fakeApi({ reject: Object.assign(new Error("no views"), { code: "unsupported" }) });
  const { browser, external } = browserWith(f.api);
  const err = console.error;
  console.error = () => {};
  try {
    assertEquals(await browser.open(RUN), "browser");
    assertEquals(await browser.open(RUN), "browser");
  } finally {
    console.error = err;
  }
  assertEquals(external, [RUN, RUN]);
  assertEquals(f.created.length, 1, "not tried again");
});

Deno.test("web panel: links off GitHub open nowhere (the allowlist stays)", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  for (const u of ["https://evil.example/", "http://github.com/x", "https://github.com.evil/"]) {
    assertEquals(await browser.open(u), "refused");
  }
  assertEquals(external, []);
  assertEquals(f.created.length, 0);
});

Deno.test("web panel: denext.config.ts lets web views load github.com only", () => {
  assertEquals(config.desktop.webViews, { allowedOrigins: ["https://github.com"] });
});

// --- staying on GitHub ----------------------------------------------------------------------

const OFF = "https://docs.example/guide";

Deno.test("web panel: a link off github.com is stopped before it commits and opens in the browser", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  await browser.open(RUN);
  f.view.emit("url", { url: RUN, canGoBack: false, canGoForward: false });
  f.view.emit("load", { state: "loading", url: OFF });
  assertEquals(external, [OFF]);
  assert(f.view.calls.includes("stop"));
  assertFalse(f.view.calls.includes("back"), "nothing committed: no history step");
  assertEquals(browser.state.url, RUN);
  assert(browser.state.open);
});

Deno.test("web panel: a committed off-GitHub page goes back to GitHub, handed off once", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  await browser.open(RUN);
  f.view.emit("url", { url: RUN, canGoBack: false, canGoForward: false });
  f.view.emit("load", { state: "loading", url: OFF });
  f.view.emit("url", { url: OFF, canGoBack: true, canGoForward: false });
  f.view.emit("title", { title: "Someone else's page" });
  await tick();
  assertEquals(external, [OFF], "its load and URL events are one hand-off");
  assert(f.view.calls.includes("back"));
  assertEquals(browser.state.url, RUN, "the toolbar never shows the other site");
  assertFalse(browser.state.title === "Someone else's page");
  // Back on GitHub, titles show again.
  f.view.emit("url", { url: RUN, canGoBack: false, canGoForward: true });
  f.view.emit("title", { title: "CI" });
  assertEquals(browser.state.title, "CI");
});

Deno.test("web panel: an off-GitHub redirect with no history returns to the last GitHub page", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  f.view.emit("url", { url: RUN, canGoBack: false, canGoForward: false });
  f.view.emit("url", { url: OFF, canGoBack: false, canGoForward: false });
  await tick();
  assert(f.view.calls.includes(`navigate:${RUN}`));
});

Deno.test("web panel: an off-GitHub first page closes the panel (nothing to return to)", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  await browser.open(RUN);
  f.view.emit("url", { url: OFF, canGoBack: false, canGoForward: false });
  await tick();
  assertEquals(external, [OFF]);
  assertFalse(browser.state.open);
});

Deno.test("web panel: GitHub's own site and about:blank stay in the view", async () => {
  const f = fakeApi();
  const { browser, external } = browserWith(f.api);
  await browser.open(RUN);
  for (
    const url of [
      "https://github.com/login",
      "https://github.com/sessions/two-factor",
      "about:blank",
    ]
  ) {
    f.view.emit("load", { state: "loading", url });
    f.view.emit("url", { url, canGoBack: true, canGoForward: false });
  }
  assertEquals(external, []);
  assertFalse(f.view.calls.includes("stop"));
  for (const url of ["https://docs.github.com/en/actions", "https://gist.github.com/x"]) {
    f.view.emit("load", { state: "loading", url });
  }
  assertEquals(external, [], "GitHub's own subdomains stay");
  for (
    const url of [
      "https://github.com.evil/",
      "https://notgithub.com/",
      "http://github.com/x",
      "https://github.com:8443/x",
    ]
  ) {
    f.view.emit("load", { state: "loading", url });
  }
  assertEquals(external.length, 4, "a look-alike, plain http or another port leaves");
});

// --- the panel ------------------------------------------------------------------------------

/** FleetApp's wiring in small: the browser's state into the panel while it is open. */
function Harness<O>({ browser }: { browser: GitHubBrowser<O> }) {
  const [state, setState] = useState(browser.state);
  useEffect(() => browser.subscribe(setState), [browser]);
  return state.open ? <GitHubPanel browser={browser} state={state} /> : <p>fleet home</p>;
}

function walk(root: TestElement): TestElement[] {
  const out: TestElement[] = [];
  const go = (el: TestElement) => {
    for (const c of el.children) {
      out.push(c);
      go(c);
    }
  };
  go(root);
  return out;
}
const byClass = (root: TestElement, cls: string) =>
  walk(root).find((e) => (e.getAttribute("class") ?? "").split(/\s+/).includes(cls));
const button = (root: TestElement, name: string) =>
  walk(root).find((e) =>
    e.localName === "button" &&
    (e.getAttribute("aria-label") === name || (e.textContent ?? "").trim() === name)
  )!;
const isDisabled = (el: TestElement) => el.getAttribute("disabled") !== null;

/** The link's page loads in `view`: started, committed, painted, finished. */
function loads(view: FakeView, url = RUN, canGoBack = false) {
  view.emit("load", { state: "loading", url });
  view.emit("url", { url, canGoBack, canGoForward: false });
  view.emit("load", { state: "interactive", url });
  view.emit("load", { state: "complete", url });
}

async function openPanel() {
  const f = fakeApi();
  const b = browserWith(f.api);
  await b.browser.open(RUN);
  const screen = await render(<Harness browser={b.browser} />);
  await screen.act(() => loads(f.view));
  await screen.act(tick);
  return { ...f, ...b, screen };
}

Deno.test("web panel: the view follows the panel's placeholder", async () => {
  const { screen, attached } = await openPanel();
  assertEquals(attached.length, 1);
  assertEquals(attached[0], byClass(screen.container, "webpanel-view") as unknown as WebViewAnchor);
});

Deno.test("web panel: title, URL and history buttons follow the view's events", async () => {
  const { screen, view } = await openPanel();
  const c = screen.container;
  assert(isDisabled(button(c, "Back")));
  assert(isDisabled(button(c, "Forward")));
  await screen.act(() => {
    view.emit("title", { title: "CI · Brainwires/denext" });
    view.emit("url", {
      url: "https://github.com/Brainwires/denext/actions",
      canGoBack: true,
      canGoForward: false,
    });
  });
  assertEquals(byClass(c, "webpanel-title")?.textContent, "CI · Brainwires/denext");
  assertEquals(
    byClass(c, "webpanel-url")?.textContent,
    "https://github.com/Brainwires/denext/actions",
  );
  assertFalse(isDisabled(button(c, "Back")));
  assert(isDisabled(button(c, "Forward")));
});

Deno.test("web panel: loading bar from load events, an inline error for a failed load", async () => {
  const { screen, view } = await openPanel();
  const c = screen.container;
  await screen.act(() => view.emit("load", { state: "loading", url: RUN }));
  assert(byClass(c, "webpanel-loading"));
  await screen.act(() =>
    view.emit("load", {
      state: "failed",
      url: RUN,
      error: { code: "ERR_NAME_NOT_RESOLVED", message: "github.com could not be found." },
    })
  );
  assertFalse(byClass(c, "webpanel-loading"));
  assertEquals(byClass(c, "webpanel-error")?.textContent, "github.com could not be found.");
  await screen.act(() => view.emit("load", { state: "loading", url: RUN }));
  assertFalse(byClass(c, "webpanel-error"), "a new load clears the error");
  await screen.act(() => view.emit("load", { state: "complete", url: RUN }));
  assertFalse(byClass(c, "webpanel-loading"));
});

Deno.test("web panel: back, forward and reload drive the view", async () => {
  const { screen, view } = await openPanel();
  const c = screen.container;
  await screen.act(() => view.emit("url", { url: RUN, canGoBack: true, canGoForward: true }));
  await screen.fireEvent.click(button(c, "Back"));
  await screen.fireEvent.click(button(c, "Forward"));
  await screen.fireEvent.click(button(c, "Reload"));
  assertEquals(view.calls.filter((x) => ["back", "forward", "reload"].includes(x)), [
    "back",
    "forward",
    "reload",
  ]);
});

Deno.test("web panel: Open in browser hands the current URL to the system browser", async () => {
  const { screen, view, external } = await openPanel();
  const elsewhere = "https://docs.github.com/en/actions";
  await screen.act(() =>
    view.emit("url", { url: elsewhere, canGoBack: true, canGoForward: false })
  );
  await screen.fireEvent.click(button(screen.container, "Open in browser"));
  await tick();
  assertEquals(external, [elsewhere]);
});

Deno.test("web panel: Fleet (home) closes the panel and hides the view, kept for reopening", async () => {
  const { screen, view, browser, detached, created } = await openPanel();
  await screen.fireEvent.click(button(screen.container, "Fleet"));
  await screen.act(tick);
  assertFalse(browser.state.open);
  assert(screen.html().includes("fleet home"));
  assert(detached() >= 1);
  assert(view.calls.includes("setVisible:false"));
  assertFalse(view.calls.includes("close"));
  await screen.act(async () => void (await browser.open(RUN)));
  assertEquals(created.length, 1, "the same view again");
  assert(browser.state.open);
});

Deno.test("web panel: unmounting the page closes the view", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  browser.dispose();
  assert(f.view.calls.includes("close"));
  assertFalse(browser.state.open);
});

// --- hidden while covered -------------------------------------------------------------------

Deno.test("web panel: hidden while another screen covers the panel, back after", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  loads(f.view);
  browser.setAnchor(ANCHOR);
  await tick();
  assertEquals(f.attached.length, 1);
  assert(browser.showing);
  browser.setCovered(true);
  assertFalse(browser.showing, "Esc and the history keys stay with the covering screen");
  assertEquals(f.detached(), 1);
  assertEquals(f.view.calls.at(-1), "setVisible:false");
  browser.setCovered(false);
  await tick();
  assertEquals(f.attached.length, 2, "glued to the placeholder again");
});

Deno.test("web panel: a link opened while covered shows only once uncovered", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  browser.setAnchor(ANCHOR);
  browser.setCovered(true);
  await browser.open(RUN);
  loads(f.view);
  await tick();
  assertEquals(f.attached.length, 0);
  browser.setCovered(false);
  await tick();
  assertEquals(f.attached.length, 1);
});

// --- keyboard -------------------------------------------------------------------------------

const key = (k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

Deno.test("web panel keys: Cmd+[ / Cmd+] on macOS, Ctrl elsewhere; Esc goes home", () => {
  assertEquals(browserShortcut(key("[", { metaKey: true }), true), "back");
  assertEquals(browserShortcut(key("]", { metaKey: true }), true), "forward");
  assertEquals(browserShortcut(key("[", { ctrlKey: true }), false), "back");
  assertEquals(browserShortcut(key("]", { ctrlKey: true }), false), "forward");
  assertEquals(browserShortcut(key("Escape"), true), "home");
  assertEquals(browserShortcut(key("Escape"), false), "home");
});

Deno.test("web panel keys: nothing with the wrong or extra modifiers, or other keys", () => {
  assertEquals(browserShortcut(key("[", { ctrlKey: true }), true), null);
  assertEquals(browserShortcut(key("[", { metaKey: true }), false), null);
  assertEquals(browserShortcut(key("[", { metaKey: true, shiftKey: true }), true), null);
  assertEquals(browserShortcut(key("]", { metaKey: true, altKey: true }), true), null);
  assertEquals(browserShortcut(key("Escape", { shiftKey: true }), true), null);
  assertEquals(browserShortcut(key("w", { metaKey: true }), true), null);
  assertEquals(browserShortcut(key("["), true), null);
});

Deno.test("web panel keys: one press seen by the page and the app menu steps once", async () => {
  let t = 1000;
  const f = fakeApi();
  const { browser } = browserWith(f.api, { now: () => t });
  await browser.open(RUN);
  loads(f.view);
  // Three pages further in, so Back steps within GitHub (not back to Fleet).
  for (const n of [2, 3, 4]) {
    f.view.emit("url", { url: `${RUN}/job/${n}`, canGoBack: true, canGoForward: false });
  }
  browser.command("back", "page");
  browser.command("back", "menu");
  assertEquals(f.view.calls.filter((c) => c === "back").length, 1);
  t += 500;
  browser.command("back", "menu");
  t += 50;
  browser.command("back", "menu"); // a held key repeats from one source
  assertEquals(f.view.calls.filter((c) => c === "back").length, 3);
});

Deno.test("web panel keys: Esc (home) from the page closes the panel", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  browser.command("home", "page");
  assertFalse(browser.state.open);
});

Deno.test("web panel keys: the view losing the keyboard hands it back to Fleet's page", async () => {
  const f = fakeApi();
  const { browser, blurs } = browserWith(f.api);
  await browser.open(RUN);
  f.view.emit("focus-change", { focused: true });
  assert(browser.state.viewFocused);
  f.view.emit("focus-change", { focused: false });
  assertFalse(browser.state.viewFocused);
  assertEquals(blurs(), 1);
});

/** A fake app menu recording each menu set. */
function fakeMenu() {
  const menus: AppMenuItem[][] = [];
  let handler: ((id: string) => void) | null = null;
  return {
    menus,
    click: (id: string) => handler?.(id),
    api: {
      setAppMenu: (m: readonly AppMenuItem[]) => {
        menus.push([...m]);
        return Promise.resolve();
      },
      onAppMenuItem: (fn: (id: string) => void) => {
        handler = fn;
        return () => void (handler = null);
      },
    },
  };
}

/** The Go submenu's items by id. */
function goItems(menu: AppMenuItem[]) {
  const go = menu.find((m) => typeof m === "object" && "label" in m && m.label === "Go");
  const items = (go as unknown as { submenu: AppMenuItem[] }).submenu as {
    id: string;
    accelerator?: string;
    disabled?: boolean;
  }[];
  return Object.fromEntries(items.map((i) => [i.id, i]));
}

Deno.test("web panel menu: set on first open; Back/Forward accelerators follow the history", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  const m = fakeMenu();
  const stop = connectBrowserMenu(browser, m.api, true);
  assertEquals(m.menus.length, 0, "no menu of Fleet's until the panel opens");
  await browser.open(RUN);
  assertEquals(m.menus.length, 1);
  let items = goItems(m.menus.at(-1)!);
  assertEquals(items[MENU_BACK].accelerator, "CommandOrControl+[");
  assertEquals(items[MENU_FORWARD].accelerator, "CommandOrControl+]");
  assert(items[MENU_BACK].disabled);
  f.view.emit("url", { url: RUN, canGoBack: true, canGoForward: false });
  items = goItems(m.menus.at(-1)!);
  assertFalse(items[MENU_BACK].disabled);
  assert(items[MENU_FORWARD].disabled);
  // The accelerator (the web view focused) steps the view.
  m.click(MENU_BACK);
  assertEquals(f.view.calls.filter((c) => c === "back").length, 1);
  // Home: the items go disabled, so the keys reach whichever page has the keyboard.
  browser.home();
  items = goItems(m.menus.at(-1)!);
  assert(items[MENU_BACK].disabled && items[MENU_FORWARD].disabled);
  stop();
});

Deno.test("web panel menu: keeps the editing roles and never takes Esc", () => {
  for (const mac of [true, false]) {
    const json = JSON.stringify(
      browserMenu({ open: true, canGoBack: true, canGoForward: true, canReturn: true }, mac),
    );
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      assert(json.includes(`"role":"${role}"`), role);
    }
    assertFalse(/Esc/i.test(json));
  }
});

Deno.test("web panel: covered by loading, the wizard, the token screen and Settings only", () => {
  const ok = { auth: "gh", setupComplete: true } as const;
  assert(panelCovered(null, "main", null), "loading");
  assert(panelCovered({ ...ok, setupComplete: false }, "main", null), "first run");
  assert(panelCovered(ok, "wizard", null));
  for (const auth of ["pending", "needs-token", "invalid"] as const) {
    assert(panelCovered({ ...ok, auth }, "main", null), auth);
  }
  assert(panelCovered(ok, "settings", null));
  assertFalse(panelCovered(ok, "settings", "mac-pool"), "a pool screen over Settings shows it");
  assertFalse(panelCovered(ok, "main", null));
  assertFalse(panelCovered(ok, "main", "mac-pool"));
});

// --- never blank ----------------------------------------------------------------------------

const OTHER = "https://github.com/Brainwires/denext/actions/runs/2";

Deno.test("web panel: a new view requests the page at creation and shows only once it has loaded", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  assertEquals(f.created[0].url, RUN, "the first load is requested at creation");
  assertEquals(f.created[0].visible, false);
  browser.setAnchor(ANCHOR);
  await tick();
  assert(browser.state.waiting);
  assertEquals(f.attached.length, 0, "no blank view while the page loads");
  assertFalse(f.view.calls.includes("setVisible:true"));
  f.view.emit("load", { state: "loading", url: RUN });
  f.view.emit("url", { url: RUN, canGoBack: false, canGoForward: false });
  await tick();
  assertEquals(f.attached.length, 0, "committed is not painted yet");
  f.view.emit("load", { state: "interactive", url: RUN });
  await tick();
  assertEquals(f.attached.length, 1, "shown on the first paint");
  assertFalse(browser.state.waiting);
});

Deno.test("web panel: a different link hides the view, navigates, and shows it on the new load", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  loads(f.view);
  browser.setAnchor(ANCHOR);
  await tick();
  assertEquals(f.attached.length, 1);
  browser.home();
  browser.setAnchor(null);
  f.view.calls = [];
  await browser.open(OTHER);
  browser.setAnchor(ANCHOR);
  await tick();
  const hide = f.view.calls.indexOf("setVisible:false");
  const nav = f.view.calls.indexOf(`navigate:${OTHER}`);
  assert(hide >= 0 && nav > hide, `hidden before navigating: ${f.view.calls.join(", ")}`);
  assertEquals(f.attached.length, 1, "not shown on the previous page");
  assert(browser.state.waiting);
  assertEquals(browser.state.url, OTHER);
  assertEquals(browser.state.title, "", "no stale title from the previous page");
  // A late "complete" of the page it was on doesn't count.
  f.view.emit("load", { state: "complete", url: RUN });
  await tick();
  assertEquals(f.attached.length, 1);
  loads(f.view, OTHER);
  await tick();
  assertEquals(f.attached.length, 2, "shown once the new page has loaded");
});

Deno.test("web panel: a failed first load stays hidden with its error; Reload waits for the page", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  browser.setAnchor(ANCHOR);
  f.view.emit("load", { state: "loading", url: RUN });
  f.view.emit("load", {
    state: "failed",
    url: RUN,
    error: { code: "network", message: "offline" },
  });
  await tick();
  assertEquals(f.attached.length, 0);
  assertEquals(browser.state.error, "offline");
  assertFalse(browser.state.waiting);
  browser.command("reload");
  assert(browser.state.waiting);
  assert(f.view.calls.includes("reload"));
  loads(f.view);
  await tick();
  assertEquals(f.attached.length, 1);
});

Deno.test("web panel: Fleet's own loading state shows under the hidden view until the page loads", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api);
  await browser.open(RUN);
  const screen = await render(<Harness browser={browser} />);
  await screen.act(tick);
  const wait = byClass(screen.container, "webpanel-wait");
  assert(wait, "a loading state, not a blank panel");
  assert((wait.textContent ?? "").includes(RUN));
  assert(byClass(screen.container, "webpanel-spinner"));
  await screen.act(() => loads(f.view));
  assertEquals(byClass(screen.container, "webpanel-wait"), undefined);
});

Deno.test("web panel: with no load event the view shows after the fallback, with a warning", async () => {
  const f = fakeApi();
  const { browser } = browserWith(f.api, { revealFallbackMs: 5 });
  const warn = console.warn;
  const warned: string[] = [];
  console.warn = (m: string) => void warned.push(m);
  try {
    await browser.open(RUN);
    browser.setAnchor(ANCHOR);
    await new Promise((r) => setTimeout(r, 30));
  } finally {
    console.warn = warn;
  }
  assertEquals(f.attached.length, 1);
  assertEquals(warned.length, 1);
  browser.dispose();
});

// --- Back returns to Fleet ------------------------------------------------------------------

const DASHBOARD: PanelOrigin = { pool: null, range: "24h", tab: "usage", scroll: [] };

/** A browser whose returns are recorded. */
function returningBrowser(extra: Partial<GitHubBrowserDeps<PanelOrigin>> = {}) {
  const f = fakeApi();
  const returned: PanelOrigin[] = [];
  const b = browserWith<PanelOrigin>(f.api, { onReturn: (o) => void returned.push(o), ...extra });
  return { ...f, ...b, returned };
}

Deno.test("web panel back: from the link's first page restores the dashboard", async () => {
  const { browser, view, returned } = returningBrowser();
  await browser.open(RUN, DASHBOARD);
  // The reused view still has earlier sessions' pages behind it.
  loads(view, RUN, true);
  assert(browser.state.canGoBack);
  browser.command("back");
  assertFalse(view.calls.includes("back"), "not into an earlier session's pages");
  assertFalse(browser.state.open);
  assertEquals(returned, [DASHBOARD]);
});

Deno.test("web panel back: from the first page restores a pool screen with its range, tab and scroll", async () => {
  const lane = { scrollTop: 340, scrollLeft: 0 };
  const page = {
    scrollTop: 120,
    scrollLeft: 0,
    querySelectorAll: () => [lane, { scrollTop: 0, scrollLeft: 0 }],
  };
  const origin: PanelOrigin = {
    pool: "mac-arm",
    range: "7d",
    tab: "logs",
    scroll: captureScroll([page, null]),
  };
  assertEquals(origin.scroll.length, 2, "only the scrolled ones");
  const { browser, view, returned } = returningBrowser();
  await browser.open(RUN, origin);
  loads(view);
  // The main view is display: none under the panel: its scrollers lose their offsets.
  page.scrollTop = 0;
  lane.scrollTop = 0;
  browser.command("back");
  assertEquals(returned.length, 1);
  const restored: Record<string, unknown> = {};
  restoreOrigin(returned[0], {
    setPool: (p) => void (restored.pool = p),
    setRange: (r) => void (restored.range = r),
    setTab: (t) => void (restored.tab = t),
  }, (fn) => fn());
  assertEquals(restored, { pool: "mac-arm", range: "7d", tab: "logs" });
  assertEquals([page.scrollTop, lane.scrollTop], [120, 340]);
});

Deno.test("web panel back: mid-history goes back within GitHub, then to Fleet", async () => {
  const { browser, view, returned } = returningBrowser();
  await browser.open(RUN, DASHBOARD);
  loads(view);
  view.emit("url", { url: `${RUN}/job/7`, canGoBack: true, canGoForward: false });
  browser.command("back");
  assertEquals(view.calls.filter((c) => c === "back").length, 1, "within GitHub");
  assert(browser.state.open);
  assertEquals(returned, []);
  view.emit("url", { url: RUN, canGoBack: true, canGoForward: true });
  browser.command("back");
  assertEquals(view.calls.filter((c) => c === "back").length, 1);
  assertEquals(returned, [DASHBOARD]);
});

Deno.test("web panel back: the button stays enabled at the first page while there is a Fleet screen", async () => {
  const { browser, view } = returningBrowser();
  await browser.open(RUN, DASHBOARD);
  const screen = await render(<Harness browser={browser} />);
  await screen.act(() => loads(view));
  assertFalse(browser.state.canGoBack);
  assertFalse(isDisabled(button(screen.container, "Back")));
  await screen.fireEvent.click(button(screen.container, "Back"));
  assertFalse(browser.state.open);
});

Deno.test("web panel back: Esc and the Fleet button restore the origin too", async () => {
  const { browser, view, returned } = returningBrowser();
  await browser.open(RUN, DASHBOARD);
  loads(view);
  browser.command("home");
  assertEquals(returned, [DASHBOARD]);
});

// --- reopen where you left it ---------------------------------------------------------------

Deno.test("web panel reopen: the same link shows at once on the page and history left", async () => {
  const { browser, view, attached, returned } = returningBrowser();
  const pool: PanelOrigin = { pool: "mac-arm", range: "24h", tab: "usage", scroll: [] };
  await browser.open(RUN, DASHBOARD);
  loads(view);
  view.emit("url", { url: `${RUN}/job/7`, canGoBack: true, canGoForward: false });
  view.emit("title", { title: "job 7" });
  browser.setAnchor(ANCHOR);
  await tick();
  browser.command("home");
  browser.setAnchor(null);
  view.calls = [];
  assertEquals(await browser.open(RUN, pool), "panel");
  browser.setAnchor(ANCHOR);
  await tick();
  assertEquals(attached.length, 2, "shown at once");
  assertFalse(browser.state.waiting, "no loading state");
  assertFalse(view.calls.some((c) => c.startsWith("navigate") || c === "reload"));
  assertEquals(browser.state.url, `${RUN}/job/7`);
  assertEquals(browser.state.title, "job 7");
  // History intact: Back steps to the run page, then returns to the new click's screen.
  browser.command("back");
  assertEquals(view.calls.filter((c) => c === "back").length, 1);
  view.emit("url", { url: RUN, canGoBack: true, canGoForward: true });
  browser.command("back");
  assertEquals(returned, [DASHBOARD, pool], "Back's target is the screen clicked from now");
});

/** A browser over a link whose run / job status the test sets, on a clock the test moves. */
function statusBrowser(status: { now: LinkStatus }) {
  const clock = { t: 1_000_000 };
  const b = returningBrowser({
    now: () => clock.t,
    quietReloadMs: 15,
    linkStatus: () => status.now,
  });
  return { ...b, clock };
}

const STEP = `${RUN}/job/7#step:4:120`;

/** Open RUN, follow to a job's step, go back to Fleet. */
async function openAndLeave(b: ReturnType<typeof statusBrowser>) {
  await b.browser.open(RUN, DASHBOARD);
  loads(b.view);
  b.view.emit("url", { url: STEP, canGoBack: true, canGoForward: false });
  b.browser.setAnchor(ANCHOR);
  await tick();
  b.browser.command("home");
  b.view.calls = [];
}

Deno.test("web panel reopen: a run in progress reloads in place, keeping the step hash and history", async () => {
  const status = { now: "live" as LinkStatus };
  const b = statusBrowser(status);
  await openAndLeave(b);
  b.clock.t += 1000;
  await b.browser.open(RUN, DASHBOARD);
  await tick();
  assertEquals(b.view.calls.filter((c) => c === "reload").length, 1, "reloaded, even after 1 s");
  assertFalse(
    b.view.calls.some((c) => c.startsWith("navigate")),
    "the page in place, not the link",
  );
  assertEquals(b.attached.length, 2, "shown at once, not hidden for the reload");
  assertEquals(b.browser.state.url, STEP, "the #step hash is kept");
  // Quick: no loading bar.
  b.view.emit("load", { state: "loading", url: STEP });
  assertFalse(b.browser.state.loading);
  b.view.emit("url", { url: STEP, canGoBack: true, canGoForward: false });
  b.view.emit("load", { state: "complete", url: STEP });
  await new Promise((r) => setTimeout(r, 30));
  assertFalse(b.browser.state.loading, "finished before the bar was due");
  // History kept: Back steps to the run page.
  b.browser.command("back");
  assert(b.view.calls.includes("back"));
});

Deno.test("web panel reopen: a slow reload shows the loading bar after the quiet period", async () => {
  const status = { now: "live" as LinkStatus };
  const b = statusBrowser(status);
  await openAndLeave(b);
  await b.browser.open(RUN, DASHBOARD);
  b.view.emit("load", { state: "loading", url: STEP });
  assertFalse(b.browser.state.loading);
  await new Promise((r) => setTimeout(r, 30));
  assert(b.browser.state.loading);
  b.view.emit("load", { state: "complete", url: STEP });
  assertFalse(b.browser.state.loading);
});

Deno.test("web panel reopen: a completed run reopens as it was, with no reload", async () => {
  const status = { now: "done" as LinkStatus };
  const b = statusBrowser(status);
  await openAndLeave(b);
  b.clock.t += 60 * 60_000;
  await b.browser.open(RUN, DASHBOARD);
  await tick();
  assertFalse(b.view.calls.includes("reload"), "a finished page can't change");
  assertEquals(b.attached.length, 2, "shown at once");
  assertEquals(b.browser.state.url, STEP);
});

Deno.test("web panel reopen: a run that completed while hidden reloads once", async () => {
  const status = { now: "live" as LinkStatus };
  const b = statusBrowser(status);
  await openAndLeave(b);
  status.now = "done";
  await b.browser.open(RUN, DASHBOARD);
  assertEquals(b.view.calls.filter((c) => c === "reload").length, 1, "the final state shows");
  b.view.emit("load", { state: "complete", url: STEP });
  b.browser.command("home");
  b.view.calls = [];
  await b.browser.open(RUN, DASHBOARD);
  assertFalse(b.view.calls.includes("reload"), "only once");
});

Deno.test("web panel reopen: an unknown page reloads after 30 s hidden, not before", async () => {
  const status = { now: null as LinkStatus };
  const b = statusBrowser(status);
  await openAndLeave(b);
  b.clock.t += UNKNOWN_STALE_MS - 1;
  await b.browser.open(RUN, DASHBOARD);
  assertFalse(b.view.calls.includes("reload"), "within 30 s: as it was");
  b.browser.command("home");
  b.view.calls = [];
  b.clock.t += UNKNOWN_STALE_MS + 1;
  await b.browser.open(RUN, DASHBOARD);
  assertEquals(b.view.calls.filter((c) => c === "reload").length, 1);
});

Deno.test("web panel reopen policy: live reloads, done only if it finished while hidden, unknown after 30 s", () => {
  assert(reloadOnReopen("live", "live", 0));
  assert(reloadOnReopen(null, "live", 0));
  assertFalse(reloadOnReopen("done", "done", 10 * UNKNOWN_STALE_MS));
  assert(reloadOnReopen("live", "done", 0));
  assertFalse(reloadOnReopen(null, null, UNKNOWN_STALE_MS));
  assert(reloadOnReopen(null, null, UNKNOWN_STALE_MS + 1));
  assert(reloadOnReopen("live", null, UNKNOWN_STALE_MS + 1));
});

Deno.test("web panel reopen: a different link always starts fresh", async () => {
  const { browser, view, returned } = returningBrowser();
  await browser.open(RUN, DASHBOARD);
  loads(view);
  view.emit("url", { url: `${RUN}/job/7`, canGoBack: true, canGoForward: false });
  browser.command("home");
  view.calls = [];
  await browser.open(OTHER, DASHBOARD);
  assert(view.calls.includes(`navigate:${OTHER}`));
  assert(browser.state.waiting);
  loads(view, OTHER, true);
  browser.command("back");
  assertFalse(view.calls.includes("back"), "a fresh history: Back returns to Fleet");
  assertEquals(returned.length, 2);
});
