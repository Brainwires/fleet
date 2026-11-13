// Fleet Notifier: posts a notification for a shell script (the runner watchdog) and, when one is
// clicked, opens Fleet. A UI element app (LSUIElement): no Dock icon, never a window.
//
//   fleet-notify --title T --body B [--subtitle S] [--id KEY] [--url fleet:LINK] [--dry-run]
//
// Post mode exits once the post is accepted: within 2 s once authorized; the first run waits up to
// 60 s for the answer to the one-time permission prompt. A helper LaunchServices doesn't know
// registers its own bundle first (a `ditto` install doesn't). A click launches the helper with
// no arguments; the notification response reaches the delegate set before launch finishes, Fleet
// is opened (`open -b <Fleet's id>`), and the helper quits.

import AppKit
import Foundation
import UserNotifications

/// A click launch with no response by then (someone opened the helper by hand): quit.
let CLICK_WAIT: TimeInterval = 5

func fail(_ code: ExitCode, _ message: String? = nil) -> Never {
  if let m = message { FileHandle.standardError.write(Data("fleet-notify: \(m)\n".utf8)) }
  exit(code.rawValue)
}

func authStatus(_ s: UNAuthorizationStatus) -> AuthStatus {
  switch s {
  case .notDetermined: return .notDetermined
  case .denied: return .denied
  case .authorized: return .authorized
  case .provisional: return .provisional
  case .ephemeral: return .ephemeral
  @unknown default: return .denied
  }
}

/// Register the helper's own bundle with LaunchServices when it knows no app for its id: a `ditto`
/// install registers only the outer Fleet.app, and the notification center refuses an app
/// LaunchServices doesn't know (exit 3, and no prompt ever appears). `LSRegisterURL`, else
/// `lsregister -f` on the bundle.
func registerIfNeeded() {
  let bundle = Bundle.main.bundleURL
  let registered = Bundle.main.bundleIdentifier.flatMap {
    NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0)
  }
  guard needsRegistration(registeredURL: registered, ownBundlePath: bundle.path) else { return }
  if LSRegisterURL(bundle as CFURL, true) == noErr { return }
  let p = Process()
  p.executableURL = URL(
    fileURLWithPath:
      "/System/Library/Frameworks/CoreServices.framework/Versions/A/Frameworks/"
      + "LaunchServices.framework/Versions/A/Support/lsregister")
  p.arguments = ["-f", bundle.path]
  p.standardOutput = FileHandle.nullDevice
  p.standardError = FileHandle.nullDevice
  try? p.run()
  p.waitUntilExit()
}

/// Seconds on the monotonic clock.
func monotonicNow() -> TimeInterval { TimeInterval(DispatchTime.now().uptimeNanoseconds) / 1e9 }

/// Wait for `sem` until `deadline` (monotonicNow()); false when the wait ran out.
func wait(_ sem: DispatchSemaphore, until deadline: TimeInterval) -> Bool {
  sem.wait(timeout: .now() + max(0, deadline - monotonicNow())) == .success
}

func post(_ r: PostRequest) -> Never {
  let start = monotonicNow()
  registerIfNeeded()
  let center = UNUserNotificationCenter.current()
  // A click that lands while this process still runs comes here, not to a new launch.
  let presenter = NotificationDelegate(quitAfterClick: false)
  center.delegate = presenter

  // 1. The authorization state (within the 1.8 s budget).
  let gotSettings = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var status: AuthStatus = .denied
  center.getNotificationSettings { settings in
    status = authStatus(settings.authorizationStatus)
    gotSettings.signal()
  }
  guard wait(gotSettings, until: phaseDeadline(.settings, start: start)) else {
    let (code, m) = timeoutOutcome(.settings)
    fail(code, m)
  }

  // 2. The one-time prompt, while undetermined: wait for the user's answer (up to 60 s).
  var answeredAt: TimeInterval? = nil
  switch authStep(status) {
  case .post: break
  case .refuse:
    fail(.notAuthorized, "notifications are off for Fleet Notifier (System Settings > Notifications)")
  case .request:
    let promptStart = monotonicNow()
    let answered = DispatchSemaphore(value: 0)
    nonisolated(unsafe) var granted = false
    center.requestAuthorization(options: [.alert, .sound]) { ok, _ in
      granted = ok
      answered.signal()
    }
    guard wait(answered, until: phaseDeadline(.prompt, start: start, promptStart: promptStart))
    else {
      let (code, m) = timeoutOutcome(.prompt)
      fail(code, m)
    }
    guard promptOutcome(granted: granted) != nil else {
      fail(.notAuthorized, "notifications were not allowed for Fleet Notifier")
    }
    answeredAt = monotonicNow()
  }

  // 3. The post (1.8 s from the start, or from the prompt's answer).
  let content = UNMutableNotificationContent()
  content.title = r.title
  content.body = r.body
  if let s = r.subtitle { content.subtitle = s }
  content.threadIdentifier = "fleet-notifier"
  var info: [String: String] = [:]
  if let id = r.id { info["id"] = id }
  if let url = r.url { info["url"] = url }
  content.userInfo = info
  let identifier = r.id ?? UUID().uuidString
  // A delivered notification with the same id goes first: the new one replaces it.
  if r.id != nil { center.removeDeliveredNotifications(withIdentifiers: [identifier]) }
  let added = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var refused: String? = nil
  center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) { err in
    if let err { refused = "the system refused the post: \(err.localizedDescription)" }
    added.signal()
  }
  guard wait(added, until: phaseDeadline(.add, start: start, promptAnswered: answeredAt)) else {
    let (code, m) = timeoutOutcome(.add)
    fail(code, m)
  }
  withExtendedLifetime(presenter) {}
  if let refused { fail(.failed, refused) }
  exit(ExitCode.posted.rawValue)
}

/// Open Fleet (`open -b <Fleet's id>`), its window up.
func openFleet() {
  let id = fleetIdentifier(
    plistValue: Bundle.main.object(forInfoDictionaryKey: "FleetAppIdentifier") as? String,
    ownIdentifier: Bundle.main.bundleIdentifier)
  guard let id else { return }
  let argv = openCommand(fleetId: id)
  let p = Process()
  p.executableURL = URL(fileURLWithPath: argv[0])
  p.arguments = Array(argv.dropFirst())
  try? p.run()
  p.waitUntilExit()
}

/// The notification center's delegate: a click opens Fleet; banners show even if the helper were
/// frontmost (it never is: it has no UI).
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
  let quitAfterClick: Bool
  init(quitAfterClick: Bool) { self.quitAfterClick = quitAfterClick }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
    withCompletionHandler done: @escaping () -> Void
  ) {
    if response.actionIdentifier == UNNotificationDefaultActionIdentifier { openFleet() }
    done()
    if quitAfterClick { DispatchQueue.main.async { NSApp.terminate(nil) } }
  }

  func userNotificationCenter(
    _ center: UNUserNotificationCenter, willPresent notification: UNNotification,
    withCompletionHandler done: @escaping (UNNotificationPresentationOptions) -> Void
  ) {
    done([.banner, .list])
  }
}

/// Click mode: the delegate must be set before launch finishes to get the launching response.
final class ClickLaunch: NSObject, NSApplicationDelegate {
  let delegate = NotificationDelegate(quitAfterClick: true)

  func applicationWillFinishLaunching(_ notification: Notification) {
    UNUserNotificationCenter.current().delegate = delegate
  }

  func applicationDidFinishLaunching(_ notification: Notification) {
    DispatchQueue.main.asyncAfter(deadline: .now() + CLICK_WAIT) { NSApp.terminate(nil) }
  }
}

switch parseCommand(Array(CommandLine.arguments.dropFirst())) {
case .help:
  print(usage)
  exit(0)
case .invalid(let m):
  FileHandle.standardError.write(Data("fleet-notify: \(m)\n\(usage)\n".utf8))
  exit(ExitCode.badArgs.rawValue)
case .post(let r):
  if r.dryRun {
    print(describe(r))
    exit(0)
  }
  post(r)
case .click:
  let app = NSApplication.shared
  let launch = ClickLaunch()
  app.delegate = launch
  app.setActivationPolicy(.accessory)
  app.run()
}
