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
    // v2 S4c, board 01.
    "wemessage.title", "wemessage.title.counter", "wemessage.lens.recent", "wemessage.lens.needsyou",
    "wemessage.lens.triage", "wemessage.kill.chip", "wemessage.content", "wemessage.inspector",
    "wemessage.inspector.toggle",
    // v2 S4d, board 02.
    "wemessage.thread", "wemessage.thread.banner", "wemessage.thread.capability.note", "wemessage.thread.inv5",
    "wemessage.thread.draft", "wemessage.thread.draft.approve", "wemessage.thread.draft.edit",
    "wemessage.thread.draft.hold", "wemessage.composer", "wemessage.composer.field", "wemessage.composer.send",
    "wemessage.composer.hold", "wemessage.composer.outbox",
    // v2 S4e, board 08 (the per-specimen ids are prefixes: atlas.<slug>,
    // bubble.reaction.<guid>.<n>, bubble.delivery.<guid>, bubble.draft.<id>,
    // bubble.sms.<guid>, bubble.effect.<guid>, bubble.unsupported.<guid>).
    "wemessage.atlas",
    // v2 S4f, boards 06 and 09 (prefixes: bulk.included.<id>,
    // bulk.excluded.<id>, draft.<id>.<verb>, audit.row.<seq>).
    "wemessage.triage.bar", "wemessage.bulk.strip", "wemessage.bulk.open", "wemessage.audit.open",
    "wemessage.bulk.sheet", "wemessage.bulk.confirm", "wemessage.bulk.cancel", "wemessage.undo.ring",
    "wemessage.verbs", "wemessage.verb.reply", "wemessage.verb.done", "wemessage.verb.snooze", "wemessage.verb.mute",
    "wemessage.thread.release", "wemessage.kill.banner", "wemessage.kill.disengage", "wemessage.zero",
    "wemessage.zero.receipt", "wemessage.zero.verify", "wemessage.connect.card", "wemessage.audit",
    "wemessage.audit.close",
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

  /// v2 S4g: the one file that may reach Contacts, and the one module it adds.
  static let contactsFile = appDir + "/Models/ContactsAvatarProvider.swift"
  static let contactsModule = "Con" + "tacts"

  @Test("H-A1: every file under Sources/WeMessageApp imports only Foundation, SwiftUI, AppKit, Observation and WeMessageKit; Contacts only in ContactsAvatarProvider.swift")
  func importRule() throws {
    let files = try Self.sources(Self.appDir)
    #expect(files.count >= 6)
    var contacts: [String] = []
    for (path, text) in files {
      let modules = Set(try Self.imports(text))
      let allowed = path == Self.contactsFile ? Self.allowedImports.union([Self.contactsModule]) : Self.allowedImports
      #expect(modules.isSubset(of: allowed), "\(path) imports \(modules.subtracting(allowed).sorted())")
      if modules.contains(Self.contactsModule) { contacts.append(path) }
    }
    #expect(contacts == [Self.contactsFile], "Contacts imported by \(contacts)")
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

  /// The text of `struct <name>` (private or not) up to the next top-level
  /// struct.
  static func block(_ name: String, in text: String) -> String {
    guard let start = text.range(of: "struct \(name): ") else { return "" }
    let rest = text[start.upperBound...]
    let ends = ["\nprivate struct ", "\nstruct "].compactMap { rest.range(of: $0)?.lowerBound }
    return String(rest[..<(ends.min() ?? rest.endIndex)])
  }

  @Test("H-A5+: every rail tile is labelled with its full channel name and bound to cmd-<digit>; the lens is labelled")
  func railAndLensLabels() throws {
    let shell = try Repo.text(Self.appDir + "/ShellView.swift")
    let rail = Self.block("RailView", in: shell)
    #expect(rail.contains("ForEach(ShellModel.Scope.allCases"), "the rail is not one tile per scope")
    #expect(rail.contains(".accessibilityLabel(scope.fullLabel)"), "a rail tile has no full-name label")
    #expect(rail.contains(".keyboardShortcut(KeyEquivalent(scope.shortcutDigit), modifiers: .command)"))
    // v2 S4c: the lens lives in the title bar, labelled, each segment a Tab
    // stop; the kill chip is a Tab stop bound to shift-cmd-K.
    let titleBar = try Repo.text(Self.appDir + "/Boards/Shell/TitleBar.swift")
    let lens = Self.block("LensPicker", in: titleBar)
    #expect(lens.contains(#".accessibilityLabel("Lens")"#), "the lens picker is unlabelled")
    #expect(lens.contains(".accessibilityIdentifier(ShellID.lens)"))
    #expect(lens.components(separatedBy: ".focusable()").count - 1 >= 2, "the lens segments are not Tab stops")
    #expect(lens.contains(#".keyboardShortcut("t", modifiers: .command)"#), "Triage is not cmd-T")
    let kill = Self.block("KillChip", in: titleBar)
    #expect(kill.contains(".focusable()"), "the kill chip is not a Tab stop")
    #expect(kill.contains(#".keyboardShortcut("k", modifiers: [.command, .shift])"#), "the kill chip is not shift-cmd-K")
    #expect(kill.contains("engageKillSwitch()"))
    #expect(kill.contains(".accessibilityIdentifier(ShellID.killChip)"), "the kill chip has no identifier")
    // Always visible: the title bar places it unconditionally, outside any
    // if, so no state can drop it.
    let bar = Self.block("TitleBar", in: titleBar)
    let placed = bar.components(separatedBy: "\n").filter { $0.contains("KillChip(model:") }
    #expect(placed.count == 1, "the title bar does not place the kill chip once")
    if let line = placed.first, let at = bar.range(of: line) {
      let opened = bar[..<at.lowerBound].components(separatedBy: "if ").count - 1
      let closed = bar[..<at.lowerBound].components(separatedBy: "\n      }").count - 1
      #expect(opened == closed, "the kill chip sits inside a condition")
    }
    #expect(!kill.contains("setKillSwitch(false"), "the chip turns sending back on")
    // A plain-style button is not a Tab stop on macOS (run 37555284794:
    // the first Tab went straight to the lens).
    #expect(Self.block("RailTile", in: shell).contains(".focusable()"), "the rail tiles are not Tab stops")
    // The rows are one element each and never a Tab stop.
    let rows = try Repo.text(Self.appDir + "/Boards/Shell/ThreadViews.swift")
    let row = Self.block("ListRow", in: rows)
    #expect(row.contains(".focusable(false)"))
    #expect(row.contains(".accessibilityElement(children: .ignore)"))
    // The window's hosting group is described (the audit's "Element has no
    // description" on the group above wemessage.shell), and so is every
    // window-sized view under it (S4a: the frost container background).
    let delegate = try Repo.text(Self.appDir + "/AppDelegate.swift")
    let describe = Self.function("describe(_ window: " + Self.nsWindow + "?)", in: delegate)
    #expect(describe.contains("let root = window.contentView"))
    #expect(describe.contains("root.setAccessibilityLabel(window.title)"))
    #expect(describe.contains("view.setAccessibilityLabel(window.title)"))
    #expect(describe.contains("(root.superview ?? root).subviews"))
    #expect(describe.contains("sizes.contains(view.frame.size)"))
    #expect(describe.contains("level.flatMap(\\.subviews)"))
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
        let listed = try Self.count(#", modifiers: \[[^\]]*\.command\b[^\]]*\]\)$"#, in: hit)
        let command = hit.hasSuffix(", modifiers: .command)") || listed == 1
        #expect(command, "\(path): \(hit)")
      }
    }
    #expect(found >= 1, "no shortcut found: the rail binds cmd-1..5")
    // Non-vacuity: the pattern sees a bare letter binding.
    let planted = "Button {}.keyboardShortcut(\"r\")"
    #expect(call.numberOfMatches(in: planted, range: NSRange(planted.startIndex..., in: planted)) == 1)
  }

  @Test("H-S4c: the reload key (cmd-opt-R) exists only under the UI-test flag, and the window names no send route")
  func reloadOnlyUnderTestFlag() throws {
    let shell = try Repo.text(Self.appDir + "/ShellView.swift")
    let binding = #".keyboardShortcut("r", modifiers: [.command, .option])"#
    #expect(shell.components(separatedBy: binding).count - 1 == 1)
    guard let at = shell.range(of: binding) else { return }
    let before = shell[..<at.lowerBound]
    let guardLine = before.range(of: "if TestHooks.isUITest {", options: .backwards)
    #expect(guardLine != nil, "the reload key is not under the UI-test flag")
    if let guardLine {
      let between = shell[guardLine.upperBound..<at.lowerBound]
      #expect(!between.contains("\n    }"), "the reload key sits after the flag's block closed")
    }
    var swept = 0
    for (path, text) in try Self.sources(Self.appDir) {
      swept += 1
      // v2 S4d: the send funnel is the one caller (H-S4-2 holds it there).
      if !path.hasSuffix("/Models/Outbound.swift") {
        #expect(!text.contains(".send" + "(to:"), "\(path) calls the client's send")
      }
      #expect(!text.contains("/v1/" + "send"), "\(path) names the send route")
    }
    #expect(swept >= 12)
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

  /// The D-UI questions ProvisionalUI.swift answers provisionally: S3's
  /// 1..6, S4's 7..21 (plan section 5 and the S4a.0 spike's D-UI-21) and
  /// S4c's 22..26 (choices the board 01 wireframe left open), S4d's
  /// 27..38 (choices board 02 left open, or the daemon cannot yet serve)
  /// S4e's 39..42 (where board 08 and the plan disagree) and S4f's 43..53
  /// (where boards 06 and 09 leave a choice open), and S4g's 54..57 (the
  /// avatar choices the plan leaves open), and S4h's 58..68 (where board 10
  /// leaves a choice open or the daemon cannot serve what it draws).
  static let dUIKeys = (1...68).map { "D-UI-\($0)" }

  /// ProvisionalUI.swift cut into its "// D-UI-n:" sections, keyed by n.
  static func dUISections(_ text: String) throws -> [Int: String] {
    let regex = try NSRegularExpression(pattern: #"^[ \t]*// D-UI-(\d+):"#, options: [.anchorsMatchLines])
    let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
    var out: [Int: String] = [:]
    for (i, match) in matches.enumerated() {
      guard let numberRange = Range(match.range(at: 1), in: text), let n = Int(text[numberRange]),
        let start = Range(match.range, in: text)?.lowerBound
      else { continue }
      let end = i + 1 < matches.count ? Range(matches[i + 1].range, in: text)?.lowerBound ?? text.endIndex : text.endIndex
      out[n] = String(text[start..<end])
    }
    return out
  }

  @Test("D-UI: every provisional design value lives in ProvisionalUI.swift, marked pending Eric's D-UI-1..68, one section and at least one constant per question, and is never repeated as a literal")
  func provisionalValues() throws {
    let file = Self.appDir + "/ProvisionalUI.swift"
    let provisional = try Repo.text(file)
    #expect(provisional.contains("PROVISIONAL pending Eric's D-UI-1..68 decisions"))
    for key in Self.dUIKeys {
      // D-UI-1 must not be satisfied by D-UI-10..19.
      #expect(try Self.count(key + #"(?!\d)"#, in: provisional) >= 1, "ProvisionalUI.swift does not mark \(key)")
    }
    // One section per question, in order, each holding a constant the app
    // can read.
    let sections = try Self.dUISections(provisional)
    #expect(sections.keys.sorted() == Array(1...68), "sections found: \(sections.keys.sorted())")
    for (n, body) in sections.sorted(by: { $0.key < $1.key }) {
      #expect(body.contains("public static let ") || body.contains("public static func "), "D-UI-\(n) holds no constant")
    }
    // D-UI-21 (the S4a.0 spike's material): regular material, as an enum
    // case, never a string another file could copy.
    let material = sections[21] ?? ""
    #expect(material.contains("public static let frostMaterial: FrostMaterial = .regular"))
    #expect(material.contains("containerBackground"), "D-UI-21 does not say where the material is applied")
    // Foundation only: the UI test bundle compiles this file too.
    #expect(try Self.imports(provisional) == ["Foundation"])

    // Every copy string of six characters or more (dictionary keys are the
    // scopes' raw values, not copy).
    let literal = try NSRegularExpression(pattern: #""([^"\\\n]{6,})"(?!\s*:)"#)
    let strings = literal.matches(in: provisional, range: NSRange(provisional.startIndex..., in: provisional))
      .compactMap { Range($0.range(at: 1), in: provisional).map { String(provisional[$0]) } }
      .filter { !$0.contains("D-UI") }
    #expect(strings.count >= 7, "provisional copy strings found: \(strings)")
    // No material or style name is copy: those are enum cases.
    #expect(strings.filter { $0.contains("Material") }.isEmpty, "a material is spelled as a string: \(strings)")
    let numbers = #"\b(1180|760|870|560)\b"#
    #expect(try Self.count(numbers, in: provisional) >= 4)

    let others = try (Self.sources(Self.appDir) + Self.sources(Self.uiTestsDir)).filter { !$0.0.hasSuffix("/ProvisionalUI.swift") }
    #expect(others.count >= 14)
    for (path, text) in others {
      for s in strings {
        #expect(!text.contains(s), "\(path) repeats the provisional copy \"\(s)\"")
      }
      #expect(try Self.count(numbers, in: text) == 0, "\(path) repeats a provisional window size as a literal")
    }
  }

  // MARK: S4a

  /// The H-S4-5 verdicts over (path, text) pairs: every way the contacts
  /// store could be named outside its one file, or built where the UI-test
  /// flag could reach it (a TCC prompt hangs the ui job).
  static func contactsLeaks(_ files: [(String, String)], home: String, hooks: String) -> [String] {
    let store = "CN" + "Contact" + "Store"
    let system = "System" + "Contacts("
    let provider = "Contacts" + "AvatarProvider("
    let guardLine = "precondition(!TestHooks.isUITest"
    var leaks: [String] = []
    for (path, text) in files {
      if path != home && text.contains(store) { leaks.append("\(path): names the store") }
      if path != hooks && text.contains(system) { leaks.append("\(path): builds the system seam") }
      if path != hooks && path != home && text.contains(provider) && !path.contains("/Tests/") {
        leaks.append("\(path): builds the provider")
      }
    }
    // Its own file builds the store once, as the first act of an init whose
    // first statement refuses the UI-test flag; the provider's init refuses
    // it too.
    let own = files.first { $0.0 == home }?.1 ?? ""
    let builds = own.components(separatedBy: store + "(").count - 1
    if builds != 1 { leaks.append("\(home): builds the store \(builds) times") }
    if let at = own.range(of: store + "(") {
      let head = own[..<at.lowerBound]
      let initAt = head.range(of: "init(", options: .backwards)
      let body = initAt.map { String(head[$0.upperBound...]) } ?? ""
      let first = body.split(separator: "{", maxSplits: 1).dropFirst().first?
        .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
        .first { !$0.isEmpty && !$0.hasPrefix("//") } ?? ""
      if !first.hasPrefix(guardLine) { leaks.append("\(home): the store is built after \(first)") }
    }
    let inits = own.components(separatedBy: "init(").count - 1
    let guarded = own.components(separatedBy: guardLine).count - 1
    if guarded < 2 || guarded < inits { leaks.append("\(home): \(inits) inits, \(guarded) refuse the flag") }
    // The hooks build the seam once, on the line after the flag returns.
    let hooksText = files.first { $0.0 == hooks }?.1 ?? ""
    let lines = hooksText.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
    let at = lines.indices.filter { lines[$0].contains(system) }
    if at.count != 1 {
      leaks.append("\(hooks): builds the system seam \(at.count) times")
    } else if let line = at.first {
      let before = lines[..<line].last { !$0.isEmpty && !$0.hasPrefix("//") } ?? ""
      if !before.hasPrefix("if isUITest { return ") { leaks.append("\(hooks): the seam is not behind the flag: \(before)") }
    }
    return leaks
  }

  @Test("H-S4-5: the contacts store is named only in ContactsAvatarProvider.swift, built once behind a UI-test-flag refusal, and the hooks build it only after the flag returns the fixtures")
  func contactsStoreOnlyInProvider() throws {
    let home = Self.contactsFile
    let hooks = Self.appDir + "/TestHooks.swift"
    let files =
      try Self.sources("apps/mac/Sources") + Self.sources(Self.uiTestsDir) + Self.sources(Self.appTestsDir)
    #expect(files.count >= 40)
    #expect(Self.contactsLeaks(files, home: home, hooks: hooks) == [])
    // The provider is built in the hooks, and nowhere else in the app.
    let hooksText = try Repo.text(hooks)
    #expect(hooksText.contains("if isUITest { return FixtureAvatarProvider() }"))
    let seam = "System" + "Contacts()"
    #expect(hooksText.contains("return ContactsAvatarProvider(fetching: \(seam))"))

    // Non-vacuity, on planted trees.
    let store = "CN" + "Contact" + "Store"
    let good = [
      (home, "final class S {\n  @MainActor init() {\n    precondition(!TestHooks.isUITest, \"x\")\n    s = \(store)()\n  }\n}\nstruct P {\n  @MainActor init(f: F) {\n    precondition(!TestHooks.isUITest, \"x\")\n  }\n}"),
      (hooks, "static func p() -> any AvatarProvider {\n    if isUITest { return FixtureAvatarProvider() }\n    return ContactsAvatarProvider(fetching: \(seam))\n  }"),
    ]
    #expect(Self.contactsLeaks(good, home: home, hooks: hooks) == [])
    let named = good + [("app/ShellView.swift", "let s = \(store).self")]
    #expect(Self.contactsLeaks(named, home: home, hooks: hooks) == ["app/ShellView.swift: names the store"])
    let late = [(home, good[0].1.replacingOccurrences(of: "    precondition(!TestHooks.isUITest, \"x\")\n    s =", with: "    s =")), good[1]]
    #expect(Self.contactsLeaks(late, home: home, hooks: hooks).contains { $0.contains("the store is built after") })
    let unguarded = [good[0], (hooks, good[1].1.replacingOccurrences(of: "    if isUITest { return FixtureAvatarProvider() }\n", with: ""))]
    #expect(Self.contactsLeaks(unguarded, home: home, hooks: hooks).contains { $0.contains("not behind the flag") })
    let elsewhere = good + [("app/ShellModel.swift", "let a = \(seam)")]
    #expect(Self.contactsLeaks(elsewhere, home: home, hooks: hooks) == ["app/ShellModel.swift: builds the system seam"])
  }

  /// Types declared in a file under Fixtures/, and every name that looks like
  /// a fixture type ("Fixture" then an upper-case letter).
  static func fixtureNames(_ text: String) throws -> Set<String> {
    let regex = try NSRegularExpression(pattern: #"\bFixture[A-Z]\w*"#)
    return Set(
      regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        .compactMap { Range($0.range, in: text).map { String(text[$0]) } })
  }

  static func declaredTypes(_ text: String) throws -> Set<String> {
    let regex = try NSRegularExpression(
      pattern: #"^[ \t]*(?:@\w+\s+)*(?:(?:public|internal|fileprivate|private|final|nonisolated)\s+)*(?:struct|class|enum|actor|protocol)\s+([A-Za-z_]\w*)"#,
      options: [.anchorsMatchLines])
    return Set(
      regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
        .compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } })
  }

  /// The H-S4-1 verdicts over (path, text) pairs: every offending
  /// "<path>: <name>".
  static func fixtureLeaks(_ files: [(String, String)]) throws -> [String] {
    let inFixtures = files.filter { $0.0.contains("/Fixtures/") }
    var fixtureTypes = Set<String>()
    for (_, text) in inFixtures { fixtureTypes.formUnion(try declaredTypes(text)) }
    var leaks: [String] = []
    for (path, text) in files where !path.contains("/Fixtures/") {
      if path.hasSuffix("/TestHooks.swift") { continue }
      var names = try fixtureNames(text)
      for type in fixtureTypes {
        if try count(#"\b"# + type + #"\b"#, in: text) > 0 { names.insert(type) }
      }
      leaks += names.sorted().map { "\(path): \($0)" }
    }
    // A Fixture-named type declared outside Fixtures/ is a leak too.
    for (path, text) in files where !path.contains("/Fixtures/") {
      leaks += try declaredTypes(text).filter { $0.hasPrefix("Fixture") }.sorted().map { "\(path): declares \($0)" }
    }
    return leaks
  }

  @Test("H-S4-1: fixture types live in Sources/WeMessageApp/Fixtures and are named only there and in the TestHooks switch")
  func fixturesStayFixtures() throws {
    let files = try Self.sources(Self.appDir)
    #expect(files.count >= 10)
    #expect(try Self.fixtureLeaks(files) == [])
    // Non-vacuity, on planted trees: a fixture type named by a view is a
    // leak, by its prefix or by its declaration in Fixtures/; the switch is
    // allowed.
    let fixtures = ("app/Fixtures/Avatars.swift", "struct CannedAvatars {}\nenum FixtureCatalogue {}")
    let hooks = ("app/TestHooks.swift", "let a = CannedAvatars(); let c = FixtureCatalogue.self")
    #expect(try Self.fixtureLeaks([fixtures, hooks]) == [])
    let view = ("app/Boards/Shell/ShellView.swift", "let a = CannedAvatars()")
    #expect(try Self.fixtureLeaks([fixtures, hooks, view]) == ["app/Boards/Shell/ShellView.swift: CannedAvatars"])
    let prefixed = ("app/Glass/Frost.swift", "let c = FixtureCatalogue.self")
    #expect(try Self.fixtureLeaks([fixtures, prefixed]) == ["app/Glass/Frost.swift: FixtureCatalogue"])
    let declared = ("app/Models/Thread.swift", "final class FixtureThreads {}")
    #expect(
      try Self.fixtureLeaks([declared]) == [
        "app/Models/Thread.swift: FixtureThreads", "app/Models/Thread.swift: declares FixtureThreads",
      ])
  }

  @Test("H-S4-3: the CI backdrop window is named only by its own file and the delegate, built only under the UI-test flag, and never pinned")
  func backdropOnlyUnderTestFlag() throws {
    let name = "Backdrop" + "Window"
    let own = Self.appDir + "/Glass/" + name + ".swift"
    let delegatePath = Self.appDir + "/AppDelegate.swift"
    var namedIn: [String] = []
    for (path, text) in try Self.sources(Self.appDir) + Self.sources(Self.uiTestsDir) where text.contains(name) {
      namedIn.append(path)
    }
    #expect(namedIn.sorted() == [delegatePath, own].sorted(), "named in \(namedIn)")
    // Its initialiser refuses to run outside the flag.
    let ownText = try Repo.text(own)
    #expect(ownText.contains("precondition(TestHooks.isUITest"))
    #expect(ownText.contains("override var canBecomeKey: Bool { false }"))
    #expect(ownText.contains("override var canBecomeMain: Bool { false }"))
    #expect(ownText.contains("ignoresMouseEvents = true"))
    #expect(ownText.contains("override func isAccessibilityElement() -> Bool { false }"))
    // The delegate constructs it once, in a function whose first statement
    // returns unless the flag is on, and pin() never picks it.
    let delegate = try Repo.text(delegatePath)
    #expect(delegate.components(separatedBy: name + "(").count - 1 == 1, "the delegate builds it more than once")
    guard let construct = delegate.range(of: name + "(") else {
      Issue.record("the delegate never builds the backdrop")
      return
    }
    let before = delegate[..<construct.lowerBound]
    guard let fn = before.range(of: "func ", options: .backwards) else {
      Issue.record("the backdrop is built outside a function")
      return
    }
    let body = delegate[fn.lowerBound..<construct.lowerBound]
    let firstStatement = body.split(separator: "{", maxSplits: 1).dropFirst().first?
      .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty && !$0.hasPrefix("//") }
    #expect(firstStatement == "guard TestHooks.isUITest else { return }", "first statement: \(String(describing: firstStatement))")
    let pin = Self.function("pin()", in: delegate)
    #expect(pin.contains("!($0 is " + name + ")"), "pin() can pick the backdrop")
  }

  /// The text of `func <signature>` up to the next `func ` (or the end).
  static func function(_ signature: String, in text: String) -> String {
    guard let start = text.range(of: "func " + signature) else { return "" }
    let rest = text[start.upperBound...]
    let end = rest.range(of: "func ")?.lowerBound ?? rest.endIndex
    return String(rest[..<end])
  }

  @Test("H-S4-3b: FrostEvidence's layer0 triples equal Tokens' layer0, so the opaque legs compare against what the app paints")
  func frostEvidenceLayer0() throws {
    let evidence = try Repo.text(Self.uiTestsDir + "/Support/FrostEvidence.swift")
    let tokens = try Repo.text(Self.appDir + "/Tokens.swift")
    func triple(_ pattern: String, in text: String) throws -> [String] {
      let regex = try NSRegularExpression(pattern: pattern)
      let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
      guard matches.count == 1, let m = matches.first else { return ["matches: \(matches.count)"] }
      return (1...3).compactMap { Range(m.range(at: $0), in: text).map { String(text[$0]) } }
    }
    let hex = #"(0x[0-9A-F]{2}), (0x[0-9A-F]{2}), (0x[0-9A-F]{2})"#
    for (side, token) in [("Light", "light"), ("Dark", "dark")] {
      let fromTests = try triple(#"layer0"# + side + #": \(UInt8, UInt8, UInt8\) = \("# + hex + #"\)"#, in: evidence)
      // The enum's own block: from its opening to the next enum.
      let after = tokens.components(separatedBy: "public enum " + side + " {").dropFirst().first ?? ""
      let block = after.components(separatedBy: "public enum ").first ?? ""
      let fromTokens = try triple(#"static let layer0 = RGB\("# + hex + #"\)"#, in: block)
      #expect(fromTests.count == 3 && fromTests == fromTokens, "\(token): \(fromTests) vs \(fromTokens)")
    }
  }

  // MARK: S4d

  /// The files under `rel` whose text contains `needle`, by repo path.
  static func naming(_ needle: String, under rel: String) throws -> [String] {
    try sources(rel).filter { $0.1.contains(needle) }.map(\.0).sorted()
  }

  @Test("H-S4-2: the client's send and approve are called from Models/Outbound.swift only, once each, behind its gesture switch")
  func sendOnlyFromOutbound() throws {
    let outbound = Self.appDir + "/Models/Outbound.swift"
    let send = ".send" + "(to:"
    let approve = "approve" + "Draft("
    #expect(try Self.naming(send, under: Self.appDir) == [outbound])
    #expect(try Self.naming(approve, under: Self.appDir) == [outbound])
    let text = try Repo.text(outbound)
    #expect(text.components(separatedBy: send).count - 1 == 1)
    #expect(text.components(separatedBy: approve).count - 1 == 1)
    // No gesture is a bare key: the cases are exactly these three.
    let gesture = (text.components(separatedBy: "public enum Gesture").dropFirst().first ?? "")
      .components(separatedBy: "\n  }").first ?? ""
    let cases = gesture.components(separatedBy: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
      .filter { $0.hasPrefix("case ") }
    #expect(cases == ["case commandReturn", "case sendButton", "case approveButton"], "gesture cases: \(cases)")
    // The undo entry is written before the task that can reach the client.
    let perform = Self.function("perform(", in: text)
    let entry = perform.range(of: "entries.append(")
    let task = perform.range(of: "Task {")
    #expect(entry != nil && task != nil && entry!.lowerBound < task!.lowerBound, "the undo entry is not written first")
    #expect(perform.contains("guard killSwitch() == false else { return .killSwitch }"))
    // The kill switch is read again at the minute the request would go.
    let run = Self.function("run(", in: text)
    #expect(run.contains("guard killSwitch() == false else {"))
  }

  @Test("H-S4-2b: nothing under Sources/WeMessageApp submits on Return: no onSubmit, no default action, no Return binding without cmd")
  func noReturnSubmit() throws {
    let banned = [".on" + "Submit", ".default" + "Action", "keyboardShortcut(." + "return)"]
    var swept = 0
    for (path, text) in try Self.sources(Self.appDir) {
      swept += 1
      for token in banned {
        #expect(!text.contains(token), "\(path) contains \(token)")
      }
    }
    #expect(swept >= 15)
    // The composer's one Return binding carries cmd, and Send calls the funnel.
    let composer = try Repo.text(Self.appDir + "/Boards/Thread/ComposerView.swift")
    #expect(composer.contains(".keyboardShortcut(.return, modifiers: .command)"))
    #expect(composer.contains("perform(") && composer.contains("gesture: .commandReturn"))
    #expect(!composer.contains("model.client"), "the composer reaches the client directly")
    // The field's own Return handler: only in the composer, and only with cmd.
    let keyPress = ".onKeyPress(" + ".return"
    for (path, text) in try Self.sources(Self.appDir) where text.contains(keyPress) {
      #expect(path.hasSuffix("/Boards/Thread/ComposerView.swift"), "\(path) handles Return")
    }
    let handlers = composer.components(separatedBy: keyPress).dropFirst()
    for handler in handlers {
      let head = String(handler.prefix(160))
      #expect(
        head.contains("guard press.modifiers.contains(.command) else { return .ignored }"),
        "a Return handler in the composer does not require cmd: \(head)")
    }
    // Raw key codes live in TriageKeys only, and its bare Return confirms the
    // bulk card and nothing else (09.D); its verbs reach the model, never the client.
    for (path, text) in try Self.sources(Self.appDir) where text.contains("keyCode") {
      #expect(path.hasSuffix("/Boards/Queue/TriageKeys.swift"), "\(path) reads raw key codes")
    }
    let triage = try Repo.text(Self.appDir + "/Boards/Queue/TriageKeys.swift")
    let returnCase = triage.components(separatedBy: "case Self.returnKey, Self.enterKey:").dropFirst().first ?? ""
    #expect(String(returnCase.prefix(200)).contains("guard model.bulkSheetShown else { return }"), "bare Return is not confined to the bulk card")
    #expect(!triage.contains("model.client") && !triage.contains("perform("), "a triage key reaches the client")
  }

  @Test("H-S4d: board 02 never places Hold until while D-UI-17 is absent-with-reason, and the cmd-Z undo lives under the composer")
  func holdUntilAbsent() throws {
    let files = try Self.sources(Self.appDir + "/Boards/Thread")
    #expect(files.count >= 4)
    let placed = try files.filter { try Self.count(#"accessibilityIdentifier\(ShellID\.composerHold\)"#, in: $0.1) > 0 }
    #expect(placed.isEmpty, "Hold until is placed in \(placed.map(\.0))")
    let composer = try Repo.text(Self.appDir + "/Boards/Thread/ComposerView.swift")
    #expect(composer.contains(#".keyboardShortcut("z", modifiers: .command)"#))
  }

  // MARK: S4e

  @Test("H-S4-4: no menu item and no key reach the specimen sheet; it opens only under the UI-test flag with board 08")
  func specimenSheetUnreachable() throws {
    let name = "Specimen" + "Sheet"
    let atlas = Self.appDir + "/Boards/Atlas/"
    let app = Self.appDir + "/ShellApp.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    var namedIn: [String] = []
    for (path, text) in try Self.sources(Self.appDir) where try Self.count(#"\b"# + name + #"\b"#, in: text) > 0 {
      namedIn.append(path)
    }
    #expect(namedIn.contains(app), "the window group never opens the sheet")
    for path in namedIn {
      #expect(path.hasPrefix(atlas) || path == app, "\(path) names the sheet")
    }
    // The sheet's own files hold no menu, command or key.
    let menus = ["Command" + "Menu", ".com" + "mands", "Menu" + "Builder", ".keyboard" + "Shortcut", "Command" + "Group"]
    let files = try Self.sources(Self.appDir + "/Boards/Atlas")
    #expect(files.count >= 2)
    for (path, text) in files {
      for token in menus {
        #expect(!text.contains(token), "\(path) contains \(token)")
      }
    }
    // The app builds no menu that could name it, and the window group
    // opens it only when the hooks built its content.
    let appText = try Repo.text(app)
    #expect(!appText.contains(".com" + "mands"), "the app declares commands")
    #expect(appText.contains("if let specimens = TestHooks.specimens {"))
    for (path, text) in try Self.sources(Self.appDir) where text.contains("Menu" + "Builder") {
      #expect(!text.contains(name) && !text.contains("TestHooks.specimens"), "\(path) reaches the sheet")
    }
    // The content is built only under the flag, for board 08 only.
    let hooksText = try Repo.text(hooks)
    #expect(
      hooksText.contains(#"specimens = isUITest && environment["WEMESSAGE_UI_BOARD"] == "08""#),
      "the specimen content is not gated on the flag and board 08")
    #expect(try Self.naming("TestHooks.specimens", under: Self.appDir) == [app])
  }

  @Test("H-S4-4b: no app source draws a typing indicator or a react affordance, which the UI tests require absent")
  func noTypingNoReact() throws {
    let typing = "wemessage." + "typing"
    let react = "wemessage.bubble." + "react."
    var swept = 0
    for (path, text) in try Self.sources(Self.appDir) {
      swept += 1
      #expect(!text.contains(typing), "\(path) names the typing indicator")
      #expect(!text.contains(react), "\(path) names a react affordance")
    }
    #expect(swept >= 20)
    // The UI tests do name both, so their absence is asserted, not assumed.
    let ui = try Self.sources(Self.uiTestsDir).map(\.1).joined(separator: "\n")
    #expect(ui.contains(typing) && ui.contains(react))
  }

  @Test("H-S4-4c: AtlasPalette's triples equal Tokens' ink, layer1 and layer2, so the pixel probes compare against what the app paints")
  func atlasPaletteMatchesTokens() throws {
    let palette = try Repo.text(Self.uiTestsDir + "/Support/AtlasPalette.swift")
    let tokens = try Repo.text(Self.appDir + "/Tokens.swift")
    func triple(_ pattern: String, in text: String) throws -> [String] {
      let regex = try NSRegularExpression(pattern: pattern)
      let matches = regex.matches(in: text, range: NSRange(text.startIndex..., in: text))
      guard matches.count == 1, let m = matches.first else { return ["matches: \(matches.count)"] }
      return (1...3).compactMap { Range(m.range(at: $0), in: text).map { String(text[$0]) } }
    }
    let hex = #"(0x[0-9A-F]{2}), (0x[0-9A-F]{2}), (0x[0-9A-F]{2})"#
    for side in ["Light", "Dark"] {
      let after = tokens.components(separatedBy: "public enum " + side + " {").dropFirst().first ?? ""
      let block = after.components(separatedBy: "public enum ").first ?? ""
      for name in ["ink", "layer1", "layer2"] {
        let fromTests = try triple(#"\b"# + name + side + #": RGB = \("# + hex + #"\)"#, in: palette)
        let fromTokens = try triple(#"static let "# + name + #" = RGB\("# + hex + #"\)"#, in: block)
        #expect(fromTests.count == 3 && fromTests == fromTokens, "\(name) \(side): \(fromTests) vs \(fromTokens)")
      }
    }
  }
}
