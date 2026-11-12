// The webhook receiver without a window, for an end-to-end check of the tunnel and the org webhook:
//
//   denext task hooks
//
// It listens on 127.0.0.1:8789 (POST /github/hooks only), verifies each delivery's signature with
// the keychain secret, appends verified workflow_job / workflow_run deliveries to
// ~/.denext-runners/hooks/events.jsonl, and prints one summary line per delivery: event, action,
// repo, and the job or run name. Never the secret, headers or the body. Stop it with Ctrl+C.
// Don't run it beside the app on the same machine: only one can hold the port.

import { hooksAvailable, readHookSecret, startReceiver } from "./lib/deno-hooks.ts";
import { HOOK_HOST, HOOK_PATH, HOOK_PORT, payloadRepo } from "./lib/hooks.ts";

const str = (
  v: unknown,
) => (typeof v === "string" ? v.replace(/[^\w ./:-]/g, "?").slice(0, 80) : "?");

if (!(await hooksAvailable())) {
  console.error("hooks: not this machine (no tunnel launchd job, or no keychain secret)");
  Deno.exit(2);
}
const secret = await readHookSecret();
if (!secret) {
  console.error("hooks: the keychain secret couldn't be read");
  Deno.exit(2);
}
let n = 0;
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
});
if (!receiver) {
  console.error(`hooks: ${HOOK_HOST}:${HOOK_PORT} is taken`);
  Deno.exit(1);
}
console.log(`hooks: listening on http://${HOOK_HOST}:${HOOK_PORT}${HOOK_PATH}`);
Deno.addSignalListener("SIGINT", () => void receiver.stop().then(() => Deno.exit(0)));
