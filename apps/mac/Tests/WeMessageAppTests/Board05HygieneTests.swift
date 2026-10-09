import Foundation
import Testing

/// H-B-3 (v2 B2, board 05): the Email board over fixtures. Its provisional
/// values live in ProvisionalUI+Board05.swift and nowhere else; compose's
/// one client call is createDraft, after the undo window; nothing on the
/// board can send, approve, name a route, pick a time or read a key code;
/// remote images are fetched by one loader, on an ephemeral session with no
/// bearer, and only from a view drawn after a reveal; the wall blocks Send.
/// Every verdict is a pure function over (path, text) pairs, and each kind
/// of leak is planted once to prove it is seen. Like AppHygieneTests, the
/// file assembles what it hunts for, so it never spells what it forbids.
@Suite("Board05Hygiene")
struct Board05HygieneTests {
  static let appDir = AppHygieneTests.appDir
  static let provisionalFile = appDir + "/ProvisionalUI+Board05.swift"
  static let boardDir = appDir + "/Boards/Email/"
  static let views = boardDir + "EmailViews.swift"
  static let desk = appDir + "/Models/EmailBoardModel.swift"
  static let compose = appDir + "/Models/EmailComposeModel.swift"
  static let loader = appDir + "/Models/RemoteImageLoader.swift"

  static let dUINumbers = [136, 139] + Array(150...159)

  static func files() throws -> [(String, String)] {
    try AppHygieneTests.sources(appDir) + AppHygieneTests.sources(AppHygieneTests.uiTestsDir)
  }

  /// Comment lines out, so a doc comment may name what the code may not do.
  static func code(_ source: String) -> String {
    source.split(separator: "\n", omittingEmptySubsequences: false)
      .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
  }

  /// The copy strings of six characters or more in the board's provisional
  /// file, as the D-UI row reads ProvisionalUI.swift's.
  static func copy(_ provisional: String) -> [String] {
    let literal = try? NSRegularExpression(pattern: #""([^"\\\n]{6,})"(?!\s*:)"#)
    return (literal?.matches(in: provisional, range: NSRange(provisional.startIndex..., in: provisional)) ?? [])
      .compactMap { Range($0.range(at: 1), in: provisional).map { String(provisional[$0]) } }
      .filter { !$0.contains("D-UI") }
  }

  /// The provisional verdicts: header, one section per row in order, each
  /// holding a constant, Foundation only, and no copy string written again
  /// as a whole literal in code (short words such as a verb also occur in
  /// longer copy and in comments elsewhere, so the sweep is literal-exact).
  static func provisionalLeaks(_ files: [(String, String)]) -> [String] {
    var leaks: [String] = []
    let text = files.first { $0.0 == provisionalFile }?.1 ?? ""
    if !text.contains("PROVISIONAL pending Eric's D-UI-136, 139 and 150..159 decisions") {
      leaks.append("\(provisionalFile): no PROVISIONAL header")
    }
    let sections = (try? AppHygieneTests.dUISections(text)) ?? [:]
    if sections.keys.sorted() != dUINumbers { leaks.append("sections found: \(sections.keys.sorted())") }
    for (n, body) in sections where !body.contains("public static let ") && !body.contains("public static func ") {
      leaks.append("D-UI-\(n) holds no constant")
    }
    if (try? AppHygieneTests.imports(text)) != ["Foundation"] { leaks.append("\(provisionalFile): not Foundation only") }
    let strings = copy(text)
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
    var swept = 0
    var creates = 0
    let board = files.filter { $0.0.hasPrefix(boardDir) || [desk, compose, loader].contains($0.0) }
    for (path, source) in board {
      swept += 1
      let body = code(source)
      for token in writes + colours where body.contains(token) { leaks.append("\(path): \(token)") }
      let regex = try? NSRegularExpression(pattern: #"\bclient\.([A-Za-z]+)"#)
      for m in regex?.matches(in: body, range: NSRange(body.startIndex..., in: body)) ?? [] {
        guard let r = Range(m.range(at: 1), in: body) else { continue }
        if body[r] == "createDraft" && path == compose { creates += 1 } else { leaks.append("\(path): client.\(body[r])") }
      }
    }
    if swept < 4 { leaks.append("swept \(swept) board 05 files") }
    if creates != 1 { leaks.append("\(compose): \(creates) createDraft calls, not one") }

    // 05.B: the create runs only from the undo window's task, after every
    // tick of the message's own window, and checks it was not undone.
    let model = text(compose)
    let send = AppHygieneTests.function("send(", in: model)
    let opens = send.range(of: "phase = .undo(secondsLeft: seconds)")
    let window = send.range(of: "for left in stride(from: seconds - 1")
    let create = send.range(of: "await self.createDraft(")
    if opens == nil || create == nil || opens!.lowerBound > create!.lowerBound {
      leaks.append("\(compose): send() does not open the undo window before the create")
    }
    if window == nil || create == nil || window!.lowerBound > create!.lowerBound {
      leaks.append("\(compose): send() creates the draft before the undo window has run")
    }
    if !model.contains("undoSeconds = card.meta.undoSeconds") {
      leaks.append("\(compose): the undo window is not the message's own")
    }
    if !AppHygieneTests.function("createDraft(chatGuid:", in: model).contains("guard !Task.isCancelled, case .undo = phase else { return }") {
      leaks.append("\(compose): the create does not check the window was not undone")
    }
    // 05.D: the wall blocks Send.
    if !AppHygieneTests.function("send(", in: model).contains("guard canSend") || !model.contains("wall != .block") {
      leaks.append("\(compose): Send is not blocked at the wall")
    }

    // 05.E: one loader, ephemeral, no bearer, fetched only from the image
    // view, and that view drawn only inside the revealed branch; a reveal
    // is per message and held in memory only.
    let load = text(loader)
    if !load.contains("URLSessionConfiguration.ephemeral") { leaks.append("\(loader): the session is not ephemeral") }
    for token in ["Authori" + "zation", "Bearer", "token", "GatewayClient", "shared"] where load.contains(token) {
      leaks.append("\(loader): \(token)")
    }
    for (path, source) in files where path != loader {
      if path.hasPrefix(appDir + "/") && code(source).contains("URL" + "Session") { leaks.append("\(path): reaches the network outside the loader") }
      if path != views && code(source).contains("RemoteImageLoader.fetch(") { leaks.append("\(path): fetches an image") }
    }
    let view = text(views)
    if view.components(separatedBy: "RemoteImageLoader.fetch(").count != 2 {
      leaks.append("\(views): not exactly one image fetch")
    }
    if view.components(separatedBy: "RemoteImageView(").count != 2 || !view.contains("if revealed {\n        ForEach(card.meta.images") {
      leaks.append("\(views): an image is drawn outside the revealed branch")
    }
    let deskText = text(desk)
    if !deskText.contains("func isRevealed(_ turnGuid: String) -> Bool { revealed.contains(turnGuid) }") {
      leaks.append("\(desk): a message is revealed without a reveal")
    }
    for token in ["UserDefaults", "write(to", "FileManager"] where deskText.contains(token) || view.contains(token) {
      leaks.append("board 05 persists: \(token)")
    }

    // 05.B, D-UI-139: Hold until is drawn disabled and opens nothing.
    let hold = view.components(separatedBy: "private var hold: some View").dropFirst().first ?? ""
    if !hold.contains(".disabled(true)") || !hold.contains("ProvisionalUI.emailHoldParked") {
      leaks.append("\(views): Hold until is not parked")
    }
    for token in ["Date" + "Picker", "Hold" + "Until(", "schedule" + "d"] where view.contains(token) || model.contains(token) {
      leaks.append("board 05 schedules: \(token)")
    }
    return leaks
  }

  @Test("H-B-3: board 05's provisional values live in ProvisionalUI+Board05.swift, pending Eric's D-UI-136, 139 and 150..159, one section and a constant each, Foundation only, never repeated as a literal")
  func provisionalSealed() throws {
    let files = try Self.files()
    let leaks = Self.provisionalLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    let views = Self.views
    let swaps: [(String, String, String)] = [
      (views, "Text(ProvisionalUI.emailHoldParked)", "Text(\"Scheduling is parked in this version.\")"),
      (views, "SettingsButton(title: ProvisionalUI.emailLoadImages,", "SettingsButton(title: \"Load images\","),
      (Self.provisionalFile, "// D-UI-153:", "// D-UI-1530:"),
      (Self.provisionalFile, "import Foundation", "import Foundation\nimport App" + "Kit"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.provisionalLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  @Test("H-B-3: board 05 creates a draft after the message's undo window and nothing else; no send, approve, route, key code or picker; remote images through one ephemeral, bearer-free loader, only after a reveal; the wall blocks Send; Hold until is parked")
  func boardSealed() throws {
    let files = try Self.files()
    #expect(try AppHygieneTests.sources(Self.boardDir).count >= 1)
    let leaks = Self.boardLeaks(files)
    #expect(leaks.isEmpty, "\(leaks)")
    let (model, views, desk, loader) = (Self.compose, Self.views, Self.desk, Self.loader)
    let swaps: [(String, String, String)] = [
      (model, "try await client.createDraft(", "try await client.send" + "(to: chatGuid, body: text) ?? client.createDraft("),
      (model, "try await client.createDraft(", "try await client.approve" + "Draft(id: \"x\") ?? client.createDraft("),
      (model, "phase = .drafting", "phase = .drafting\n    _ = try? await client.settings()"),
      (model, "      for left in stride(", "      await self.createDraft(chatGuid: guid, body: text)\n      for left in stride("),
      (model, "guard !Task.isCancelled, case .undo = phase else { return }", "guard !Task.isCancelled else { return }"),
      (model, "undoSeconds = card.meta.undoSeconds", "undoSeconds = 1"),
      (model, "!busy && wall != .block", "!busy"),
      (loader, "URLSessionConfiguration.ephemeral", "URLSessionConfiguration.default"),
      (loader, "config.urlCache = nil", "config.httpAdditionalHeaders = [\"Authori" + "zation\": \"Bearer x\"]"),
      (desk, "func isRevealed(_ turnGuid: String) -> Bool { revealed.contains(turnGuid) }", "func isRevealed(_ turnGuid: String) -> Bool { true }"),
      (views, "if revealed {\n        ForEach(card.meta.images", "if true {\n        ForEach(card.meta.images"),
      (views, "    .accessibilityIdentifier(ShellID.emailComposeHold)\n    .disabled(true)", "    .accessibilityIdentifier(ShellID.emailComposeHold)"),
      (views, ".foregroundStyle(Tokens.color(palette.inkDim))", ".foregroundStyle(Color." + "green)"),
      (views, "event.charactersIgnoringModifiers?.lowercased() == \"r\"", "event.key" + "Code == 15"),
      (views, "desk.reveal(card.id)", "desk.reveal(card.id)\n            _ = URL" + "Session.shared"),
    ]
    for (path, from, to) in swaps {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.boardLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }
}
