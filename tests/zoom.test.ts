// The window zoom (lib/zoom.ts, app/zoom-dom.ts, the View menu in app/web-panel/browser-menu.ts):
// the level's bounds and steps, the keys, the View menu merged into Fleet's app menu, the page's
// controller (one step per press, the backend's answer), the preference file in a temp folder, the
// zoomed layout's attributes, the GitHub view's page zoom, and the stylesheet's zoom block (the
// breakpoints repeated by effective width, no viewport-unit heights left unzoomed). No desktop
// runtime, no window.

import "./fixture-settings.ts";
// Type-checks app/web-panel/engine.ts's denext/desktop/window types: a test graph without
// denext/testing doesn't resolve them under denext 4.18 (as in tests/web-panel.test.tsx).
import "denext/testing";

import { assert, assertEquals, assertFalse } from "@std/assert";
import type { AppMenuItem } from "denext/desktop/app";
import {
  clampZoom,
  createZoomStore,
  MENU_ZOOM_IN,
  MENU_ZOOM_OUT,
  MENU_ZOOM_RESET,
  parseZoomPrefs,
  stepZoom,
  ZOOM_DEFAULT,
  ZOOM_ECHO_MS,
  ZOOM_FILE,
  ZOOM_MAX,
  ZOOM_MIN,
  ZoomController,
  zoomLayout,
  zoomMenu,
  zoomMenuAction,
  zoomPrefs,
  zoomShortcut,
} from "../lib/zoom.ts";
import { loadZoom, saveZoom } from "../lib/deno-host.ts";
import { applyZoom } from "../app/zoom-dom.ts";
import {
  browserMenu,
  connectBrowserMenu,
  MENU_BACK,
  MENU_FORWARD,
} from "../app/web-panel/browser-menu.ts";
import { GitHubBrowser } from "../app/web-panel/github-browser.ts";
import { nativeWebViews, type WebViewApi, type WebViewHandle } from "../app/web-panel/engine.ts";
import type { ShortcutKey } from "../lib/shortcuts.ts";

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

// --- the level ------------------------------------------------------------------------------

Deno.test("zoom: 80% to 200% in 10% steps, 100% by default", () => {
  assertEquals([ZOOM_MIN, ZOOM_DEFAULT, ZOOM_MAX], [80, 100, 200]);
  assertEquals(clampZoom(150), 150);
  assertEquals(clampZoom(154), 150, "to the nearest step");
  assertEquals(clampZoom(156), 160);
  assertEquals(clampZoom(10), 80);
  assertEquals(clampZoom(900), 200);
  for (const bad of [NaN, Infinity, -Infinity, "150", null, undefined, {}]) {
    assertEquals(clampZoom(bad), 100, String(bad));
  }
  assertEquals(stepZoom(100, "in"), 110);
  assertEquals(stepZoom(100, "out"), 90);
  assertEquals(stepZoom(200, "in"), 200, "stops at the top");
  assertEquals(stepZoom(80, "out"), 80, "stops at the bottom");
  assertEquals(stepZoom(170, "reset"), 100);
  // No floating-point drift over a run of steps.
  let z = 80;
  const seen: number[] = [];
  while (z < 200) seen.push(z = stepZoom(z, "in"));
  assertEquals(seen, [90, 100, 110, 120, 130, 140, 150, 160, 170, 180, 190, 200]);
});

Deno.test("zoom: the preference file's document parses back; anything else is the default", () => {
  assertEquals(zoomPrefs(150), { version: 1, zoom: 150 });
  assertEquals(zoomPrefs(999), { version: 1, zoom: 200 });
  assertEquals(parseZoomPrefs(zoomPrefs(130)), 130);
  assertEquals(parseZoomPrefs({ version: 1, zoom: 133 }), 130);
  for (const raw of [null, "x", 150, [], { zoom: 150 }, { version: 2, zoom: 150 }]) {
    assertEquals(parseZoomPrefs(raw), 100, JSON.stringify(raw));
  }
});

// --- keys -----------------------------------------------------------------------------------

const key = (k: string, mods: Partial<ShortcutKey> = {}): ShortcutKey => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

Deno.test("zoom keys: Cmd on macOS, Ctrl elsewhere, with + or =, -, 0", () => {
  const cmd = { metaKey: true };
  const ctrl = { ctrlKey: true };
  assertEquals(zoomShortcut(key("=", cmd), true), "in");
  assertEquals(zoomShortcut(key("+", { ...cmd, shiftKey: true }), true), "in", "Cmd++ (Shift+=)");
  assertEquals(zoomShortcut(key("-", cmd), true), "out");
  assertEquals(zoomShortcut(key("0", cmd), true), "reset");
  assertEquals(zoomShortcut(key("=", ctrl), false), "in");
  assertEquals(zoomShortcut(key("+", ctrl), false), "in", "the keypad's +");
  assertEquals(zoomShortcut(key("-", ctrl), false), "out");
  assertEquals(zoomShortcut(key("0", ctrl), false), "reset");
});

Deno.test("zoom keys: not the other platform's modifier, not with Alt, not other keys", () => {
  assertEquals(zoomShortcut(key("=", { ctrlKey: true }), true), null);
  assertEquals(zoomShortcut(key("=", { metaKey: true }), false), null);
  assertEquals(zoomShortcut(key("=", { metaKey: true, altKey: true }), true), null);
  assertEquals(zoomShortcut(key("="), true), null, "no modifier: typing");
  assertEquals(zoomShortcut(key("-"), false), null);
  for (const k of ["1", "w", "[", "]", "Escape"]) {
    assertEquals(zoomShortcut(key(k, { metaKey: true }), true), null, k);
  }
});

// --- the View menu --------------------------------------------------------------------------

type Item = { id: string; label: string; accelerator?: string; disabled?: boolean };

/** A top-level submenu's items by label. */
function submenu(menu: AppMenuItem[], label: string): Item[] | undefined {
  const found = menu.find((m) => typeof m === "object" && "label" in m && m.label === label);
  return (found as { submenu?: Item[] } | undefined)?.submenu;
}

Deno.test("View menu: Actual Size, Zoom In, Zoom Out with accelerators, disabled at the bounds", () => {
  const view = zoomMenu(100);
  assertEquals(view.label, "View");
  const items = view.submenu as Item[];
  assertEquals(items.map((i) => [i.id, i.label, i.accelerator]), [
    [MENU_ZOOM_RESET, "Actual Size", "CommandOrControl+0"],
    [MENU_ZOOM_IN, "Zoom In", "CommandOrControl+="],
    [MENU_ZOOM_OUT, "Zoom Out", "CommandOrControl+-"],
  ]);
  const disabled = (pct: number) =>
    Object.fromEntries((zoomMenu(pct).submenu as Item[]).map((i) => [i.id, i.disabled]));
  assertEquals(disabled(100), {
    [MENU_ZOOM_RESET]: true,
    [MENU_ZOOM_IN]: false,
    [MENU_ZOOM_OUT]: false,
  });
  assertEquals(disabled(200)[MENU_ZOOM_IN], true);
  assertEquals(disabled(200)[MENU_ZOOM_RESET], false);
  assertEquals(disabled(80)[MENU_ZOOM_OUT], true);
  // Accelerators name physical keys only (the runtime's syntax has no "Plus").
  assertFalse(JSON.stringify(view).includes("Plus"));
  assertEquals(zoomMenuAction(MENU_ZOOM_IN), "in");
  assertEquals(zoomMenuAction(MENU_ZOOM_OUT), "out");
  assertEquals(zoomMenuAction(MENU_ZOOM_RESET), "reset");
  assertEquals(zoomMenuAction(MENU_BACK), null);
});

Deno.test("View menu: merged into Fleet's app menu between Edit and Go, every item kept", () => {
  const state = { open: false, canGoBack: false, canGoForward: false, canReturn: false };
  for (const mac of [true, false]) {
    const menu = browserMenu(state, mac, 130);
    const labels = menu.map((m) => (typeof m === "object" && "label" in m ? m.label : m));
    assertEquals(labels, mac ? ["Fleet", "Edit", "View", "Go"] : ["Edit", "View", "Go"]);
    const json = JSON.stringify(menu);
    for (const role of ["undo", "redo", "cut", "copy", "paste", "selectAll"]) {
      assert(json.includes(`"role":"${role}"`), role);
    }
    assertEquals(submenu(menu, "Go")!.map((i) => i.id), [MENU_BACK, MENU_FORWARD]);
    // Without the zoom the menu is as before.
    const before = browserMenu(state, mac);
    assertEquals(submenu(before, "View"), undefined);
    assertEquals(before.length, menu.length - 1);
  }
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

/** A browser stand-in for the menu (no web view): records commands, never opens. */
function fakeBrowser() {
  const commands: string[] = [];
  return {
    commands,
    controls: {
      command: (cmd: string) => void commands.push(cmd),
      setAnchor: () => {},
      subscribe: () => () => {},
    } as unknown as Parameters<typeof connectBrowserMenu>[0],
  };
}

Deno.test("View menu: with the zoom the menu is set at once and follows the level's bounds", async () => {
  const m = fakeMenu();
  const b = fakeBrowser();
  const saved: number[] = [];
  const zoom = new ZoomController({
    apply: () => {},
    save: (pct) => (saved.push(pct), Promise.resolve(pct)),
  });
  const stop = connectBrowserMenu(b.controls, m.api, true, zoom);
  assertEquals(m.menus.length, 1, "set before the GitHub panel ever opens");
  assert(submenu(m.menus[0], "View")!.find((i) => i.id === MENU_ZOOM_RESET)!.disabled);
  // The accelerator / click steps the level and re-sets the menu (Actual Size now enabled).
  m.click(MENU_ZOOM_IN);
  assertEquals(zoom.level, 110);
  await tick();
  assertEquals(saved, [110]);
  assertFalse(submenu(m.menus.at(-1)!, "View")!.find((i) => i.id === MENU_ZOOM_RESET)!.disabled);
  const count = m.menus.length;
  m.click(MENU_ZOOM_IN);
  await tick();
  assertEquals(zoom.level, 120);
  assertEquals(m.menus.length, count, "no re-set while nothing in the menu changes");
  m.click(MENU_ZOOM_RESET);
  await tick();
  assertEquals(zoom.level, 100);
  // Go's items still drive the browser.
  m.click(MENU_BACK);
  assertEquals(b.commands, ["back"]);
  stop();
  m.click(MENU_ZOOM_IN);
  assertEquals(zoom.level, 100, "stopped: no handler");
});

// --- the page's controller ------------------------------------------------------------------

function controller(save: (pct: number) => Promise<number> = (p) => Promise.resolve(p)) {
  let now = 1000;
  const applied: number[] = [];
  const saves: number[] = [];
  const zoom = new ZoomController({
    apply: (pct) => void applied.push(pct),
    save: (pct) => (saves.push(pct), save(pct)),
    now: () => now,
  });
  return { zoom, applied, saves, advance: (ms: number) => void (now += ms) };
}

Deno.test("zoom controller: a press steps at once and saves; the backend's answer is the level", async () => {
  const c = controller((p) => Promise.resolve(Math.min(p, 150)));
  c.zoom.zoom("in", "page");
  assertEquals(c.zoom.level, 110);
  assertEquals(c.applied, [110]);
  await tick();
  assertEquals(c.saves, [110]);
  // A level from the backend (another window's change).
  c.zoom.set(140);
  assertEquals(c.zoom.level, 140);
  c.advance(1000);
  c.zoom.zoom("in", "page");
  c.advance(1000);
  c.zoom.zoom("in", "page");
  await tick();
  assertEquals(c.saves, [110, 150, 160]);
  assertEquals(c.zoom.level, 150, "the backend kept 150 (its clamp here)");
});

Deno.test("zoom controller: the page's key and the menu's accelerator for one press step once", () => {
  const c = controller();
  c.zoom.zoom("in", "page");
  c.advance(10);
  c.zoom.zoom("in", "menu");
  assertEquals(c.zoom.level, 110, "the echo dropped");
  c.advance(ZOOM_ECHO_MS + 1);
  c.zoom.zoom("in", "menu");
  assertEquals(c.zoom.level, 120, "a later press counts");
  c.advance(10);
  c.zoom.zoom("in", "menu");
  assertEquals(c.zoom.level, 130, "key repeat from one source counts");
  c.advance(10);
  c.zoom.zoom("out", "page");
  assertEquals(c.zoom.level, 120, "another action counts");
});

Deno.test("zoom controller: backend pushes are ignored while its own saves are unanswered", async () => {
  const pending: ((v: number) => void)[] = [];
  const c = controller(() => new Promise<number>((r) => pending.push(r)));
  c.zoom.zoom("in", "page");
  c.advance(1000);
  c.zoom.zoom("in", "page");
  assertEquals(c.zoom.level, 120);
  c.zoom.set(110); // the first save's event, late
  assertEquals(c.zoom.level, 120, "no step back");
  pending[0](110);
  await tick();
  assertEquals(c.zoom.level, 120, "an older answer is passed over");
  pending[1](120);
  await tick();
  assertEquals(c.zoom.level, 120);
  c.zoom.set(150);
  assertEquals(c.zoom.level, 150, "pushes count again once answered");
});

Deno.test("zoom controller: off desktop the save rejects and the level holds for the page", async () => {
  const c = controller(() =>
    Promise.reject(Object.assign(new Error("x"), { code: "unavailable" }))
  );
  c.zoom.zoom("in", "page");
  await tick();
  assertEquals(c.zoom.level, 110);
  c.zoom.set(130);
  assertEquals(c.zoom.level, 130, "nothing left in flight");
  const heard: number[] = [];
  const stop = c.zoom.subscribe((p) => heard.push(p));
  c.zoom.set(130);
  c.zoom.set(140);
  stop();
  c.zoom.set(150);
  assertEquals(heard, [140], "only changes, until unsubscribed");
});

// --- the preference file --------------------------------------------------------------------

Deno.test("zoom file: written in the data folder (0600), read back; a bad file is 100%", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fleet-zoom-" });
  try {
    assertEquals(await loadZoom(dir), 100, "no file yet");
    await saveZoom(dir, 150);
    const path = `${dir}/${ZOOM_FILE}`;
    assertEquals(JSON.parse(await Deno.readTextFile(path)), { version: 1, zoom: 150 });
    if (Deno.build.os !== "windows") {
      assertEquals((await Deno.stat(path)).mode! & 0o777, 0o600);
    }
    assertEquals(await loadZoom(dir), 150);
    await saveZoom(dir, 5000);
    assertEquals(await loadZoom(dir), 200, "clamped on write");
    await Deno.writeTextFile(path, "{not json");
    assertEquals(await loadZoom(dir), 100);
    await Deno.writeTextFile(path, JSON.stringify({ version: 1, zoom: "big" }));
    assertEquals(await loadZoom(dir), 100);
    // No temp files left behind.
    const names = [];
    for await (const e of Deno.readDir(dir)) names.push(e.name);
    assertEquals(names, [ZOOM_FILE]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("zoom store: loads the file, saves each change in order, pushes it to the pages", async () => {
  const dir = await Deno.makeTempDir({ prefix: "fleet-zoom-" });
  try {
    await saveZoom(dir, 130);
    const pushed: number[] = [];
    const store = createZoomStore({
      load: () => loadZoom(dir),
      save: (p) => saveZoom(dir, p),
      onChange: (p) => void pushed.push(p),
    });
    await store.ready();
    assertEquals(store.level(), 130, "the saved level at start");
    assertEquals(await store.set(130), 130);
    assertEquals(pushed, [], "no change, no push");
    // A quick run of changes: the newest ends on disk.
    const answers = await Promise.all([store.set(140), store.set(150), store.set(999)]);
    assertEquals(answers.at(-1), 200);
    assertEquals(pushed, [140, 150, 200]);
    assertEquals(await loadZoom(dir), 200);
    // A restart reads it back.
    const again = createZoomStore({
      load: () => loadZoom(dir),
      save: () => Promise.resolve(),
      onChange: () => {},
    });
    await again.ready();
    assertEquals(again.level(), 200);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("zoom store: a failed write keeps the level; a failed read is 100%", async () => {
  const errors: unknown[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    const store = createZoomStore({
      load: () => Promise.reject(new Error("unreadable")),
      save: () => Promise.reject(new Error("disk full")),
      onChange: () => {},
    });
    await store.ready();
    assertEquals(store.level(), 100);
    assertEquals(await store.set(120), 120);
    assertEquals(store.level(), 120);
    assertEquals(errors.length, 1);
  } finally {
    console.error = orig;
  }
});

// --- the zoomed layout ----------------------------------------------------------------------

Deno.test("zoom layout: 100% sets nothing; zoomed, the effective width picks the breakpoints", () => {
  const plain = zoomLayout(100, 1320, 860);
  assertEquals(Object.values(plain.attrs).filter((v) => v !== null), []);
  assertEquals(plain.vars["--fleet-zoom"], "1");
  assertEquals(plain.vars["--fleet-vh"], "860px");
  // The default window at 150%: 880 px effective (under both breakpoints, not tiny).
  const at150 = zoomLayout(150, 1320, 860);
  assertEquals(at150.vars["--fleet-zoom"], "1.5");
  assertEquals(at150.vars["--fleet-zoom-inv"], "0.666667");
  assertEquals(at150.vars["--fleet-vh"], "573.33px");
  assertEquals(at150.attrs, {
    "data-fleet-zoomed": "",
    "data-fleet-mid": "",
    "data-fleet-narrow": "",
    "data-fleet-tiny": null,
  });
  // The default window at 200% (660 effective) and the smallest one at 150% (573): tiny.
  assertEquals(zoomLayout(200, 1320, 860).attrs["data-fleet-tiny"], "");
  assertEquals(zoomLayout(150, 860, 560).attrs["data-fleet-tiny"], "");
  // A wide window at 120% stays wide.
  const wide = zoomLayout(120, 1920, 1080).attrs;
  assertEquals([wide["data-fleet-mid"], wide["data-fleet-narrow"]], [null, null]);
  // Below 100% the window's own media queries already cover it: no breakpoint attributes.
  const small = zoomLayout(80, 900, 600).attrs;
  assertEquals(small["data-fleet-zoomed"], "");
  assertEquals(small["data-fleet-mid"], null);
});

Deno.test("zoom layout: applied to the root element, attributes removed again at 100%", () => {
  const props = new Map<string, string>();
  const attrs = new Map<string, string>();
  const root = {
    style: { setProperty: (n: string, v: string) => void props.set(n, v) },
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
  applyZoom(root, 200, 1320, 860);
  assertEquals(props.get("--fleet-zoom"), "2");
  assertEquals(props.get("--fleet-vh"), "430px");
  assertEquals(
    [...attrs.keys()].sort(),
    ["data-fleet-mid", "data-fleet-narrow", "data-fleet-tiny", "data-fleet-zoomed"],
  );
  applyZoom(root, 100, 1320, 860);
  assertEquals([...attrs.keys()], []);
  assertEquals(props.get("--fleet-zoom"), "1");
});

// --- the GitHub view ------------------------------------------------------------------------

Deno.test("zoom: the GitHub view gets the window's zoom as its page zoom, where it has one", async () => {
  const zooms: number[] = [];
  const view = {
    id: "1",
    setBounds: () => Promise.resolve(),
    setVisible: () => Promise.resolve(),
    navigate: () => Promise.resolve(),
    back: () => Promise.resolve(),
    forward: () => Promise.resolve(),
    reload: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    close: () => Promise.resolve(),
    on: () => () => {},
    setZoom: (f: number) => (zooms.push(f), Promise.resolve()),
  } as unknown as WebViewHandle;
  const api: WebViewApi = {
    webViewCapabilities: () => Promise.resolve({ supported: true }),
    createWebView: () => Promise.resolve(view),
    attachWebView: () => () => {},
  };
  const browser = new GitHubBrowser({
    openExternal: () => Promise.resolve(),
    webViews: () => nativeWebViews(api),
    revealFallbackMs: 0,
  });
  browser.setZoom(1.5);
  assertEquals(zooms, [], "no view yet");
  await browser.open("https://github.com/Brainwires/denext/actions/runs/1");
  assertEquals(zooms, [1.5], "applied when the view is made");
  browser.setZoom(2);
  browser.setZoom(2);
  assertEquals(zooms, [1.5, 2], "once per change");
  browser.setZoom(NaN);
  assertEquals(zooms, [1.5, 2]);
  browser.dispose();
});

// --- the stylesheet -------------------------------------------------------------------------

interface Rule {
  media: string | null;
  selectors: string[];
  body: string;
}

/** The stylesheet's rules (one level of @media), comments stripped. */
function cssRules(css: string): Rule[] {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const walk = (src: string, media: string | null) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf("{", i);
      if (open < 0) break;
      const head = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(open + 1, j - 1);
      if (head.startsWith("@media")) walk(body, head.replace(/\s+/g, " "));
      else {
        rules.push({ media, selectors: head.split(",").map((s) => s.trim()), body: body.trim() });
      }
      i = j;
    }
  };
  walk(text, null);
  return rules;
}

/** A rule's declarations, normalized. */
const decls = (body: string) =>
  body.split(";").map((d) => d.trim().replace(/\s+/g, " ")).filter(Boolean).sort();

const CSS = Deno.readTextFileSync(new URL("../public/styles.css", import.meta.url));
const RULES = cssRules(CSS);

Deno.test("zoom CSS: each width breakpoint's rules repeated under the effective-width attribute", () => {
  const pairs = [
    ["@media (max-width: 1000px)", ":root[data-fleet-narrow]"],
    ["@media (max-width: 1080px)", ":root[data-fleet-mid]"],
  ] as const;
  for (const [media, attr] of pairs) {
    const originals = RULES.filter((r) =>
      r.media === media && !r.selectors.some((s) => s.startsWith(":root"))
    );
    assert(originals.length > 0, media);
    for (const rule of originals) {
      for (const sel of rule.selectors) {
        const mirror = RULES.find((r) =>
          r.media === null && r.selectors.includes(`${attr} ${sel}`)
        );
        assert(mirror, `${media} ${sel} has no ${attr} copy`);
        // The same declarations, viewport heights read from --fleet-vh.
        const want = decls(rule.body.replaceAll("100vh", "var(--fleet-vh)"));
        assertEquals(decls(mirror.body), want, `${attr} ${sel}`);
      }
    }
  }
});

Deno.test("zoom CSS: no viewport-unit height left unzoomed (the GitHub panel is kept at 100%)", () => {
  const vhRules = RULES.filter((r) =>
    /\b\d+vh\b/.test(r.body) && !r.selectors.some((s) => s.startsWith(":root"))
  );
  assert(vhRules.length > 0);
  for (const rule of vhRules) {
    for (const sel of rule.selectors) {
      if (sel === ".webpanel") continue;
      const override = RULES.find((r) =>
        r.selectors.includes(`:root[data-fleet-zoomed] ${sel}`) && r.body.includes("--fleet-vh")
      );
      assert(override, `${sel} uses vh with no zoomed --fleet-vh override`);
    }
  }
  const panel = RULES.find((r) => r.selectors.includes(":root[data-fleet-zoomed] .webpanel"));
  assert(panel?.body.includes("zoom: var(--fleet-zoom-inv)"), "the panel undoes the zoom");
  const bar = RULES.find((r) => r.selectors.includes(":root[data-fleet-zoomed] .webpanel-bar"));
  assert(bar?.body.includes("zoom: var(--fleet-zoom)"), "the panel's toolbar is zoomed again");
  const body = RULES.find((r) => r.selectors.includes(":root[data-fleet-zoomed] body"));
  assert(body?.body.includes("zoom: var(--fleet-zoom)"));
});

Deno.test("zoom CSS: fixed minimum widths give way when zoomed (no horizontal overflow)", () => {
  // Grids whose fixed column minimums would overflow a zoomed window: relaxed under zoom.
  const charts = RULES.find((r) => r.selectors.includes(":root[data-fleet-zoomed] .charts"));
  assert(charts?.body.includes("minmax(min(420px, 100%), 1fr)"));
  for (const sel of [".lanes", ".lanes-q-empty"]) {
    const tiny = RULES.find((r) => r.selectors.includes(`:root[data-fleet-tiny] ${sel}`));
    assertEquals(tiny && decls(tiny.body), ["grid-template-columns: minmax(0, 1fr)"], sel);
  }
  const narrow = RULES.find((r) => r.selectors.includes(":root[data-fleet-narrow] .pools-row"));
  assert(narrow?.body.includes("minmax(0, 1fr)"), "the GitHub panel's 340 px column stacks");
  // Header-like rows of fixed pieces wrap.
  for (const sel of [".top", ".top-right", ".status", ".settings-head", ".webpanel-bar"]) {
    const wraps = RULES.some((r) =>
      r.selectors.includes(`:root[data-fleet-zoomed] ${sel}`) && r.body.includes("flex-wrap: wrap")
    );
    assert(wraps, sel);
  }
  // Every grid with a fixed px column minimum over 300 px is relaxed at some zoomed width.
  const wide = RULES.filter((r) =>
    r.media === null && !r.selectors.some((s) => s.startsWith(":root")) &&
    /minmax\((3\d\d|[4-9]\d\d)px/.test(r.body)
  );
  for (const rule of wide) {
    for (const sel of rule.selectors) {
      const relaxed = RULES.some((r) =>
        r.selectors.some((s) => s.startsWith(":root[data-fleet-") && s.endsWith(` ${sel}`)) &&
        r.body.includes("grid-template-columns")
      );
      assert(relaxed, `${sel} keeps a fixed column minimum when zoomed`);
    }
  }
});
