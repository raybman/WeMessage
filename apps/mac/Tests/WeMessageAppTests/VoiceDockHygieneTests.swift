import Foundation
import Testing

/// H-B-5 (v2 B4, board 07): the voice dock is drawn over fixtures and has
/// nothing behind it. No microphone, no audio session, no speech engine and
/// no entitlement or usage string that would ask for one, anywhere in the
/// Mac app's sources, resources or project. The dock's own files never
/// send, never hide the caption and paint only the palette's neutrals; its
/// provisional values live in ProvisionalUI+Board07.swift and nowhere else.
/// Every name this file hunts for is assembled, so it never spells what it
/// forbids.
@Suite("VoiceDockHygiene")
struct VoiceDockHygieneTests {
  static let macDir = "apps/mac"
  static let dockDir = AppHygieneTests.appDir + "/Boards/Shell/VoiceDock"
  static let provisionalFile = AppHygieneTests.appDir + "/ProvisionalUI+Board07.swift"
  static let shellModelFile = AppHygieneTests.appDir + "/ShellModel.swift"

  /// The modules that would hear or speak.
  static let audioModules: Set<String> = [
    "AV" + "Foundation", "AV" + "FAudio", "Spe" + "ech", "AV" + "Kit", "Core" + "Audio", "Audio" + "Toolbox",
    "AV" + "Routing", "Sound" + "Analysis",
  ]

  /// The symbols, usage strings and entitlements that would.
  static let audioNames = [
    "AV" + "Audio", "SF" + "Speech", "AV" + "Capture", "AV" + "SpeechSynthesizer", "NS" + "SpeechSynthesizer",
    "NS" + "SpeechRecognizer", "NSMicrophone" + "UsageDescription", "NSSpeechRecognition" + "UsageDescription",
    "device." + "audio-input", "device." + "microphone", "request" + "RecordPermission", "record" + "Permission",
  ]

  /// Every text file the rule reads: the Swift sources of every target,
  /// the resources (plists and entitlements) and the project.
  static func files() throws -> [(String, String)] {
    let sources = try AppHygieneTests.sources(macDir + "/Sources") + AppHygieneTests.sources(macDir + "/UITests")
    let resources = try Repo.files(under: macDir + "/Resources")
      .filter { $0.hasSuffix(".plist") || $0.hasSuffix(".entitlements") }
      .map { (macDir + "/Resources/" + $0, try Repo.text(macDir + "/Resources/" + $0)) }
    return sources + resources + [(macDir + "/project.yml", try Repo.text(macDir + "/project.yml"))]
  }

  /// The H-B-5 verdicts over (path, text) pairs.
  static func audioLeaks(_ files: [(String, String)]) throws -> [String] {
    var out: [String] = []
    for (path, text) in files {
      if path.hasSuffix(".swift") {
        for module in try AppHygieneTests.imports(text) where audioModules.contains(module) {
          out.append("\(path) imports \(module)")
        }
      }
      for name in audioNames where text.contains(name) {
        out.append("\(path) names \(name)")
      }
    }
    return out
  }

  @Test("H-B-5: no microphone, audio session, speech engine, usage string or audio entitlement anywhere in the Mac app")
  func noAudio() throws {
    let files = try Self.files()
    #expect(files.count > 80, "files read: \(files.count)")
    #expect(files.contains { $0.0.hasSuffix(".entitlements") })
    #expect(files.contains { $0.0.hasSuffix("Info.plist") })
    #expect(try Self.audioLeaks(files) == [])
  }

  @Test("H-B-5 teeth: every planted way to hear or speak is seen")
  func noAudioPlants() throws {
    let plants: [(String, String)] = [
      ("a.swift", "import " + "AV" + "Foundation\n"),
      ("a.swift", "@preconcurrency import " + "Spe" + "ech\n"),
      ("a.swift", "let e = " + "AV" + "AudioEngine()\n"),
      ("a.swift", "let r = " + "SF" + "SpeechRecognizer()\n"),
      ("Info.plist", "<key>" + "NSMicrophone" + "UsageDescription</key>"),
      ("a.entitlements", "<key>com.apple.security." + "device." + "audio-input</key>"),
    ]
    for plant in plants {
      #expect(try Self.audioLeaks([plant]).count >= 1, "missed: \(plant.1)")
    }
  }

  /// The dock's files' verdicts: no send, no caption switch, only the
  /// palette's neutrals.
  static func dockLeaks(_ files: [(String, String)]) throws -> [String] {
    var out: [String] = []
    let sends = ["perform(", "approve" + "Draft(", ".send(to:", "approve" + "All(", "approve" + "Pending("]
    let hiding = [
      "Tog" + "gle(", ".hid" + "den()", ".opacity(0)", "caption" + "Shown", "caption" + "Hidden", "caption" + "Visible",
      "show" + "Caption", "hide" + "Caption", "caption" + "Off", "caption" + "Toggle",
    ]
    let neutrals: Set<String> = ["ink", "inkDim", "layer1", "layer2"]
    for (path, text) in files {
      for word in sends where text.contains(word) { out.append("\(path) sends: \(word)") }
      for word in hiding where text.contains(word) { out.append("\(path) can hide the caption: \(word)") }
      let palette = try NSRegularExpression(pattern: #"palette\.(\w+)"#)
      for match in palette.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
        guard let r = Range(match.range(at: 1), in: text) else { continue }
        let name = String(text[r])
        if !neutrals.contains(name) { out.append("\(path) paints \(name)") }
      }
      for word in ["Color" + ".", "Color" + "(", "NSColor", ".tint(", "accent" + "Color", "foregroundStyle(."]
      where text.contains(word) {
        out.append("\(path) paints a colour outside the palette: \(word)")
      }
    }
    return out
  }

  @Test("H-B-5: the dock's files never send or approve, have no way to hide the caption, and paint only ink, inkDim, layer1 and layer2")
  func dockConfined() throws {
    let files = try AppHygieneTests.sources(Self.dockDir)
    #expect(files.count >= 2)
    #expect(try Self.dockLeaks(files) == [])
    let view = files.first { $0.0.hasSuffix("/VoiceDockView.swift") }?.1 ?? ""
    #expect(view.contains("model.voiceCommit(in: thread.chatGuid)"), "Send does not go through voiceCommit")
    #expect(view.contains(".keyboardShortcut(.return, modifiers: .command)"), "Send is not cmd-Return")
    // The caption switch would live on the model too.
    let shell = try Repo.text(Self.shellModelFile)
    #expect(try Self.dockLeaks([(Self.shellModelFile, shell)]).filter { $0.contains("caption") } == [])
    // voiceCommit's one way forward is approvePending.
    #expect(shell.contains("    return approvePending(in: chatGuid)\n  }"))
  }

  @Test("H-B-5 teeth: a send, a caption switch and a colour planted in the dock are each seen")
  func dockPlants() throws {
    for plant in [
      "model.outbound.perform(x, gesture: .approveButton)", "Tog" + "gle(\"Caption\", isOn: $on)",
      "Text(x).foregroundStyle(Tokens.color(palette.layer0))", "Capsule().fill(" + "Color" + ".blue)",
    ] {
      #expect(try Self.dockLeaks([("p.swift", plant)]).count >= 1, "missed: \(plant)")
    }
  }

  static let dUINumbers = [138] + Array(170...179)

  @Test("D-UI (B4): board 07's provisional values live in ProvisionalUI+Board07.swift, marked pending Eric's D-UI-138 and 170..179, one section and a constant per question, Foundation only, and never repeated as a literal")
  func provisionalValues() throws {
    let provisional = try Repo.text(Self.provisionalFile)
    #expect(provisional.contains("PROVISIONAL pending Eric's D-UI-138 and 170..179 decisions"))
    let sections = try AppHygieneTests.dUISections(provisional)
    #expect(sections.keys.sorted() == Self.dUINumbers, "sections found: \(sections.keys.sorted())")
    for (n, body) in sections.sorted(by: { $0.key < $1.key }) {
      #expect(body.contains("public static let ") || body.contains("public static func "), "D-UI-\(n) holds no constant")
    }
    #expect(try AppHygieneTests.imports(provisional) == ["Foundation"])
    // The base file does not claim these numbers.
    let base = try Repo.text(AppHygieneTests.appDir + "/ProvisionalUI.swift")
    #expect(try AppHygieneTests.dUISections(base).keys.filter { Self.dUINumbers.contains($0) } == [])

    let strings = AppHygieneTests.literals(provisional).filter { !$0.contains("D-UI") && !$0.contains("\\(") }
    #expect(strings.count >= 10, "provisional strings found: \(strings)")
    let others = try (AppHygieneTests.sources(AppHygieneTests.appDir) + AppHygieneTests.sources(AppHygieneTests.uiTestsDir))
      .filter { $0.0 != Self.provisionalFile }
    #expect(others.count >= 14)
    for (path, text) in others {
      for s in strings {
        // Long copy may not appear at all; a short word may not appear as
        // a whole literal (the word alone is common in code).
        if s.count >= 12 {
          #expect(!text.contains(s), "\(path) repeats the provisional copy \"\(s)\"")
        } else {
          #expect(!text.contains("\"" + s + "\""), "\(path) repeats the provisional word \"\(s)\"")
        }
      }
    }
  }
}
