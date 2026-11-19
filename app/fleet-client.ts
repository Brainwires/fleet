// The page's typed handle on the `fleet` desktop extension (desktop/fleet.ts). Outside a Deno
// Desktop window (`denext task dev` in a browser) every call rejects with code `unavailable`.

import { desktopExtension } from "denext/desktop/client";
import type { FleetEvent } from "../lib/events.ts";
import type { ControlResult, DispatchWorkflow } from "../lib/control-runner.ts";
import type { ControlRequest, PoolRequest } from "./controls.tsx";
import type { Snapshot } from "../lib/model.ts";
export { CHANGED_EVENT } from "../lib/model.ts";
import type { TokenCheck } from "../lib/service.ts";
import type { FleetSettings, SettingsResult } from "../lib/settings.ts";
import type { RepoChoice, TokenInfo } from "../lib/discover.ts";
import type { MachineInfo } from "./settings-view.tsx";
import type { HistoryRange } from "../lib/history.ts";
import type { PoolDetail } from "../lib/pool-detail.ts";
import type { LogError, LogView } from "../lib/logs.ts";
import type { LauncherLog } from "../lib/runner-logs.ts";
import type { ChangeRecord, ConfigSchema, ConfigShow, ValueChange } from "../lib/runner-config.ts";
import type { ConfigResult } from "../lib/config-runner.ts";

import type { MachineSeries, MachinesView } from "../lib/machines.ts";
export { MACHINES_EVENT } from "../lib/machines.ts";
import type { RoutingPreview, RoutingRules } from "../lib/routing.ts";
import type { RoutingLoad, RoutingResult } from "../lib/routing-runner.ts";

/** The runner settings' first load. */
export type ConfigLoad =
  | { ok: true; schema: ConfigSchema; show: ConfigShow; history: ChangeRecord[] }
  | { ok: false; message: string };

/** What the page can ask the backend. */
export interface FleetClient {
  snapshot(args: { visible: boolean }): Promise<Snapshot>;
  events(args: { after: number }): Promise<{ events: FleetEvent[]; lastSeq: number }>;
  visibility(args: { visible: boolean }): Promise<null>;
  capabilities(
    args?: Record<never, never>,
  ): Promise<
    {
      pools: boolean;
      restart?: boolean;
      watchdog?: boolean;
      config?: boolean;
      routing?: boolean;
      machines?: boolean;
    }
  >;
  /** Machines: each machine's newest reading, its pools and jobs, and the sparklines' trails. */
  machines(args?: Record<never, never>): Promise<MachinesView>;
  machineHistory(args: { host: string; range: string }): Promise<MachineSeries | { error: string }>;
  routingLoad(args?: Record<never, never>): Promise<RoutingLoad>;
  routingCheck(args: { draft: RoutingRules }): Promise<RoutingPreview>;
  routingApply(args: { generation: string; draft: RoutingRules }): Promise<RoutingResult>;
  routingRevert(args: { id: string; generation: string }): Promise<RoutingResult>;
  configLoad(args?: Record<never, never>): Promise<ConfigLoad>;
  configCheck(
    args: { changes: ValueChange[] },
  ): Promise<{ ok: boolean; errors: string[]; warnings: string[] }>;
  configApply(args: { generation: string; changes: ValueChange[] }): Promise<ConfigResult>;
  configRevert(args: { id: string; generation: string }): Promise<ConfigResult>;
  configStatus(args: { id: string }): Promise<ChangeRecord | null>;
  settings(args?: Record<never, never>): Promise<{ settings: FleetSettings; machine: MachineInfo }>;
  saveSettings(args: { settings: FleetSettings }): Promise<SettingsResult>;
  tokenInfo(args?: Record<never, never>): Promise<TokenInfo>;
  ownerRepos(args: { owner: string; kind: "org" | "user" }): Promise<RepoChoice[]>;
  settingsShown(args?: Record<never, never>): Promise<null>;
  repos(args?: Record<never, never>): Promise<string[]>;
  workflows(args: { repo: string }): Promise<DispatchWorkflow[]>;
  control(args: ControlRequest): Promise<ControlResult>;
  poolControl(args: PoolRequest): Promise<ControlResult>;
  refresh(args?: Record<never, never>): Promise<Snapshot>;
  setToken(args: { token: string }): Promise<TokenCheck>;
  retryGh(args?: Record<never, never>): Promise<boolean>;
  clearToken(args?: Record<never, never>): Promise<null>;
  usePublic(args?: Record<never, never>): Promise<null>;
  poolDetail(args: { pool: string; range: HistoryRange }): Promise<PoolDetail>;
  runnerLogList(args: { pool: string }): Promise<{ configured: boolean; logs: LauncherLog[] }>;
  poolLogLines(
    args: { pool: string },
  ): Promise<{ configured: boolean; scheduler: string[]; alerts: string[] }>;
  runnerLog(
    args: { pool: string; file: string; after?: number; before?: number },
  ): Promise<LogView | LogError>;
  runnerLogForJob(args: { jobId: number }): Promise<LogView | LogError>;
  jobLog(args: { repo: string; jobId: number }): Promise<LogView | LogError>;
  /** The window zoom (percent, lib/zoom.ts) every page shows. */
  zoom(args?: Record<never, never>): Promise<number>;
  /** Keep a new window zoom; answers the level kept (clamped). */
  setZoom(args: { zoom: number }): Promise<number>;
}

/** The backend. */
export const fleet = desktopExtension("fleet") as unknown as FleetClient;

/** A bridge error's message, for the page. */
export function errorText(err: unknown): string {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === "unavailable") return "Fleet's backend runs only in the desktop app.";
  return typeof e?.message === "string" ? e.message : String(err);
}
