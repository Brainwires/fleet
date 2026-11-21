// One status document per OS, to the parser for that OS.

import type { CollectResult, UpdatesOs } from "./model.ts";
import { parseAptStatus } from "./collect-apt.ts";
import { parseDnfStatus } from "./collect-dnf.ts";
import { parseMacStatus } from "./collect-macos.ts";
import { parseWindowsStatus } from "./collect-windows.ts";

/** Parse the gate's `status` output for a machine of `os`. */
export function parseStatusDocument(os: UpdatesOs, text: string): CollectResult {
  switch (os) {
    case "ubuntu":
      return parseAptStatus(text);
    case "fedora":
      return parseDnfStatus(text);
    case "macos":
      return parseMacStatus(text);
    case "windows":
      return parseWindowsStatus(text);
  }
}
