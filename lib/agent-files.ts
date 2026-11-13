// The files Fleet writes in its data folder for agents, by name: shared by the backend
// (lib/deno-host.ts) and the read-only MCP server (mcp/fleet-mcp.ts). No imports, no I/O.

/** The event log and its tracker (the last 2,000 lines; rewritten whole). */
export const LOG_FILE = "fleet-events.json";
/** The agents' snapshot (lib/agent-snapshot.ts), rewritten atomically on every update. */
export const AGENT_SNAPSHOT_FILE = "snapshot.json";
/** The append-only event journal: one event a line, `seq` increasing. */
export const JOURNAL_FILE = "fleet-events.jsonl";
/** The previous journal, after a rotation (one is kept). */
export const JOURNAL_OLD_FILE = "fleet-events.1.jsonl";
/** The journal rotates past this size. */
export const JOURNAL_MAX_BYTES = 5 * 1024 * 1024;
/** The usage history per pool (lib/history.ts), rewritten atomically every few minutes. */
export const HISTORY_FILE = "fleet-history.json";
/** The app's identifier: its data folder's name (macOS `~/Library/Application Support/<id>`). */
export const APP_ID = "dev.brainwires.fleet";
