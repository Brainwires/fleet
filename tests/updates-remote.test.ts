// The machine updates' remote runner and data files: the one fixed ssh argv (a fake ssh records
// exactly what it was given; an alias or verb outside its pattern never reaches it), the cleared
// environment, the update lock in update-run.json, the audit log, the request spool, and the
// internal build's ssh grant (a release build's grants unchanged).

import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { createSshRemote, createUpdateFiles, REQUEST_FILE_MAX } from "../lib/deno-updates.ts";
import { grantsFromConfig, internalGrants } from "../lib/build-grants.ts";
import {
  SSH_BIN,
  sshArgv,
  sshHost,
  sshProgram,
  validSshAlias,
  validSshConfigPath,
} from "../lib/updates/remote.ts";
import type { RemoteVerb, RunRecord, UpdatesMachine } from "../lib/updates/model.ts";

const posix = Deno.build.os !== "windows";
const CONFIG = "/data/fleet/updates/ssh_config";
const FIXED = [
  "-F",
  CONFIG,
  "-T",
  "-o",
  "BatchMode=yes",
  "-o",
  "IdentitiesOnly=yes",
  "-o",
  "StrictHostKeyChecking=yes",
  "-o",
  "ClearAllForwardings=yes",
  "-o",
  "PermitLocalCommand=no",
];

const BAD_ALIASES = [
  "",
  "-oProxyCommand=id",
  "-F",
  "a b",
  "a;b",
  "a$(id)",
  "a`id`",
  "host\n",
  "user@host",
  "host:22",
  "../x",
  "x".repeat(65),
  "ü",
];

Deno.test("remote: the ssh argv is exactly the fixed one, the host and one verb", () => {
  assertEquals(sshArgv(CONFIG, "linux-1", "busy"), [...FIXED, "linux-1", "busy"]);
  assertEquals(sshArgv(CONFIG, "linux-1", "install-all"), [...FIXED, "linux-1", "install-all"]);
  // status goes to the status key's host entry.
  assertEquals(sshArgv(CONFIG, "linux-1", "status"), [...FIXED, "linux-1-status", "status"]);
  assertEquals(sshHost("mac.x_1", "reboot"), "mac.x_1");
});

Deno.test("remote: an alias, verb or config path outside its pattern never builds an argv", () => {
  for (const a of BAD_ALIASES) {
    assertEquals(validSshAlias(a), false, JSON.stringify(a));
    assertEquals(sshArgv(CONFIG, a, "busy"), null, JSON.stringify(a));
  }
  for (const v of ["", "rm -rf /", "status;reboot", "STATUS", "install", "__job", "reboot "]) {
    assertEquals(sshArgv(CONFIG, "linux-1", v as RemoteVerb), null, v);
  }
  for (const c of ["", "relative/ssh_config", "-oProxyCommand=id", "/a\nb", "~/x"]) {
    assertEquals(validSshConfigPath(c), false, c);
    assertEquals(sshArgv(c, "linux-1", "busy"), null, c);
  }
});

Deno.test("remote: only /usr/bin/ssh is ever the program", () => {
  assertEquals(sshProgram(undefined), SSH_BIN);
  assertEquals(sshProgram(SSH_BIN), SSH_BIN);
  assertEquals(sshProgram("/opt/homebrew/bin/ssh"), null);
  assertEquals(sshProgram("ssh"), null);
});

const machine = (via: UpdatesMachine["via"]): UpdatesMachine => ({
  id: "linux-1",
  os: "ubuntu",
  kind: "runner",
  via,
  self: false,
  install: "security",
  pools: [],
  busy: ["remote"],
  verify: { mounts: [], reach: [] },
  reboot: "if-needed",
  drainCapMinutes: 90,
});

/** A fake ssh that writes its argv (one per line) and two environment probes, then `body`. */
async function fakeSsh(body: string): Promise<{ program: string; log: string }> {
  const dir = await Deno.makeTempDir({ prefix: "fleet-ssh-" });
  const log = `${dir}/argv`;
  const program = `${dir}/ssh`;
  await Deno.writeTextFile(
    program,
    `#!/bin/sh
for a in "$@"; do printf '%s\\n' "$a"; done >'${log}'
printf 'SSH_AUTH_SOCK=%s\\nFLEET_PROBE=%s\\n' "\${SSH_AUTH_SOCK-unset}" "\${FLEET_PROBE-unset}" >>'${log}'
${body}
`,
    { mode: 0o755 },
  );
  await Deno.chmod(program, 0o755);
  return { program, log };
}

Deno.test({
  name: "remote runner: a fake ssh receives exactly the fixed argv, with a cleared environment",
  ignore: !posix,
  async fn() {
    const { program, log } = await fakeSsh("echo '{\"busy\":false}'\nexit 10");
    Deno.env.set("SSH_AUTH_SOCK", "/tmp/agent.sock");
    Deno.env.set("FLEET_PROBE", "leak");
    try {
      const remote = createSshRemote({ configFile: CONFIG, program });
      const r = await remote.run(machine({ ssh: "linux-1" }), "busy", { timeoutMs: 10_000 });
      assertEquals([r.code, r.unreachable, r.timedOut], [10, false, false]);
      assertEquals(r.stdout, '{"busy":false}\n');
      const lines = (await Deno.readTextFile(log)).trimEnd().split("\n");
      assertEquals(lines.slice(0, -2), [...FIXED, "linux-1", "busy"]);
      assertEquals(lines.slice(-2), ["SSH_AUTH_SOCK=unset", "FLEET_PROBE=unset"]);
    } finally {
      Deno.env.delete("SSH_AUTH_SOCK");
      Deno.env.delete("FLEET_PROBE");
    }
  },
});

Deno.test({
  name: "remote runner: refused aliases, verbs and the local machine never start ssh",
  ignore: !posix,
  async fn() {
    const { program, log } = await fakeSsh("exit 0");
    const remote = createSshRemote({ configFile: CONFIG, program });
    for (const a of BAD_ALIASES) {
      const r = await remote.run(machine({ ssh: a }), "busy", { timeoutMs: 5_000 });
      assertEquals(r.code, -1);
    }
    for (const v of ["reboot now", "status;id", "x"]) {
      await remote.run(machine({ ssh: "linux-1" }), v as RemoteVerb, { timeoutMs: 5_000 });
    }
    assertEquals((await remote.run(machine("local"), "status", { timeoutMs: 5_000 })).code, -1);
    const bad = createSshRemote({ configFile: "relative", program });
    assertEquals(
      (await bad.run(machine({ ssh: "linux-1" }), "busy", { timeoutMs: 5_000 })).code,
      -1,
    );
    await assertRejects(() => Deno.stat(log), Deno.errors.NotFound, undefined, "ssh never ran");
  },
});

Deno.test({
  name: "remote runner: ssh's own failure is unreachable; the time cap stops it",
  ignore: !posix,
  async fn() {
    const failing = await fakeSsh("exit 255");
    let r = await createSshRemote({ configFile: CONFIG, program: failing.program })
      .run(machine({ ssh: "linux-1" }), "boot-id", { timeoutMs: 5_000 });
    assertEquals([r.code, r.unreachable], [255, true]);
    const slow = await fakeSsh("exec sleep 30");
    const t0 = Date.now();
    r = await createSshRemote({ configFile: CONFIG, program: slow.program })
      .run(machine({ ssh: "linux-1" }), "status", { timeoutMs: 1_000 });
    assertEquals([r.code, r.timedOut], [-1, true]);
    assert(Date.now() - t0 < 10_000);
  },
});

const run = (id: string): RunRecord => ({
  v: 1,
  id,
  machine: "linux-1",
  origin: { kind: "user" },
  mode: "security",
  reboot: "if-needed",
  drainCapMinutes: 90,
  windowEnd: null,
  startedAt: 1,
  step: "preflight",
  stepAt: 1,
  holds: [],
  bootId: null,
  baseline: null,
  installAt: null,
  installOk: null,
  rebootNeeded: false,
  rebooted: false,
  steps: [],
  outcome: null,
  keptHolds: [],
} as unknown as RunRecord);

Deno.test({
  name: "update files: one run holds the lock; files are 0600; the audit appends",
  ignore: !posix,
  async fn() {
    const dir = `${await Deno.makeTempDir()}/data`;
    const files = createUpdateFiles(dir);
    assertEquals(await files.readRun(), null);
    assert(await files.claimRun(run("a-1")));
    assertEquals(await files.claimRun(run("b-1")), false, "a second run is refused");
    assertEquals((await files.readRun())?.id, "a-1");
    await assertRejects(() => files.saveRun(run("b-1")), Error, "another run");
    await files.saveRun({ ...run("a-1"), step: "drain" } as RunRecord);
    assertEquals((await files.readRun())?.step, "drain");
    await files.clearRun("b-1");
    assertEquals((await files.readRun())?.id, "a-1", "another run's clear leaves it");
    await files.clearRun("a-1");
    assertEquals(await files.readRun(), null);
    assert(await files.claimRun(run("c-1")));
    assertEquals((Deno.statSync(`${dir}/update-run.json`).mode ?? 0) & 0o777, 0o600);
    assertEquals((Deno.statSync(dir).mode ?? 0) & 0o777, 0o700);
    assertEquals([...Deno.readDirSync(dir)].filter((e) => e.name.endsWith(".tmp")), []);

    const entry = { v: 1, id: "a-1", machine: "linux-1", outcome: "succeeded", steps: [] };
    await files.appendAudit(entry as never);
    await files.appendAudit({ ...entry, id: "a-2" } as never);
    Deno.writeTextFileSync(`${dir}/update-runs.jsonl`, "{torn\n", { append: true });
    assertEquals((await files.readAudit(10)).map((e) => (e as { id: string }).id), ["a-1", "a-2"]);
    assertEquals((await files.readAudit(1)).length, 1);
    assertEquals((Deno.statSync(`${dir}/update-runs.jsonl`).mode ?? 0) & 0o777, 0o600);

    await files.writeJson("updates.json", { machines: {} });
    assertEquals(await files.readJson("updates.json"), { machines: {} });
    assertEquals(await files.readJson("update-schedules.json"), null);
  },
});

Deno.test({
  name: "update files: the request spool reads plain small files only, never through a symlink",
  ignore: !posix,
  async fn() {
    const dir = await Deno.makeTempDir();
    const spool = `${dir}/update-requests`;
    Deno.mkdirSync(spool);
    Deno.writeTextFileSync(`${spool}/r1.json`, '{"machine":"linux-1"}');
    Deno.writeTextFileSync(`${spool}/r2.json`, "not json");
    Deno.writeTextFileSync(`${spool}/big.json`, `"${"x".repeat(REQUEST_FILE_MAX)}"`);
    Deno.writeTextFileSync(`${spool}/bad name.json`, "{}");
    Deno.writeTextFileSync(`${dir}/secret.json`, '{"secret":true}');
    Deno.symlinkSync(`${dir}/secret.json`, `${spool}/link.json`);
    const files = createUpdateFiles(dir);
    assertEquals(await files.readRequests(), [{ id: "r1", doc: { machine: "linux-1" } }]);
    await files.removeRequest("../secret");
    assert(Deno.statSync(`${dir}/secret.json`).isFile, "a path never escapes the spool");
    await files.removeRequest("r1");
    assertEquals(await files.readRequests(), []);
  },
});

const withUpdates = (updates: unknown) => ({ v: 1, integrations: { updates } });

Deno.test("build grants: the updates section adds /usr/bin/ssh to an internal build only", () => {
  assertEquals(grantsFromConfig(withUpdates({ machines: [] }), "/h").run, [SSH_BIN]);
  assertEquals(
    grantsFromConfig(withUpdates({ ssh: { program: SSH_BIN, configFile: "/x" } }), "/h").run,
    [SSH_BIN],
  );
  assertEquals(grantsFromConfig({ v: 1 }, "/h").run, [], "no section, no ssh");
  assertThrows(
    () => grantsFromConfig(withUpdates({ ssh: { program: "/tmp/ssh" } }), "/h"),
    Error,
    SSH_BIN,
  );
  // A release build: nothing, whatever the local config says.
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const cfg = JSON.stringify(withUpdates({ machines: [] }));
  assertEquals(internalGrants(env({ HOME: "/h" }), () => cfg), { run: [], write: [], net: [] });
  assertEquals(internalGrants(env({ FLEET_INTERNAL: "1", HOME: "/h" }), () => cfg).run, [SSH_BIN]);
});
