import Foundation
import Testing

/// H-B-2, v2 B1: board 03 drawn over fixtures. Its provisional values live
/// in ProvisionalUI+Board03.swift, one section per D-UI-141..149 question,
/// Foundation only, and its copy is never repeated as a literal; the board
/// reads only: no client, no route, no composer, nothing fetched, nothing
/// green, colours only through Tokens. Words this file hunts for are
/// assembled, so it never spells what it forbids.
@Suite("AppHygieneBoard03")
struct AppHygieneBoard03Tests {
  static let appDir = AppHygieneTests.appDir
  static let provisionalFile = appDir + "/ProvisionalUI+Board03.swift"
  static let boardDir = appDir + "/Boards/WhatsApp/"
  static let threadViews = boardDir + "WhatsAppThreadViews.swift"
  static let models = [appDir + "/Models/WhatsAppBoardModel.swift", appDir + "/Models/WhatsAppThreadModel.swift"]
  static let shellView = appDir + "/ShellView.swift"
  static let bubbleContent = appDir + "/Boards/Thread/BubbleContent.swift"
  static let dUINumbers = Array(141...149)
  static let header = "PROVISIONAL pending Eric's D-UI-141..149 decisions"

  // MARK: D-UI-141..149

  /// Every copy string of six characters or more in `text` (dictionary keys
  /// excluded), as the D-UI row reads ProvisionalUI.swift.
  static func copy(_ text: String) throws -> [String] {
    let literal = try NSRegularExpression(pattern: #""([^"\\\n]{6,})"(?!\s*:)"#)
    return literal.matches(in: text, range: NSRange(text.startIndex..., in: text))
      .compactMap { Range($0.range(at: 1), in: text).map { String(text[$0]) } }
      .filter { !$0.contains("D-UI") }
  }

  /// The D-UI verdicts over (path, text) pairs of the app and UI test
  /// sources: the header, one section per question in order, each holding a
  /// constant, Foundation only, and no copy string repeated in another file.
  static func provisionalLeaks(_ files: [(String, String)]) throws -> [String] {
    var out: [String] = []
    guard let text = files.first(where: { $0.0 == provisionalFile })?.1 else { return ["\(provisionalFile) is gone"] }
    if !text.contains(header) { out.append("the header does not name D-UI-141..149") }
    let sections = try AppHygieneTests.dUISections(text)
    if sections.keys.sorted() != dUINumbers { out.append("sections found: \(sections.keys.sorted())") }
    for (n, body) in sections where !(body.contains("public static let ") || body.contains("public static func ")) {
      out.append("D-UI-\(n) holds no constant")
    }
    if try AppHygieneTests.imports(text) != ["Foundation"] { out.append("\(provisionalFile) imports beyond Foundation") }
    let strings = try copy(text)
    if strings.count < 20 { out.append("copy strings found: \(strings.count)") }
    for (path, other) in files where path != provisionalFile {
      for s in strings where other.contains(s) { out.append("\(path) repeats the provisional copy \"\(s)\"") }
    }
    return out
  }

  static func provisionalSources() throws -> [(String, String)] {
    try AppHygieneTests.sources(appDir) + AppHygieneTests.sources(AppHygieneTests.uiTestsDir)
  }

  @Test("H-B-2 D-UI: board 03's provisional values live in ProvisionalUI+Board03.swift, marked pending Eric's D-UI-141..149, one section and one constant per question, Foundation only, never repeated as a literal")
  func provisionalValues() throws {
    let files = try Self.provisionalSources()
    #expect(files.count > 60)
    let leaks = try Self.provisionalLeaks(files)
    #expect(leaks == [], "\(leaks)")
  }

  @Test("H-B-2 D-UI teeth: a repeated copy string, a lost section and a widened import are each seen")
  func provisionalPlants() throws {
    let files = try Self.provisionalSources()
    let text = files.first { $0.0 == Self.provisionalFile }?.1 ?? ""
    let copy = try Self.copy(text)
    let sample = copy.first ?? "(none)"
    let plants: [(String, String, String)] = [
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = \"" + sample + "\"\n"),
      (Self.provisionalFile, "// D-UI-147:", "// a section:"),
      (Self.provisionalFile, "import Foundation\n", "import Foundation\nimport " + "Swift" + "UI\n"),
      (Self.provisionalFile, "PROVISIONAL pending", "Provisional, pending"),
    ]
    for (path, from, to) in plants {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(try !Self.provisionalLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }

  // MARK: Reads only

  /// Source with whole-line comments dropped.
  static func code(_ source: String) -> String {
    source.split(separator: "\n", omittingEmptySubsequences: false)
      .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
      .joined(separator: "\n")
  }

  /// The H-B-2 verdicts over (path, text) pairs of the app sources: board
  /// 03's views and models hold no client, route or write, place no
  /// composer, draft or text entry, name no colour but through Tokens and
  /// nothing green; the one await is the thread's own read; a media tile's
  /// press only raises its note; and a single scope's rows draw no tag.
  static func boardLeaks(_ files: [(String, String)]) -> [String] {
    let writes = [
      "client", "Gateway" + "Client", "Outbound.", "Outbound(", ".send(", "approve" + "Draft(", "httpMethod",
      "\"PO" + "ST\"", "/v1/", "URL" + "Session", "URL" + "Request", "NSWork" + "space", "down" + "load(", "fe" + "tch(",
      "contents" + "Of",
    ]
    let composer = ["Composer" + "View", "Text" + "Field", "Text" + "Editor", "Verb" + "Row", "Draft" + "Bubble", "Find" + "Bar"]
    let colours = [
      "." + "green", "." + "mint", "." + "teal", "Color(" + "red:", "Color(" + "hue:", "Color(." + "sRGB", "NSColor(",
      "NSColor." + "system", "Color." + "accent", "#color" + "Literal", "Color." + "blue",
    ]
    var out: [String] = []
    var swept = 0
    for (path, source) in files where path.hasPrefix(boardDir) || models.contains(path) {
      swept += 1
      let body = code(source)
      for token in writes + composer + colours where body.contains(token) { out.append("\(path): \(token)") }
    }
    if swept < 4 { out.append("swept \(swept) board 03 files") }
    let views = code(files.first { $0.0 == threadViews }?.1 ?? "")
    let awaits = views.components(separatedBy: "await ").count - 1
    if awaits != 1 || !views.contains("await model.loadSelectedThread()") {
      out.append("\(threadViews): \(awaits) awaits, not the thread's one read")
    }
    for token in ["Task {", "Task(", ".task {"] where views.contains(token) { out.append("\(threadViews): \(token)") }
    let tile = AppHygieneTests.block("WhatsAppMediaTile", in: views)
    if !tile.contains("Button {\n        asked = true\n      } label: {") {
      out.append("\(threadViews): a media tile's press does more than raise its note")
    }
    // A reaction's glyph is drawn unsaturated: U+FE0E cannot stop a colour
    // emoji with no text glyph, and its edge over the wash reads as green.
    let reactions = AppHygieneTests.block("ReactionRow", in: code(files.first { $0.0 == bubbleContent }?.1 ?? ""))
    if !reactions.contains("Text(glyph).saturation(0)") {
      out.append("\(bubbleContent): a reaction's glyph keeps its colour")
    }
    let shell = files.first { $0.0 == shellView }?.1 ?? ""
    if !shell.contains("showsChannel: WhatsAppThreadLayout.showsChannelTag(model.scope)") {
      out.append("\(shellView): the list's tag does not follow the scope")
    }
    return out
  }

  @Test("H-B-2: board 03 reads only: no client, route or write; no composer, draft or text entry; colours only through Tokens and never green; one await, the thread's read; a media tile only raises its note; a single scope's rows draw no tag; a reaction's glyph is drawn without colour")
  func boardSealed() throws {
    let files = try AppHygieneTests.sources(Self.appDir)
    let leaks = Self.boardLeaks(files)
    #expect(leaks == [], "\(leaks)")
  }

  @Test("H-B-2 teeth: every planted write, composer, colour, fetch and tag is seen")
  func boardPlants() throws {
    let files = try AppHygieneTests.sources(Self.appDir)
    let tile = "      Button {\n        asked = true\n"
    let plants: [(String, String, String)] = [
      (Self.threadViews, tile, "      Button {\n        asked = true\n        Task { await model.load() }\n"),
      (Self.threadViews, tile, "      Button {\n        asked = true\n        _ = try? Data(contentsOf: url)\n"),
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = Outbound" + ".self\n"),
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = model." + "client\n"),
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = Composer" + "View.self\n"),
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = Color." + "green\n"),
      (Self.threadViews, "import WeMessageKit\n", "import WeMessageKit\nlet probe = Color(" + "hue: 0.33, saturation: 1, brightness: 1)\n"),
      (Self.models[1], "import Foundation\n", "import Foundation\nlet probe = \"/v1/" + "attachments\"\n"),
      (Self.shellView, "WhatsAppThreadLayout.showsChannelTag(model.scope)", "true"),
      (Self.bubbleContent, "Text(glyph).saturation(0)", "Text(glyph)"),
    ]
    for (path, from, to) in plants {
      let source = files.first { $0.0 == path }?.1 ?? ""
      #expect(source.contains(from), "plant anchor \(from) is gone from \(path)")
      let swapped = files.map { $0.0 == path ? ($0.0, $0.1.replacingOccurrences(of: from, with: to)) : $0 }
      #expect(!Self.boardLeaks(swapped).isEmpty, "a planted \(to) in \(path) went unseen")
    }
  }
}
