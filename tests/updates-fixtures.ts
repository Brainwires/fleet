// Machine-update fixtures shared by the update tests: a config with two runner hosts, two
// servers (one with automatic installs off) and the machine Fleet runs on, and one status per
// level. Neutral names only.

import { validateUpdatesConfig } from "../lib/updates/config.ts";
import {
  emptyStatus,
  type MachineStatus,
  type UpdatesConfig,
  withCheck,
} from "../lib/updates/model.ts";

export const NOW = Date.parse("2026-11-22T15:00:00Z");
export const H = 3_600_000;
export const D = 24 * H;
export const TZ = "America/Chicago";

export const CONFIG: UpdatesConfig = (() => {
  const r = validateUpdatesConfig({
    ssh: { configFile: "~/fleet-test/ssh_config" },
    machines: [
      {
        id: "runner-1",
        os: "ubuntu",
        via: { ssh: "runner-1" },
        pools: ["lx-a"],
        drainCapMinutes: 45,
      },
      { id: "runner-2", os: "fedora", via: { ssh: "runner-2" }, pools: ["arm-a"] },
      { id: "mail-1", os: "ubuntu", kind: "server", via: { ssh: "mail-1" } },
      { id: "files-1", os: "ubuntu", kind: "server", via: { ssh: "files-1" }, autoInstall: false },
      { id: "here", os: "macos", via: "local", self: true },
    ],
  });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.value!;
})();

export const host = (
  total: number,
  security: number,
  reboot: { since: number | null; packages?: string[] } | null = null,
) => ({
  pending: {
    total,
    security,
    names: Array.from({ length: total }, (_, i) => (i < security ? `sec-${i}` : `pkg-${i}`)),
    securityNames: Array.from({ length: security }, (_, i) => `sec-${i}`),
  },
  reboot: reboot
    ? { required: true, since: reboot.since, packages: reboot.packages ?? ["linux-image"] }
    : { required: false, since: null, packages: [] },
  indexAt: NOW - H,
});

/** One fixture per level: ok, info, warn (a restart pending 2 d), bad (security 9 d), self. */
export function statuses(): Record<string, MachineStatus> {
  const at = NOW - H;
  return {
    "runner-1": withCheck(emptyStatus("runner-1"), host(0, 0), at),
    "runner-2": withCheck(emptyStatus("runner-2"), host(4, 0), at),
    "mail-1": withCheck(emptyStatus("mail-1"), host(0, 0, { since: NOW - 2 * D }), at),
    "files-1": {
      ...withCheck(emptyStatus("files-1"), host(12, 3), at),
      firstSeen: { security: NOW - 9 * D, reboot: null },
    },
    "here": withCheck(emptyStatus("here"), host(2, 2), at),
  };
}
