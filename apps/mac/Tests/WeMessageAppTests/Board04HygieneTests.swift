import Foundation
import Testing

/// H-B-4 (v2 B3, board 04): LinkedIn over fixtures. Its provisional values
/// live in ProvisionalUI+Board04.swift and nowhere else. The board has no
/// network client, names no LinkedIn host, imports no web view and drives
/// no automation; it is never green. Its one client call is createDraft, in
/// the desk, behind the composer's gate, and the views reach it only through
/// the shell model, whose press re-reads the gate; the composer view is
/// drawn only where the gate allows one. Every verdict is a pure function
/// over (path, text) pairs, and each kind of leak is planted once to prove
/// it is seen. Like AppHygieneTests, the file assembles what it hunts for,
/// so it never spells what it forbids.
@Suite("Board04Hygiene")
struct Board04HygieneTests {
  static let appDir = AppHygieneTests.appDir
  static let provisionalFile = appDir + "/ProvisionalUI+Board04.swift"
  static let boardDir = appDir + "/Boards/LinkedIn/"
  static let views = boardDir + "LinkedInViews.swift"
  static let inspector = boardDir + "LinkedInInspector.swift"
  static let desk = appDir + "/Models/LinkedInBoardModel.swift"

  static let dUINumbers = [137] + Array(160...169)

  static func files() throws -> [(String, String)] {
    try AppHygieneTests.sources(appDir) + AppHygieneTests.sources(AppHygieneTests.uiTestsDir)
  }

  static func code(_ source: String) -> String { Board05HygieneTests.code(source) }

  /// The provisional verdicts: header, one section per row in order, each
  /// holding a constant, Foundation only, and no copy string written again
  /// as a whole literal in code.
  static func provisionalLeaks(_ files: [(String, String)]) -> [String] {
    var leaks: [String] = []
    let text = files.first { $0.0 == provisionalFile }?.1 ?? ""
    if !text.contains("PROVISIONAL pending Eric's D-UI-137 and 160..169 decisions") {
      leaks.append("\(provisionalFile): no PROVISIONAL header")
    }
    let sections = (try? AppHygieneTests.dUISections(text)) ?? [:]
    if sections.keys.sorted() != dUINumbers { leaks.append("sections found: \(sections.keys.sorted())") }
    for (n, body) in sections where !body.contains("public static let ") && !body.contains("public static func ") {
      leaks.append("D-UI-\(n) holds no constant")
    }
    if (try? AppHygieneTests.imports(text)) != ["Foundation"] { leaks.append("\(provisionalFile): not Foundation only") }
    let strings = Board05HygieneTests.copy(text)
    if strings.count < 20 { leaks.append("provisional copy strings found: \(strings.count)") }
    for (path, source) in files where path != provisionalFile {
      let body = code(source)
      for s in strings where body.contains("\"" + s + "\"") {
        leaks.append("\(path) repeats the provisional copy \"\(s)\"")
      }
    }
    return leaks
  }

  /// The board's verdicts.
  static func boardLeaks(_ files: [(String, String)]) -> [String] {
    var leaks: [String] = []
    let text = { (want: String) in code(files.first { $0.0 == want }?.1 ?? "") }
    let writes = [
      "Schedule" + "Input(", "approve" + "Draft(", "setKill" + "Switch", "engageKill" + "Switch", "/v1/", "httpMethod",
      "\"POST\"", "Picker" + "(", "key" + "Code", ".on" + "Submit", "keyboard" + "Shortcut(", "Outbound",
    ]
    let colours = ["." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "NSColor." + "system", "Color." + "accent"]
    // No network client, no LinkedIn host, no web view, no automation.
    let reach = [
      "URL" + "Session", "URL" + "Request", "linked" + "in.com", "lnkd" + ".in", "import " + "WebKit", "WK" + "WebView",
      "NSApple" + "Script", "osa" + "script", "AXUI" + "Element", "CG" + "Event", "Process" + "(", "NSWorkspace",
      "open" + "URL", "send" + "(to:",
    ]
    var swept = 0
    var creates = 0
    let board = files.filter { $0.0.hasPrefix(boardDir) || $0.0 == desk }
    for (path, source) in board {
      swept += 1
      let body = code(source)
      for token in writes + colours + reach where body.contains(token) { leaks.append("\(path): \(token)") }
      let regex = try? NSRegularExpression(pattern: #"\bclient\.([A-Za-z]+)"#)
      for m in regex?.matches(in: body, range: NSRange(body.startIndex..., in: body)) ?? [] {
        guard let r = Range(m.range(at: 1), in: body) else { continue }
        if body[r] == "createDraft" && path == desk { creates += 1 } else { leaks.append("\(path): client.\(body[r])") }
      }
    }
    if swept < 3 { leaks.append("swept \(swept) board 04 files") }
    if creates != 1 { leaks.append("\(desk): \(creates) createDraft calls, not one") }

    // 04.H: the create sits behind the gate, and the press re-reads it.
    let model = text(desk)
    let make = AppHygieneTests.function("makeDraft(chatGuid:", in: model)
    let gate = make.range(of: "guard gate.allowsDraft")
    let create = make.range(of: "client.createDraft(")
    if gate == nil || create == nil || gate!.lowerBound > create!.lowerBound {
      leaks.append("\(desk): makeDraft creates before the gate is checked")
    }
    if !AppHygieneTests.function("draftLinkedIn(body:", in: model).contains("gate: linkedInComposer(") {
      leaks.append("\(desk): the press does not re-read the gate")
    }
    if !AppHygieneTests.function("linkedInComposer(_ thread:", in: model).contains("paused: paused") {
      leaks.append("\(desk): the gate does not read the pause")
    }

    // The views reach a draft only through the shell model, and draw the
    // composer only where the gate allows one.
    for path in board.map(\.0) where path != desk {
      let body = text(path)
      if body.contains(".makeDraft(") || body.contains("linkedIn.make") { leaks.append("\(path): drafts around the gate") }
    }
    let view = text(views)
    if view.components(separatedBy: "model.draftLinkedIn(").count != 2 {
      leaks.append("\(views): not exactly one draft press")
    }
    if view.components(separatedBy: "LinkedInComposerView(").count != 2
      || !view.contains("case .composer(let rung):\n        LinkedInComposerView(")
    {
      leaks.append("\(views): the composer is drawn outside the gate's composer case")
    }
    for token in ["UserDefaults", "write(to", "FileManager"] where model.contains(token) || view.contains(token) {
      leaks.append("board 04 persists: \(token)")
    }
    for token in ["Date" + "Picker", "Hold" + "Until(", "schedule" + "d"] where view.contains(token) || model.contains(token) {
      leaks.append("board 04 schedules: \(token)")
    }
    return leaks
  }

  @Test("H-B-4: board 04's provisional values live in ProvisionalUI+Board04.swift, pending Eric's D-UI-137 and 160..169, one section and a constant each, Foundation only, never repeated as a literal")
  func provisionalSealed() throws {
    let files = try Self.files()
    let leaks = Self.provisionalLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    let views = Self.views
    let swaps: [(String, String, String)] = [
      (views, "Text(ProvisionalUI.linkedInRequestTitle)", "Text(\"Message request\")"),
      (views, "SettingsButton(title: ProvisionalUI.linkedInDraftLabel,", "SettingsButton(title: \"Make draft\","),
      (Self.provisionalFile, "// D-UI-164:", "// D-UI-1640:"),
      (Self.provisionalFile, "import Foundation", "import Foundation\nimport App" + "Kit"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.provisionalLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  @Test("H-B-4: board 04 has no network client, LinkedIn host, web view or automation, is never green, and its one write is a draft behind the composer's gate, re-read at the press")
  func boardSealed() throws {
    let files = try Self.files()
    #expect(try AppHygieneTests.sources(Self.boardDir).count >= 2)
    let leaks = Self.boardLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    let (desk, views, inspector) = (Self.desk, Self.views, Self.inspector)
    let swaps: [(String, String, String)] = [
      (desk, "try await client.createDraft(", "try await client.send" + "(to: chatGuid, body: text) ?? client.createDraft("),
      (desk, "try await client.createDraft(", "try await client.approve" + "Draft(id: \"x\") ?? client.createDraft("),
      (desk, "phases[chatGuid] = .drafting", "phases[chatGuid] = .drafting\n    _ = try? await client.settings()"),
      (desk, "guard gate.allowsDraft, !phase(chatGuid).busy else { return }", "guard !phase(chatGuid).busy else { return }"),
      (desk, "gate: linkedInComposer(open.thread)", "gate: .composer(.message)"),
      (desk, "commercial: LinkedInTurnMeta.commercial(in: open.page.turns)?.kind, paused: paused)",
        "commercial: LinkedInTurnMeta.commercial(in: open.page.turns)?.kind, paused: false)"),
      (views, "Task { await model.draftLinkedIn(body: body) }", "Task { await model.linkedIn.makeDraft(chatGuid: thread.chatGuid, body: body, gate: .composer(rung)) }"),
      (views, "case .absent(let reason):", "case .absent(let reason):\n        LinkedInComposerView(model: model, thread: thread, rung: .message, degree: nil, palette: palette)"),
      (views, ".foregroundStyle(Tokens.color(palette.inkDim))", ".foregroundStyle(Color." + "green)"),
      (inspector, ".foregroundStyle(Tokens.color(palette.inkDim))", ".foregroundStyle(Color." + "green)"),
      (views, "import SwiftUI", "import SwiftUI\nimport Web" + "Kit"),
      (inspector, "  private var meta:", "  let page = URL(string: \"https://www.linked" + "in.com/in/x\")\n  private var meta:"),
      (views, "model.linkedIn.switchShown.toggle()", "model.linkedIn.switchShown.toggle()\n        _ = URL" + "Session.shared"),
      (views, "model.linkedIn.switchShown.toggle()", "model.linkedIn.switchShown.toggle()\n        _ = NSApple" + "Script(source: \"\")"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.boardLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }
}
