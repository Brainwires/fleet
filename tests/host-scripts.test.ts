// The host-side helpers (host/linux, host/macos) against fake programs in a scratch tree: each gate
// verb runs exactly its command, anything else exits 64 having run nothing, injection strings in
// SSH_ORIGINAL_COMMAND run nothing, and the documents they print parse with lib/updates' parsers.
// The scripts are copied with their marked location lines rewritten (ROOT, PATH, HOOK_UID); nothing
// here runs a real package manager, sudo, shutdown or ssh. POSIX hosts only (the gates are sh).

import { assert, assertEquals, assertFalse, assertMatch, assertStringIncludes } from "@std/assert";
import { parseAptStatus } from "../lib/updates/collect-apt.ts";
import { parseDnfStatus } from "../lib/updates/collect-dnf.ts";
import { parseMacStatus } from "../lib/updates/collect-macos.ts";
import { parseResultDoc, parseVerifyDoc } from "../lib/updates/model.ts";

const HOST = new URL("../host/", import.meta.url).pathname;
const posix = Deno.build.os !== "windows";
/** Ubuntu's /bin/sh is dash: run the scripts under dash where the test machine has it. */
const SH = (() => {
  try {
    return Deno.statSync("/bin/dash").isFile ? "/bin/dash" : "/bin/sh";
  } catch {
    return "/bin/sh";
  }
})();

/** Strings an attacker might put in SSH_ORIGINAL_COMMAND. None may run anything. */
const INJECTIONS = [
  "",
  "STATUS",
  " status",
  "status ",
  "status\n",
  "status;reboot",
  "install-all; id",
  "install-all && id",
  "reboot|id",
  "$(id)",
  "`id`",
  "install-*",
  "*",
  "reboot\nreboot",
  "install-security install-all",
  "../../bin/sh",
  "-c id",
  "__job install-all",
  "boot-id\u0001reboot", // (a NUL can't reach an environment variable at all)
];

interface Tree {
  root: string;
  bin: string;
  log: string;
  /** The recorded calls, one line each: `name [arg] [arg]…`. */
  calls(): string[];
  clear(): void;
  fake(name: string, body?: string): void;
  write(path: string, text: string, mode?: number): void;
  install(src: string, dest: string): string;
  run(script: string, args: string[], cmd?: string): Promise<{ code: number; out: string }>;
}

/** A recording fake: logs its name and argv (each in brackets), then runs `body`. */
function fakeScript(log: string, name: string, body: string): string {
  return `#!/bin/sh
{ printf '%s' '${name}'; for a in "$@"; do printf ' [%s]' "$a"; done; printf '\\n'; } >>'${log}'
${body}
`;
}

async function tree(): Promise<Tree> {
  const root = await Deno.realPath(await Deno.makeTempDir({ prefix: "fleet-host-" }));
  const bin = `${root}/fakebin`;
  const log = `${root}/calls.log`;
  await Deno.mkdir(bin);
  await Deno.mkdir(`${root}/home`);
  Deno.writeTextFileSync(log, "");
  const uid = Deno.uid() ?? 0;
  const t: Tree = {
    root,
    bin,
    log,
    calls: () => Deno.readTextFileSync(log).split("\n").filter(Boolean),
    clear: () => Deno.writeTextFileSync(log, ""),
    fake(name, body = "exit 0") {
      Deno.writeTextFileSync(`${bin}/${name}`, fakeScript(log, name, body), { mode: 0o755 });
      Deno.chmodSync(`${bin}/${name}`, 0o755);
    },
    write(path, text, mode = 0o644) {
      const full = `${root}${path}`;
      Deno.mkdirSync(full.replace(/\/[^/]*$/, ""), { recursive: true });
      Deno.writeTextFileSync(full, text);
      Deno.chmodSync(full, mode);
    },
    install(src, dest) {
      const text = Deno.readTextFileSync(`${HOST}${src}`)
        .replace(/^ROOT=$/m, `ROOT=${root}`)
        .replace(/^PATH=.*$/m, `PATH=${bin}:/usr/bin:/bin`)
        .replace(/^HOOK_UID=0$/m, `HOOK_UID=${uid}`);
      t.write(dest, text, 0o755);
      return `${root}${dest}`;
    },
    async run(script, args, cmd) {
      const env: Record<string, string> = { HOME: `${root}/home`, PATH: "/usr/bin:/bin" };
      if (cmd !== undefined) env.SSH_ORIGINAL_COMMAND = cmd;
      const r = await new Deno.Command(SH, {
        args: [script, ...args],
        clearEnv: true,
        env,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      return { code: r.code, out: new TextDecoder().decode(r.stdout) };
    },
  };
  return t;
}

/** The fakes every Linux test needs (sudo and systemd-run pass through; flock / timeout trivial). */
function linuxFakes(t: Tree, os: "ubuntu" | "fedora") {
  t.write(
    "/etc/os-release",
    os === "ubuntu" ? "ID=ubuntu\nID_LIKE=debian\n" : "ID=fedora\nVERSION_ID=41\n",
  );
  t.write("/proc/sys/kernel/random/boot_id", "0a1b2c3d-0000-4000-8000-00000000abcd\n");
  t.write("/proc/mounts", "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /srv/data ext4 rw 0 0\n");
  t.fake("sudo", '[ "$1" = -n ] && shift\nexec "$@"');
  t.fake(
    "systemd-run",
    'while [ "$#" -gt 0 ] && [ "$1" != -- ]; do shift; done\nshift\nINVOCATION_ID=test exec "$@"',
  );
  t.fake("flock");
  t.fake("timeout", 'shift\nexec "$@"');
  t.fake(
    "systemctl",
    `case "$*" in
  "is-active --quiet fleet-update-install.service") exit 3 ;;
  is-system-running) echo running ;;
  "list-unit-files docker.service --no-legend") echo "docker.service enabled enabled" ;;
  "is-active docker.service") echo active ;;
esac
exit 0`,
  );
  const env =
    'echo "env DEBIAN_FRONTEND=${DEBIAN_FRONTEND-} NEEDRESTART_MODE=${NEEDRESTART_MODE-}" >>' +
    `'${t.log}'`;
  t.fake("apt-get", env);
  t.fake("unattended-upgrade", env);
  t.fake(
    "apt",
    `echo "Listing..."
echo 'openssl/noble-updates,noble-security 3.0.13-0ubuntu3.5 amd64 [upgradable from: 3.0.13-0ubuntu3.4]'
echo 'vim/noble-updates 2:9.1.0016-1ubuntu7.4 amd64 [upgradable from: 2:9.1.0016-1ubuntu7.3]'`,
  );
  t.fake(
    "dnf",
    `case "$*" in
  "-q check-update") echo "openssl.x86_64  1:3.2.2-9.fc41  updates"; echo "vim-enhanced.x86_64  2:9.1.1-1.fc41  updates"; exit 100 ;;
  "-q updateinfo list --security") echo "FEDORA-2026-abc  Important/Sec.  openssl-1:3.2.2-9.fc41.x86_64" ;;
  "needs-restarting -r") echo "Core libraries or services have been updated since boot-up:"; echo "  * openssl"; exit 1 ;;
esac
exit 0`,
  );
  t.fake("shutdown");
  t.fake("docker", "exit 0");
}

/** The calls of the commands that matter (the plumbing fakes left out). */
const effects = (t: Tree) =>
  t.calls().filter((l) => !/^(sudo|systemd-run|flock|timeout|systemctl) /.test(l));

async function linuxTree(os: "ubuntu" | "fedora") {
  const t = await tree();
  linuxFakes(t, os);
  const gate = t.install("linux/fleet-update-gate", "/usr/local/sbin/fleet-update-gate");
  const apply = t.install("linux/fleet-update-apply", "/usr/local/sbin/fleet-update-apply");
  Deno.mkdirSync(`${t.root}/etc/fleet-update/busy.d`, { recursive: true });
  Deno.mkdirSync(`${t.root}/etc/fleet-update/verify.d`, { recursive: true });
  return { t, gate, apply };
}

Deno.test({
  name: "linux gate (apt): each verb runs exactly its command",
  ignore: !posix,
  async fn() {
    const { t, gate, apply } = await linuxTree("ubuntu");
    const sudo = (v: string) => `sudo [-n] [${apply}] [${v}]`;
    const env = "env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l";

    let r = await t.run(gate, [], "install-security");
    assertEquals(r.code, 0);
    assertEquals(t.calls()[0], sudo("install-security"));
    assertEquals(effects(t), ["unattended-upgrade [-v]", env]);
    const res = parseResultDoc((await t.run(gate, [], "result")).out);
    assertEquals([res?.state, res?.exitCode], ["succeeded", 0]);

    t.clear();
    r = await t.run(gate, [], "install-all");
    assertEquals(r.code, 0);
    assertEquals(effects(t), [
      "apt-get [-q] [-o] [DPkg::Lock::Timeout=600] [update]",
      env,
      "apt-get [-q] [-y] [-o] [DPkg::Lock::Timeout=600] " +
      "[-o] [APT::Get::Always-Include-Phased-Updates=true] [-o] [Dpkg::Options::=--force-confdef] " +
      "[-o] [Dpkg::Options::=--force-confold] [upgrade] [--with-new-pkgs]",
      env,
    ]);
    assert(
      !effects(t).some((l) => /\b(remove|autoremove|purge|dist-upgrade|full-upgrade)\b/.test(l)),
    );

    t.clear();
    r = await t.run(gate, [], "reboot");
    assertEquals([r.code, effects(t)], [0, ["shutdown [-r] [+1]"]]);

    t.clear();
    r = await t.run(gate, [], "boot-id");
    assertEquals([r.code, r.out.trim(), t.calls()], [
      0,
      "0a1b2c3d-0000-4000-8000-00000000abcd",
      [],
    ]);

    // status: no root, no index refresh, a document the apt parser takes.
    t.clear();
    t.write("/var/run/reboot-required", "*** System restart required ***\n");
    t.write("/var/run/reboot-required.pkgs", "linux-image-6.8.0-50-generic\n");
    t.write("/var/lib/apt/periodic/update-success-stamp", "");
    r = await t.run(gate, [], "status");
    assertEquals(r.code, 0);
    assertEquals(t.calls(), ["apt [list] [--upgradable]"]);
    const st = parseAptStatus(r.out);
    assert(st.ok, JSON.stringify(st));
    if (st.ok) {
      assertEquals(st.status.pending.names, ["openssl", "vim"]);
      assertEquals(st.status.pending.securityNames, ["openssl"]);
      assert(st.status.reboot.required);
      assertEquals(st.status.reboot.packages, ["linux-image-6.8.0-50-generic"]);
    }

    // verify: a document the model parses, with the mounts and the docker state.
    t.clear();
    r = await t.run(gate, [], "verify");
    assertEquals(r.code, 0, r.out);
    const v = parseVerifyDoc(r.out);
    assertEquals([v?.system, v?.docker, v?.mounts], ["running", "active", ["/", "/srv/data"]]);
    assertFalse(effects(t).length > 0, "verify changes nothing");
  },
});

Deno.test({
  name: "linux gate (dnf): each verb runs exactly its command; status parses",
  ignore: !posix,
  async fn() {
    const { t, gate } = await linuxTree("fedora");
    let r = await t.run(gate, [], "install-security");
    assertEquals(r.code, 0);
    assertEquals(effects(t)[0], "dnf [-y] [upgrade] [--security]");
    t.clear();
    r = await t.run(gate, [], "install-all");
    assertEquals(effects(t)[0], "dnf [-y] [upgrade]");
    t.clear();
    r = await t.run(gate, [], "status");
    assertEquals(r.code, 0);
    assertEquals(t.calls(), [
      "dnf [-q] [check-update]",
      "dnf [-q] [updateinfo] [list] [--security]",
      "dnf [needs-restarting] [-r]",
    ]);
    const st = parseDnfStatus(r.out);
    assert(st.ok, JSON.stringify(st));
    if (st.ok) {
      assertEquals(st.status.pending.names, ["openssl", "vim-enhanced"]);
      assertEquals(st.status.pending.securityNames, ["openssl"]);
      assert(st.status.reboot.required);
    }
  },
});

Deno.test({
  name: "linux gate: anything but a verb exits 64 and runs nothing; the status key is pinned",
  ignore: !posix,
  async fn() {
    const { t, gate, apply } = await linuxTree("ubuntu");
    for (const cmd of INJECTIONS) {
      const r = await t.run(gate, [], cmd);
      assertEquals(r.code, 64, JSON.stringify(cmd));
    }
    // No SSH_ORIGINAL_COMMAND at all.
    assertEquals((await t.run(gate, [])).code, 64);
    // The status key: only `status` (or nothing) runs, and only status.
    for (const cmd of ["install-all", "reboot", "busy", "verify", ...INJECTIONS.slice(2)]) {
      assertEquals((await t.run(gate, ["status"], cmd)).code, 64, JSON.stringify(cmd));
    }
    assertEquals((await t.run(gate, ["reboot"], "reboot")).code, 64);
    assertEquals((await t.run(gate, ["status", "x"], "status")).code, 64);
    assertEquals(t.calls(), [], "nothing ran");
    assertEquals((await t.run(gate, ["status"], "status")).code, 0);
    assertEquals((await t.run(gate, ["status"])).code, 0);
    // The root helper refuses anything else too, and its internal job verb without systemd.
    t.clear();
    for (
      const args of [[], ["install"], ["reboot", "now"], ["__job", "install-all"], ["$(id)"], [
        "busy",
        "x",
      ]]
    ) {
      assertEquals((await t.run(apply, args)).code, 64, JSON.stringify(args));
    }
    assertEquals(t.calls(), []);
  },
});

Deno.test({
  name: "linux apply: busy and verify run only root-owned, owner-writable hooks",
  ignore: !posix,
  async fn() {
    const { t, gate } = await linuxTree("ubuntu");
    // The flake-hunt hook as shipped, with a running hunt container.
    t.install("linux/busy.d/flake-hunt", "/etc/fleet-update/busy.d/flake-hunt");
    t.fake("docker", "echo 3f2a9c1b7d4e");
    let r = await t.run(gate, [], "busy");
    assertEquals(r.code, 10, r.out);
    assertStringIncludes(r.out, "flake hunt running");
    assertEquals(effects(t), ["docker [ps] [-q] [--filter] [label=flake-hunt=1]"]);
    t.fake("docker", "exit 0");
    assertEquals((await t.run(gate, [], "busy")).code, 0);
    t.fake("docker", "exit 1");
    assertEquals((await t.run(gate, [], "busy")).code, 1, "can't tell = not free");

    // A group-writable hook, a symlink and a badly named file never run.
    t.fake("docker", "exit 0");
    t.write("/etc/fleet-update/verify.d/loose", "#!/bin/sh\necho ran >>" + t.log, 0o775);
    t.write("/etc/fleet-update/verify.d/bad name", "#!/bin/sh\necho ran >>" + t.log, 0o755);
    t.write("/target", "#!/bin/sh\necho ran >>" + t.log, 0o755);
    Deno.symlinkSync(`${t.root}/target`, `${t.root}/etc/fleet-update/verify.d/link`);
    t.write("/etc/fleet-update/verify.d/fails", "#!/bin/sh\necho broken\nexit 3\n", 0o755);
    t.clear();
    r = await t.run(gate, [], "verify");
    assertEquals(r.code, 1);
    assertFalse(t.calls().includes("ran"));
    const v = parseVerifyDoc(r.out);
    assertEquals(v?.checks, [{ name: "fails", ok: false }]);
    // A world-writable hooks folder runs nothing.
    Deno.chmodSync(`${t.root}/etc/fleet-update/verify.d`, 0o777);
    r = await t.run(gate, [], "verify");
    assertEquals([r.code, parseVerifyDoc(r.out)?.checks], [0, []]);
  },
});

Deno.test({
  name: "verify.d/mailcow: every container up and healthy, the mail ports listening",
  ignore: !posix,
  async fn() {
    const t = await tree();
    const hook = t.install("linux/verify.d/mailcow", "/etc/fleet-update/verify.d/mailcow");
    t.write("/etc/fleet-update/mailcow.conf", "MAILCOW_DIR=/opt/mailcow-dockerized\n");
    Deno.mkdirSync(`${t.root}/opt/mailcow-dockerized`, { recursive: true });
    t.write("/proc/uptime", "9999.50 12345.00\n");
    const ps = (lines: string) => t.fake("docker", `pwd >>'${t.log}'\nprintf '${lines}'`);
    const ports = (list: string) =>
      t.fake(
        "ss",
        list.split(" ").map((p) => `echo "LISTEN 0 4096 0.0.0.0:${p} 0.0.0.0:*"`).join("\n"),
      );
    // MAILCOW_DIR is read from the host's config, relative to nothing in Fleet.
    t.write("/etc/fleet-update/mailcow.conf", `MAILCOW_DIR=${t.root}/opt/mailcow-dockerized\n`);
    ps(
      "postfix-mailcow running healthy\\ndovecot-mailcow running healthy\\nredis-mailcow running \\n",
    );
    ports("25 587 993 443");
    let r = await t.run(hook, []);
    assertEquals(r.code, 0, r.out);
    assertEquals(t.calls().slice(0, 2), [
      "docker [compose] [ps] [--all] [--format] [{{.Service}} {{.State}} {{.Health}}]",
      `${t.root}/opt/mailcow-dockerized`,
    ]);

    ps("postfix-mailcow running healthy\\nsogo-mailcow running starting\\nacme-mailcow exited \\n");
    r = await t.run(hook, []);
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "sogo-mailcow running (starting)");
    assertStringIncludes(r.out, "acme-mailcow exited");

    ps("postfix-mailcow running healthy\\n");
    ports("25 993");
    r = await t.run(hook, []);
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "587");

    ps("");
    ports("25 587 993");
    assertEquals((await t.run(hook, [])).code, 1, "no containers is not healthy");

    for (
      const conf of [
        "",
        "MAILCOW_DIR=relative/dir\n",
        "MAILCOW_DIR=/opt/$(id)\n",
        "MAILCOW_DIR=/nonexistent\n",
      ]
    ) {
      t.write("/etc/fleet-update/mailcow.conf", conf);
      assertEquals((await t.run(hook, [])).code, 2, conf);
    }
  },
});

Deno.test({
  name: "verify.d/samba: smbd (and an enabled nmbd) active, testparm clean, shares mounted",
  ignore: !posix,
  async fn() {
    const t = await tree();
    const hook = t.install("linux/verify.d/samba", "/etc/fleet-update/verify.d/samba");
    t.write("/etc/fleet-update/samba.conf", "SHARE_PATH=/srv/share\nSHARE_PATH=/srv/media/\n");
    t.write(
      "/proc/mounts",
      "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /srv/share ext4 rw 0 0\n/dev/sdc1 /srv/media xfs rw 0 0\n",
    );
    const systemctl = (nmbdEnabled: boolean, nmbdActive: boolean, smbd = true) =>
      t.fake(
        "systemctl",
        `case "$*" in
  "is-active smbd.service") echo ${smbd ? "active" : "failed"} ;;
  "is-enabled nmbd.service") echo ${nmbdEnabled ? "enabled" : "disabled"} ;;
  "is-active nmbd.service") echo ${nmbdActive ? "active" : "inactive"} ;;
esac`,
      );
    t.fake(
      "testparm",
      'echo "Load smb config files from /etc/samba/smb.conf" >&2\necho "Loaded services file OK." >&2\necho "[share]"',
    );
    systemctl(false, false);
    let r = await t.run(hook, []);
    assertEquals(r.code, 0, r.out);
    assert(t.calls().includes("testparm [-s]"));

    systemctl(true, false);
    r = await t.run(hook, []);
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "nmbd");
    systemctl(true, true);
    assertEquals((await t.run(hook, [])).code, 0);
    systemctl(false, false, false);
    assertStringIncludes((await t.run(hook, [])).out, "smbd is not active");

    systemctl(false, false);
    t.fake("testparm", 'echo "Unknown parameter encountered: \\"wins sever\\"" >&2');
    assertEquals((await t.run(hook, [])).code, 1);
    t.fake("testparm", "exit 1");
    assertEquals((await t.run(hook, [])).code, 1);

    t.fake("testparm");
    t.write("/proc/mounts", "/dev/sda1 / ext4 rw 0 0\n/dev/sdb1 /srv/share ext4 rw 0 0\n");
    r = await t.run(hook, []);
    assertEquals(r.code, 1);
    assertStringIncludes(r.out, "/srv/media is not mounted");
    t.write("/etc/fleet-update/samba.conf", "");
    assertEquals((await t.run(hook, [])).code, 1);
  },
});

async function macTree() {
  const t = await tree();
  t.fake("sudo", '[ "$1" = -n ] && shift\nexec "$@"');
  t.write(
    "/usr/sbin/softwareupdate",
    fakeScript(
      t.log,
      "softwareupdate",
      `case "$*" in
  -l) echo "Software Update Tool"; echo "Finding available software"; echo "Software Update found the following new or updated software:"
      echo "* Label: macOS Sequoia 15.7.3-24G400"
      echo "	Title: macOS Sequoia 15.7.3, Version: 15.7.3, Size: 1800000KiB, Recommended: YES, Action: restart," ;;
  *) echo "Restart required" ;;
esac`,
    ),
    0o755,
  );
  t.write("/sbin/shutdown", fakeScript(t.log, "shutdown", "exit 0"), 0o755);
  const plat = `${t.root}/Library/Developer/CoreSimulator/Volumes`;
  Deno.mkdirSync(`${plat}/iOS_23A343`, { recursive: true });
  Deno.mkdirSync(`${t.root}/Library/Developer/CoreSimulator/Images/A1B2`, { recursive: true });
  const gate = t.install("macos/fleet-update-gate", "/usr/local/sbin/fleet-update-gate");
  return { t, gate, plat };
}

async function waitDone(t: Tree, gate: string) {
  for (let i = 0; i < 100; i++) {
    const doc = parseResultDoc((await t.run(gate, [], "result")).out);
    if (doc && doc.state !== "running") return doc;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("the install never finished");
}

Deno.test({
  name: "macos gate: each verb runs exactly its command; the platform check is read-only",
  ignore: !posix,
  async fn() {
    const { t, gate, plat } = await macTree();
    const swu = `${t.root}/usr/sbin/softwareupdate`;
    let r = await t.run(gate, [], "status");
    assertEquals(r.code, 0);
    assertEquals(t.calls(), ["softwareupdate [-l]"]);
    const st = parseMacStatus(r.out);
    assert(st.ok, JSON.stringify(st));
    if (st.ok) assert(st.status.reboot.required);
    assertEquals(JSON.parse(r.out).xcodePlatforms, ["Images/A1B2", "Volumes/iOS_23A343"]);

    t.clear();
    r = await t.run(gate, [], "install-security");
    assertEquals(r.code, 0);
    let done = await waitDone(t, gate);
    assertEquals([done.state, done.exitCode], ["succeeded", 0]);
    assertEquals(t.calls(), [`sudo [-n] [${swu}] [-i] [-r]`, "softwareupdate [-i] [-r]"]);

    t.clear();
    await t.run(gate, [], "install-all");
    done = await waitDone(t, gate);
    assertEquals(t.calls(), [`sudo [-n] [${swu}] [-i] [-a]`, "softwareupdate [-i] [-a]"]);

    t.clear();
    r = await t.run(gate, [], "reboot");
    assertEquals(t.calls(), [
      `sudo [-n] [${t.root}/sbin/shutdown] [-r] [+1]`,
      "shutdown [-r] [+1]",
    ]);

    // verify: unchanged platforms pass; one gone since the install fails, naming it.
    r = await t.run(gate, [], "verify");
    assertEquals(r.code, 0, r.out);
    assertEquals(parseVerifyDoc(r.out)?.xcodePlatforms, ["Images/A1B2", "Volumes/iOS_23A343"]);
    Deno.removeSync(`${plat}/iOS_23A343`); // the scratch tree's stand-in, nothing real
    r = await t.run(gate, [], "verify");
    assertEquals(r.code, 1);
    assertEquals(JSON.parse(r.out).xcodePlatformsMissing, ["Volumes/iOS_23A343"]);

    t.clear();
    for (const cmd of INJECTIONS) assertEquals((await t.run(gate, [], cmd)).code, 64, cmd);
    for (const cmd of ["install-all", "reboot"]) {
      assertEquals((await t.run(gate, ["status"], cmd)).code, 64);
    }
    assertEquals(t.calls(), []);
  },
});

Deno.test("host scripts: no Xcode tool, no simulator command, nothing that changes platforms", async () => {
  const files: string[] = [];
  const walk = async (dir: string) => {
    for await (const e of Deno.readDir(dir)) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory) await walk(p);
      else files.push(p);
    }
  };
  await walk(HOST.replace(/\/$/, ""));
  assert(files.length >= 10);
  for (const f of files) {
    const text = await Deno.readTextFile(f);
    assertFalse(/simctl|xcodebuild|xcrun|xcode-select|downloadPlatform/i.test(text), f);
    for (const line of text.split("\n")) {
      if (/CoreSimulator|AssetsV2|DeviceSupport/.test(line)) {
        assertFalse(/\b(rm|mv|rmdir|unlink|Remove-Item|delete)\b/.test(line), `${f}: ${line}`);
      }
    }
    // Neutral text: no private addresses, home folders or host names.
    assertFalse(/192\.168\.|\/Users\/|\/home\/[a-z]/.test(text), f);
  }
});

Deno.test("host scripts: the JSON encoder survives hostile text", { ignore: !posix }, async () => {
  const t = await tree();
  linuxFakes(t, "ubuntu");
  const gate = t.install("linux/fleet-update-gate", "/usr/local/sbin/fleet-update-gate");
  const hostile = 'a"b\\c\td\u0001e\u001bf $(id) `id` ü 日本\u007f';
  t.fake("apt", `printf '%s\\n' '${hostile.replace(/'/g, "")}'`);
  const r = await t.run(gate, [], "status");
  const doc = JSON.parse(r.out);
  assertEquals(doc.apt, hostile);
  assertMatch(r.out, /\\u0001/);
});
