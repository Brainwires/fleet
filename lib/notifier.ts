// Fleet Notifier (notifier/): the small macOS helper app shell scripts post notifications through,
// so a click opens Fleet (an `osascript` notification is Script Editor's, and its click opens an
// untitled script). Fleet's macOS package embeds it at Contents/Helpers/Fleet Notifier.app
// (tools/notifier.ts); a runner watchdog script (its `alert_notify`) calls it.
//
// Its alerts are the watchdog's conditions, so where the watchdog notifies through it Fleet leaves
// out its own notice for the one condition both detect the same way: a job queued over 15 min on a
// self-hosted pool (the watchdog's `stuck:<pool>` alert). lib/notify.ts applies that.
// Pure: the caller passes the executable path and a file test.

import { appBundleOf } from "./dock-policy.ts";

/** The helper's bundle name inside Fleet.app. */
export const NOTIFIER_BUNDLE = "Fleet Notifier.app";
/** Its executable (Contents/MacOS/fleet-notify). */
export const NOTIFIER_EXECUTABLE = "fleet-notify";
/** Its place in an app bundle. */
export const NOTIFIER_HELPER_DIR = "Contents/Helpers";

/** The helper's bundle id: Fleet's plus `.notifier`. */
export function notifierIdentifier(fleetIdentifier: string): string {
  return `${fleetIdentifier}.notifier`;
}

/** The helper's executable inside an app bundle. */
export function notifierExecutableIn(appBundle: string): string {
  return `${appBundle}/${NOTIFIER_HELPER_DIR}/${NOTIFIER_BUNDLE}/Contents/MacOS/${NOTIFIER_EXECUTABLE}`;
}

/**
 * Whether the watchdog posts its alerts through this Fleet's helper: Fleet runs beside the runner
 * scheduler (its integration is configured) from a bundle that embeds the helper.
 *
 * @param execPath Fleet's executable (`Deno.execPath()`).
 * @param schedulerConfigured `settings().integrations.runnerScheduler !== null`.
 * @param isFile Whether a path is an existing file.
 */
export function watchdogNotifies(
  execPath: string,
  schedulerConfigured: boolean,
  isFile: (path: string) => boolean,
): boolean {
  if (!schedulerConfigured) return false;
  const app = appBundleOf(execPath);
  if (!app) return false;
  try {
    return isFile(notifierExecutableIn(app));
  } catch {
    return false;
  }
}

/** LaunchServices' registration tool (macOS), by absolute path: baked as Fleet's `--allow-run`. */
export const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/LaunchServices.framework/Versions/A/Support/lsregister";

/** `open`, by absolute path: starts the helper through LaunchServices to ask for permission. */
export const OPEN_BIN = "/usr/bin/open";

/**
 * `open`'s arguments that start the helper through LaunchServices with `--request-authorization`
 * (notifier/Sources/Core.swift authorizationLaunchCommand): it asks for notification permission
 * while that is undetermined, else quits at once. Only a LaunchServices-launched instance gets the
 * prompt: the watchdog's exec from a shell gets none.
 */
export function notifierAuthorizationArgs(helperBundle: string): string[] {
  return ["-n", "-g", "-a", helperBundle, "--args", "--request-authorization"];
}

/** The data-folder file recording which helper build Fleet registered. */
export const NOTIFIER_STAMP_FILE = "fleet-notifier-registered";

/** A helper build's stamp: its bundle path and its executable's mtime (a new build, a move). */
export function notifierStamp(helperBundle: string, mtimeMs: number): string {
  return `${helperBundle}\t${Math.round(mtimeMs)}`;
}

/** What {@linkcode registerNotifier} needs from the machine. */
export interface RegisterDeps {
  readonly os: string;
  readonly execPath: string;
  /** The executable's mtime (ms), or `null` when it is missing. */
  readonly mtime: (path: string) => Promise<number | null>;
  readonly readStamp: () => Promise<string | null>;
  readonly writeStamp: (stamp: string) => Promise<void>;
  /** Run `lsregister -f <bundle>`; whether it succeeded. */
  readonly lsregister: (bundle: string) => Promise<boolean>;
  /** Start the helper's `--request-authorization` instance (`open …`). */
  readonly askPermission: (bundle: string) => Promise<void>;
}

/**
 * Register Fleet's embedded helper with LaunchServices once per helper build. A `ditto` / `cp`
 * install registers only the outer Fleet.app, and the notification center refuses an app
 * LaunchServices doesn't know: the helper's post fails with exit 3 and its permission prompt
 * never appears. The helper also registers itself when it finds itself unknown; this covers it
 * before the first post, then asks for notification permission through the helper. Best effort: a
 * failed registration is retried at the next launch.
 *
 * @returns Whether `lsregister` ran.
 */
export async function registerNotifier(deps: RegisterDeps): Promise<boolean> {
  if (deps.os !== "darwin") return false;
  const app = appBundleOf(deps.execPath);
  if (!app) return false;
  const bundle = `${app}/${NOTIFIER_HELPER_DIR}/${NOTIFIER_BUNDLE}`;
  const mtime = await deps.mtime(notifierExecutableIn(app));
  if (mtime === null) return false;
  const stamp = notifierStamp(bundle, mtime);
  if ((await deps.readStamp())?.trim() === stamp) return false;
  if (!(await deps.lsregister(bundle))) return false;
  await deps.writeStamp(stamp);
  // Fleet is launched by LaunchServices; the helper's instance it starts asks for permission (a
  // no-op once the user answered), so the first watchdog alert needn't wait on the prompt.
  await deps.askPermission(bundle).catch(() => {});
  return true;
}
