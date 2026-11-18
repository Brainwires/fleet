// The window zoom on the page (lib/zoom.ts): CSS `zoom` on the body by way of the root's custom
// properties and attributes, which public/styles.css's "zoom" block reads. Recomputed on resize: the
// zoomed layout's breakpoints follow the effective width (the window's divided by the zoom).

import { zoomLayout } from "../lib/zoom.ts";

/** The slice of the DOM the zoom touches (the tests pass a fake). */
export interface ZoomRoot {
  style: { setProperty(name: string, value: string): void };
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

/** Set `pct`'s properties on `root` for a `width` × `height` viewport. */
export function applyZoom(root: ZoomRoot, pct: number, width: number, height: number): void {
  const { vars, attrs } = zoomLayout(pct, width, height);
  for (const [name, value] of Object.entries(vars)) root.style.setProperty(name, value);
  for (const [name, on] of Object.entries(attrs)) {
    if (on === null) root.removeAttribute(name);
    else root.setAttribute(name, on);
  }
}

/** Show `level()` on this page now and on every resize; returns the stop. */
export function watchZoom(level: () => number): { update(): void; stop(): void } {
  if (typeof document === "undefined" || !document.documentElement) {
    return { update() {}, stop() {} };
  }
  const update = () =>
    applyZoom(
      document.documentElement,
      level(),
      globalThis.innerWidth || document.documentElement.clientWidth || 0,
      globalThis.innerHeight || document.documentElement.clientHeight || 0,
    );
  update();
  globalThis.addEventListener?.("resize", update);
  return { update, stop: () => globalThis.removeEventListener?.("resize", update) };
}
