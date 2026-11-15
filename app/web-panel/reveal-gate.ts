// When the panel's web view may show: never before the page a link asked for has loaded, so a click
// never shows a blank view, about:blank or the previous link's page. Until then the view stays hidden
// and the panel shows its own loading state (github-panel.tsx).
//
// A load for the link starts ("loading"), then reaches "interactive" (painted, the DOM parsed) or
// "complete"; that opens the gate. A new view requests its first page at creation and its "loading"
// event may come before Fleet listens, so a new view waits for the commit alone. A reused view
// waits for its new load to start first, so a late "complete" of the page it was on doesn't count.
// A fallback timer opens the gate if no load event comes (a same-document link fires none).

/** What the gate waits for (`null`: open, or closed by a failed load). */
type Phase = "start" | "commit" | null;

export interface RevealGateDeps {
  /** The gate opened: show the view. */
  onReveal(): void;
  /** How long to wait at most before showing the view anyway (0: never). */
  fallbackMs: number;
}

export class RevealGate {
  #deps: RevealGateDeps;
  #phase: Phase = null;
  #open = false;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(deps: RevealGateDeps) {
    this.#deps = deps;
  }

  /** The view may show. */
  get open(): boolean {
    return this.#open;
  }

  /** The view is hidden and waiting for its page. */
  get waiting(): boolean {
    return this.#phase !== null;
  }

  /** Close the gate until the next load: `fresh` for a new view (its load already started). */
  close(fresh: boolean): void {
    this.#open = false;
    this.#phase = fresh ? "commit" : "start";
    this.#arm();
  }

  /** A main-frame load event. Returns whether it opened the gate. */
  load(state: "loading" | "interactive" | "complete" | "failed"): boolean {
    if (this.#phase === null) return false;
    if (state === "loading") {
      this.#phase = "commit";
      return false;
    }
    if (state === "failed") {
      // Hidden: the panel shows the error in its own UI; Reload closes the gate again.
      this.#phase = null;
      this.#disarm();
      return false;
    }
    if (this.#phase !== "commit") return false;
    this.#reveal();
    return true;
  }

  /** Stop waiting (the panel closed, or the view did). */
  cancel(): void {
    this.#phase = null;
    this.#open = false;
    this.#disarm();
  }

  #reveal(): void {
    this.#phase = null;
    this.#open = true;
    this.#disarm();
    this.#deps.onReveal();
  }

  #arm(): void {
    this.#disarm();
    if (this.#deps.fallbackMs > 0) {
      this.#timer = setTimeout(() => {
        this.#timer = undefined;
        if (this.#phase === null) return;
        // Diagnostics: the runtime reported no load for the link's page in time.
        console.warn(`fleet: web view shown without a load event (waited for ${this.#phase})`);
        this.#reveal();
      }, this.#deps.fallbackMs);
    }
  }

  #disarm(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
