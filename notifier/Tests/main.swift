// Fleet Notifier's core (notifier/Sources/Core.swift), checked without XCTest: compiled with it
// alone into one executable that exits 1 on the first failed check. tests/notifier.test.ts builds
// and runs it.

import Foundation

nonisolated(unsafe) var failures = 0
nonisolated(unsafe) var checks = 0

func check<T: Equatable>(_ got: T, _ want: T, _ what: String, line: Int = #line) {
  checks += 1
  if got != want {
    failures += 1
    print("FAIL line \(line): \(what)\n  got:  \(got)\n  want: \(want)")
  }
}

func invalid(_ args: [String]) -> Bool {
  if case .invalid = parseCommand(args) { return true }
  return false
}

// No arguments (LaunchServices, a click): click mode; its -psn_ argument is ignored.
check(parseCommand([]), .click, "no arguments")
check(parseCommand(["-psn_0_12345"]), .click, "a -psn_ argument only")
check(parseCommand(["--help"]), .help, "--help")

// A full post, both spellings.
check(
  parseCommand([
    "--title", "Pool mac-arm", "--body", "queued 16m", "--subtitle", "watchdog", "--id",
    "stuck:mac-arm", "--url", "fleet://alerts/stuck",
  ]),
  .post(
    PostRequest(
      title: "Pool mac-arm", body: "queued 16m", subtitle: "watchdog", id: "stuck:mac-arm",
      url: "fleet://alerts/stuck")),
  "every option")
check(
  parseCommand(["--title=T", "--body=B=C", "--dry-run"]),
  .post(PostRequest(title: "T", body: "B=C", dryRun: true)), "--name=value and --dry-run")
// An id is the watchdog's condition key as is: spaces and punctuation included.
check(
  parseCommand(["--title", "T", "--body", "B", "--id", "msg:pool # REFUSED: a/b (x)"]),
  .post(PostRequest(title: "T", body: "B", id: "msg:pool # REFUSED: a/b (x)")), "a free-form id")
// A value may start with dashes (a message that does).
check(
  parseCommand(["--title", "T", "--body", "--not-an-option"]),
  .post(PostRequest(title: "T", body: "--not-an-option")), "a value that starts with --")
// Whitespace around values is trimmed; long values are cut.
check(
  parseCommand(["--title", "  T \n", "--body", String(repeating: "b", count: 5000)]),
  .post(PostRequest(title: "T", body: String(repeating: "b", count: maxBody))), "trim and cut")

// Bad arguments: exit 4.
check(invalid(["--body", "B"]), true, "no --title")
check(invalid(["--title", "T"]), true, "no --body")
check(invalid(["--title", " ", "--body", "B"]), true, "a blank --title")
check(invalid(["--title", "T", "--body", "B", "--id", ""]), true, "an empty --id")
check(invalid(["--title", "T", "--body", "B", "--subtitle", ""]), true, "an empty --subtitle")
check(invalid(["--title", "T", "--body"]), true, "a missing value")
check(invalid(["--title", "T", "--title", "U", "--body", "B"]), true, "an option given twice")
check(invalid(["--title", "T", "--body", "B", "--sound", "x"]), true, "an unknown option")
check(invalid(["--title", "T", "--body", "B", "extra"]), true, "a stray argument")
check(invalid(["--title", "T", "--body", "B", "--url", "https://x.test"]), true, "a non-fleet url")
check(invalid(["--title", "T", "--body", "B", "--url", "not a url"]), true, "a malformed url")

// Exit codes are the documented ones.
check(ExitCode.posted.rawValue, 0, "posted")
check(ExitCode.notAuthorized.rawValue, 3, "not authorized")
check(ExitCode.badArgs.rawValue, 4, "bad args")

// Authorization: ask only while undetermined; denied refuses (exit 3).
check(authStep(.notDetermined), .request, "undetermined asks")
check(authStep(.denied), .refuse, "denied refuses")
check(authStep(.authorized), .post, "authorized posts")
check(authStep(.provisional), .post, "provisional posts")
check(authStep(.ephemeral), .post, "ephemeral posts")

// A click opens Fleet by its bundle id.
check(
  fleetIdentifier(plistValue: "dev.brainwires.fleet", ownIdentifier: "x.notifier"),
  "dev.brainwires.fleet", "the plist key wins")
check(
  fleetIdentifier(plistValue: nil, ownIdentifier: "dev.brainwires.fleet.notifier"),
  "dev.brainwires.fleet", "else the own id less .notifier")
check(fleetIdentifier(plistValue: "", ownIdentifier: "other"), nil, "else none")
check(
  openCommand(fleetId: "dev.brainwires.fleet"),
  ["/usr/bin/open", "-b", "dev.brainwires.fleet", "--args", "--show-window"], "the open command")

// --dry-run's JSON.
check(
  describe(PostRequest(title: "T", body: "B", id: "k")), #"{"body":"B","id":"k","title":"T"}"#,
  "dry-run JSON")

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
