// The page's typed handle on the `fleet` desktop extension (desktop/fleet.ts). Outside a Deno
// Desktop window (`denext task dev` in a browser) every call rejects with code `unavailable`.

import { desktopExtension } from "denext/desktop/client";
import type { FleetEvent } from "../lib/events.ts";
import type { ControlResult, DispatchWorkflow } from "../lib/control-runner.ts";
import type { ControlRequest, PoolRequest } from "./controls.tsx";
import type { Snapshot } from "../lib/model.ts";
export { CHANGED_EVENT } from "../lib/model.ts";
import type { TokenCheck } from "../lib/service.ts";

/** What the page can ask the backend. */
export interface FleetClient {
  snapshot(args: { visible: boolean }): Promise<Snapshot>;
  events(args: { after: number }): Promise<{ events: FleetEvent[]; lastSeq: number }>;
  visibility(args: { visible: boolean }): Promise<null>;
  capabilities(args?: Record<never, never>): Promise<{ pools: boolean }>;
  repos(args?: Record<never, never>): Promise<string[]>;
  workflows(args: { repo: string }): Promise<DispatchWorkflow[]>;
  control(args: ControlRequest): Promise<ControlResult>;
  poolControl(args: PoolRequest): Promise<ControlResult>;
  refresh(args?: Record<never, never>): Promise<Snapshot>;
  setToken(args: { token: string }): Promise<TokenCheck>;
  retryGh(args?: Record<never, never>): Promise<boolean>;
  clearToken(args?: Record<never, never>): Promise<null>;
  usePublic(args?: Record<never, never>): Promise<null>;
}

/** The backend. */
export const fleet = desktopExtension("fleet") as unknown as FleetClient;

/** A bridge error's message, for the page. */
export function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "unavailable") return "Fleet's backend runs only in the desktop app.";
  return typeof e?.message === "string" ? e.message : String(err);
}
