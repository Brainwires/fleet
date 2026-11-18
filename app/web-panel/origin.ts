// Where a GitHub link was clicked: the panel's "origin", restored when the panel returns to Fleet
// (Back from its first page, Esc, the Fleet button). The screen (the dashboard or one pool's detail
// screen, with its range and tab) is FleetApp's state; the scroll offsets are the DOM's, and are
// captured here because the main view is `hidden` (display: none) under the panel, which drops every
// scroller's offset.
//
// No JSX; DOM through the small interfaces below, so the tests drive it with plain objects.

import type { HistoryRange } from "../../lib/history.ts";

/** A pool detail screen's tab. */
export type DetailTab = "usage" | "logs" | "settings";

/** A scroller and where it was. */
export interface ScrollMark {
  readonly el: Scroller;
  readonly top: number;
  readonly left: number;
}

/** The slice of an element whose scroll offset is kept. */
export interface Scroller {
  scrollTop: number;
  scrollLeft: number;
}

/** The slice of a root element whose scrollers are found. */
export interface ScrollRoot extends Scroller {
  querySelectorAll(selectors: string): ArrayLike<Scroller>;
}

/** The screen a link came from. */
export interface PanelOrigin {
  /** The pool detail screen's pool, or `null` for the dashboard. */
  readonly pool: string | null;
  readonly range: HistoryRange;
  readonly tab: DetailTab;
  /** Every scroller that was scrolled (the page's own scrolling element included). */
  readonly scroll: readonly ScrollMark[];
}

/** The scrolled elements among `roots` and their descendants (unscrolled ones are left out). */
export function captureScroll(roots: readonly (ScrollRoot | null | undefined)[]): ScrollMark[] {
  const marks: ScrollMark[] = [];
  const seen = new Set<Scroller>();
  const add = (el: Scroller) => {
    if (seen.has(el)) return;
    seen.add(el);
    if (el.scrollTop !== 0 || el.scrollLeft !== 0) {
      marks.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
  };
  for (const root of roots) {
    if (!root) continue;
    add(root);
    const all = root.querySelectorAll("*");
    for (let i = 0; i < all.length; i++) add(all[i]);
  }
  return marks;
}

/** Put every scroller back where it was. */
function restoreScroll(marks: readonly ScrollMark[]): void {
  for (const m of marks) {
    m.el.scrollTop = m.top;
    m.el.scrollLeft = m.left;
  }
}

/** What FleetApp restores: the screen's state setters. */
export interface OriginTarget {
  setPool(pool: string | null): void;
  setRange(range: HistoryRange): void;
  setTab(tab: DetailTab): void;
}

/**
 * Restore `origin`'s screen now and its scroll offsets once that screen has laid out again
 * (`afterLayout`: two animation frames in the page).
 */
export function restoreOrigin(
  origin: PanelOrigin,
  target: OriginTarget,
  afterLayout: (fn: () => void) => void,
): void {
  target.setTab(origin.tab);
  target.setRange(origin.range);
  target.setPool(origin.pool);
  if (origin.scroll.length > 0) afterLayout(() => restoreScroll(origin.scroll));
}
