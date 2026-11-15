#!/usr/bin/env -S deno run -A
// The `desktop:package:internal` task's entry (deno.json), which static analysis doesn't follow.
// fallow-ignore-file unused-file
/**
 * `denext task desktop:package:internal`: `denext desktop package` with FLEET_INTERNAL=1, which bakes
 * this machine's local grants (lib/build-grants.ts). The package step writes the resolved desktop
 * config, those local paths included, into the tracked `.deno-desktop/config.json`; this wrapper
 * puts the file's bytes back afterwards (on failure too), so an internal build never leaves the
 * tracked file dirty with one machine's paths for a commit to pick up.
 *
 *   deno run -A scripts/package-internal.ts [package flags…]
 */

const CONFIG = new URL("../.deno-desktop/config.json", import.meta.url);
const CLI = "jsr:@denext/denext@^4.18.0/cli";

async function readIfThere(url: URL): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(url);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return null;
    throw err;
  }
}

const saved = await readIfThere(CONFIG);
let code = 1;
try {
  const child = new Deno.Command(Deno.execPath(), {
    args: ["run", "-A", CLI, "desktop", "package", ".", ...Deno.args],
    cwd: new URL("..", import.meta.url),
    env: { FLEET_INTERNAL: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn();
  code = (await child.status).code;
} finally {
  if (saved) await Deno.writeFile(CONFIG, saved);
  else await Deno.remove(CONFIG).catch(() => {});
}
Deno.exit(code);
