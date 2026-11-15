"use client";
// The in-app GitHub browser's panel: a toolbar (back, forward, reload, Fleet's home, the page's title
// and URL, Open in browser), a loading bar, an inline error for a failed load, and the placeholder
// the native web view is glued to (app/web-panel/github-browser.ts). It covers Fleet's main view
// while it shows. Until the link's page has loaded the view stays hidden and the placeholder shows
// Fleet's own loading state (a spinner, the page's title or URL), never a blank view.

import { useEffect, useRef } from "denext";
import type { BrowserControls, BrowserState } from "./github-browser.ts";
import type { WebViewAnchor } from "./engine.ts";

export interface GitHubPanelProps {
  readonly browser: BrowserControls;
  readonly state: BrowserState;
  /** Whether the keys are Cmd (macOS) or Ctrl, for the buttons' hints. */
  readonly mac?: boolean;
}

export function GitHubPanel({ browser, state, mac = false }: GitHubPanelProps) {
  const root = useRef<HTMLElement | null>(null);
  const placeholder = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    browser.setAnchor(placeholder.current as WebViewAnchor | null);
    // The keyboard starts in Fleet's own HTML, so Esc and the history keys work at once.
    root.current?.focus?.();
    return () => browser.setAnchor(null);
  }, [browser]);
  const mod = mac ? "⌘" : "Ctrl+";
  return (
    <section class="webpanel" aria-label="GitHub" tabIndex={-1} ref={root}>
      <div class="webpanel-bar" role="toolbar" aria-label="Browser">
        <button
          type="button"
          class="btn webpanel-nav"
          aria-label="Back"
          title={`Back (${mod}[)`}
          disabled={!state.canGoBack && !state.canReturn}
          onClick={() => browser.command("back")}
        >
          ←
        </button>
        <button
          type="button"
          class="btn webpanel-nav"
          aria-label="Forward"
          title={`Forward (${mod}])`}
          disabled={!state.canGoForward}
          onClick={() => browser.command("forward")}
        >
          →
        </button>
        <button
          type="button"
          class="btn webpanel-nav"
          aria-label="Reload"
          title="Reload"
          onClick={() => browser.command("reload")}
        >
          ↻
        </button>
        <button
          type="button"
          class="btn"
          title="Back to Fleet (Esc)"
          onClick={() => browser.command("home")}
        >
          Fleet
        </button>
        <div class="webpanel-where">
          <span class="webpanel-title">{state.title || "GitHub"}</span>
          <span class="webpanel-url">{state.url}</span>
        </div>
        <button
          type="button"
          class="btn"
          disabled={!state.url}
          onClick={() => browser.command("external")}
        >
          Open in browser
        </button>
      </div>
      {state.loading
        ? <div class="webpanel-loading" role="progressbar" aria-label="Loading" />
        : <div class="webpanel-loading-off" aria-hidden="true" />}
      {state.error ? <p class="webpanel-error" role="alert">{state.error}</p> : null}
      <div class="webpanel-view" ref={placeholder}>
        {state.waiting
          ? (
            <div class="webpanel-wait" role="status">
              <span class="webpanel-spinner" aria-hidden="true" />
              <span class="webpanel-wait-text">Loading {state.title || state.url}</span>
            </div>
          )
          : null}
      </div>
    </section>
  );
}
