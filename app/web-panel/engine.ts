// The embedded web view API (denext/desktop/window's `createWebView`, `webViewCapabilities`,
// `attachWebView`), feature-detected. The denext Fleet pins does not export them yet; this file
// mirrors the draft's types so Fleet type-checks today and uses the real functions, unchanged, once
// the pinned denext has them. Nothing else in Fleet imports the namespace for these.

import * as desktopWindow from "denext/desktop/window";

/** A web view's rectangle: CSS pixels, relative to the window's page viewport. */
export interface WebViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What `createWebView` opens. */
export interface CreateWebViewOptions {
  url: string;
  bounds: WebViewBounds;
  partition?: string;
  visible?: boolean;
  allowPopups?: "deny" | "same-view" | "browser";
  downloads?: "deny" | "ask" | "browser";
  permissions?: "deny" | "ask";
  userAgent?: string;
}

/** A web view's last load state. */
export type WebViewLoadState = "loading" | "interactive" | "complete" | "failed";

/** The events Fleet listens to (the draft's map has more; listening to them is not needed). */
export interface WebViewEventMap {
  title: { title: string };
  url: { url: string; canGoBack: boolean; canGoForward: boolean };
  load: { state: WebViewLoadState; url: string; error?: { code: string; message: string } };
  "focus-change": { focused: boolean };
  closed: Record<string, never>;
}

/** The slice of a web view handle Fleet uses. */
export interface WebViewHandle {
  readonly id: string;
  setBounds(bounds: WebViewBounds): Promise<void>;
  setVisible(visible: boolean): Promise<void>;
  navigate(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(opts?: { ignoreCache?: boolean }): Promise<void>;
  focus(): Promise<void>;
  on<K extends keyof WebViewEventMap>(event: K, fn: (e: WebViewEventMap[K]) => void): () => void;
  close(): Promise<void>;
}

/** The element `attachWebView` measures. */
export interface WebViewAnchor {
  getBoundingClientRect(): {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly isConnected?: boolean;
}

/** The three functions, once they exist. */
export interface WebViewApi {
  createWebView(opts: CreateWebViewOptions): Promise<WebViewHandle>;
  webViewCapabilities(): Promise<{ supported: boolean }>;
  attachWebView(handle: WebViewHandle, element: WebViewAnchor): () => void;
}

/** The functions from `ns` when all three are there, else `null`. */
export function webViewApiOf(ns: unknown): WebViewApi | null {
  const m = ns as Partial<Record<keyof WebViewApi, unknown>> | null;
  if (
    typeof m?.createWebView !== "function" ||
    typeof m.webViewCapabilities !== "function" ||
    typeof m.attachWebView !== "function"
  ) return null;
  return m as WebViewApi;
}

/**
 * The web view API when this denext exports it and this window's engine hosts web views, else
 * `null` (an older denext, an engine without them, off desktop).
 */
export async function nativeWebViews(ns: unknown = desktopWindow): Promise<WebViewApi | null> {
  const api = webViewApiOf(ns);
  if (!api) return null;
  try {
    return (await api.webViewCapabilities()).supported ? api : null;
  } catch {
    return null;
  }
}
