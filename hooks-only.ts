// The webhook receiver without a window: a background service, or an end-to-end check of the public
// endpoint and the GitHub webhook:
//
//   denext task hooks -- --settings "<data dir>/fleet-settings.json"
//   deno run <grants> hooks-only.ts --spool-dir <dir> --keychain-service <s> --keychain-account <a>
//
// Its configuration is the `webhooks` section of a Fleet settings file (`--settings <file>`, the
// first readable one when given more than once), or flags, which win over the file: `--port`,
// `--spool-dir`, `--keychain-service` + `--keychain-account` (the macOS login keychain; the only
// secret source a process without Fleet's secure store can read) and `--require-launchd-job
// <label>`. It listens on 127.0.0.1 (POST /github/hooks only), verifies each delivery's signature,
// appends verified workflow_job / workflow_run deliveries to `<spool>/events.jsonl`, and prints one
// summary line per delivery: event, action, repo, and the job or run name. Never the secret, headers
// or the body. Stop it with Ctrl+C. Don't run it beside the app on one machine with the same port:
// only one can hold it (Fleet then tails this spool).

import {
  hooksUnavailable,
  readHookSecret,
  recentSpoolIds,
  spoolDirOf,
  startReceiver,
} from "./lib/deno-hooks.ts";
import { HOOK_HOST, HOOK_PATH, payloadRepo } from "./lib/hooks.ts";
import { DEFAULT_SETTINGS, validateSettings, type WebhookSettings } from "./lib/settings.ts";

/** The receiver's configuration from argv (flags over the settings file's `webhooks`). */
export async function receiverConfig(
  args: readonly string[],
  read: (path: string) => Promise<string> = Deno.readTextFile,
): Promise<{ cfg: WebhookSettings; dataDir: string | null } | string> {
  const all = (flag: string): string[] => {
    const out: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === flag && i + 1 < args.length) out.push(args[++i]);
      else if (args[i].startsWith(`${flag}=`)) out.push(args[i].slice(flag.length + 1));
    }
    return out;
  };
  const one = (flag: string) => all(flag).at(-1);
  let cfg: WebhookSettings = { ...DEFAULT_SETTINGS.webhooks, enabled: true };
  let dataDir: string | null = null;
  for (const path of all("--settings")) {
    let raw: unknown;
    try {
      raw = JSON.parse(await read(path));
    } catch {
      continue;
    }
    const r = validateSettings(raw);
    if (!r.ok) return `hooks: ${path} isn't valid settings: ${r.errors.join("; ")}`;
    cfg = { ...r.settings.webhooks, enabled: true };
    // A spool left to its default lives beside the settings file (Fleet's data folder).
    dataDir = path.replace(/[\\/][^\\/]*$/, "") || null;
    break;
  }
  const port = one("--port");
  const service = one("--keychain-service");
  const account = one("--keychain-account");
  const merged = {
    ...cfg,
    ...(port !== undefined ? { port: Number(port) } : {}),
    ...(one("--spool-dir") !== undefined ? { spoolDir: one("--spool-dir")! } : {}),
    ...(one("--require-launchd-job") !== undefined
      ? { requireLaunchdJob: one("--require-launchd-job")! }
      : {}),
    ...(service !== undefined || account !== undefined
      ? { secret: { source: "macos-keychain", service: service ?? "", account: account ?? "" } }
      : {}),
  };
  const r = validateSettings({ v: 1, webhooks: merged });
  if (!r.ok) return `hooks: ${r.errors.join("; ")}`;
  if (r.settings.webhooks.secret.source !== "macos-keychain") {
    return "hooks: the standalone receiver reads its secret from the macOS keychain: " +
      "pass --keychain-service and --keychain-account (or a settings file that names them)";
  }
  if (!r.settings.webhooks.spoolDir && !dataDir) {
    return "hooks: pass --spool-dir (or --settings with Fleet's settings file)";
  }
  return { cfg: r.settings.webhooks, dataDir };
}

const str = (
  v: unknown,
) => (typeof v === "string" ? v.replace(/[^\w ./:-]/g, "?").slice(0, 80) : "?");

if (import.meta.main) {
  const got = await receiverConfig(Deno.args);
  if (typeof got === "string") {
    console.error(got);
    Deno.exit(2);
  }
  const { cfg, dataDir } = got;
  const why = await hooksUnavailable(cfg);
  if (why) {
    console.error(`hooks: not this machine (${why})`);
    Deno.exit(2);
  }
  const secret = await readHookSecret(cfg);
  if (!secret) {
    console.error("hooks: the keychain secret couldn't be read (or is shorter than 32 characters)");
    Deno.exit(2);
  }
  const spoolDir = spoolDirOf(cfg, dataDir);
  let n = 0;
  // The ids already spooled: a replay of one after a restart is still a duplicate.
  const seen = await recentSpoolIds(spoolDir).catch(() => []);
  const receiver = startReceiver(secret, {
    onDelivery: (d) => {
      const p = d.payload;
      const item = (d.event === "workflow_job" ? p.workflow_job : p.workflow_run) as
        | Record<string, unknown>
        | undefined;
      console.log(
        `${new Date(d.receivedAt).toISOString()} #${++n} ${d.event} ${str(p.action)} ` +
          `${str(payloadRepo(p))} ${str(item?.name)} ${str(item?.status)}/${str(item?.conclusion)}`,
      );
    },
    onVerified: (event) => {
      if (event === "ping") console.log(`${new Date().toISOString()} ping (signature verified)`);
    },
    onReject: (why) => console.log(`${new Date().toISOString()} rejected ${why}`),
  }, { seen, port: cfg.port, spoolDir });
  if (!receiver) {
    console.error(`hooks: ${HOOK_HOST}:${cfg.port} is taken`);
    Deno.exit(1);
  }
  console.log(`hooks: listening on http://${HOOK_HOST}:${cfg.port}${HOOK_PATH}`);
  Deno.addSignalListener("SIGINT", () => void receiver.stop().then(() => Deno.exit(0)));
}
