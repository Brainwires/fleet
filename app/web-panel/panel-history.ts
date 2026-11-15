// Where the web view is in the panel's own history: the view is reused, so its back list still holds
// the pages of earlier panel sessions, and `canGoBack` alone can't tell the first page of this
// session from a later one. Back from the first page returns to Fleet instead (github-browser.ts).
//
// It counts the view's main-frame URL changes since the link opened: the first one is the link's own
// page (index 0), each later one a new entry, except those Fleet caused by a history command (Back
// steps down, Forward up, Reload and a return from an off-GitHub page stay).

/** What caused the next URL change (`null`: the page itself, a new entry). */
export type HistoryCause = "back" | "forward" | "reload" | "bounce";

export class PanelHistory {
  #index = 0;
  #first = true;
  #expect: HistoryCause | null = null;

  /** At the link's own page: Back returns to Fleet. */
  get atStart(): boolean {
    return this.#index === 0;
  }

  /** A new link opened: its page is entry 0. */
  reset(): void {
    this.#index = 0;
    this.#first = true;
    this.#expect = null;
  }

  /** Fleet is about to cause the next URL change. */
  expect(cause: HistoryCause): void {
    this.#expect = cause;
  }

  /** The view's main-frame URL changed. */
  committed(): void {
    const cause = this.#expect;
    this.#expect = null;
    if (this.#first) {
      this.#first = false;
      return;
    }
    if (cause === "back") this.#index = Math.max(0, this.#index - 1);
    else if (cause === "forward") this.#index++;
    else if (cause === null) this.#index++;
  }
}
