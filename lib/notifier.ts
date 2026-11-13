// Fleet Notifier (notifier/): the small macOS helper app shell scripts post notifications through,
// so a click opens Fleet (an `osascript` notification is Script Editor's, and its click opens an
// untitled script). Fleet's macOS package embeds it at Contents/Helpers/Fleet Notifier.app
// (tools/notifier.ts); the runner watchdog (ops/runners/lib/common.sh `alert_notify`) calls it.
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
