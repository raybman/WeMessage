import AppKit
import Foundation
import XCTest

/// v2 B0 and B1: board 03, WhatsApp, drawn over fixtures. The fake daemon's
/// "preview-whatsapp" scenario says the channel is in the fixture state and
/// lists six chats; "preview-whatsapp-empty" lists none. Only the UI-test
/// flag opens the gate that reads either (H-B-1). One launch per scenario
/// and appearance: cmd-3 selects the WhatsApp tile, each chat is a row click.
///
/// Empty (B0): the rail draws WhatsApp's mark as a connected channel's
/// (D-UI-140); the pane is board 03, its banner (D-UI-135) carrying the
/// fixture chip (D-UI-132), over the New here state; no not-connected zero.
///
/// Populated (B1): the pane asks for a pick (D-UI-141) and the rows carry
/// no channel tag (wireframe 03 legend 4). Ines: the linked device's line
/// with the day-17 warning, the end-to-end line, the history horizon
/// (D-UI-143), a voice note read as duration and transcript (D-UI-145) with
/// a reaction (D-UI-146), and the phone panel (D-UI-144). Tomas: expired, so
/// the re-link card and its QR placeholder replace the transcript (D-UI-142).
/// Amara: re-linking. The rowing club: INV-5, who may send, a counted
/// reaction. Kenji: media tiles that say why nothing happened and never
/// fetch (D-UI-149). Lucia: three not-shown cards (D-UI-147) and the phone
/// offline. No chat places a composer, and the journal holds no write.
///
/// Shots: board-03-preview (empty), board-03-populated, board-03-voice and
/// board-03-expired, per appearance, swept for green and held to the frost
/// evidence; the group, media, not-shown and re-linking states are glanced
/// (attached and swept; their strips and cards cover the stripe patch).
/// The light launches also run the accessibility audit. CI only.
final class Board03Tests: XCTestCase {
  override func setUp() async throws {
    try await FakeDaemon.reset()
  }

  static let ines = "whatsapp;-;+15550142001"
  static let tomas = "whatsapp;-;+15550142002"
  static let amara = "whatsapp;-;+15550142003"
  static let kenji = "whatsapp;-;+15550142005"
  static let lucia = "whatsapp;-;+15550142006"
  static let rowing = "whatsapp;+;chat5550142900"
  static let all = [ines, tomas, rowing, kenji, lucia, amara]

  // MARK: Empty (B0)

  @MainActor
  func testPreviewEmptyStateLight() async throws {
    try await previewEmptyState(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 03 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testPreviewEmptyStateDark() async throws {
    try await previewEmptyState(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 03 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func previewEmptyState(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-whatsapp-empty")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()

    // The rail: WhatsApp draws a mark as a connected channel would; the two
    // channels still not connected say nothing.
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.value(app, ID.railWhatsApp) == "clear" },
      "rail: WhatsApp reads '\(QueueUI.value(app, ID.railWhatsApp))'")
    for id in [ID.railLinkedIn, ID.railEmail] {
      XCTAssertEqual(QueueUI.value(app, id), "", "rail: \(id) is not connected and must say nothing")
    }

    app.typeKey("3", modifierFlags: .command)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.whatsAppBoard).exists }, "board 03 never appeared on cmd-3")
    XCTAssertEqual(QueueUI.label(app, ID.whatsAppBanner), ProvisionalUI.whatsAppBannerName, "banner")
    XCTAssertTrue(QueueUI.element(app, ID.fixtureChip).exists, "the fixture chip is missing")
    XCTAssertFalse(QueueUI.label(app, ID.fixtureChip).isEmpty, "the fixture chip says nothing")
    XCTAssertEqual(QueueUI.label(app, ID.whatsAppEmpty), ProvisionalUI.whatsAppEmptyHeadline, "empty state")
    XCTAssertFalse(QueueUI.element(app, ID.zero).exists, "the not-connected zero is drawn under board 03")
    XCTAssertFalse(QueueUI.element(app, ID.connectCard).exists, "a connect card is drawn under board 03")
    XCTAssertEqual(QueueUI.value(app, ID.railWhatsApp), "clear", "rail: WhatsApp lost its mark on select")

    QueueUI.settle()
    capture(
      app, geometry: geometry, appearance: appearance, frost: true, name: "board-03-preview-\(appearance).png",
      layout: .banner, luminance: luminance)
    QueueUI.printTime("BOARD03", appearance, "preview", since: started)
    if appearance == "light" { try audit(app, window: "audit-board-03-preview") }

    try await QueueUI.assertJournal("board 03 \(appearance)")
  }

  // MARK: Populated (B1)

  @MainActor
  func testPopulatedLight() async throws {
    try await populated(appearance: "light") { mean in
      XCTAssertGreaterThan(mean, 0.6, "a light board 03 renders dark: mean luminance \(mean)")
    }
  }

  @MainActor
  func testPopulatedDark() async throws {
    try await populated(appearance: "dark") { mean in
      XCTAssertLessThan(mean, 0.4, "a dark board 03 renders light: mean luminance \(mean)")
    }
  }

  @MainActor
  private func populated(appearance: String, luminance: (Double) -> Void) async throws {
    try await FakeDaemon.scenario("preview-whatsapp")
    let app = UITestApp.make(appearance: appearance, reduceTransparency: false)
    app.launch()
    defer { app.terminate() }
    XCTAssertTrue(UITestApp.shellElement(app).waitForExistence(timeout: UITestApp.timeout), "the shell never appeared")
    let geometry = settledGeometry(app)
    let started = Date()
    func shoot(_ state: String, _ layout: FrostProbe.Layout) {
      QueueUI.settle()
      capture(
        app, geometry: geometry, appearance: appearance, frost: true, name: "board-03-\(state)-\(appearance).png",
        layout: layout, luminance: luminance)
    }
    func peek(_ state: String) {
      QueueUI.settle()
      glance(app, name: "board-03-\(state)-\(appearance).png")
    }
    func label(_ id: String) -> String { QueueUI.label(app, id) }
    func exists(_ id: String) -> Bool { QueueUI.element(app, id).exists }
    func assertReadOnly(_ state: String) {
      for id in [ID.composer, ID.composerField, ID.composerSend, ID.threadBanner, ID.draft] {
        XCTAssertFalse(exists(id), "\(state): \(id) is placed on a WhatsApp chat")
      }
      XCTAssertTrue(exists(ID.whatsAppBanner), "\(state): the channel banner left the chat")
      XCTAssertTrue(exists(ID.fixtureChip), "\(state): the fixture chip left the chat")
    }

    // populated: six rows, none tagged, and the pane asks for a pick.
    app.typeKey("3", modifierFlags: .command)
    XCTAssertTrue(
      QueueUI.waitUntil { QueueUI.element(app, ID.whatsAppBoard).exists }, "board 03 never appeared on cmd-3")
    XCTAssertTrue(
      QueueUI.waitUntil { label(ID.whatsAppEmpty) == ProvisionalUI.whatsAppPickHeadline },
      "populated: the headline reads \(label(ID.whatsAppEmpty))")
    for guid in Self.all {
      let row = QueueUI.element(app, ID.rowPrefix + guid)
      XCTAssertTrue(row.waitForExistence(timeout: UITestApp.timeout), "populated: no row for \(guid)")
      let value = QueueUI.value(app, ID.rowPrefix + guid)
      XCTAssertTrue(value.hasSuffix(" untagged"), "populated: \(guid) drew a channel tag in a single scope: '\(value)'")
    }
    XCTAssertNotEqual(QueueUI.value(app, ID.railWhatsApp), "", "rail: WhatsApp lost its mark")
    shoot("populated", .banner)
    if appearance == "light" { try audit(app, window: "audit-board-03-populated") }

    // voice: Ines, linked 18 days, a voice note with its transcript.
    QueueUI.open(app, Self.ines)
    XCTAssertTrue(
      QueueUI.waitUntil { exists(ID.whatsAppVoicePrefix + "wa-0103") }, "voice: the voice note never drew")
    let voice = label(ID.whatsAppVoicePrefix + "wa-0103")
    XCTAssertTrue(voice.hasPrefix("0:15, "), "voice: the note reads '\(voice)'")
    XCTAssertTrue(voice.contains("Running a little late"), "voice: no transcript in '\(voice)'")
    XCTAssertFalse(voice.contains(ProvisionalUI.whatsAppVoicePlayed), "voice: a received note claims a played state")
    let linked = label(ID.whatsAppLinked)
    XCTAssertTrue(linked.hasPrefix("18 "), "voice: the linked line reads '\(linked)'")
    XCTAssertTrue(
      linked.contains(ProvisionalUI.whatsAppRelinkWarning(daysLeft: 2)), "voice: no day-17 warning in '\(linked)'")
    XCTAssertTrue(exists(ID.whatsAppEncrypted), "voice: no end-to-end line")
    XCTAssertTrue(label(ID.whatsAppHorizon).contains(ProvisionalUI.whatsAppHorizonDetail), "voice: horizon \(label(ID.whatsAppHorizon))")
    XCTAssertTrue(exists(ID.reactionPrefix + "wa-0103.0"), "voice: the note's reaction is missing")
    XCTAssertTrue(label(ID.reactionPrefix + "wa-0102.0").hasSuffix(", 1"), "voice: wa-0102's reaction \(label(ID.reactionPrefix + "wa-0102.0"))")
    let phone = label(ID.whatsAppPhone)
    XCTAssertTrue(phone.hasPrefix(ProvisionalUI.whatsAppPhoneTitle), "voice: the phone panel reads '\(phone)'")
    XCTAssertTrue(phone.contains(ProvisionalUI.whatsAppPhoneOnline), "voice: the phone is not online in '\(phone)'")
    XCTAssertFalse(exists(ID.whatsAppRelink), "voice: a linked chat draws the re-link card")
    assertReadOnly("voice")
    shoot("voice", .threadBanner)
    if appearance == "light" { try audit(app, window: "audit-board-03-voice") }

    // expired: Tomas. The re-link card and its placeholder replace the
    // transcript; no turn is drawn.
    QueueUI.open(app, Self.tomas)
    XCTAssertTrue(QueueUI.waitUntil { exists(ID.whatsAppRelink) }, "expired: no re-link card")
    XCTAssertTrue(exists(ID.whatsAppQR), "expired: no QR placeholder")
    XCTAssertEqual(label(ID.whatsAppQR), ProvisionalUI.whatsAppQRPlaceholder, "expired: the QR frame")
    XCTAssertEqual(label(ID.whatsAppLinked), ProvisionalUI.whatsAppExpiredLine, "expired: the linked line")
    for guid in ["wa-0201", "wa-0202"] {
      XCTAssertFalse(exists(ID.bubblePrefix + guid), "expired: \(guid) is drawn under an expired session")
    }
    XCTAssertFalse(exists(ID.whatsAppEncrypted), "expired: the transcript's end-to-end line is drawn")
    assertReadOnly("expired")
    shoot("expired", .threadBanner)

    // relinking: Amara. The same card, the re-linking line.
    QueueUI.open(app, Self.amara)
    XCTAssertTrue(
      QueueUI.waitUntil { label(ID.whatsAppLinked) == ProvisionalUI.whatsAppRelinkingLine },
      "relinking: the linked line reads '\(label(ID.whatsAppLinked))'")
    XCTAssertTrue(exists(ID.whatsAppRelink), "relinking: no re-link card")
    XCTAssertFalse(exists(ID.bubblePrefix + "wa-0301"), "relinking: a turn is drawn")
    peek("relinking")

    // group: the rowing club. INV-5, who may send, two thumbs counted once.
    QueueUI.open(app, Self.rowing)
    XCTAssertTrue(QueueUI.waitUntil { exists(ID.inv5) }, "group: no INV-5 strip")
    XCTAssertEqual(label(ID.whatsAppAdmins), ProvisionalUI.whatsAppAdminOnlyLine(admins: 2), "group: who may send")
    XCTAssertTrue(
      QueueUI.waitUntil { exists(ID.reactionPrefix + "wa-0402.0") }, "group: wa-0402's reaction never drew")
    XCTAssertTrue(label(ID.reactionPrefix + "wa-0402.0").hasSuffix(", 2"), "group: \(label(ID.reactionPrefix + "wa-0402.0"))")
    XCTAssertFalse(exists(ID.reactionPrefix + "wa-0402.1"), "group: one emoji drew two chips")
    assertReadOnly("group")
    peek("group")

    // media: Kenji. Two tiles; pressing one says why and fetches nothing.
    QueueUI.open(app, Self.kenji)
    let photo = QueueUI.element(app, ID.whatsAppMediaPrefix + "wa-0502")
    XCTAssertTrue(photo.waitForExistence(timeout: UITestApp.timeout), "media: no photo tile")
    XCTAssertTrue(label(ID.whatsAppMediaPrefix + "wa-0502").hasPrefix("Photo"), "media: \(label(ID.whatsAppMediaPrefix + "wa-0502"))")
    XCTAssertTrue(label(ID.whatsAppMediaPrefix + "wa-0503").hasPrefix("Video"), "media: \(label(ID.whatsAppMediaPrefix + "wa-0503"))")
    XCTAssertFalse(exists(ID.whatsAppFetchNote), "media: the note is up before a press")
    XCTAssertTrue(photo.isHittable, "media: the photo tile cannot be pressed")
    photo.click()
    XCTAssertTrue(QueueUI.waitUntil { exists(ID.whatsAppFetchNote) }, "media: no note after the press")
    XCTAssertEqual(label(ID.whatsAppFetchNote), ProvisionalUI.whatsAppMediaNote, "media: the note")
    assertReadOnly("media")
    peek("media")

    // notshown: Lucia. Disappearing, view-once and poll as cards; the phone
    // is offline.
    QueueUI.open(app, Self.lucia)
    let cards = [
      ("wa-0601", ProvisionalUI.whatsAppDisappearingTitle), ("wa-0602", ProvisionalUI.whatsAppViewOnceTitle),
      ("wa-0603", ProvisionalUI.whatsAppPollTitle),
    ]
    for (guid, title) in cards {
      XCTAssertTrue(
        QueueUI.waitUntil { exists(ID.whatsAppNotShownPrefix + guid) }, "notshown: no card for \(guid)")
      XCTAssertTrue(label(ID.whatsAppNotShownPrefix + guid).hasPrefix(title), "notshown: \(guid) reads \(label(ID.whatsAppNotShownPrefix + guid))")
    }
    XCTAssertFalse(exists(ID.whatsAppMediaPrefix + "wa-0602"), "notshown: a view-once photo is offered as media")
    XCTAssertTrue(label(ID.whatsAppPhone).contains(ProvisionalUI.whatsAppPhoneOffline), "notshown: \(label(ID.whatsAppPhone))")
    assertReadOnly("notshown")
    peek("notshown")

    QueueUI.printTime("BOARD03", appearance, "populated", since: started)
    try await QueueUI.assertJournal("board 03 populated \(appearance)")
    let fetched = try await FakeDaemon.journal().requests.filter {
      let path = $0.path.lowercased()
      return path.contains("attachment") || path.contains("media") || path.contains("download")
    }
    XCTAssertEqual(fetched, [], "board 03 \(appearance): media was fetched")
  }
}
