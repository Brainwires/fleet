// Builds Fleet Notifier (notifier/Sources, Swift) and embeds it in a packaged Fleet.app at
// Contents/Helpers/Fleet Notifier.app (lib/notifier.ts). scripts/package-macos.ts calls
// `embedNotifiers` after building each bundle and before signing it, so the bundle's signature
// (and notarization) covers the helper: the script's inside-out sign() re-signs the helper's
// executable, which signs its bundle, with the package's identity and the Hardened Runtime.
// macOS only (swiftc, lipo, plutil, codesign).

import {
  NOTIFIER_BUNDLE,
  NOTIFIER_EXECUTABLE,
  NOTIFIER_HELPER_DIR,
  notifierIdentifier,
} from "../lib/notifier.ts";

/** The architectures the helper is built for: one universal binary serves every Fleet build. */
const NOTIFIER_ARCHES = ["arm64", "x86_64"] as const;
/** The oldest macOS the helper runs on. */
const NOTIFIER_MIN_MACOS = "13.0";

const SOURCES = ["Core.swift", "main.swift"].map((f) =>
  new URL(`../notifier/Sources/${f}`, import.meta.url).pathname
);

async function run(cmd: string[]): Promise<string> {
  const p = await new Deno.Command(cmd[0], { args: cmd.slice(1), stdout: "piped", stderr: "piped" })
    .output();
  const out = new TextDecoder().decode(p.stdout);
  if (!p.success) {
    throw new Error(`${cmd[0]} failed (${p.code}): ${new TextDecoder().decode(p.stderr).trim()}`);
  }
  return out;
}

const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** What the helper's Info.plist says. */
export interface NotifierPlist {
  /** Fleet's bundle id (`desktop.app.identifier`). */
  readonly fleetIdentifier: string;
  readonly version: string;
  /** The icon file in Contents/Resources (Fleet's, copied), without `.icns`; none: no icon key. */
  readonly iconFile?: string;
}

/** The helper's Info.plist: a UI element (LSUIElement, no Dock icon) named Fleet Notifier. */
export function notifierInfoPlist(o: NotifierPlist): string {
  const entries: [string, string][] = [
    ["CFBundleDevelopmentRegion", "<string>en</string>"],
    ["CFBundleDisplayName", "<string>Fleet Notifier</string>"],
    ["CFBundleExecutable", `<string>${NOTIFIER_EXECUTABLE}</string>`],
    ["CFBundleIdentifier", `<string>${xml(notifierIdentifier(o.fleetIdentifier))}</string>`],
    ["CFBundleInfoDictionaryVersion", "<string>6.0</string>"],
    ["CFBundleName", "<string>Fleet Notifier</string>"],
    ["CFBundlePackageType", "<string>APPL</string>"],
    ["CFBundleShortVersionString", `<string>${xml(o.version)}</string>`],
    ["CFBundleVersion", `<string>${xml(o.version)}</string>`],
    ...(o.iconFile
      ? [["CFBundleIconFile", `<string>${xml(o.iconFile)}</string>`]] as [
        string,
        string,
      ][]
      : []),
    // What a click opens (notifier/Sources/Core.swift fleetIdentifier).
    ["FleetAppIdentifier", `<string>${xml(o.fleetIdentifier)}</string>`],
    ["LSMinimumSystemVersion", `<string>${NOTIFIER_MIN_MACOS}</string>`],
    ["LSUIElement", "<true/>"],
    ["NSHighResolutionCapable", "<true/>"],
    ["NSPrincipalClass", "<string>NSApplication</string>"],
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([k, v]) => `\t<key>${k}</key>\n\t${v}`).join("\n")}
</dict>
</plist>
`;
}

/** Compile the helper into one universal executable at `out`. */
export async function buildNotifierExecutable(out: string): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "fleet-notifier-" });
  try {
    const slices: string[] = [];
    for (const arch of NOTIFIER_ARCHES) {
      const slice = `${tmp}/${NOTIFIER_EXECUTABLE}-${arch}`;
      await run([
        "xcrun",
        "swiftc",
        "-swift-version",
        "5",
        "-O",
        "-target",
        `${arch}-apple-macos${NOTIFIER_MIN_MACOS}`,
        "-o",
        slice,
        ...SOURCES,
      ]);
      slices.push(slice);
    }
    await run(["lipo", "-create", ...slices, "-output", out]);
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

async function plistValue(plist: string, key: string): Promise<string | null> {
  try {
    return (await run(["plutil", "-extract", key, "raw", "-o", "-", plist])).trim() || null;
  } catch {
    return null;
  }
}

/**
 * Embed the helper in `app` (a built Fleet.app): Contents/Helpers/Fleet Notifier.app with the
 * executable at `executable`, Fleet's identifier + `.notifier`, Fleet's version and icon. Sealed
 * ad-hoc here, so the bundle is valid as is; the package's sign() re-signs it with the identity.
 *
 * @returns The helper bundle's path.
 */
export async function embedNotifier(app: string, executable: string): Promise<string> {
  const info = `${app}/Contents/Info.plist`;
  const fleetIdentifier = await plistValue(info, "CFBundleIdentifier");
  if (!fleetIdentifier) throw new Error(`no CFBundleIdentifier in ${info}`);
  const version = await plistValue(info, "CFBundleShortVersionString") ?? "0.0.0";
  const helper = `${app}/${NOTIFIER_HELPER_DIR}/${NOTIFIER_BUNDLE}`;
  await Deno.remove(helper, { recursive: true }).catch(() => {});
  await Deno.mkdir(`${helper}/Contents/MacOS`, { recursive: true });
  await Deno.mkdir(`${helper}/Contents/Resources`, { recursive: true });
  // Fleet's icon (CFBundleIconFile, with or without its .icns).
  let iconFile: string | undefined;
  const icon = await plistValue(info, "CFBundleIconFile");
  if (icon) {
    const base = icon.replace(/\.icns$/, "");
    try {
      await Deno.copyFile(
        `${app}/Contents/Resources/${base}.icns`,
        `${helper}/Contents/Resources/${base}.icns`,
      );
      iconFile = base;
    } catch {
      // No icon file: the helper goes without one.
    }
  }
  await Deno.writeTextFile(
    `${helper}/Contents/Info.plist`,
    notifierInfoPlist({ fleetIdentifier, version, iconFile }),
  );
  const exe = `${helper}/Contents/MacOS/${NOTIFIER_EXECUTABLE}`;
  await Deno.copyFile(executable, exe);
  await Deno.chmod(exe, 0o755);
  await run(["codesign", "--force", "--timestamp=none", "-s", "-", helper]);
  return helper;
}

/** Build the helper once and embed it in every bundle (package-macos.ts, before signing). */
export async function embedNotifiers(apps: readonly string[]): Promise<void> {
  const tmp = await Deno.makeTempDir({ prefix: "fleet-notifier-bin-" });
  try {
    const exe = `${tmp}/${NOTIFIER_EXECUTABLE}`;
    console.log(`Building ${NOTIFIER_BUNDLE} (${NOTIFIER_ARCHES.join(" + ")})`);
    await buildNotifierExecutable(exe);
    for (const app of apps) {
      console.log(`Embedding ${await embedNotifier(app, exe)}`);
    }
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}
