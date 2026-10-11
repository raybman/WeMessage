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
    // v2 S4h, board 10 (prefixes: freshness.row.<scope>, states.tab.<page>,
    // states.page.<page>, empty.<case>, empty.<case>.action).
    "wemessage.trust.banner", "wemessage.trust.action", "wemessage.freshness", "wemessage.freshness.footer",
    "wemessage.revoked.banner", "wemessage.revoked.fix", "wemessage.fda", "wemessage.fda.open", "wemessage.fda.skip",
    "wemessage.states", "wemessage.pacing", "wemessage.collision",
    // v2 S4h2, board 12 (prefixes: onboarding.page.<slug>,
    // onboarding.card.<channel>, onboarding.connect.<channel>,
    // onboarding.skip.<channel>, onboarding.agent.channel.<channel>).
    "wemessage.onboarding", "wemessage.onboarding.step", "wemessage.onboarding.next", "wemessage.onboarding.again",
    "wemessage.onboarding.sizing", "wemessage.onboarding.progress", "wemessage.onboarding.notbuilt",
    "wemessage.onboarding.agent.off", "wemessage.onboarding.agent.draft", "wemessage.onboarding.kill",
    "wemessage.onboarding.done", "wemessage.coach", "wemessage.voice.dock",
    // v2 S4i, board 11 (prefixes: search.token.<n>, search.group.<channel>,
    // search.result.<guid>, search.facet.<n>, scrubber.year.<year>,
    // switcher.row.<id>).
    "wemessage.search", "wemessage.search.field", "wemessage.search.summary", "wemessage.search.coverage",
    "wemessage.search.prompt", "wemessage.search.facets", "wemessage.search.more", "wemessage.find", "wemessage.find.field",
    "wemessage.find.counter", "wemessage.scrubber", "wemessage.scrubber.line", "wemessage.switcher",
    "wemessage.switcher.field",
    // v2 S4j, board 13 (prefixes: settings.pane.<p>, settings.page.<p>,
    // settings.appearance.<id>, settings.keyboard.row.<id>,
    // settings.parked.<id>).
    "wemessage.settings", "wemessage.settings.appearance.theme",
    "wemessage.settings.appearance.reducetransparency", "wemessage.settings.parked.autosend",
    "wemessage.settings.parked.schedules", "wemessage.settings.storage", "wemessage.settings.storage.delete",
    "wemessage.settings.confirm.sheet", "wemessage.settings.confirm.cancel", "wemessage.settings.confirm.go",
    "wemessage.settings.kill.state", "wemessage.settings.kill.release",
    // v2 S4j, board 14 (prefixes: compose.tab.<p>, compose.page.<p>,
    // compose.result.<id>, compose.channel.<c>, compose.slot.<id>,
    // compose.state.<s>).
    "wemessage.compose", "wemessage.compose.to", "wemessage.compose.recipient", "wemessage.compose.banner",
    "wemessage.compose.strip", "wemessage.compose.proposal", "wemessage.compose.proposal.ask",
    "wemessage.compose.proposal.take", "wemessage.compose.proposal.hold", "wemessage.compose.field",
    "wemessage.compose.send", "wemessage.compose.undo", "wemessage.compose.bubble",
    // v2 F5: the lookup's refusal, the typed-handle row and the hint.
    "wemessage.compose.refusal", "wemessage.compose.result.typed", "wemessage.compose.hint",
    // v2 S4k, board 15 (prefixes: media.tab.<p>, media.page.<p>, media.row.<id>,
    // media.message.<id>, media.item.<id>, media.tray.item.<id>,
    // media.tray.remove.<id>, media.compression.row.<w>, media.wall.<c>,
    // media.refusal.part.<n>, media.matrix.<n>).
    "wemessage.media", "wemessage.media.rail", "wemessage.media.header", "wemessage.media.drop",
    "wemessage.media.drop.card", "wemessage.media.drop.reason", "wemessage.media.thread", "wemessage.media.tray",
    "wemessage.media.conversion", "wemessage.media.location", "wemessage.media.counter", "wemessage.media.grid",
    "wemessage.media.compression", "wemessage.media.field", "wemessage.media.send", "wemessage.media.record",
    "wemessage.media.note", "wemessage.media.viewer", "wemessage.media.viewer.position",
    "wemessage.media.viewer.meta", "wemessage.media.viewer.line", "wemessage.media.viewer.origin",
    "wemessage.media.viewer.close", "wemessage.media.viewer.previous", "wemessage.media.viewer.next",
    "wemessage.media.viewer.kinds", "wemessage.media.viewer.save", "wemessage.media.viewer.reveal",
    "wemessage.media.viewer.copy", "wemessage.media.refusal", "wemessage.media.refusal.take",
    // v2 S4l, board 16.
    "wemessage.oslayer", "wemessage.oslayer.dock", "wemessage.oslayer.menu", "wemessage.popover",
    "wemessage.popover.title", "wemessage.popover.stamp", "wemessage.popover.line", "wemessage.popover.more",
    "wemessage.popover.notes", "wemessage.popover.open", "wemessage.popover.kill", "wemessage.popover.settings",
    "wemessage.killconfirm", "wemessage.killconfirm.engage", "wemessage.killconfirm.cancel",
    // v2 S4m, board 17.
    "wemessage.progress", "wemessage.meter.all", "wemessage.streak", "wemessage.streak.current",
    "wemessage.streak.longest", "wemessage.streak.ribbon", "wemessage.card", "wemessage.card.copy",
    "wemessage.card.save", "wemessage.card.share", "wemessage.card.status", "wemessage.zero.kind",
    "wemessage.zero.progress", "wemessage.zero.streak",
    // v2 B0, board 03.
    "wemessage.board.whatsapp", "wemessage.board.whatsapp.banner", "wemessage.board.whatsapp.empty",
    "wemessage.board.chip",
    // v2 B1, board 03 over fixtures.
    "wemessage.board.whatsapp.linked", "wemessage.board.whatsapp.admins", "wemessage.board.whatsapp.relink",
    "wemessage.board.whatsapp.qr", "wemessage.board.whatsapp.encrypted", "wemessage.board.whatsapp.horizon",
    "wemessage.board.whatsapp.phone", "wemessage.board.whatsapp.fetchnote",
    // v2 B4, board 07.
    "wemessage.voicedock", "wemessage.voicedock.chip", "wemessage.voicedock.caption", "wemessage.voicedock.mic",
    "wemessage.voicedock.card", "wemessage.voicedock.card.send", "wemessage.voicedock.card.cancel",
    "wemessage.voicedock.failure",
    // v2 B3, board 04.
    "wemessage.board.linkedin", "wemessage.board.linkedin.banner", "wemessage.board.linkedin.empty",
    "wemessage.linkedin.switch", "wemessage.linkedin.inbox.", "wemessage.linkedin.tabs", "wemessage.linkedin.tab.",
    "wemessage.linkedin.paused", "wemessage.linkedin.thread", "wemessage.linkedin.inmail.",
    "wemessage.linkedin.commercial.", "wemessage.linkedin.request", "wemessage.linkedin.nocomposer",
    "wemessage.linkedin.compose", "wemessage.linkedin.compose.subject", "wemessage.linkedin.compose.body",
    "wemessage.linkedin.compose.hold", "wemessage.linkedin.compose.pacing", "wemessage.linkedin.compose.draft",
    "wemessage.linkedin.compose.state", "wemessage.linkedin.inspector", "wemessage.linkedin.ladder",
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

  /// v2 S4l: the one file that may reach the notification center.
  static let notesFile = appDir + "/Boards/OSLayer/Notifications.swift"
  static let notesModule = "User" + "Notifications"

  @Test("H-A1: every file under Sources/WeMessageApp imports only Foundation, SwiftUI, AppKit, Observation and WeMessageKit; Contacts only in ContactsAvatarProvider.swift; UserNotifications only in Notifications.swift")
  func importRule() throws {
    let files = try Self.sources(Self.appDir)
    #expect(files.count >= 6)
    var contacts: [String] = []
    var notes: [String] = []
    for (path, text) in files {
      let modules = Set(try Self.imports(text))
      var allowed = Self.allowedImports
      if path == Self.contactsFile { allowed.insert(Self.contactsModule) }
      if path == Self.notesFile { allowed.insert(Self.notesModule) }
      #expect(modules.isSubset(of: allowed), "\(path) imports \(modules.subtracting(allowed).sorted())")
      if modules.contains(Self.contactsModule) { contacts.append(path) }
      if modules.contains(Self.notesModule) { notes.append(path) }
    }
    #expect(contacts == [Self.contactsFile], "Contacts imported by \(contacts)")
    #expect(notes == [Self.notesFile], "UserNotifications imported by \(notes)")
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
  /// leaves a choice open or the daemon cannot serve what it draws), and
  /// S4h2's 69..78 (the same for board 12), and on to S4l's 112..120
  /// (the OS layer, board 16) and S4m's 121..131 (board 17, progress), and
  /// B0's 132, 135 and 140 (plan rows 102, 105 and 110 plus 30: the
  /// fixture chip, the WhatsApp board's words, the fixture rail mark), and
  /// v2 F1's 185 (the paging caption, Eric's choice (b)), and v2 F5's
  /// 186..189 (the compose lookup's words, plan rows D-F5-2..5), and v2
  /// F3's 190..194 (the reason line, the failure and conflict lines, the
  /// silent save). v2 F3 retires D-UI-51: queue state is no longer
  /// memory-only, the daemon keeps it. v2 F4's 195..202: the rich turns'
  /// glyphs, delivery words and file lines. v2 F2's 203..212: search on
  /// the daemon's index (coverage, indexing, debounce, chips, notes, the
  /// scrubber's rows, paging and the daemon-down line). v2 F2 retires
  /// D-UI-79: search runs on the daemon's index, with no client-side caps.
  /// v2 F7's 213..218: the status fields (the age rule, the local copy, 2c
  /// and CopyProgress from the mirror, the banner's handle, the re-read).
  /// v2 F7 retires D-UI-20 (the banner names the handle status serves) and
  /// D-UI-72 (the daemon serves the copy's counts).
  static let dUINumbers =
    Array(1...19) + Array(21...50) + Array(52...71) + Array(73...78) + Array(80...131) + [132, 135, 140, 185]
    + Array(186...194) + Array(195...202) + Array(203...212) + Array(213...218)
  static let dUIKeys = dUINumbers.map { "D-UI-\($0)" }

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

  @Test("D-UI: every provisional design value lives in ProvisionalUI.swift, marked pending Eric's D-UI-1..131, 132, 135 and 140, one section and at least one constant per question, and is never repeated as a literal")
  func provisionalValues() throws {
    let file = Self.appDir + "/ProvisionalUI.swift"
    let provisional = try Repo.text(file)
    #expect(provisional.contains("PROVISIONAL pending Eric's D-UI-1..131, 132, 135 and 140 decisions"))
    for key in Self.dUIKeys {
      // D-UI-1 must not be satisfied by D-UI-10..19.
      #expect(try Self.count(key + #"(?!\d)"#, in: provisional) >= 1, "ProvisionalUI.swift does not mark \(key)")
    }
    // One section per question, in order, each holding a constant the app
    // can read.
    let sections = try Self.dUISections(provisional)
    #expect(sections.keys.sorted() == Self.dUINumbers, "sections found: \(sections.keys.sorted())")
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
    // v2 F7e (D-UI-217): the operator's own number comes from the daemon's
    // status, never from the Contacts "me" card, in any file at all.
    let meCard = "unified" + "Me" + "Contact"
    var leaks: [String] = []
    for (path, text) in files {
      if text.contains(meCard) { leaks.append("\(path): reads the me card") }
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

  @Test("H-S4-5: the contacts store is named only in ContactsAvatarProvider.swift, built once behind a UI-test-flag refusal, and the hooks build it only after the flag returns the fixtures; no file reads the me card (v2 F7e)")
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
    // v2 F7e: the banner, or even the provider's own file, reading the me card.
    let meCard = "unified" + "Me" + "Contact"
    let banner = good + [("app/Boards/Thread/ThreadView.swift", "let me = try? s.\(meCard)(withKeysToFetch: [])")]
    #expect(Self.contactsLeaks(banner, home: home, hooks: hooks) == ["app/Boards/Thread/ThreadView.swift: reads the me card"])
    let ownFile = [(home, good[0].1 + "\nlet m = s.\(meCard)"), good[1]]
    #expect(Self.contactsLeaks(ownFile, home: home, hooks: hooks) == ["\(home): reads the me card"])
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
    // A field's own Return handler: only in the composer and board 11's
    // search and switcher fields (D-UI-81), and every one requires cmd.
    let keyPress = ".onKeyPress(" + ".return"
    let returnFiles = ["/Boards/Thread/ComposerView.swift", "/Boards/Search/SearchViews.swift"]
    var handlerCount = 0
    for (path, text) in try Self.sources(Self.appDir) where text.contains(keyPress) {
      #expect(returnFiles.contains { path.hasSuffix($0) }, "\(path) handles Return")
      for handler in text.components(separatedBy: keyPress).dropFirst() {
        handlerCount += 1
        let head = String(handler.prefix(160))
        #expect(
          head.contains("guard press.modifiers.contains(.command) else { return .ignored }"),
          "a Return handler in \(path) does not require cmd: \(head)")
      }
    }
    #expect(handlerCount >= 3, "the composer, search and switcher Return handlers were not all swept")
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

  // MARK: S4h

  @Test("H-S4-6: the states sheet opens only under the UI-test flag with board 10.B; the FDA screen opens nothing and the hooks build the fixture seam first; board 10 paints no system colour")
  func statesSheetAndFDASeam() throws {
    let name = "States" + "Sheet"
    let states = Self.appDir + "/Boards/States/"
    let app = Self.appDir + "/ShellApp.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    let fixtures = Self.appDir + "/Fixtures/"
    var namedIn: [String] = []
    for (path, text) in try Self.sources(Self.appDir) where try Self.count(#"\b"# + name + #"\b"#, in: text) > 0 {
      namedIn.append(path)
    }
    #expect(namedIn.contains(app), "the window group never opens the sheet")
    for path in namedIn {
      #expect(path.hasPrefix(states) || path == app, "\(path) names the sheet")
    }
    let appText = try Repo.text(app)
    #expect(appText.contains("} else if let states = TestHooks.statesSheet {"))
    let hooksText = try Repo.text(hooks)
    #expect(
      hooksText.contains(#"statesSheet = isUITest && environment["WEMESSAGE_UI_BOARD"] == "10.B""#),
      "the states content is not gated on the flag and board 10.B")
    #expect(try Self.naming("TestHooks.statesSheet", under: Self.appDir) == [app])
    // The seam: the fixture under the flag, checked before anything else,
    // and the shipped seam refuses to run under it.
    #expect(hooksText.contains("if isUITest { return Fixture" + "FullDiskAccess() }"))
    let model = try Repo.text(Self.appDir + "/Models/StatesModel.swift")
    #expect(model.contains("precondition(!TestHooks.isUITest"))
    #expect(try Self.naming("Fixture" + "FullDiskAccess()", under: Self.appDir) == [hooks])
    // Nothing on board 10 opens a URL, a pane or an app; no menu or key.
    let opens = ["x-apple." + "systempreferences", "NSWork" + "space", "openURL", "open" + "Application", "URL(string"]
    let menus = ["Command" + "Menu", ".com" + "mands", "Menu" + "Builder", ".keyboard" + "Shortcut", "Command" + "Group"]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    var files = try Self.sources(Self.appDir + "/Boards/States")
    #expect(files.count >= 2)
    files.append((Self.appDir + "/Models/StatesModel.swift", model))
    files += try Self.sources(Self.appDir + "/Fixtures").filter { $0.0.hasPrefix(fixtures + "Fixture" + "FullDiskAccess") || $0.0.hasPrefix(fixtures + "FixtureStates") }
    #expect(files.count >= 5)
    for (path, text) in files {
      for token in opens + menus + colours {
        #expect(!text.contains(token), "\(path) contains \(token)")
      }
    }
  }

  // MARK: S4h2

  /// The H-S4-7 verdicts over (path, text) pairs of the app sources: every
  /// way onboarding could reach the daemon, open a pane under the flag,
  /// write the runner's defaults, or paint a system colour.
  static func onboardingLeaks(_ files: [(String, String)]) -> [String] {
    let onboardingDir = appDir + "/Boards/Onboarding/"
    let pane = onboardingDir + "SystemSettingsPane.swift"
    let model = appDir + "/Models/OnboardingModel.swift"
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let reach = ["Gateway" + "Client", ".client", ".send" + "(", "setKill" + "Switch", "engageKill" + "Switch", "approve" + "Draft(", "/v1/"]
    let opens = ["x-apple." + "systempreferences", "NSWork" + "space", "openURL", "open" + "Application", "URL(string"]
    let menus = ["Command" + "Menu", ".com" + "mands", "Menu" + "Builder", ".keyboard" + "Shortcut", "Command" + "Group"]
    let colours = [
      "." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent", "Tokens." + "danger",
    ]
    var leaks: [String] = []
    for (path, text) in files {
      let onboarding = path.hasPrefix(onboardingDir) || path == model
      // The pane is named in one file, and only that file opens anything.
      if path != pane && text.contains(opens[0]) { leaks.append("\(path): names the pane") }
      if onboarding && path != pane {
        for token in opens where text.contains(token) { leaks.append("\(path): \(token)") }
      }
      if onboarding {
        for token in reach + menus + colours where text.contains(token) { leaks.append("\(path): \(token)") }
        // A client's call, not the word in copy ("a normal mail client.").
        if (try? count(#"\bclient\.[a-z]"#, in: text)) != 0 { leaks.append("\(path): calls a client") }
      }
      // The shipped store is built in the hooks only; the model reaches
      // the window group only.
      if path != hooks && path != model && text.contains("DefaultsOnboarding" + "Store()") {
        leaks.append("\(path): builds the defaults store")
      }
      if path != app && text.contains("TestHooks." + "onboarding") { leaks.append("\(path): opens onboarding") }
    }
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    let paneText = text(pane)
    let open = paneText.components(separatedBy: "func openFullDiskAccess()").dropFirst().first ?? ""
    let first = open.split(separator: "{", maxSplits: 1).dropFirst().first?
      .split(separator: "\n").map { $0.trimmingCharacters(in: .whitespaces) }
      .first { !$0.isEmpty && !$0.hasPrefix("//") } ?? ""
    if !first.hasPrefix("precondition(!TestHooks.isUITest") { leaks.append("\(pane): opens before refusing the flag") }
    let modelText = text(model)
    if !modelText.contains("public var drafting = false") { leaks.append("\(model): drafting is not off by default") }
    let store = modelText.components(separatedBy: "class DefaultsOnboardingStore").dropFirst().first ?? ""
    if !String(store.prefix(260)).contains("precondition(!TestHooks.isUITest") {
      leaks.append("\(model): the defaults store runs under the flag")
    }
    let hooksText = text(hooks)
    let flagFirst =
      "if isUITest { return board == \"12\" ? OnboardingModel(store: MemoryOnboardingStore(), seam: fullDiskAccess()) : nil }"
    let built = hooksText.components(separatedBy: "func onboardingModel(").dropFirst().first ?? ""
    let firstLine = built.split(separator: "\n").dropFirst().first.map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
    if firstLine != flagFirst { leaks.append("\(hooks): the flag does not return first: \(firstLine)") }
    if !text(app).contains("} else if let onboarding = TestHooks.onboarding {") { leaks.append("\(app): never opens onboarding") }
    return leaks
  }

  @Test("H-S4-7: onboarding never reaches the daemon, opens the Full Disk Access pane only outside the UI-test flag, keeps the runner's defaults untouched, and paints no system colour")
  func onboardingSealed() throws {
    let files = try Self.sources(Self.appDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Onboarding").count >= 2)
    let leaks = Self.onboardingLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let views = Self.appDir + "/Boards/Onboarding/OnboardingViews.swift"
    let model = Self.appDir + "/Models/OnboardingModel.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    let plants: [(String, String)] = [
      (views, "Circle().fill(." + "green)"),
      (views, "await client." + "setKill" + "Switch(true)"),
      (views, "NSWork" + "space.shared.open(url)"),
      (model, "public var drafting = true"),
      (hooks, "func onboardingModel(board: String?) -> OnboardingModel? {\n    let store = DefaultsOnboarding" + "Store()"),
    ]
    for (path, planted) in plants {
      let mutated = files.map { $0.0 == path ? ($0.0, $0.1 + "\n" + planted) : $0 }
      var swapped = mutated
      if planted.hasPrefix("public var drafting") || planted.hasPrefix("func onboardingModel") {
        swapped = files.map {
          guard $0.0 == path else { return $0 }
          if planted.hasPrefix("public var drafting") {
            return ($0.0, $0.1.replacingOccurrences(of: "public var drafting = false", with: planted))
          }
          return ($0.0, $0.1.replacingOccurrences(of: "func onboardingModel(board: String?) -> OnboardingModel? {", with: planted))
        }
      }
      #expect(!Self.onboardingLeaks(swapped).isEmpty, "a planted \(planted) in \(path) went unseen")
    }
  }

  // MARK: S4i

  /// The H-S4-8 verdicts over (path, text) pairs of the app sources: board
  /// 11 reads through the daemon's GETs only, never a file or a database,
  /// paints its highlight and its outlines in ink, keeps its keys in every
  /// build, and takes the panes (and the composer) while it is up.
  static func searchLeaks(_ files: [(String, String)]) -> [String] {
    let searchDir = appDir + "/Boards/Search/"
    let models = [
      appDir + "/Models/SearchModel.swift", appDir + "/Models/SearchQuery.swift", appDir + "/Models/SearchWire.swift",
    ]
    let shell = appDir + "/ShellView.swift"
    let transcript = appDir + "/Boards/Thread/TranscriptView.swift"
    let composer = appDir + "/Boards/Thread/ComposerView.swift"
    let reads = ["Library/" + "Messages", "chat" + ".db", "sqlite", "File" + "Manager", "CNContact", "Data(contentsOf"]
    let writes = [".send" + "(", "approve" + "Draft(", "setKill" + "Switch", "engageKill" + "Switch", "/v1/", "httpMethod", "\"POST\""]
    let colours = [
      "." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent", "Tokens." + "tint",
      "Tokens." + "danger", ".tint" + "(", "background" + "Color", "underline" + "Color",
    ]
    var leaks: [String] = []
    var swept = 0
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    for (path, source) in files where path.hasPrefix(searchDir) || models.contains(path) {
      swept += 1
      // Code only: the doc comments name the route they read (v2 F2).
      let body = source.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
      for token in reads + writes + colours where body.contains(token) { leaks.append("\(path): \(token)") }
      // The only client call is the daemon's search GET (v2 F2): no
      // client-side corpus, so no listThreads and no readThread here.
      let regex = try? NSRegularExpression(pattern: #"\bclient\.([A-Za-z]+)"#)
      for m in regex?.matches(in: body, range: NSRange(body.startIndex..., in: body)) ?? [] {
        guard let r = Range(m.range(at: 1), in: body) else { continue }
        let call = String(body[r])
        if call != "search" { leaks.append("\(path): client.\(call)") }
      }
    }
    if swept < 5 { leaks.append("swept \(swept) board 11 files") }
    // A match is told by weight and an underline, never by a hue: the
    // highlight sets no colour of any kind (S4i tooth 3).
    let views = searchDir + "SearchViews.swift"
    let styled = function("styled(", in: text(views)).components(separatedBy: "\n  }\n").first ?? ""
    if !styled.contains("run.underlineStyle = .single") { leaks.append("\(views): the highlight lost its underline") }
    if styled.contains("Color") || styled.contains("Tokens.") { leaks.append("\(views): the highlight sets a colour") }
    // The outlines a jump and find draw over bubbles are ink too.
    let outline = text(transcript).components(separatedBy: "struct Board11" + "Outline").dropFirst().first?
      .components(separatedBy: "\n}\n").first ?? ""
    if !outline.contains("Tokens.color(palette.ink)") { leaks.append("\(transcript): the outline is not ink") }
    for token in colours where outline.contains(token) { leaks.append("\(transcript): outline \(token)") }
    // The keys are placed in every build, outside the UI-test block.
    let shellText = text(shell)
    let keys = shellText.components(separatedBy: "Board11Keys(model: model)")
    if keys.count != 2 { leaks.append("\(shell): Board11Keys placed \(keys.count - 1) times") }
    let lead = keys.first.map { String($0.suffix(160)) } ?? ""
    if lead.contains("if ") { leaks.append("\(shell): Board11Keys sits under a condition") }
    // Search and the switcher take the list and thread panes, so the
    // composer (and its Send) is not in the window while they are up.
    let order = ["if model.switcher.shown {", "} else if model.search.shown {", "SidebarView(", "ContentPane("]
    let at = order.map { shellText.range(of: $0)?.lowerBound }
    if at.contains(where: { $0 == nil }) || zip(at, at.dropFirst()).contains(where: { $0! >= $1! }) {
      leaks.append("\(shell): the panes are not replaced while board 11 is up")
    }
    // A chip's op already ends in its colon; the view adds none.
    if !text(views).contains("Text(op)") || text(views).contains("op + \":\"") {
      leaks.append("\(views): the chip doubles the operator's colon")
    }
    // The find counter is ink at 11 pt: in 10 pt inkDim the audit could
    // not measure it (run 37756434645), and the UI test audits the
    // results only.
    let find = searchDir + "FindViews.swift"
    let counter = text(find).components(separatedBy: "Text(find.counter)").dropFirst().first?
      .components(separatedBy: ".accessibilityLabel(").first ?? ""
    if !counter.contains(".foregroundStyle(Tokens.color(palette.ink))") || !counter.contains("size: 11") {
      leaks.append("\(find): the find counter is not 11 pt ink")
    }
    // The find field holds the keyboard while it is up; the composer
    // takes it back after.
    if !text(composer).contains("guard !model.find.shown else { return nil }") {
      leaks.append("\(composer): the composer claims the keyboard over the find bar")
    }
    return leaks
  }

  @Test("H-S4-8: board 11 reads only through the daemon's GETs, never a file, paints its highlight and outlines in ink, keeps its keys in every build and takes the panes while it is up")
  func searchSealed() throws {
    let files = try Self.sources(Self.appDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Search").count >= 3)
    let leaks = Self.searchLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let views = Self.appDir + "/Boards/Search/SearchViews.swift"
    let model = Self.appDir + "/Models/SearchModel.swift"
    let shell = Self.appDir + "/ShellView.swift"
    let transcript = Self.appDir + "/Boards/Thread/TranscriptView.swift"
    let find = Self.appDir + "/Boards/Search/FindViews.swift"
    let swaps: [(String, String, String)] = [
      (views, "run.underlineStyle = .single", "run.underlineStyle = .single\n        run.foregroundColor = ." + "green"),
      (views, "run.underlineStyle = .single", "run.background" + "Color = .yellow"),
      (views, "run.underlineStyle = .single", "run.underlineStyle = .single\n        run.foreground" + "Color = Tokens.color(palette.ok)"),
      (model, "switch try await client.search(params) {", "_ = try? await client.send" + "(to: \"x\")\n    switch try await client.search(params) {"),
      (model, "switch try await client.search(params) {", "_ = try? await client.readThread(\"x\")\n    switch try await client.search(params) {"),
      (
        model, "public func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {",
        "public func search(_ query: SearchQuery, zone: TimeZone, cursor: String?) async throws -> SearchPage {\n    _ = File"
          + "Manager.default"
      ),
      (transcript, ".strokeBorder(Tokens.color(palette.ink), lineWidth: width)", ".strokeBorder(Tokens." + "tint, lineWidth: width)"),
      (shell, "      Board11Keys(model: model)", "      if TestHooks.isUITest { Board11Keys(model: model) }"),
      (shell, "} else if model.search.shown {", "} else if model.search.hidden {"),
      (views, "Text(op)", "Text(op + \":\")"),
      (find, "        .foregroundStyle(Tokens.color(palette.ink))\n        .lineLimit(1)", "        .foregroundStyle(Tokens.color(palette.inkDim))\n        .lineLimit(1)"),
      (find, "size: 11, weight: .semibold, design: .monospaced))\n        .foregroundStyle(Tokens.color(palette.ink))\n        .lineLimit(1)", "size: 10, design: .monospaced))\n        .foregroundStyle(Tokens.color(palette.ink))\n        .lineLimit(1)"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.searchLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  // MARK: S4j

  /// The H-S4-9 verdicts over (path, text) pairs of the app sources: board
  /// 13 reads settings and writes nothing but the kill switch's release,
  /// through the shell's own path and behind a confirm; parked features
  /// hold no control; nothing destructive can run; nothing is green; and
  /// the window opens only under the UI-test flag with board 13.
  static func settingsLeaks(_ files: [(String, String)]) -> [String] {
    let dir = appDir + "/Boards/Settings/"
    let model = appDir + "/Models/SettingsModel.swift"
    let panes = dir + "SettingsPanes.swift"
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let controls = ["Toggle" + "(", "Picker" + "(", "Slider" + "(", "Stepper" + "(", "TextField" + "("]
    let writes = [
      ".send" + "(", "approve" + "Draft(", "set" + "Settings(", "disconnect" + "(", "purge" + ":", "setKill" + "Switch",
      "." + "engageKill" + "Switch", "httpMethod", "\"POST\"", "/v1/", "create" + "Draft(",
    ]
    let colours = [
      "." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent", "Tokens." + "tint",
    ]
    var leaks: [String] = []
    var swept = 0
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    for (path, source) in files where path.hasPrefix(dir) || path == model {
      swept += 1
      let body = source.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
      for token in controls + writes + colours where body.contains(token) { leaks.append("\(path): \(token)") }
      if body.contains("armable: true") { leaks.append("\(path): a parked feature is armable") }
      // The only client call is the one settings read.
      let regex = try? NSRegularExpression(pattern: #"\bclient\.([A-Za-z]+)"#)
      for m in regex?.matches(in: body, range: NSRange(body.startIndex..., in: body)) ?? [] {
        guard let r = Range(m.range(at: 1), in: body) else { continue }
        if body[r] != "settings" { leaks.append("\(path): client.\(body[r])") }
      }
    }
    if swept < 3 { leaks.append("swept \(swept) board 13 files") }
    let modelText = text(model)
    if modelText.components(separatedBy: "armable: false").count - 1 != 2 {
      leaks.append("\(model): the two parked features are not both unarmable")
    }
    // The release is the shell's own disengage, once, behind the confirm;
    // delete's go does nothing and cannot be pressed.
    if modelText.components(separatedBy: "disengageKill" + "Switch()").count - 1 != 1
      || !modelText.contains("case .releaseKill: await shell.disengageKill" + "Switch()")
    {
      leaks.append("\(model): the release is not the shell's one disengage")
    }
    if !modelText.contains("case .deleteCopy: break") { leaks.append("\(model): delete's go does something") }
    if !modelText.contains("{ what == .releaseKill && shell.killSwitch == true }") {
      leaks.append("\(model): a confirm other than release can go")
    }
    if !text(panes).contains(".disabled(!can)") { leaks.append("\(panes): the go control is never disabled") }
    for (path, source) in files where !path.hasPrefix(dir) && path != model && source.contains("disengageKill" + "Switch()") {
      if path != appDir + "/ShellModel.swift" && path != appDir + "/ShellView.swift" && !path.hasPrefix(appDir + "/Boards/Queue") {
        leaks.append("\(path): another release path")
      }
    }
    // The door: the flag and board 13, read once by the hooks, opened by
    // the window group only.
    if !text(hooks).contains(#"settingsBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "13""#) {
      leaks.append("\(hooks): the settings board is not gated on the flag and board 13")
    }
    for (path, source) in files where source.contains("SettingsRoot" + "(") && path != app && !path.hasPrefix(dir) {
      leaks.append("\(path): opens the settings window")
    }
    if !text(app).contains("} else if TestHooks.settingsBoard {") { leaks.append("\(app): never opens the settings window") }
    return leaks
  }

  @Test("H-S4-9: board 13 reads settings and writes nothing but the kill release, through the shell and behind a confirm; parked rows hold no control; nothing destructive runs; nothing is green; it opens only with board 13 under the flag")
  func settingsSealed() throws {
    let files = try Self.sources(Self.appDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Settings").count >= 2)
    let leaks = Self.settingsLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let model = Self.appDir + "/Models/SettingsModel.swift"
    let panes = Self.appDir + "/Boards/Settings/SettingsPanes.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    let swaps: [(String, String, String)] = [
      (model, "armable: false),\n    ParkedFeature(", "armable: true),\n    ParkedFeature("),
      (
        panes, "SettingsLine(title: feature.title, detail: feature.copy, trailing: \"parked\", palette: palette)",
        "Toggle" + "(feature.title, isOn: .constant(false))"
      ),
      (model, "envelope = try? await client.settings()", "_ = try? await client.set" + "Settings([:])"),
      (model, "case .deleteCopy: break", "case .deleteCopy: _ = try? await client.disconnect" + "(purge" + ": true)"),
      (
        panes, ".foregroundStyle(Tokens.color(model.killState == \"on\" ? Tokens.danger : palette.ink))",
        ".foregroundStyle(model.killState == \"on\" ? Color.red : Color." + "green)"
      ),
      (model, "{ what == .releaseKill && shell.killSwitch == true }", "{ true }"),
      (panes, ".disabled(!can)", ".disabled(false)"),
      (hooks, "settingsBoard = isUITest && environment", "settingsBoard = environment"),
      (model, "case .releaseKill: await shell.disengageKill" + "Switch()", "case .releaseKill: break"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.settingsLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  /// The H-S4-10 verdicts over (path, text) pairs of the app sources: board
  /// 14's one client write is createDraft, after the undo window, and its
  /// one read is v2 F5's resolveHandle, from the model; nothing in
  /// it can send, approve or name a route; the proposal reaches the input
  /// only through takeProposal; no channel exists before a person; nothing
  /// is green; and the window opens only under the flag with board 14.
  static func composeLeaks(_ files: [(String, String)]) -> [String] {
    let dir = appDir + "/Boards/Compose/"
    let model = appDir + "/Models/ComposeModel.swift"
    let fixture = appDir + "/Fixtures/FixtureCompose.swift"
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let writes = [
      ".send" + "(to:", "approve" + "Draft(", "set" + "Settings(", "disconnect" + "(", "setKill" + "Switch",
      "disengageKill" + "Switch", "httpMethod", "\"POST\"", "/v1/", "URLSession", "Picker" + "(",
    ]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    var leaks: [String] = []
    var swept = 0
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    let code = { (source: String) in
      source.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
    }
    var creates = 0
    var lookups = 0
    for (path, source) in files where path.hasPrefix(dir) || path == model || path == fixture {
      swept += 1
      let body = code(source)
      for token in writes + colours where body.contains(token) { leaks.append("\(path): \(token)") }
      let regex = try? NSRegularExpression(pattern: #"\bclient\.([A-Za-z]+)"#)
      for m in regex?.matches(in: body, range: NSRange(body.startIndex..., in: body)) ?? [] {
        guard let r = Range(m.range(at: 1), in: body) else { continue }
        if body[r] == "createDraft" {
          creates += 1
        } else if body[r] == "resolveHandle" && path == model {
          lookups += 1
        } else {
          leaks.append("\(path): client.\(body[r])")
        }
      }
    }
    if swept < 4 { leaks.append("swept \(swept) board 14 files") }
    if creates != 1 { leaks.append("\(model): \(creates) createDraft calls, not one") }
    if lookups != 1 { leaks.append("\(model): \(lookups) resolveHandle calls, not one") }
    let modelText = code(text(model))
    // The create runs only from the undo window's task, after the window.
    let send = Self.function("send(", in: modelText)
    let undoFirst = send.range(of: "phase = .undo(secondsLeft: Self.undoSeconds)")
    let create = send.range(of: "await self.createDraft(")
    if undoFirst == nil || create == nil || undoFirst!.lowerBound > create!.lowerBound {
      leaks.append("\(model): send() does not open the undo window before the create")
    }
    // Opening the window is not enough: the create waits for every tick.
    let window = send.range(of: "for left in stride(from: Self.undoSeconds - 1")
    if window == nil || create == nil || window!.lowerBound > create!.lowerBound {
      leaks.append("\(model): send() creates the draft before the undo window has run")
    }
    if !Self.function("createDraft(chatGuid:", in: modelText).contains("guard !Task.isCancelled, case .undo = phase else { return }") {
      leaks.append("\(model): the create does not check the window was not undone")
    }
    // Only takeProposal writes the input from the proposal.
    for name in ["askForDraft(", "dropProposal(", "choose("] where Self.function(name, in: modelText).contains("body =") {
      leaks.append("\(model): \(name) writes the input")
    }
    if !Self.function("takeProposal(", in: modelText).contains("body = text") {
      leaks.append("\(model): Approve does not move the proposal down")
    }
    if !modelText.contains("guard let person else { return [] }") {
      leaks.append("\(model): channels exist before a person")
    }
    // The door.
    if !text(hooks).contains(#"composeBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "14""#) {
      leaks.append("\(hooks): the compose board is not gated on the flag and board 14")
    }
    for (path, source) in files where source.contains("ComposeRoot" + "(") && path != app && !path.hasPrefix(dir) {
      leaks.append("\(path): opens the compose window")
    }
    if !text(app).contains("} else if TestHooks.composeBoard {") { leaks.append("\(app): never opens the compose window") }
    return leaks
  }

  @Test("H-S4-10: board 14 creates a draft after the undo window and nothing else: no send, no approve, no route; the proposal never writes the input; no channel before a person; nothing is green; it opens only with board 14 under the flag")
  func composeSealed() throws {
    let files = try Self.sources(Self.appDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Compose").count >= 2)
    let leaks = Self.composeLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let model = Self.appDir + "/Models/ComposeModel.swift"
    let views = Self.appDir + "/Boards/Compose/ComposeViews.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    let swaps: [(String, String, String)] = [
      (model, "try await client.createDraft(", "try await client.send" + "(to: chatGuid, body: text) ?? client.createDraft("),
      (model, "try await client.createDraft(", "try await client.approve" + "Draft(id: \"x\") ?? client.createDraft("),
      (model, "phase = .drafting", "phase = .drafting\n    _ = try? await client.settings()"),
      // v2 F5: the one read is the model's, and only one.
      (model, "lookup = Task {", "_ = Task { _ = try? await self.client.resolveHandle(handle) }\n    lookup = Task {"),
      (views, ".foregroundStyle(Tokens.color(palette.inkDim))", ".foregroundStyle(Tokens.color(palette.inkDim))\n        .task { _ = try? await model.client.resolveHandle(\"x\") }"),
      (model, "proposal = .ready(propose(person))", "body = propose(person)"),
      (model, "guard let person else { return [] }", "let person = person ?? people[0]"),
      (model, "guard !Task.isCancelled, case .undo = phase else { return }", "guard !Task.isCancelled else { return }"),
      (model, "      for left in stride(", "      await self.createDraft(chatGuid: guid, body: text)\n      for left in stride("),
      (views, ".foregroundStyle(Tokens.color(palette.inkDim))", ".foregroundStyle(Color." + "green)"),
      (hooks, "composeBoard = isUITest && environment", "composeBoard = environment"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.composeLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  // MARK: S4k

  /// The H-S4-11 verdicts over (path, text) pairs of the app sources: board
  /// 15 holds no client and names no route; every door stages and none
  /// sends; the sink is called once, from sendTray, with a set built only
  /// from the tray; the record slot prints a reason and draws no control,
  /// greyed or otherwise; nothing offers to send anyway, opens a camera or
  /// synthesises a voice; nothing is green; and the window opens only under
  /// the flag with board 15.
  static func mediaLeaks(_ files: [(String, String)]) -> [String] {
    let dir = appDir + "/Boards/Attachments/"
    let model = appDir + "/Models/AttachmentsModel.swift"
    let fixture = appDir + "/Fixtures/FixtureAttachments.swift"
    let trayView = dir + "StagingTray.swift"
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let writes = [
      "client", "GatewayClient", "Outbound.", "Outbound(", ".send" + "(to:", "approve" + "Draft(", "httpMethod", "\"POST\"",
      "/v1/", "URLSession", "NSWork" + "space", "NSPaste" + "board", "downloads" + "Directory",
    ]
    let refused = ["Send " + "anyway", "Cam" + "era", "Speech" + "Synthesizer", "AVSpeech", "Delete"]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    var leaks: [String] = []
    var swept = 0
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    let code = { (source: String) in
      source.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") && !$0.trimmingCharacters(in: .whitespaces).hasPrefix("///") }
        .joined(separator: "\n")
    }
    let count = { (pattern: String, body: String) -> Int in (try? Self.count(pattern, in: body)) ?? -1 }
    var trayCalls = 0
    for (path, source) in files where path.hasPrefix(dir) || path == model || path == fixture {
      swept += 1
      let body = code(source)
      for token in writes + refused + colours where body.contains(token) { leaks.append("\(path): \(token)") }
      if path.hasPrefix(dir) {
        let calls = count(#"sendTray\(\)"#, body)
        trayCalls += calls
        if calls > 0 && path != trayView { leaks.append("\(path): calls sendTray") }
      }
    }
    if swept < 8 { leaks.append("swept \(swept) board 15 files") }
    if trayCalls != 1 { leaks.append("\(trayView): \(trayCalls) sendTray calls, not one") }
    // The sink: one call, from sendTray, with the tray's set.
    let modelText = code(text(model))
    if count(#"(?<![A-Za-z.])send\("#, modelText) != 1 { leaks.append("\(model): the sink is called other than once") }
    if !Self.function("sendTray(", in: modelText).contains("note = send(set)") {
      leaks.append("\(model): sendTray does not hand the sink its set")
    }
    let builds = files.map { count(#"OutboundAttachments\("#, code($0.1)) }.reduce(0, +)
    if builds != 1 || !Self.function("sendTray(", in: modelText).contains("guard let set = OutboundAttachments(tray: tray) else { return }") {
      leaks.append("\(model): a set is built other than once, from the tray")
    }
    if !modelText.contains("init?(tray: StagingTray) {\n    guard tray.canSend else { return nil }") {
      leaks.append("\(model): a set can be built from a tray that cannot send")
    }
    // No door sends.
    for door in ["hover(", "dwellElapsed(", "leave(", "release(", "attach(", "paste(", "takeDraftedWords("] {
      let body = Self.function(door, in: modelText)
      if body.isEmpty { leaks.append("\(model): no \(door)") }
      if body.contains("send(") || body.contains("sendTray(") { leaks.append("\(model): \(door) sends") }
    }
    // The record slot: a printed reason, and no control of any kind.
    let slot = Self.block("RecordSlot", in: code(text(trayView)))
    if !slot.contains("control.reason") { leaks.append("\(trayView): the record slot prints no reason") }
    for token in ["Button", ".disabled(", "Toggle(", ".opacity(", "onTapGesture"] where slot.contains(token) {
      leaks.append("\(trayView): the record slot draws a control (\(token))")
    }
    // The door.
    if !text(hooks).contains(#"attachmentsBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "15""#) {
      leaks.append("\(hooks): the media board is not gated on the flag and board 15")
    }
    for (path, source) in files where source.contains("AttachmentsRoot" + "(") && path != app && !path.hasPrefix(dir) {
      leaks.append("\(path): opens the media window")
    }
    if !text(app).contains("} else if TestHooks.attachmentsBoard {") { leaks.append("\(app): never opens the media window") }
    return leaks
  }

  @Test("H-S4-11: board 15 never sends from a door: no client, no route, one sink call from sendTray with the tray's set; the record slot is a reason with no control; no send anyway, camera or voice; nothing is green; it opens only with board 15 under the flag")
  func mediaSealed() throws {
    let files = try Self.sources(Self.appDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Attachments").count >= 6)
    let leaks = Self.mediaLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let model = Self.appDir + "/Models/AttachmentsModel.swift"
    let dir = Self.appDir + "/Boards/Attachments/"
    let hooks = Self.appDir + "/TestHooks.swift"
    let swaps: [(String, String, String)] = [
      (model, "      tray.stage(staged)\n", "      tray.stage(staged)\n      sendTray()\n"),
      (model, "    note = send(set)\n", "    note = send(set)\n    _ = send(set)\n"),
      (model, "    guard tray.canSend else { return nil }\n", "\n"),
      (model, "  func attach(_ files: [StagedFile]) {\n", "  func attach(_ files: [StagedFile]) {\n    _ = send(OutboundAttachments(tray: tray)!)\n"),
      (dir + "StagingTray.swift", "    if let reason = control.reason {\n",
       "    Button(\"Record\") {}.disabled(true)\n    if let reason = control.reason {\n"),
      (dir + "StagingTray.swift", "Text(\"\\u{2715}\")", "Text(\"Send " + "anyway\")"),
      (dir + "RefusalPanel.swift", "            model.takeDraftedWords()\n", "            model.sendTray()\n"),
      (dir + "DropTarget.swift", ".fill(Tokens.color(palette.layer0, opacity: look.scrim))", ".fill(Color." + "green)"),
      (dir + "ViewerWindow.swift", "{ model.copyCurrent() }", "{ _ = try? await client.settings() }"),
      (hooks, "attachmentsBoard = isUITest && environment", "attachmentsBoard = environment"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.mediaLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  // MARK: S4l

  static let kitDir = "apps/mac/Sources/WeMessageKit"
  static let kitTestsDir = "apps/mac/Tests/WeMessageKitTests"

  /// The H-S4-12 verdicts over (path, text) pairs of the app, kit, test and
  /// UI test sources: no inline reply anywhere (the word for it is never
  /// spelled and no action takes text); the notification center is reached
  /// from Notifications.swift alone, through switches with no default, and
  /// nothing outranks Focus; the extra, the Dock badge and the system poster
  /// are made only outside the UI-test flag; board 16 holds no client and
  /// names no route; nothing is green; and the board opens only with 16
  /// under the flag.
  static func osLayerLeaks(_ files: [(String, String)]) -> [String] {
    let dir = appDir + "/Boards/OSLayer/"
    let notes = notesFile
    let statusFile = dir + "StatusItemController.swift"
    let delegate = appDir + "/AppDelegate.swift"
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let kitFiles = [kitDir + "/Boards/OSLayer.swift", kitDir + "/Boards/AppMenu.swift"]
    let reply = "has" + "Reply"
    let textAction = "UNTextInput" + "NotificationAction"
    let center = "UNUser" + "NotificationCenter"
    let writes = ["client", "GatewayClient", "Outbound.", "/v1/", "URLSession", "httpMethod", "\"POST\"", "approve" + "Draft("]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    let extra = "StatusItem" + "Controller("
    let poster = "System" + "Poster("
    let loud = ["." + "timeSensitive", "." + "critical", "criticalAlert", "provisional" + "Authorization"]
    var leaks: [String] = []
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    let code = { (source: String) in
      source.split(separator: "\n", omittingEmptySubsequences: false)
        .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
        .joined(separator: "\n")
    }
    var swept = 0
    for (path, source) in files {
      if source.contains(reply) { leaks.append("\(path): \(reply)") }
      let body = code(source)
      if path != notes {
        for token in [textAction, center] where body.contains(token) { leaks.append("\(path): names \(token)") }
        if body.contains(poster) && path != delegate { leaks.append("\(path): builds the system poster") }
      }
      if body.contains(extra) && path != delegate && path != statusFile {
        leaks.append("\(path): builds the extra")
      }
      if body.contains("NSStatus" + "Bar") && path != statusFile { leaks.append("\(path): names the status bar") }
      if body.contains("dock" + "Tile") && path != delegate { leaks.append("\(path): marks the Dock") }
      if path.hasPrefix(dir) || kitFiles.contains(path) {
        swept += 1
        for token in writes + colours + loud where body.contains(token) { leaks.append("\(path): \(token)") }
      }
    }
    if swept < 8 { leaks.append("swept \(swept) board 16 files") }
    // The one door to the notification center: no text, no default.
    let notesCode = code(text(notes))
    if notesCode.components(separatedBy: textAction).count != 2 || !notesCode.contains("$0 is " + textAction) {
      leaks.append("\(notes): a text action is named other than in the refusal check")
    }
    if notesCode.contains("default:") || notesCode.contains("@unknown") { leaks.append("\(notes): a switch has a default") }
    for name in ["action(_ action: NotificationAction)", "route(_ actionId: String"] {
      let body = Self.function(name, in: notesCode)
      if !body.contains("switch action {") { leaks.append("\(notes): \(name) does not switch over the union") }
    }
    for token in loud where notesCode.contains(token) { leaks.append("\(notes): \(token)") }
    if !notesCode.contains("content.interruptionLevel = .active") { leaks.append("\(notes): the level is not active") }
    // The delegate: the extra, the poster and the badge sit behind the flag.
    let delegateCode = code(text(delegate))
    let start = Self.function("startOSLayer()", in: delegateCode)
    let gate =
      "    if !TestHooks.isUITest {\n      statusItem = " + extra + "hub: hub) { self.showWindow() }\n"
      + "      if Bundle.main.bundleIdentifier != nil {\n        Notifications.poster = " + poster + "center: .current())\n"
    if !start.contains(gate) { leaks.append("\(delegate): the extra or the poster is made under the flag") }
    if delegateCode.components(separatedBy: extra).count != 2
      || delegateCode.components(separatedBy: poster).count != 2
    {
      leaks.append("\(delegate): the extra or the poster is made more than once")
    }
    let badge = delegateCode.split(separator: "\n").filter { $0.contains("dock" + "Tile") }
    if badge.count != 1 || !(badge.first ?? "").contains("if !TestHooks.isUITest { " + nsApp + ".dock" + "Tile.badgeLabel = OSLayer.dockBadge(") {
      leaks.append("\(delegate): the Dock badge is set under the flag or not from OSLayer.dockBadge")
    }
    // The door.
    if !text(hooks).contains(#"osLayerBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "16""#) {
      leaks.append("\(hooks): board 16 is not gated on the flag")
    }
    for (path, source) in files where source.contains("OSLayerRoot" + "(") && path != app && !path.hasPrefix(dir) {
      leaks.append("\(path): opens board 16")
    }
    if !text(app).contains("} else if TestHooks.osLayerBoard {") { leaks.append("\(app): never opens board 16") }
    return leaks
  }

  @Test("H-S4-12: board 16 never replies inline: no text action and no word for one; the notification center is reached from one file through switches with no default, never louder than active; no extra, Dock badge or system poster under the flag; no client, no route, nothing green; it opens only with board 16 under the flag")
  func osLayerSealed() throws {
    let files = try Self.sources(Self.appDir) + Self.sources(Self.kitDir) + Self.sources(Self.uiTestsDir)
      + Self.sources(Self.appTestsDir) + Self.sources(Self.kitTestsDir)
    #expect(try Self.sources(Self.appDir + "/Boards/OSLayer").count >= 6)
    let leaks = Self.osLayerLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let dir = Self.appDir + "/Boards/OSLayer/"
    let delegate = Self.appDir + "/AppDelegate.swift"
    let hooks = Self.appDir + "/TestHooks.swift"
    let swaps: [(String, String, String)] = [
      (Self.kitDir + "/Boards/AppMenu.swift", "  public static let inlineReply = false\n",
       "  public static let inlineReply = false\n  public static let " + "has" + "Reply = false\n"),
      (Self.notesFile, "    case .done: options = []\n    }\n", "    case .done: options = []\n    @unknown default: options = []\n    }\n"),
      (Self.notesFile, "    case .done: hub.actOn(thread, \"popover:done\")\n",
       "    default: hub.actOn(thread, \"popover:done\")\n"),
      (Self.notesFile, "content.interruptionLevel = .active", "content.interruptionLevel = .time" + "Sensitive"),
      (dir + "PopoverView.swift", "import SwiftUI\n", "import SwiftUI\nlet probe = UNTextInput" + "NotificationAction.self\n"),
      (delegate, "    if !TestHooks.isUITest {\n      statusItem", "    if true {\n      statusItem"),
      (delegate, "if !TestHooks.isUITest { " + Self.nsApp + ".dock" + "Tile", "if true { " + Self.nsApp + ".dock" + "Tile"),
      (dir + "OSLayerHub.swift", "Task { await self.engageKillSwitch() }", "Task { _ = try? await client.settings() }"),
      (dir + "PopoverView.swift", "import SwiftUI\n", "import SwiftUI\nlet probe = Color." + "green\n"),
      (hooks, "osLayerBoard = isUITest && environment", "osLayerBoard = environment"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.osLayerLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  /// v2 S4m: board 17's files.
  static let progressDir = appDir + "/Boards/Progress/"
  static let cardViewFile = progressDir + "ShareCardView.swift"
  static let cardExportFile = progressDir + "ShareCardExport.swift"
  static let statTileFile = progressDir + "StatTile.swift"

  /// Code with `//` comments dropped, whole-line or trailing.
  static func uncommented(_ source: String) -> String {
    source.split(separator: "\n", omittingEmptySubsequences: false).map { line -> String in
      let text = String(line)
      if text.trimmingCharacters(in: .whitespaces).hasPrefix("//") { return "" }
      if let cut = text.range(of: " // ") { return String(text[..<cut.lowerBound]) }
      return text
    }.joined(separator: "\n")
  }

  /// Every type the app and the kit declare.
  static func declaredTypes(_ files: [(String, String)]) -> Set<String> {
    let regex = try! NSRegularExpression(pattern: #"\b(?:struct|enum|class|actor|protocol|typealias)\s+([A-Z][A-Za-z0-9_]*)"#)
    var names: Set<String> = []
    for (path, source) in files where path.hasPrefix(appDir) || path.hasPrefix(kitDir) {
      for m in regex.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
        if let r = Range(m.range(at: 1), in: source) { names.insert(String(source[r])) }
      }
    }
    return names
  }

  /// The H-S4-13 verdicts over (path, text) pairs of the app, kit and test
  /// sources: the card's view imports SwiftUI and the one struct and names
  /// no other app or kit type; board 17 prints no percentage, arrow, gauge
  /// or trend; no chrome file says streak; a stat tile cannot be made
  /// without its caveat; nothing is green; the export reaches the test
  /// pasteboard and the temporary folder under the flag; and the board
  /// opens only with 17 under the flag.
  static func progressLeaks(_ files: [(String, String)]) -> [String] {
    let dir = progressDir
    let hooks = appDir + "/TestHooks.swift"
    let app = appDir + "/ShellApp.swift"
    let shell = appDir + "/ShellView.swift"
    let swept = [appDir + "/Models/ProgressModel.swift", appDir + "/Fixtures/FixtureProgress.swift"]
    let chrome = [
      appDir + "/Boards/Shell/TitleBar.swift", shell, appDir + "/AppDelegate.swift",
      kitDir + "/Boards/OSLayer.swift", kitDir + "/Boards/AppMenu.swift",
    ]
    let unwelcome = ["%", "percent", "\u{2191}", "\u{2193}", "\u{2192}", "\u{2190}", "\u{25B2}", "\u{25BC}", "arrow.", "gauge", "trend"]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    var leaks: [String] = []
    let text = { (want: String) in files.first { $0.0 == want }?.1 ?? "" }
    // The card's view: two imports, and no app or kit type but the card.
    let card = text(cardViewFile)
    let imports = card.split(separator: "\n").map(String.init).filter { $0.hasPrefix("import ") }
    if imports != ["import SwiftUI", "import struct WeMessageKit.ShareCard"] {
      leaks.append("\(cardViewFile): imports \(imports)")
    }
    let bare = uncommented(card).split(separator: "\n").filter { !$0.hasPrefix("import ") }.joined(separator: "\n")
      .replacingOccurrences(of: #""[^"\n]*""#, with: "\"\"", options: .regularExpression)
    let ident = try! NSRegularExpression(pattern: #"\b[A-Z][A-Za-z0-9_]*\b"#)
    let named = Set(
      ident.matches(in: bare, range: NSRange(bare.startIndex..., in: bare)).compactMap {
        Range($0.range, in: bare).map { String(bare[$0]) }
      })
    let foreign = named.intersection(declaredTypes(files)).subtracting(["ShareCard", "ShareCardView"])
    if !foreign.isEmpty { leaks.append("\(cardViewFile): names \(foreign.sorted())") }
    // Board 17 and its words: nothing that reads as a score.
    var board = 0
    for (path, source) in files where path.hasPrefix(dir) || swept.contains(path) {
      board += 1
      let body = uncommented(source)
      for token in unwelcome where body.lowercased().contains(token) { leaks.append("\(path): \(token)") }
      for token in colours where body.contains(token) { leaks.append("\(path): \(token)") }
    }
    if board < 9 { leaks.append("swept \(board) board 17 files") }
    // Chrome: the rail, the title bar, the menu bar, the Dock never say streak.
    for (path, source) in files where chrome.contains(path) || path.hasPrefix(appDir + "/Boards/OSLayer/") {
      var body = uncommented(source)
      if path == shell, let start = body.range(of: "enum ShellID {") {
        let rest = body[start.lowerBound...]
        let end = rest.range(of: "\n}\n")?.upperBound ?? rest.endIndex
        body.removeSubrange(start.lowerBound..<end)
      }
      if body.lowercased().contains("streak") { leaks.append("\(path): says streak") }
    }
    // The tile: a caveat with no default and no way round it.
    let tile = uncommented(text(statTileFile))
    if !tile.contains("  let caveat: String\n") || tile.contains("init(") || tile.contains("caveat: String =")
      || tile.contains("caveat: String?")
    {
      leaks.append("\(statTileFile): the caveat can be left out")
    }
    // The export: the test pasteboard and the temporary folder under the flag.
    let export = uncommented(text(cardExportFile))
    if !export.contains("uiTest ? NSPasteboard.Name(ProvisionalUI.cardTestPasteboard) : .general")
      || export.components(separatedBy: ".general").count != 2
    {
      leaks.append("\(cardExportFile): copy reaches the general pasteboard under the flag")
    }
    let save = function("save(_ data: Data, uiTest: Bool)", in: export)
    guard let flagged = save.range(of: "if uiTest {"), let panel = save.range(of: "NSSavePanel()"),
      flagged.lowerBound < panel.lowerBound, save.contains("let folder = testFolder()")
    else {
      leaks.append("\(cardExportFile): save opens a panel or leaves the temporary folder under the flag")
      return leaks
    }
    if !function("testFolder()", in: export).contains("FileManager.default.temporaryDirectory") {
      leaks.append("\(cardExportFile): the test folder is not temporary")
    }
    for (path, source) in files where path.hasPrefix(appDir) {
      let body = uncommented(source)
      for call in ["ShareCardExport.copy(", "ShareCardExport.save("] {
        for piece in body.components(separatedBy: call).dropFirst()
        where !(piece.split(separator: "\n").first ?? "").contains("uiTest: TestHooks.isUITest)") {
          leaks.append("\(path): \(call) without the flag")
        }
      }
      if path != cardExportFile && (body.contains("NSPasteboard") || body.contains("NSSavePanel")) {
        leaks.append("\(path): reaches a pasteboard or a save panel")
      }
    }
    // The door.
    if !text(hooks).contains(#"progressBoard = isUITest && environment["WEMESSAGE_UI_BOARD"] == "17""#) {
      leaks.append("\(hooks): board 17 is not gated on the flag")
    }
    for (path, source) in files where source.contains("ProgressWindow" + "(") && path != app && !path.hasPrefix(dir) {
      leaks.append("\(path): opens board 17")
    }
    if !text(app).contains("} else if TestHooks.progressBoard {") { leaks.append("\(app): never opens board 17") }
    return leaks
  }

  @Test("H-S4-13: the share card's view imports SwiftUI and ShareCard alone and names no other app or kit type; board 17 has no percentage, arrow, gauge or trend; no chrome says streak; a stat tile needs its caveat; nothing is green; export under the flag reaches only the test pasteboard and a temporary folder; it opens only with board 17 under the flag")
  func progressSealed() throws {
    let files = try Self.sources(Self.appDir) + Self.sources(Self.kitDir) + Self.sources(Self.uiTestsDir)
      + Self.sources(Self.appTestsDir) + Self.sources(Self.kitTestsDir)
    #expect(try Self.sources(Self.appDir + "/Boards/Progress").count >= 7)
    let leaks = Self.progressLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    // Non-vacuity: each kind of leak is seen when planted.
    let dir = Self.progressDir
    let swaps: [(String, String, String)] = [
      (Self.cardViewFile, "import struct WeMessageKit.ShareCard\n", "import WeMessageKit\n"),
      (Self.cardViewFile, "  let card: ShareCard\n", "  let card: ShareCard\n  let thread: ThreadSummary\n"),
      (dir + "MeterRowView.swift", "case .count(let n): \"\\(n) left\"", "case .count(let n): \"\\(n)% left\""),
      (dir + "MeterRowView.swift", "      Text(\"CLEAR\")\n", "      Text(\"CLEAR \u{2193}\")\n"),
      (dir + "StatTile.swift", "  let caveat: String\n", "  var caveat: String = \"\"\n"),
      (dir + "StatTile.swift", "import WeMessageKit\n", "import WeMessageKit\nlet probe = Color." + "green\n"),
      (Self.appDir + "/Boards/Shell/TitleBar.swift", "import SwiftUI\n", "import SwiftUI\nlet probe = \"streak\"\n"),
      (Self.cardExportFile, "uiTest ? NSPasteboard.Name(ProvisionalUI.cardTestPasteboard) : .general",
       "NSPasteboard.Name.general"),
      (Self.cardExportFile, "    if uiTest {\n      let folder", "    if false {\n      let folder"),
      (dir + "ProgressWindow.swift", "copy(data, uiTest: TestHooks.isUITest)", "copy(data, uiTest: false)"),
      (Self.appDir + "/TestHooks.swift", "progressBoard = isUITest && environment", "progressBoard = environment"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.progressLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }
}

// MARK: - H-B-1, v2 B0

extension AppHygieneTests {
  /// The fixture state's word. Assembled, so this file never spells it.
  static let fixtureWord = "pre" + "view"
  static let testHooksFile = appDir + "/TestHooks.swift"
  static let shellModelFile = appDir + "/ShellModel.swift"
  static let whatsAppModelFile = appDir + "/Models/WhatsAppBoardModel.swift"
  /// The one line that opens the gate: the UI-test flag returns first.
  static var gateLine: String { "    if isUITest { return PreviewGate(state: \"" + fixtureWord + "\") }" }

  /// Every string literal on a line (no escapes, no multi-line).
  static func literals(_ text: String) -> [String] {
    guard let regex = try? NSRegularExpression(pattern: #""([^"\\\n]*)""#) else { return [] }
    let range = NSRange(text.startIndex..., in: text)
    return regex.matches(in: text, range: range).compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
  }

  /// The H-B-1 verdicts over (path, text) pairs of the app and kit sources:
  /// the fixture state's word is a whole string literal in TestHooks.swift
  /// alone, and nowhere in the kit at all; the gate is built open in one
  /// TestHooks line behind the flag, and closed everywhere else; the shell
  /// model's state takes the gate from TestHooks; the chip's word reaches
  /// a board only through the shell model, and only a fixture board draws
  /// it.
  static func fixtureStateLeaks(_ files: [(String, String)]) -> [String] {
    var out: [String] = []
    let word = fixtureWord
    for (path, text) in files {
      let inKit = path.hasPrefix(kitDir + "/")
      for literal in literals(text) {
        let lower = literal.lowercased()
        if inKit && lower.contains(word) { out.append("\(path): the kit spells \"\(literal)\"") }
        if !inKit && path != testHooksFile && lower.trimmingCharacters(in: .whitespaces) == word {
          out.append("\(path): the literal \"\(literal)\" outside TestHooks")
        }
      }
      for line in text.components(separatedBy: "\n") where line.contains("PreviewGate(state:") {
        if inKit {
          if !line.contains("PreviewGate(state: nil)") { out.append("\(path): the kit builds an open gate: \(line)") }
        } else if path != testHooksFile {
          out.append("\(path): a gate built outside TestHooks: \(line)")
        } else if line != gateLine {
          out.append("\(path): the gate is not built behind the flag: \(line)")
        }
      }
      if !inKit && path != shellModelFile && path != testHooksFile {
        if text.contains("TestHooks.previewGate()") { out.append("\(path): reads the gate outside the shell model") }
        if text.contains("TestHooks.previewChipText") { out.append("\(path): reads the chip's word outside the shell model") }
        if text.contains("AppState(previewGate:") { out.append("\(path): builds a gated state outside the shell model") }
      }
    }
    let hooks = files.first { $0.0 == testHooksFile }?.1 ?? ""
    if hooks.components(separatedBy: "PreviewGate(state:").count - 1 != 1 { out.append("TestHooks builds the gate other than once") }
    let shell = files.first { $0.0 == shellModelFile }?.1 ?? ""
    if !shell.contains("state = AppState(previewGate: TestHooks.previewGate())") {
      out.append("the shell model's state does not take its gate from TestHooks")
    }
    let board = files.first { $0.0 == whatsAppModelFile }?.1 ?? ""
    if !board.contains("case .connected: chip = nil") || !board.contains("case .notConnected, nil: return nil") {
      out.append("board 03 draws the chip, or a board at all, beyond a fixture board")
    }
    return out
  }

  static func fixtureStateSources() throws -> [(String, String)] {
    try sources(appDir) + sources(kitDir)
  }

  @Test("H-B-1: the fixture state's word is no production string: a literal in TestHooks alone, behind the UI-test flag, and never in the kit; the gate opens nowhere else; only a fixture board draws the chip")
  func fixtureStateConfined() throws {
    let files = try Self.fixtureStateSources()
    #expect(files.count > 50)
    #expect(Self.fixtureStateLeaks(files) == [])
    let hooks = files.first { $0.0 == Self.testHooksFile }?.1 ?? ""
    #expect(hooks.contains(Self.gateLine), "the flag-first gate line is gone")
  }

  @Test("H-B-1 teeth: every planted leak of the fixture state is seen")
  func fixtureStatePlants() throws {
    let files = try Self.fixtureStateSources()
    let word = Self.fixtureWord
    let capital = word.prefix(1).uppercased() + word.dropFirst()
    let swaps: [(String, String, String)] = [
      (Self.appDir + "/ShellView.swift", "import SwiftUI\n", "import SwiftUI\nlet probe = \"" + capital + "\"\n"),
      (Self.appDir + "/ProvisionalUI.swift", "import Foundation\n", "import Foundation\nlet probe = \" " + word + "\"\n"),
      (Self.testHooksFile, Self.gateLine, "    return PreviewGate(state: \"" + word + "\")"),
      (Self.shellModelFile, "AppState(previewGate: TestHooks.previewGate())", "AppState(previewGate: PreviewGate(state: \"x\"))"),
      (Self.kitDir + "/Channel.swift", "PreviewGate(state: nil)", "PreviewGate(state: \"x\")"),
      (Self.kitDir + "/Channel.swift", "import Foundation\n", "import Foundation\nlet probe = \"a " + word + " board\"\n"),
      (Self.whatsAppModelFile, "case .connected: chip = nil", "case .connected: chip = chipText"),
      (Self.whatsAppModelFile, "case .notConnected, nil: return nil", "case .notConnected, nil: chip = chipText"),
      (Self.appDir + "/Boards/WhatsApp/WhatsAppViews.swift", "import WeMessageKit\n",
       "import WeMessageKit\nlet probe = TestHooks.previewChipText\n"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.fixtureStateLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }
}
