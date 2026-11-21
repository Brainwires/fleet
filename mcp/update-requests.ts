// The MCP server's one write: an agent's update request, one new file in the data folder's
// `update-requests/` spool (the server's only `--allow-write`). It creates the spool folder (0700)
// and the file (0600, created exclusively, so nothing pre-placed is written through) and nothing
// else: no other path, no rename, no delete. The request was checked first
// (lib/updates/requests.ts); Fleet re-checks it when it lists the spool, and nothing runs until the
// user approves it in Fleet's dialog.

import { UPDATE_REQUESTS_DIR } from "../lib/agent-files.ts";
import { requestFile, requestIdOf, type UpdateRequest } from "../lib/updates/requests.ts";

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

/** The spool folder for a data folder. */
export const spoolDir = (dataDir: string): string => join(dataDir, UPDATE_REQUESTS_DIR);

/** The request files in the spool (names only; Fleet's readers parse them), or `[]`. */
export async function spoolFiles(dataDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(spoolDir(dataDir))) {
      if (e.isFile && requestIdOf(e.name)) out.push(e.name);
      if (out.length > 1000) break;
    }
  } catch {
    // No spool yet.
  }
  return out;
}

/** Write one request file. Throws when the file exists or the spool can't be written. */
export async function writeRequest(dataDir: string, req: UpdateRequest): Promise<string> {
  const dir = spoolDir(dataDir);
  await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, requestFile(req.id));
  await Deno.writeTextFile(path, JSON.stringify(req) + "\n", { createNew: true, mode: 0o600 });
  return path;
}
