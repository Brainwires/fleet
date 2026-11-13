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

// The waits: an authorized post shares 1.8 s from the start; the prompt waits 60 s for the answer;
// after an answer the post gets 1.8 s of its own.
check(phaseDeadline(.settings, start: 100), 101.8, "settings: start + 1.8")
check(phaseDeadline(.add, start: 100), 101.8, "add, authorized: the same 1.8 s from the start")
check(phaseDeadline(.prompt, start: 100, promptStart: 100.2), 160.2, "prompt: 60 s from asking")
check(
  phaseDeadline(.add, start: 100, promptStart: 100.2, promptAnswered: 130), 131.8,
  "add after the prompt: 1.8 s from the answer")
check(postBudget < 2, true, "an authorized post exits within 2 s")
check(promptBudget, 60, "the prompt waits about 60 s")
check(timeoutOutcome(.prompt).0, .notAuthorized, "an unanswered prompt exits 3")
check(timeoutOutcome(.settings).0, .failed, "slow settings exit 1")
check(timeoutOutcome(.add).0, .failed, "a slow post exits 1")

// LaunchServices: register only when it knows no app for the id, and only a bundle.
let own = "/Users/u/Applications/Fleet.app/Contents/Helpers/Fleet Notifier.app"
check(needsRegistration(registeredURL: nil, ownBundlePath: own), true, "unregistered: register")
check(
  needsRegistration(registeredURL: URL(fileURLWithPath: own), ownBundlePath: own), false,
  "registered: nothing to do")
check(needsRegistration(registeredURL: nil, ownBundlePath: "/tmp/fleet-notify"), false, "not a bundle")

// The LaunchServices-launched permission instance.
check(parseCommand(["--request-authorization"]), .requestAuthorization, "--request-authorization")
check(invalid(["--request-authorization", "--title", "T"]), true, "--request-authorization alone")
check(
  authorizationLaunchCommand(bundlePath: "/A/Fleet Notifier.app"),
  ["/usr/bin/open", "-n", "-g", "-a", "/A/Fleet Notifier.app", "--args", "--request-authorization"],
  "the LaunchServices launch")
check(promptPoll(.notDetermined, now: 10, deadline: 60), .keepWaiting, "undetermined: wait")
check(promptPoll(.notDetermined, now: 60, deadline: 60), .timedOut, "undetermined at the deadline")
check(promptPoll(.authorized, now: 10, deadline: 60), .post, "allowed: post")
check(promptPoll(.provisional, now: 10, deadline: 60), .post, "provisional: post")
check(promptPoll(.denied, now: 10, deadline: 60), .refuse, "denied: exit 3")
check(promptPoll(.denied, now: 99, deadline: 60), .refuse, "denied wins over the deadline")

print("\(checks - failures)/\(checks) checks passed")
exit(failures == 0 ? 0 : 1)
