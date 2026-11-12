// The GitHub webhook receiver: `POST /github/hooks` on 127.0.0.1:8789, behind the Cloudflare tunnel
// `denext-ci-hooks` (ci-hooks.denext.dev). A web-standard Request → Response handler, so the tests
// drive it without a socket.
//
// In order, before anything is parsed:
// 1. one route: anything but `POST /github/hooks` is 404;
// 2. `content-type: application/json`, else 415;
// 3. the body is at most 1 MiB (a larger Content-Length is refused unread; a longer stream is cut
//    off at the cap), else 413;
// 4. `X-Hub-Signature-256` is the HMAC-SHA256 of the raw body under the secret (constant-time
//    compare), else 401 "rejected signature" and nothing else is read or logged;
// 5. then: `ping` → 200; `workflow_job` / `workflow_run` → 202 and queued (a delivery id seen
//    before is acknowledged and dropped); any other event → 202, ignored.
//
// Payloads are data: nothing in one is executed, fetched or handed to a shell. Processing happens
// after the response (GitHub's timeout is 10 s; this answers in well under 1 s).

/** The route. */
export const HOOK_PATH = "/github/hooks";
/** The listen address: loopback only. */
export const HOOK_HOST = "127.0.0.1";
export const HOOK_PORT = 8789;
/** The body cap. */
export const MAX_BODY = 1024 * 1024;
/** Delivery ids remembered for de-duplication. */
export const DEDUPE_KEEP = 10_000;

/** The events Fleet uses. */
export type HookEventName = "workflow_job" | "workflow_run";

/** A verified delivery. */
export interface HookDelivery {
  readonly id: string;
  readonly event: HookEventName;
  readonly receivedAt: number;
  /** The parsed JSON body (data only). */
  readonly payload: Record<string, unknown>;
}

/** The handler's options. */
export interface HookHandlerOptions {
  /** The webhook secret (bytes or text). Never logged. */
  readonly secret: string;
  /** Called after the response for each new verified workflow_job / workflow_run delivery. */
  readonly onDelivery: (d: HookDelivery) => void;
  /** Called for every verified delivery, `ping` included (for "last delivery"). */
  readonly onVerified?: (event: string, at: number) => void;
  readonly now?: () => number;
  /** Where a refusal is noted (only its kind, never the body or headers). */
  readonly onReject?: (why: "signature" | "size" | "type" | "route" | "json") => void;
  /** Defer processing past the response (default: a macrotask). */
  readonly defer?: (fn: () => void) => void;
}

const enc = new TextEncoder();

/** Lower-case hex of bytes. */
function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string compare (same length checked first; the length is not secret). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `sha256=<hex>` for a body under a secret (what GitHub sends; tests sign with it too). */
export async function signBody(secret: string, body: Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `sha256=${hex(await crypto.subtle.sign("HMAC", key, body as BufferSource))}`;
}

/** Read at most `max` bytes of a body; `null` when it is longer. */
async function readCapped(req: Request, max: number): Promise<Uint8Array | null> {
  const len = Number(req.headers.get("content-length"));
  if (Number.isFinite(len) && len > max) {
    await req.body?.cancel().catch(() => {});
    return null;
  }
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

/** The receiver's request handler. */
export function createHookHandler(o: HookHandlerOptions): (req: Request) => Promise<Response> {
  const now = o.now ?? Date.now;
  const defer = o.defer ?? ((fn) => setTimeout(fn, 0));
  const seen = new Set<string>();
  const order: string[] = [];
  const remember = (id: string) => {
    seen.add(id);
    order.push(id);
    if (order.length > DEDUPE_KEEP) seen.delete(order.shift()!);
  };
  return async (req) => {
    const url = new URL(req.url);
    if (req.method !== "POST" || url.pathname !== HOOK_PATH) {
      await req.body?.cancel().catch(() => {});
      o.onReject?.("route");
      return text(404, "not found");
    }
    const type = (req.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (type !== "application/json") {
      await req.body?.cancel().catch(() => {});
      o.onReject?.("type");
      return text(415, "content-type must be application/json");
    }
    const body = await readCapped(req, MAX_BODY);
    if (body === null) {
      o.onReject?.("size");
      return text(413, "body too large");
    }
    const sig = req.headers.get("x-hub-signature-256") ?? "";
    const want = await signBody(o.secret, body);
    if (!sig || !safeEqual(sig, want)) {
      o.onReject?.("signature");
      return text(401, "rejected signature");
    }
    // Verified: only now is anything else read.
    const event = req.headers.get("x-github-event") ?? "";
    const id = req.headers.get("x-github-delivery") ?? "";
    const at = now();
    o.onVerified?.(event, at);
    if (event === "ping") return text(200, "pong");
    if (event !== "workflow_job" && event !== "workflow_run") return text(202, "ignored");
    if (!id) return text(202, "no delivery id");
    if (seen.has(id)) return text(202, "duplicate");
    let payload: unknown;
    try {
      payload = JSON.parse(new TextDecoder().decode(body));
    } catch {
      o.onReject?.("json");
      return text(400, "bad json");
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
      o.onReject?.("json");
      return text(400, "bad json");
    }
    remember(id);
    const d: HookDelivery = {
      id,
      event,
      receivedAt: at,
      payload: payload as Record<string, unknown>,
    };
    defer(() => o.onDelivery(d));
    return text(202, "accepted");
  };
}

/** The hooks' state for the status bar. */
export type HooksState = "live" | "stale" | "off";

/** No delivery for this long: stale (and polling reconciles at once if runs are active). */
export const HOOKS_STALE_MS = 10 * 60_000;
/** The hooks' state now. */
export function hooksState(
  enabled: boolean,
  lastDeliveryAt: number | null,
  now: number,
): HooksState {
  if (!enabled) return "off";
  return lastDeliveryAt !== null && now - lastDeliveryAt < HOOKS_STALE_MS ? "live" : "stale";
}

/** A payload's repository full name, if it is a string. */
export function payloadRepo(p: Record<string, unknown>): string | null {
  const r = p.repository as { full_name?: unknown } | undefined;
  return typeof r?.full_name === "string" ? r.full_name : null;
}
