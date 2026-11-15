// The embedded web view API (denext/desktop/window's `createWebView`, `webViewCapabilities`,
// `attachWebView`, denext 4.18+), feature-detected: a window whose engine hosts no web views (or a
// runtime without them) answers `supported: false`, and Fleet then opens GitHub links in the system
// browser. The types are denext's own; Fleet names the slice of a handle it uses, so the tests' fake
// view implements only that. Nothing else in Fleet imports the namespace for these.

import * as desktopWindow from "denext/desktop/window";
import type {
  CreateWebViewOptions,
  WebViewAnchor,
  WebViewCapabilities,
  WebViewEventMap,
  WebViewHandle as DenextWebViewHandle,
} from "denext/desktop/window";

export type { CreateWebViewOptions, WebViewAnchor, WebViewEventMap };

/** The slice of a web view handle Fleet uses. */
export type WebViewHandle = Pick<
  DenextWebViewHandle,
  | "id"
  | "setBounds"
  | "setVisible"
  | "navigate"
  | "back"
  | "forward"
  | "reload"
  | "stop"
  | "focus"
  | "on"
  | "close"
>;

/** The three functions, once they exist. */
export interface WebViewApi {
  createWebView(opts: CreateWebViewOptions): Promise<WebViewHandle>;
  webViewCapabilities(): Promise<Pick<WebViewCapabilities, "supported">>;
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
