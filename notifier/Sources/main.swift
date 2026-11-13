// Fleet Notifier: posts a notification for a shell script (the runner watchdog) and, when one is
// clicked, opens Fleet. A UI element app (LSUIElement): no Dock icon, never a window.
//
//   fleet-notify --title T --body B [--subtitle S] [--id KEY] [--url fleet:LINK] [--dry-run]
//
// Post mode exits once the post is accepted (or after DEADLINE). A click launches the helper with
// no arguments; the notification response reaches the delegate set before launch finishes, Fleet
// is opened (`open -b <Fleet's id>`), and the helper quits.

import AppKit
import Foundation
import UserNotifications

/// The whole post, authorization included, is given this long.
let DEADLINE: TimeInterval = 1.8
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

func post(_ r: PostRequest) -> Never {
  let center = UNUserNotificationCenter.current()
  // A click that lands while this process still runs comes here, not to a new launch.
  let presenter = NotificationDelegate(quitAfterClick: false)
  center.delegate = presenter
  let done = DispatchSemaphore(value: 0)
  nonisolated(unsafe) var result: ExitCode = .failed
  nonisolated(unsafe) var message: String? = "the post was not accepted within \(DEADLINE) s"

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

  let add = {
    // A delivered notification with the same id goes first: the new one replaces it.
    if r.id != nil { center.removeDeliveredNotifications(withIdentifiers: [identifier]) }
    center.add(UNNotificationRequest(identifier: identifier, content: content, trigger: nil)) {
      err in
      if let err {
        result = .failed
        message = "the system refused the post: \(err.localizedDescription)"
      } else {
        result = .posted
        message = nil
      }
      done.signal()
    }
  }
  center.getNotificationSettings { settings in
    switch authStep(authStatus(settings.authorizationStatus)) {
    case .post: add()
    case .refuse:
      result = .notAuthorized
      message = "notifications are off for Fleet Notifier (System Settings > Notifications)"
      done.signal()
    case .request:
      // The one-time system prompt. Not answered within the deadline: exit 3; the answer is kept.
      result = .notAuthorized
      message = "waiting for the notification permission prompt to be answered"
      center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
        if granted {
          add()
        } else {
          message = "notifications were not allowed for Fleet Notifier"
          done.signal()
        }
      }
    }
  }
  _ = done.wait(timeout: .now() + DEADLINE)
  withExtendedLifetime(presenter) {}
  if result == .posted { exit(0) }
  fail(result, message)
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
