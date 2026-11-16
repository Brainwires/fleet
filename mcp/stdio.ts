// MCP's stdio transport, shared by the servers in this folder (mcp/fleet-mcp.ts, mcp/ci-mcp.ts):
// newline-delimited JSON-RPC 2.0 on stdin / stdout. Each request runs on its own (a long wait
// doesn't hold up the others), answers and notifications are written in order, and when stdin
// closes the server is closed and every request in flight finishes before this resolves.

type Json = Record<string, unknown>;

/** What a server gives the transport. */
export interface LineServer {
  /** Answer one message (`null`: nothing to answer); `send` writes a message at any time. */
  handle(msg: unknown, send: (msg: Json) => void): Promise<Json | null>;
  /** Stdin closed: abort what's in flight, stop background work. */
  close(): void;
}

/** Serve `server` over stdin / stdout until stdin closes. */
export async function serveLines(server: LineServer): Promise<void> {
  const enc = new TextEncoder();
  let out: Promise<void> = Promise.resolve();
  const send = (msg: Json) => {
    const bytes = enc.encode(JSON.stringify(msg) + "\n");
    out = out.then(async () => {
      let off = 0;
      while (off < bytes.length) off += await Deno.stdout.write(bytes.subarray(off));
    }).catch(() => {});
  };
  const pending = new Set<Promise<void>>();
  let buf = "";
  const dispatch = (line: string) => {
    if (!line.trim()) return;
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    const p = server.handle(msg, send).then((r) => {
      if (r) send(r);
    }).catch(() => {}).finally(() => pending.delete(p));
    pending.add(p);
  };
  for await (const chunk of Deno.stdin.readable.pipeThrough(new TextDecoderStream())) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      dispatch(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  }
  dispatch(buf);
  server.close();
  await Promise.all(pending);
  await out;
}

/** One JSON-RPC message, taken apart, with its answer builders. */
export interface RpcRequest {
  /** `undefined` for a notification (nothing is answered). */
  readonly id: string | number | undefined;
  readonly method: string;
  readonly params: Json;
  reply(result: unknown): Json;
  fail(code: number, message: string): Json;
}

/** The answer to a message that isn't a JSON-RPC object. */
export const INVALID_REQUEST: Json = {
  jsonrpc: "2.0",
  id: null,
  error: { code: -32600, message: "invalid request" },
};

/** A message as an {@linkcode RpcRequest}, or `null` when it isn't an object. */
export function rpcRequest(msg: unknown): RpcRequest | null {
  if (typeof msg !== "object" || msg === null || Array.isArray(msg)) return null;
  const m = msg as Json;
  const id = m.id as string | number | undefined;
  const params = (typeof m.params === "object" && m.params !== null ? m.params : {}) as Json;
  return {
    id,
    method: typeof m.method === "string" ? m.method : "",
    params,
    reply: (result) => ({ jsonrpc: "2.0", id: id ?? null, result }),
    fail: (code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }),
  };
}

/** MCP protocol versions the servers speak (newest first). */
const PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];

/** The protocol version to answer `initialize` with: the client's when spoken, else the newest. */
export function protocolFor(params: Json): string {
  const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
  return PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0];
}

/** A notification: `notifications/cancelled` aborts the request it names; the rest need nothing. */
export function onNotification(rq: RpcRequest, inflight: Map<string | number, AbortController>) {
  if (rq.method === "notifications/cancelled") {
    inflight.get(rq.params.requestId as string | number)?.abort();
  }
}

/** A tools/call's progress reporter (`waiting N s`), silent unless the client sent a token. */
export function progressFor(send: (msg: Json) => void, params: Json): (s: number) => void {
  const token = (params._meta as Json | undefined)?.progressToken;
  return (s) => {
    if (token === undefined) return;
    send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: token, progress: s, message: `waiting ${s} s` },
    });
  };
}
