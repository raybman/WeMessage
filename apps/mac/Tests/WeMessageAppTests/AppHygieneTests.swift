import Foundation
import Testing

/// H-A1 to H-A7 and the provisional-values row: what the window target may
/// import, name and hold. Mirrored by the "v2 S1: the Swift tree" rows of
/// test/arch.spec.ts. Framework, symbol and process names this file hunts for
/// are assembled at runtime, so the file never spells what it forbids.
@Suite("AppHygiene")
struct AppHygieneTests {
  static let appDir = "apps/mac/Sources/WeMessageApp"
  static let uiTestsDir = "apps/mac/UITests/WeMessageUITests"
  static let appTestsDir = "apps/mac/Tests/WeMessageAppTests"

  /// The modules the window target may import (H-A1).
  static let allowedImports: Set<String> = ["Foundation", "Swift" + "UI", "App" + "Kit", "Observation", "WeMessageKit"]

  /// H-A2: the daemon side of the tree and every way to start, signal or
  /// detach a process. The window never spawns, never signals and never
  /// daemonises; it is a client of the daemon, nothing more.
  static let neverInWindow = [
    "Signal" + "Forwarder", "Daemon" + "Host", "Spa" + "wner", "posix" + "_spawn", "Pro" + "cess(", "NS" + "Task",
    "sig" + "nal(", "sig" + "action", "WEMESSAGE" + "_HOST", "POSIX_SPAWN" + "_SETPGROUP", "set" + "sid",
    "set" + "pgid", "dae" + "mon(", "responsibility" + "_spawnattrs", "Com" + "bine",
    // v2 S3b (TN-env-forward): the UI tests copy WEMESSAGE_* keys by name;
    // the runner's whole environment never reaches the app.
    "launchEnvironment = " + "ProcessInfo",
  ]

  /// The accessibility identifiers that are the contract between the app and
  /// the UI tests (plan §4.3).
  static let identifiers = [
    "wemessage.shell", "wemessage.rail", "wemessage.rail.all", "wemessage.rail.imessage",
    "wemessage.rail.whatsapp", "wemessage.rail.linkedin", "wemessage.rail.email", "wemessage.sidebar",
    "wemessage.lens", "wemessage.sidebar.empty", "wemessage.connection", "wemessage.content.empty",
  ]

  static let nsApp = "NS" + "App"
  static let nsApplication = "NS" + "Application"
  static let nsWindow = "NS" + "Window"
  static let nsScreen = "NS" + "Screen"

  static func imports(_ text: String) throws -> [String] {
    let pattern =
      #"^[ \t]*(?:@\w+\s+)*import\s+(?:(?:typealias|struct|class|enum|protocol|let|var|func)\s+)?([A-Za-z_]\w*)"#
    let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
    let range = NSRange(text.startIndex..., in: text)
    return regex.matches(in: text, range: range).compactMap { match in
      Range(match.range(at: 1), in: text).map { String(text[$0]) }
    }
  }

  static func count(_ pattern: String, in text: String) throws -> Int {
    let regex = try NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines])
    return regex.numberOfMatches(in: text, range: NSRange(text.startIndex..., in: text))
  }

  static func swiftFiles(under rel: String) throws -> [String] {
    try Repo.files(under: rel, skipping: [".build", ".swiftpm"]).filter { $0.hasSuffix(".swift") }
  }

  /// (path relative to the repo, text) for every Swift file under `rel`.
  static func sources(_ rel: String) throws -> [(String, String)] {
    try swiftFiles(under: rel).map { (rel + "/" + $0, try Repo.text(rel + "/" + $0)) }
  }

  /// H-A7's declaration rule: a static stored value whose initialiser line
  /// reaches for the application, a window, a screen or the accent colour
  /// runs at first touch, which may be inside `swift test`.
  static func windowServerStatics(_ text: String) throws -> Int {
    try count(
      #"static (let|var)[^\n]*(\b"# + nsApp + #"\b|\b"# + nsApplication + #"\b|"# + nsWindow + "|" + nsScreen + #"|controlAccentColor)"#,
      in: text)
  }

  @Test("H-A1: every file under Sources/WeMessageApp imports only Foundation, SwiftUI, AppKit, Observation and WeMessageKit")
  func importRule() throws {
    let files = try Self.sources(Self.appDir)
    #expect(files.count >= 6)
    for (path, text) in files {
      let modules = Set(try Self.imports(text))
      #expect(modules.isSubset(of: Self.allowedImports), "\(path) imports \(modules.subtracting(Self.allowedImports).sorted())")
    }
  }

  @Test("H-A2: no file under Sources/WeMessageApp or UITests names the daemon host, a spawn, a signal, a new session or Combine")
  func neverInWindow() throws {
    let files = try Self.sources(Self.appDir) + Self.sources(Self.uiTestsDir)
    #expect(files.count >= 8, "app and UI test files swept: \(files.count)")
    for (path, text) in files {
      for token in Self.neverInWindow {
        #expect(!text.contains(token), "\(path) contains \(token)")
      }
    }
  }

  @Test("H-A3: colour literals live in Tokens.swift and nowhere else under Sources/WeMessageApp")
  func colourLocality() throws {
    let patterns = [#"0x[0-9A-Fa-f]{2},\s*0x"#, #"Color\(red:|NSColor\(red:|#[0-9a-fA-F]{6}"#]
    var inTokens = 0
    for (path, text) in try Self.sources(Self.appDir) {
      let hits = try patterns.reduce(0) { $0 + (try Self.count($1, in: text)) }
      if path.hasSuffix("/Tokens.swift") {
        inTokens += hits
      } else {
        #expect(hits == 0, "\(path) holds \(hits) colour literal(s)")
      }
    }
    // Non-vacuity: the regexes do find the palette where it is meant to be.
    #expect(inTokens >= 12, "colour literals found in Tokens.swift: \(inTokens)")
  }

  @Test("H-A3b: no system green, mint or teal anywhere under Sources/WeMessageApp, Tokens.swift included")
  func noSystemGreen() throws {
    let pattern = #"\.(green|mint|teal)\b"#
    var swept = 0
    for (path, text) in try Self.sources(Self.appDir) {
      swept += 1
      #expect(try Self.count(pattern, in: text) == 0, "\(path) names a system green")
    }
    #expect(swept >= 6)
    // Non-vacuity: the pattern does see the spelling it bans.
    #expect(try Self.count(pattern, in: "Circle().fill(." + "green)") == 1)
  }

  @Test("H-A4: no '@main' under apps/mac/Sources")
  func noMainAttribute() throws {
    var swept = 0
    for (path, text) in try Self.sources("apps/mac/Sources") {
      swept += 1
      #expect(!text.contains("@" + "main"), "\(path) carries the attribute")
    }
    #expect(swept >= 25)
  }

  @Test("H-A5: every accessibility identifier appears in ShellView.swift and in the UI test sources")
  func identifiers() throws {
    let shell = try Repo.text(Self.appDir + "/ShellView.swift")
    let ui = try Self.sources(Self.uiTestsDir).map(\.1).joined(separator: "\n")
    for id in Self.identifiers {
      #expect(shell.contains("\"\(id)\""), "ShellView.swift lacks \(id)")
      #expect(ui.contains("\"\(id)\""), "the UI tests never name \(id)")
    }
  }

  /// The text of `private struct <name>` up to the next top-level type.
  static func block(_ name: String, in text: String) -> String {
    guard let start = text.range(of: "private struct \(name)") else { return "" }
    let rest = text[start.upperBound...]
    let end = rest.range(of: "\nprivate struct ")?.lowerBound ?? rest.endIndex
    return String(rest[..<end])
  }

  @Test("H-A5+: every rail tile is labelled with its full channel name and bound to cmd-<digit>; the lens is labelled")
  func railAndLensLabels() throws {
    let shell = try Repo.text(Self.appDir + "/ShellView.swift")
    let rail = Self.block("RailView", in: shell)
    #expect(rail.contains("ForEach(ShellModel.Scope.allCases"), "the rail is not one tile per scope")
    #expect(rail.contains(".accessibilityLabel(scope.fullLabel)"), "a rail tile has no full-name label")
    #expect(rail.contains(".keyboardShortcut(KeyEquivalent(scope.shortcutDigit), modifiers: .command)"))
    let sidebar = Self.block("SidebarView", in: shell)
    #expect(sidebar.contains(#".accessibilityLabel("Lens")"#), "the lens picker is unlabelled")
    // A plain-style button is not a Tab stop on macOS (run 37555284794:
    // the first Tab went straight to the lens).
    #expect(Self.block("RailTile", in: shell).contains(".focusable()"), "the rail tiles are not Tab stops")
    // The window's hosting group is described (the audit's "Element has no
    // description" on the group above wemessage.shell).
    let delegate = try Repo.text(Self.appDir + "/AppDelegate.swift")
    #expect(delegate.contains("contentView?.setAccessibilityLabel(window.title)"))
  }

  @Test("H-A2+: every keyboard shortcut under Sources/WeMessageApp carries the command modifier (no bare letters in S3)")
  func shortcutsCarryCommand() throws {
    // A call with one level of nested parentheses in its argument.
    let call = try NSRegularExpression(pattern: #"keyboardShortcut\((?:[^()]|\([^()]*\))*\)"#)
    var found = 0
    for (path, text) in try Self.sources(Self.appDir) {
      for match in call.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        found += 1
        let hit = Range(match.range, in: text).map { String(text[$0]) } ?? ""
        #expect(hit.hasSuffix(", modifiers: .command)"), "\(path): \(hit)")
      }
    }
    #expect(found >= 1, "no shortcut found: the rail binds cmd-1..5")
    // Non-vacuity: the pattern sees a bare letter binding.
    let planted = "Button {}.keyboardShortcut(\"r\")"
    #expect(call.numberOfMatches(in: planted, range: NSRange(planted.startIndex..., in: planted)) == 1)
  }

  @Test("H-S1: under the UI-test flag the shell renders with animations off, so a snapshot is one settled frame")
  func snapshotsSettle() throws {
    let shell = try Repo.text(Self.appDir + "/ShellView.swift")
    let body = String(shell[shell.range(of: "struct ShellView: View {")!.lowerBound...])
      .components(separatedBy: "\nprivate struct ")[0]
    #expect(
      body.contains(".transaction { if TestHooks.isUITest { $0.disablesAnimations = true } }"),
      "ShellView does not disable animations under the UI-test flag")
  }

  @Test("H-A6: non-vacuity, the window target and the UI test bundle exist")
  func nonVacuity() throws {
    #expect(try Self.swiftFiles(under: Self.appDir).count >= 6)
    #expect(try Self.swiftFiles(under: Self.uiTestsDir).count >= 2)
  }

  @Test("H-A7: only AppDelegate names the application, only AppEntry starts it, no static reaches the window server, and the app's tests touch none of it")
  func windowServerHygiene() throws {
    let appWord = #"\b"# + Self.nsApp + #"(lication)?\b"#
    for (path, text) in try Self.sources(Self.appDir) {
      let name = (path as NSString).lastPathComponent
      if name != "AppDelegate.swift" {
        #expect(try Self.count(appWord, in: text) == 0, "\(path) names the application")
      }
      if name != "AppEntry.swift" {
        #expect(!text.contains("ShellApp" + ".main()"), "\(path) starts the app")
      }
      #expect(try Self.windowServerStatics(text) == 0, "\(path) has a static that touches the window server")
    }
    // Non-vacuity: the delegate really is where the application is named,
    // and the declaration rule fires on a planted line.
    let delegate = try Repo.text(Self.appDir + "/AppDelegate.swift")
    #expect(try Self.count(appWord, in: delegate) >= 1)
    #expect(try Repo.text(Self.appDir + "/AppEntry.swift").contains("ShellApp" + ".main()"))
    #expect(try Self.windowServerStatics("static let w = " + Self.nsScreen + ".main") == 1)
    #expect(try Self.windowServerStatics("static var a = " + Self.nsApp + ".appearance") == 1)
    #expect(try Self.windowServerStatics("static let x = " + Self.nsApp + "earance.Name.aqua") == 0)

    // The unit tests never create an application, a window or a screen.
    let banned = [
      appWord, #"\b"# + Self.nsApplication + #"\.shared\b"#, Self.nsWindow, Self.nsScreen, "CGWindow" + "List",
    ]
    var swept = 0
    for (path, text) in try Self.sources(Self.appTestsDir) {
      swept += 1
      for pattern in banned {
        #expect(try Self.count(pattern, in: text) == 0, "\(path) matches \(pattern)")
      }
    }
    #expect(swept >= 4)
  }

  @Test("D-UI: every provisional design value lives in ProvisionalUI.swift, marked pending Eric's D-UI-1..6, and is never repeated as a literal")
  func provisionalValues() throws {
    let file = Self.appDir + "/ProvisionalUI.swift"
    let provisional = try Repo.text(file)
    #expect(provisional.contains("PROVISIONAL pending Eric's D-UI-1..6 decisions"))
    for key in ["D-UI-1", "D-UI-2", "D-UI-3", "D-UI-4", "D-UI-5", "D-UI-6"] {
      #expect(provisional.contains(key), "ProvisionalUI.swift does not mark \(key)")
    }
    // Foundation only: the UI test bundle compiles this file too.
    #expect(try Self.imports(provisional) == ["Foundation"])

    // Every copy string of six characters or more (dictionary keys are the
    // scopes' raw values, not copy).
    let literal = try NSRegularExpression(pattern: #""([^"\\\n]{6,})"(?!\s*:)"#)
    let strings = literal.matches(in: provisional, range: NSRange(provisional.startIndex..., in: provisional))
      .compactMap { Range($0.range(at: 1), in: provisional).map { String(provisional[$0]) } }
      .filter { !$0.contains("D-UI") }
    #expect(strings.count >= 3, "provisional copy strings found: \(strings)")
    let numbers = #"\b(1180|760|870|560)\b"#
    #expect(try Self.count(numbers, in: provisional) >= 4)

    let others = try (Self.sources(Self.appDir) + Self.sources(Self.uiTestsDir)).filter { !$0.0.hasSuffix("/ProvisionalUI.swift") }
    #expect(others.count >= 8)
    for (path, text) in others {
      for s in strings {
        #expect(!text.contains(s), "\(path) repeats the provisional copy \"\(s)\"")
      }
      #expect(try Self.count(numbers, in: text) == 0, "\(path) repeats a provisional window size as a literal")
    }
  }
}
