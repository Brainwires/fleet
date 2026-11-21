# Machine updates: host setup

Fleet can tell which machines wait on OS updates or a reboot, and run the update and restart on one
machine at a time. It reaches each machine over ssh with a fixed command line and one word, the
**verb**. On the host, a small root-owned **gate** reads that word and runs exactly one fixed
command for it; anything else exits 64 having run nothing. Fleet never sends a host anything else:
no package names, no shell text, nothing from GitHub, nothing a host printed earlier.

This page is the one-time setup on each host and on the machine Fleet runs on. Nothing here runs by
itself: every step is yours to run, as an administrator, after reading it. The scripts are in
[`host/`](../host).

## The verbs

| Verb               | Ubuntu / Debian                                          | Fedora                      | macOS                         | Windows                                         |
| ------------------ | -------------------------------------------------------- | --------------------------- | ----------------------------- | ----------------------------------------------- |
| `status`           | `apt list --upgradable`, the reboot flag, the index age  | `dnf check-update` and co.  | `softwareupdate -l`           | the Windows Update searcher, reboot keys        |
| `busy`             | `/etc/fleet-update/busy.d/*` (exit 10 = busy)            | same                        | same                          | `busy.d\*.ps1`                                  |
| `install-security` | `unattended-upgrade -v`                                  | `dnf -y upgrade --security` | `softwareupdate -i -r`        | task `FleetUpdate-Install-Security`             |
| `install-all`      | `apt-get update`, `apt-get -y upgrade --with-new-pkgs`   | `dnf -y upgrade`            | `softwareupdate -i -a`        | task `FleetUpdate-Install-All`                  |
| `result`           | the last install's state, exit code and output tail      | same                        | same                          | `result.json`                                   |
| `verify`           | system state, failed units, docker, mounts, `verify.d/*` | same                        | iOS platform list, `verify.d` | docker, free disk, `verify.d\*.ps1`             |
| `reboot`           | `shutdown -r +1`                                         | same                        | `shutdown -r +1`              | task `FleetUpdate-Reboot` (`shutdown /r /t 60`) |
| `boot-id`          | `/proc/sys/kernel/random/boot_id`                        | same                        | `kern.bootsessionuuid`        | last boot time                                  |

`status` and `boot-id` need no root. `status` never refreshes a package index. Installs run detached
(a transient systemd unit, a background process on macOS, a scheduled task on Windows), so they
survive the ssh session ending, and `result` reports them. apt runs with
`DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l` (needrestart lists, never restarts a service),
`--force-confdef --force-confold` (a changed config file keeps the local one) and a 600 s dpkg lock
wait; `install-security` installs what unattended-upgrades' own origins allow (by default the
security pockets). Nothing ever removes a package.

## Fleet's machine

1. Make two keys per host in `updates/` inside Fleet's data folder (folder 0700, keys 0600): one for
   `status`, one for everything else. No passphrase (an unattended window can't type one); a stolen
   key can only run that host's verbs, from Fleet's address.

   ```sh
   ssh-keygen -t ed25519 -N "" -C fleet-status -f <data folder>/updates/<id>-status
   ssh-keygen -t ed25519 -N "" -C fleet-update -f <data folder>/updates/<id>-update
   ```

2. Write `updates/ssh_config`, two `Host` entries per machine: `<alias>-status` (used for `status`
   only) and `<alias>` (every other verb). Fleet passes this file with `-F`, so neither
   `~/.ssh/config` nor the system file is read.

   ```
   Host <alias>-status
       HostName <address>
       User fleetupd
       IdentityFile <data folder>/updates/<id>-status
   Host <alias>
       HostName <address>
       User fleetupd
       IdentityFile <data folder>/updates/<id>-update
   Host *
       IdentitiesOnly yes
       UserKnownHostsFile <data folder>/updates/known_hosts
       StrictHostKeyChecking yes
       ConnectTimeout 15
       ServerAliveInterval 15
   ```

   On Windows both entries may use the one key (its gate accepts `status` too).

3. Record each host key by hand: `ssh-keyscan -t ed25519 <address>`, compared with the key printed
   on the host's own console (`ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub`), then appended to
   `updates/known_hosts`. Fleet never accepts a new or changed host key.
4. Add `integrations.updates` to `fleet-settings.json` and to the build machine's
   `fleet-local-config.json`, and rebuild the internal Fleet: only an internal build whose local
   config has the section may run `/usr/bin/ssh` (README, Permissions). A release build's grants are
   unchanged.

Fleet runs ssh with exactly
`-F <config> -T -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o PermitLocalCommand=no <host> <verb>`,
a cleared environment (no agent socket) and no input. It passes the config's path and never reads a
key.

## Ubuntu, Debian and Fedora hosts

```sh
sudo useradd --system --create-home --shell /bin/sh fleetupd
sudo install -o root -g root -m 0755 host/linux/fleet-update-gate host/linux/fleet-update-apply /usr/local/sbin/
sudo install -d -o root -g root -m 0755 /etc/fleet-update/busy.d /etc/fleet-update/verify.d
```

`/etc/sudoers.d/fleet-update` (0440 root:root; check it with `sudo visudo -cf <file>` before moving
it into place). Each verb is listed on its own, with no wildcard:

```
Defaults:fleetupd env_reset, secure_path="/usr/sbin:/usr/bin:/sbin:/bin"
fleetupd ALL=(root) NOPASSWD: /usr/local/sbin/fleet-update-apply busy, /usr/local/sbin/fleet-update-apply result, \
    /usr/local/sbin/fleet-update-apply install-security, /usr/local/sbin/fleet-update-apply install-all, \
    /usr/local/sbin/fleet-update-apply verify, /usr/local/sbin/fleet-update-apply reboot
```

`/etc/ssh/sshd_config.d/60-fleet-update.conf`, then `sudo sshd -t && sudo systemctl reload ssh`
(`sshd` on Fedora):

```
Match User fleetupd
    AuthenticationMethods publickey
    AuthorizedKeysFile /etc/ssh/authorized_keys.d/%u
    PermitTTY no
```

`/etc/ssh/authorized_keys.d/fleetupd` (0644 root:root, so the account can't edit its own limits;
`restrict` means no terminal and no forwarding):

```
command="/usr/local/sbin/fleet-update-gate status",restrict,from="<Fleet machine's address>" ssh-ed25519 AAAA… fleet-status
command="/usr/local/sbin/fleet-update-gate",restrict,from="<Fleet machine's address>" ssh-ed25519 AAAA… fleet-update
```

The first line pins the status key to `status`; the second accepts any verb in the table.

**Runner hosts:** stop the host installing on its own between windows, keeping the daily index
refresh: `sudo systemctl disable --now apt-daily-upgrade.timer`. A docker package upgrade restarts
dockerd and so stops job containers whatever needrestart says; that is why installs wait for the
pools to drain.

### Busy and verify hooks

`busy` and `verify` run the executable files in `/etc/fleet-update/busy.d` and `verify.d`, sorted by
name, as root, each with a time cap (busy 120 s, verify 900 s). A hook runs only when it and its
folder are owned by root and writable by root alone, its name is letters, digits, `.`, `_` and `-`,
and it is not a symlink; anything else is skipped. A busy hook exits 10 for busy (its first output
line is the reason), 0 for free; anything else counts as "can't tell", which is not free. A verify
hook exits 0 when the host is healthy; anything else fails the run's verify, which keeps the pools
held and alerts you.

Install a hook from `host/linux/` with
`sudo install -o root -g root -m 0755 <file> /etc/fleet-update/<busy.d|verify.d>/`.

- **`busy.d/flake-hunt`** (runner hosts with long non-CI work): busy while a container labelled
  `flake-hunt=1` runs.
- **`verify.d/mailcow`** (a mailcow mail server): every container of the mailcow compose project is
  running, and healthy where it has a health check, within 10 minutes of boot (the hook waits, then
  names the ones that aren't); and something listens on ports 25, 587 and 993. The mailcow folder
  comes from `/etc/fleet-update/mailcow.conf` (0644 root:root), one line, parsed and never sourced:

  ```
  MAILCOW_DIR=/opt/mailcow-dockerized
  ```

  A docker package upgrade restarts dockerd and with it every mailcow container, so give this host a
  window when mail may pause. mailcow's own `update.sh` is not a verb.

- **`verify.d/samba`** (a Samba file server): `smbd` is active, `nmbd` too when it is enabled,
  `testparm -s` loads the configuration with no error or unknown parameter, and every share path is
  a mount point. The paths come from `/etc/fleet-update/samba.conf` (0644 root:root), one line each:

  ```
  SHARE_PATH=/srv/share
  ```

  Clients reconnect by themselves after a reboot; mounts on other machines drop while it lasts.

A service host (no runners) gets the same user, gate, sudoers and keys; it has no pools to hold, and
Fleet updates it only when you ask or in a window you set, never on its own.

## macOS hosts

Unattended OS updates work only on an Intel Mac: on Apple silicon, installing a macOS update needs
the owner's password. Listing works on both.

```sh
sudo sysadminctl -addUser fleetupd -home /var/fleetupd -shell /bin/sh
sudo dscl . create /Users/fleetupd IsHidden 1
sudo dseditgroup -o edit -a fleetupd -t user com.apple.access_ssh
sudo install -o root -g wheel -m 0755 host/macos/fleet-update-gate /usr/local/sbin/
sudo install -d -o root -g wheel -m 0755 /etc/fleet-update/busy.d /etc/fleet-update/verify.d
```

The same two key lines go in `/var/fleetupd/.ssh/authorized_keys`, owned by root, 0644. Then
`/private/etc/sudoers.d/fleet-update` (0440 root:wheel; `sudo visudo -cf <file>` first):

```
fleetupd ALL=(root) NOPASSWD: /usr/sbin/softwareupdate -i -a, /usr/sbin/softwareupdate -i -r, \
    /sbin/shutdown -r +1
```

The account keeps the install's log, result and the before-install platform list in
`/var/fleetupd/fleet-update`.

**Xcode's iOS platform.** `status` and `verify` list the folder names under
`/Library/Developer/CoreSimulator/Images`, `/Library/Developer/CoreSimulator/Volumes` and
`/System/Library/AssetsV2/com_apple_MobileAsset_iOSSimulatorRuntime`, read-only. `install-*` saves
that list first, and `verify` fails, naming what is gone, when an entry disappeared. The gate runs
no Xcode tool and nothing that removes, moves or manages platforms or simulator runtimes. If verify
reports the platform missing, reinstall it yourself as the login user (Xcode's
`-downloadPlatform iOS`); Fleet never does.

## The machine Fleet runs on

Nothing to install: it is `via: "local"` with `self: true`, so Fleet notifies about it and never
installs or reboots it. Its Update button opens the system's Software Update settings.

## Windows hosts

No WinRM, no JEA, no module and no new account: one folder, three on-demand SYSTEM tasks and one key
line. In an elevated PowerShell, from the `host\windows` folder:

```powershell
.\register-tasks.ps1
```

It creates `C:\ProgramData\FleetUpdate` (SYSTEM and Administrators only, with `busy.d` and
`verify.d`), copies `gate.ps1`, `scan.ps1` and `install.ps1` there, and registers
`FleetUpdate-Install-Security`, `FleetUpdate-Install-All` (`install.ps1 -Mode security|all`) and
`FleetUpdate-Reboot` (`shutdown /r /t 60`) to run as SYSTEM with no trigger. The Windows Update
installer refuses a network logon, so ssh only starts a task; `install.ps1` uses the built-in
Windows Update Agent COM API and writes `result.json`. Then add to
`C:\ProgramData\ssh\administrators_authorized_keys` (ACL: SYSTEM and Administrators only):

```
command="powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File C:\ProgramData\FleetUpdate\gate.ps1",restrict ssh-ed25519 AAAA… fleet-update
```

`scan.ps1` reads the pending updates (`IsInstalled=0 and IsHidden=0`) and the
`WindowsUpdate\Auto Update\RebootRequired`, `Component Based Servicing\RebootPending` and
`PendingFileRenameOperations` flags, and changes nothing. A busy or verify hook is a `.ps1` file in
`busy.d` / `verify.d`, with the same exit codes as on Linux. Try search and install on a lab VM
before a host where only small changes are allowed.

## Checking a host by hand

From Fleet's machine, each verb is one command (`status` first; it changes nothing):

```sh
ssh -F <data folder>/updates/ssh_config <alias>-status status
ssh -F <data folder>/updates/ssh_config <alias> verify
ssh -F <data folder>/updates/ssh_config <alias> 'status; id'   # refused: exit 64
```
