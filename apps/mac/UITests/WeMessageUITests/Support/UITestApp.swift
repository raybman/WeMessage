import Foundation
import XCTest

/// The accessibility identifiers the app publishes (the contract in
/// Sources/WeMessageApp/ShellView.swift; AppHygieneTests H-A5 holds the two
/// lists equal).
enum ID {
  static let shell = "wemessage.shell"
  static let rail = "wemessage.rail"
  static let railAll = "wemessage.rail.all"
  static let railIMessage = "wemessage.rail.imessage"
  static let railWhatsApp = "wemessage.rail.whatsapp"
  static let railLinkedIn = "wemessage.rail.linkedin"
  static let railEmail = "wemessage.rail.email"
  static let sidebar = "wemessage.sidebar"
  static let lens = "wemessage.lens"
  static let sidebarEmpty = "wemessage.sidebar.empty"
  static let connection = "wemessage.connection"
  static let contentEmpty = "wemessage.content.empty"
  // v2 S4c, board 01.
  static let title = "wemessage.title"
  static let titleCounter = "wemessage.title.counter"
  static let lensRecent = "wemessage.lens.recent"
  static let lensNeedsYou = "wemessage.lens.needsyou"
  static let lensTriage = "wemessage.lens.triage"
  static let killChip = "wemessage.kill.chip"
  static let content = "wemessage.content"
  static let inspector = "wemessage.inspector"
  static let inspectorToggle = "wemessage.inspector.toggle"
  /// A list row is this prefix and its chatGuid.
  static let rowPrefix = "wemessage.sidebar.row."
  // v2 S4d, board 02.
  static let thread = "wemessage.thread"
  static let threadBanner = "wemessage.thread.banner"
  static let capabilityNote = "wemessage.thread.capability.note"
  static let inv5 = "wemessage.thread.inv5"
  static let draft = "wemessage.thread.draft"
  static let draftApprove = "wemessage.thread.draft.approve"
  static let draftEdit = "wemessage.thread.draft.edit"
  static let draftHold = "wemessage.thread.draft.hold"
  static let composer = "wemessage.composer"
  static let composerField = "wemessage.composer.field"
  static let composerSend = "wemessage.composer.send"
  /// Never placed while D-UI-17 is absent-with-reason: tests assert it is not.
  static let composerHold = "wemessage.composer.hold"
  static let composerOutbox = "wemessage.composer.outbox"
  /// A transcript bubble is this prefix and its message guid.
  static let bubblePrefix = "wemessage.thread.bubble."
  /// A day separator is this prefix and its day key (yyyy-MM-dd).
  static let dayPrefix = "wemessage.thread.day."
  /// A held draft is this prefix and its draft id.
  static let heldPrefix = "wemessage.thread.held."
  // v2 S4e, board 08: the specimen sheet and its specimens.
  static let atlas = "wemessage.atlas"
  /// A page of the sheet is this prefix and its section slug.
  static let atlasPagePrefix = "wemessage.atlas."
  static let reactionPrefix = "wemessage.bubble.reaction."
  static let deliveryPrefix = "wemessage.bubble.delivery."
  static let draftSpecimenPrefix = "wemessage.bubble.draft."
  static let smsPrefix = "wemessage.bubble.sms."
  static let effectPrefix = "wemessage.bubble.effect."
  static let unsupportedPrefix = "wemessage.bubble.unsupported."
  // v2 S4f, boards 06 and 09.
  static let triageBar = "wemessage.triage.bar"
  static let bulkStrip = "wemessage.bulk.strip"
  static let bulkOpen = "wemessage.bulk.open"
  static let auditOpen = "wemessage.audit.open"
  static let bulkSheet = "wemessage.bulk.sheet"
  static let bulkConfirm = "wemessage.bulk.confirm"
  static let bulkCancel = "wemessage.bulk.cancel"
  static let bulkIncludedPrefix = "wemessage.bulk.included."
  static let bulkExcludedPrefix = "wemessage.bulk.excluded."
  static let undoRing = "wemessage.undo.ring"
  static let verbs = "wemessage.verbs"
  static let verbReply = "wemessage.verb.reply"
  static let verbDone = "wemessage.verb.done"
  static let verbSnooze = "wemessage.verb.snooze"
  static let verbMute = "wemessage.verb.mute"
  /// A draft's verbs outside Recent: the prefix, the id, then the verb.
  static let draftPrefix = "wemessage.draft."
  static let release = "wemessage.thread.release"
  static let killBanner = "wemessage.kill.banner"
  static let killDisengage = "wemessage.kill.disengage"
  static let zero = "wemessage.zero"
  static let zeroReceipt = "wemessage.zero.receipt"
  static let zeroVerify = "wemessage.zero.verify"
  static let connectCard = "wemessage.connect.card"
  static let audit = "wemessage.audit"
  static let auditClose = "wemessage.audit.close"
  static let auditRowPrefix = "wemessage.audit.row."
  // v2 S4h, board 10.
  static let trustBanner = "wemessage.trust.banner"
  static let trustAction = "wemessage.trust.action"
  static let freshness = "wemessage.freshness"
  /// A row of the age table: the prefix and the scope.
  static let freshnessRowPrefix = "wemessage.freshness.row."
  static let freshnessFooter = "wemessage.freshness.footer"
  static let revokedBanner = "wemessage.revoked.banner"
  static let revokedFix = "wemessage.revoked.fix"
  static let fda = "wemessage.fda"
  static let fdaOpen = "wemessage.fda.open"
  static let fdaSkip = "wemessage.fda.skip"
  static let states = "wemessage.states"
  static let statesTabPrefix = "wemessage.states.tab."
  static let statesPagePrefix = "wemessage.states.page."
  /// An empty: the prefix and its case; its action adds ".action".
  static let emptyPrefix = "wemessage.empty."
  static let pacing = "wemessage.pacing"
  static let collision = "wemessage.collision"

  static func draftVerb(_ draftId: String, _ verb: String) -> String { draftPrefix + draftId + "." + verb }

  /// Never placed: no typing indicator is drawn either way (08.J). Tests
  /// assert it is absent; the app never spells it.
  static let typing = "wemessage.typing"
  /// Never placed: no react affordance exists on any bubble (08.C).
  static let reactAffordancePrefix = "wemessage.bubble.react."

  static let railTiles = [railAll, railIMessage, railWhatsApp, railLinkedIn, railEmail]
}

@MainActor
enum UITestApp {
  /// Every wait in the bundle.
  nonisolated static let timeout: TimeInterval = 20

  /// The app under test, configured from the runner's environment. Every
  /// WEMESSAGE_* key the job exported with a TEST_RUNNER_ prefix arrives in
  /// ProcessInfo here and is copied to the app explicitly: nothing is
  /// forwarded wholesale.
  ///
  /// `reduceTransparency` forces the app's copy of the Reduce Transparency
  /// display option ("1" on, "0" off); nil leaves the system's value.
  ///
  /// `board` opens a board's specimen sheet (WEMESSAGE_UI_BOARD; "08" is
  /// the message atlas) in place of the shell.
  static func make(appearance: String, reduceTransparency: Bool? = nil, board: String? = nil) -> XCUIApplication {
    let env = ProcessInfo.processInfo.environment
    let app = XCUIApplication()
    app.launchArguments = ["-ApplePersistenceIgnoreState", "YES", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
    var launch: [String: String] = ["WEMESSAGE_UI_TEST": "1", "WEMESSAGE_UI_APPEARANCE": appearance]
    if let reduceTransparency { launch["WEMESSAGE_UI_REDUCE_TRANSPARENCY"] = reduceTransparency ? "1" : "0" }
    if let board { launch["WEMESSAGE_UI_BOARD"] = board }
    for key in ["WEMESSAGE_DIR", "WEMESSAGE_PORT", "TZ"] {
      if let value = env[key], !value.isEmpty { launch[key] = value }
    }
    app.launchEnvironment = launch
    return app
  }

  static func shellElement(_ app: XCUIApplication) -> XCUIElement {
    app.descendants(matching: .any)[ID.shell]
  }

  // No snapshot directory: the ad hoc-signed runner is sandboxed and cannot
  // write under the job's temp dir. PNGs leave only as .keepAlways attachments.

  /// Where the app's geometry string arrived, and the string. A SwiftUI
  /// container's value is dropped on macOS (measured, run 37553425686), so
  /// the app publishes on the shell's value and label and on the window's
  /// value; the first that carries it wins.
  static func geometryText(_ app: XCUIApplication) -> (channel: String, raw: String)? {
    let shell = shellElement(app)
    let atlas = app.descendants(matching: .any)[ID.atlas]
    var candidates: [(String, String?)] = []
    // Board 08's sheet stands in for the shell and publishes the same way.
    // A property read on an element that is not there fails the test, so
    // each root is read only when it exists.
    if atlas.exists {
      candidates += [("atlas.value", atlas.value as? String), ("atlas.label", atlas.label)]
    } else {
      candidates += [("shell.value", shell.value as? String), ("shell.label", shell.label)]
    }
    candidates.append(("window.value", app.windows.firstMatch.value as? String))
    for (channel, raw) in candidates {
      if let raw, raw.hasPrefix("frame=") { return (channel, raw) }
    }
    return nil
  }

  /// Parses "frame=WxH visible=WxH" from the shell root's accessibility
  /// value: the window size the APP computed and the visible frame the APP
  /// saw. Nil until the app has published it.
  static func shellGeometry(_ app: XCUIApplication) -> (frame: CGSize, visible: CGSize)? {
    guard let raw = geometryText(app)?.raw else { return nil }
    var sizes: [String: CGSize] = [:]
    for field in raw.split(separator: " ") {
      let pair = field.split(separator: "=", maxSplits: 1)
      guard pair.count == 2 else { continue }
      let dims = pair[1].split(separator: "x")
      guard dims.count == 2, let w = Double(dims[0]), let h = Double(dims[1]) else { continue }
      sizes[String(pair[0])] = CGSize(width: w, height: h)
    }
    guard let frame = sizes["frame"], let visible = sizes["visible"] else { return nil }
    return (frame, visible)
  }
}
