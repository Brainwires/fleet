// Fleet Notifier's pure core: the command line, the exit codes, what an authorization state means
// and what a click opens. No AppKit, no UserNotifications: notifier/Tests/main.swift compiles this
// file alone and checks it (tests/notifier.test.ts runs that).

import Foundation

/// The process's exit status.
enum ExitCode: Int32 {
  /// Posted (or, with --dry-run, valid).
  case posted = 0
  /// The post was not accepted within the deadline, or the system refused it.
  case failed = 1
  /// Notifications are off for Fleet Notifier (denied, or the one-time prompt not answered yet).
  case notAuthorized = 3
  /// Bad arguments.
  case badArgs = 4
}

/// One notification to post.
struct PostRequest: Equatable {
  var title: String
  var body: String
  var subtitle: String? = nil
  /// Replaces an earlier notification with the same id (the watchdog's condition key).
  var id: String? = nil
  /// A `fleet:` deep link, kept in the notification for the click.
  var url: String? = nil
  var dryRun = false
}

/// What the command line asks for.
enum Command: Equatable {
  /// No arguments: LaunchServices started the helper for a click on one of its notifications.
  case click
  case post(PostRequest)
  case help
  /// Bad arguments: the message for stderr (exit 4).
  case invalid(String)
}

/// Longest title / subtitle / body / id kept; longer values are cut (macOS shows far less anyway).
let maxTitle = 256
let maxBody = 2000
let maxId = 1024

let usage = """
  usage: fleet-notify --title T --body B [--subtitle S] [--id KEY] [--url fleet:LINK] [--dry-run]
    --id        an earlier notification with the same id is replaced
    --url       a fleet: deep link kept for the click
    --dry-run   validate and print the notification as JSON; post nothing
  exit: 0 posted, 1 not accepted, 3 not authorized, 4 bad arguments
  """

/// Parse `args` (without the program name). LaunchServices may add `-psn_…`: ignored.
func parseCommand(_ args: [String]) -> Command {
  let args = args.filter { !$0.hasPrefix("-psn_") }
  if args.isEmpty { return .click }
  var values: [String: String] = [:]
  var dryRun = false
  var i = 0
  while i < args.count {
    let arg = args[i]
    i += 1
    if arg == "--help" || arg == "-h" { return .help }
    if arg == "--dry-run" {
      dryRun = true
      continue
    }
    var name = arg
    var value: String? = nil
    if let eq = arg.firstIndex(of: "="), arg.hasPrefix("--") {
      name = String(arg[..<eq])
      value = String(arg[arg.index(after: eq)...])
    }
    guard ["--title", "--body", "--subtitle", "--id", "--url"].contains(name) else {
      return .invalid(arg.hasPrefix("-") ? "unknown option \(name)" : "unexpected argument \(arg)")
    }
    if values[name] != nil { return .invalid("\(name) given twice") }
    if value == nil {
      guard i < args.count else { return .invalid("\(name) needs a value") }
      value = args[i]
      i += 1
    }
    values[name] = value
  }
  func text(_ key: String, _ max: Int) -> String? {
    guard let v = values[key]?.trimmingCharacters(in: .whitespacesAndNewlines), !v.isEmpty else {
      return nil
    }
    return String(v.prefix(max))
  }
  guard let title = text("--title", maxTitle) else { return .invalid("--title is required") }
  guard let body = text("--body", maxBody) else { return .invalid("--body is required") }
  if values["--subtitle"] != nil && text("--subtitle", maxTitle) == nil {
    return .invalid("--subtitle is empty")
  }
  if values["--id"] != nil && text("--id", maxId) == nil { return .invalid("--id is empty") }
  var url: String? = nil
  if let raw = values["--url"] {
    guard let u = URL(string: raw), u.scheme?.lowercased() == "fleet" else {
      return .invalid("--url must be a fleet: link")
    }
    url = u.absoluteString
  }
  return .post(
    PostRequest(
      title: title, body: body, subtitle: text("--subtitle", maxTitle), id: text("--id", maxId),
      url: url, dryRun: dryRun))
}

/// The notification as JSON (the --dry-run output), keys sorted.
func describe(_ r: PostRequest) -> String {
  var o: [String: String] = ["title": r.title, "body": r.body]
  if let s = r.subtitle { o["subtitle"] = s }
  if let s = r.id { o["id"] = s }
  if let s = r.url { o["url"] = s }
  let data = try? JSONSerialization.data(withJSONObject: o, options: [.sortedKeys])
  return data.flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
}

/// Fleet Notifier's notification authorization, as UNAuthorizationStatus reports it.
enum AuthStatus {
  case notDetermined, denied, authorized, provisional, ephemeral
}

/// What to do before posting.
enum AuthStep: Equatable {
  case post
  /// Ask once (the system prompt); post if granted.
  case request
  /// Exit 3.
  case refuse
}

func authStep(_ status: AuthStatus) -> AuthStep {
  switch status {
  case .authorized, .provisional, .ephemeral: return .post
  case .notDetermined: return .request
  case .denied: return .refuse
  }
}

/// Fleet's bundle id from the helper's Info.plist `FleetAppIdentifier`, else its own id less
/// `.notifier`.
func fleetIdentifier(plistValue: String?, ownIdentifier: String?) -> String? {
  if let v = plistValue, !v.isEmpty { return v }
  if let own = ownIdentifier, own.hasSuffix(".notifier") {
    return String(own.dropLast(".notifier".count))
  }
  return nil
}

/// The `open` command a click runs: Fleet by bundle id, brought up with its window. Fleet has no
/// deep-link handler (no `desktop.app.deepLinks`), so a notification's `url` is not passed on; a
/// running Fleet gets a reopen (its window), a stopped one starts with `--show-window`.
func openCommand(fleetId: String) -> [String] {
  ["/usr/bin/open", "-b", fleetId, "--args", "--show-window"]
}
