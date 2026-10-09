import Foundation
import WeMessageKit

// v2 B1, board 03: a WhatsApp thread's per-board detail, typed. The fake
// daemon's preview-* scenarios carry it in `meta` on a thread and on a turn;
// the real daemon never sends it. Pure: every value below is read from the
// JSON with a safe default, so a missing key, a wrong type or a value this
// build has not learned draws the most cautious state and never crashes.

/// The linked device's session (03.B). Unknown when the meta does not say.
enum WhatsAppLinkedDevice: String, Equatable, Sendable, CaseIterable {
  case linked, expired, relinking, unknown

  init(wire: String?) { self = wire.flatMap { Self(rawValue: $0) }.flatMap { $0 == .unknown ? nil : $0 } ?? .unknown }
}

/// The primary phone, as the bridge last saw it (03.C).
enum WhatsAppPhone: String, Equatable, Sendable, CaseIterable {
  case online, offline, unknown

  init(wire: String?) { self = wire.flatMap { Self(rawValue: $0) }.flatMap { $0 == .unknown ? nil : $0 } ?? .unknown }
}

/// Whether a media turn's bytes are on this Mac. A value this build does
/// not know reads as on demand: it promises less.
enum WhatsAppMediaState: String, Equatable, Sendable {
  case available, onDemand

  init(wire: String?) { self = wire.flatMap { Self(rawValue: $0) } ?? .onDemand }
}

enum WhatsAppMediaKind: String, Equatable, Sendable {
  case photo, video

  init(wire: String?) { self = wire.flatMap { Self(rawValue: $0) } ?? .photo }
}

/// The message kinds this board names and does not draw (03.F).
enum WhatsAppNotShown: String, Equatable, Sendable, CaseIterable {
  case disappearing, viewOnce, poll

  var title: String {
    switch self {
    case .disappearing: ProvisionalUI.whatsAppDisappearingTitle
    case .viewOnce: ProvisionalUI.whatsAppViewOnceTitle
    case .poll: ProvisionalUI.whatsAppPollTitle
    }
  }

  var detail: String {
    switch self {
    case .disappearing: ProvisionalUI.whatsAppDisappearingDetail
    case .viewOnce: ProvisionalUI.whatsAppViewOnceDetail
    case .poll: ProvisionalUI.whatsAppPollDetail
    }
  }
}

/// A thread's meta: `{linkedDevice, historyHorizon, phonePanel}` from the
/// slice, and the fixture's extensions `linkedAt`, `members`, `admins` and
/// `adminOnly` for the head and the group strip.
struct WhatsAppThreadMeta: Equatable, Sendable {
  var linkedDevice: WhatsAppLinkedDevice = .unknown
  var historyHorizon: Date?
  var phonePanel: WhatsAppPhone = .unknown
  var linkedAt: Date?
  var members: Int?
  var admins: Int?
  var adminOnly = false

  static func parse(_ meta: [String: JSONValue]?) -> WhatsAppThreadMeta {
    guard let meta else { return WhatsAppThreadMeta() }
    return WhatsAppThreadMeta(
      linkedDevice: WhatsAppLinkedDevice(wire: meta["linkedDevice"]?.stringValue),
      historyHorizon: meta["historyHorizon"]?.stringValue.flatMap(WireDate.parse),
      phonePanel: WhatsAppPhone(wire: meta["phonePanel"]?.stringValue),
      linkedAt: meta["linkedAt"]?.stringValue.flatMap(WireDate.parse),
      members: meta["members"]?.intValue.flatMap { $0 > 0 ? $0 : nil },
      admins: meta["admins"]?.intValue.flatMap { $0 > 0 ? $0 : nil },
      adminOnly: meta["adminOnly"]?.boolValue ?? false)
  }
}

/// One emoji under a bubble, with everyone who left it (D-UI-146).
struct WhatsAppReaction: Equatable, Sendable {
  let emoji: String
  let from: [String]
  var count: Int { from.count }
}

struct WhatsAppVoiceNote: Equatable, Sendable {
  /// Whole seconds, rounded; nil when the duration is missing or negative.
  let seconds: Int?
  /// Nil when there is none yet (an empty string is none).
  let transcript: String?
}

/// A turn's meta: `{reactions, voiceNote, mediaState}` from the slice, and
/// the fixture's extensions `mediaKind`, `mediaBytes` and `notShown`.
struct WhatsAppTurnMeta: Equatable, Sendable {
  var reactions: [WhatsAppReaction] = []
  var voiceNote: WhatsAppVoiceNote?
  var mediaState: WhatsAppMediaState = .onDemand
  var mediaKind: WhatsAppMediaKind = .photo
  var mediaBytes: Int?
  var notShown: WhatsAppNotShown?

  static func parse(_ meta: [String: JSONValue]?) -> WhatsAppTurnMeta {
    guard let meta else { return WhatsAppTurnMeta() }
    var voice: WhatsAppVoiceNote?
    if let note = meta["voiceNote"]?.objectValue {
      let ms = note["durationMs"]?.doubleValue.flatMap { $0.isFinite && $0 >= 0 ? $0 : nil }
      let words = note["transcript"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 }
      voice = WhatsAppVoiceNote(seconds: ms.map { Int(($0 / 1000).rounded()) }, transcript: words)
    }
    return WhatsAppTurnMeta(
      reactions: reactions(meta["reactions"]?.arrayValue ?? []),
      voiceNote: voice,
      mediaState: WhatsAppMediaState(wire: meta["mediaState"]?.stringValue),
      mediaKind: WhatsAppMediaKind(wire: meta["mediaKind"]?.stringValue),
      mediaBytes: meta["mediaBytes"]?.intValue.flatMap { $0 >= 0 ? $0 : nil },
      notShown: meta["notShown"]?.stringValue.flatMap(WhatsAppNotShown.init(rawValue:)))
  }

  /// One reaction per person, the later replacing the earlier (WhatsApp's
  /// own rule), grouped by emoji in the order each emoji is first seen. An
  /// entry without an emoji is dropped; one without a sender counts alone.
  static func reactions(_ entries: [JSONValue]) -> [WhatsAppReaction] {
    var byPerson: [(person: String, emoji: String)] = []
    for (index, entry) in entries.enumerated() {
      guard let emoji = entry["emoji"]?.stringValue, !emoji.isEmpty else { continue }
      let person = entry["from"]?.stringValue.flatMap { $0.isEmpty ? nil : $0 } ?? "#\(index)"
      byPerson.removeAll { $0.person == person }
      byPerson.append((person, emoji))
    }
    var order: [String] = []
    var people: [String: [String]] = [:]
    for (person, emoji) in byPerson {
      if people[emoji] == nil { order.append(emoji) }
      people[emoji, default: []].append(person)
    }
    return order.map { WhatsAppReaction(emoji: $0, from: people[$0] ?? []) }
  }
}

/// One turn as board 03 draws it.
struct WhatsAppTurn: Equatable, Sendable, Identifiable {
  enum Display: Equatable, Sendable {
    /// A bubble, as board 02 draws it (text, or a voice note's body).
    case bubble
    /// Media whose bytes the phone has not sent: a dashed tile, never
    /// fetched (D-UI-149).
    case onDemand(WhatsAppMediaKind, bytes: Int?)
    /// A kind this board names and does not draw (D-UI-147).
    case notShown(WhatsAppNotShown)
  }

  let turn: MessageTurn
  let meta: WhatsAppTurnMeta
  var id: String { turn.guid }

  var display: Display {
    if let hidden = meta.notShown { return .notShown(hidden) }
    if case .attachments = turn.kind, meta.mediaState == .onDemand {
      return .onDemand(meta.mediaKind, bytes: meta.mediaBytes)
    }
    return .bubble
  }

  /// The daemon's turn with its meta, or nil when board 02 would skip it.
  /// A voice note's transcript and duration ride in the meta.
  init?(turn wire: ThreadTurn) {
    guard let base = MessageTurn(turn: wire) else { return nil }
    let meta = WhatsAppTurnMeta.parse(wire.meta)
    self.meta = meta
    if case .voice = base.kind, let note = meta.voiceNote {
      turn = MessageTurn(
        guid: base.guid, direction: base.direction, kind: .voice(transcript: note.transcript, seconds: note.seconds),
        text: base.text, sentAt: base.sentAt, handle: base.handle, isEdited: base.isEdited,
        isUnsent: base.isUnsent, attachments: base.attachments)
    } else {
      turn = base
    }
  }

  /// Every turn of `page` this build can draw, oldest first, ties in the
  /// page's order.
  static func turns(_ page: ThreadMessagesPage) -> [WhatsAppTurn] {
    page.turns.compactMap(WhatsAppTurn.init(turn:)).enumerated()
      .sorted { $0.element.turn.sentAt == $1.element.turn.sentAt ? $0.offset < $1.offset : $0.element.turn.sentAt < $1.element.turn.sentAt }
      .map(\.element)
  }
}

/// What sits under the thread head for the linked device (03.B).
enum WhatsAppDevicePanel: Equatable, Sendable {
  /// Linked: how long, when known, and the days left once the warning is due.
  case linked(days: Int?, warnDaysLeft: Int?)
  /// Expired or re-linking: the re-link card replaces the transcript.
  case relink(WhatsAppLinkedDevice)
  /// The meta does not say: nothing is drawn.
  case unknown

  static func make(_ meta: WhatsAppThreadMeta, asOf: Date) -> WhatsAppDevicePanel {
    switch meta.linkedDevice {
    case .linked:
      guard let at = meta.linkedAt, at <= asOf else { return .linked(days: nil, warnDaysLeft: nil) }
      let days = Int(asOf.timeIntervalSince(at) / 86_400)
      let warn = days >= ProvisionalUI.whatsAppRelinkWarnDay ? max(0, ProvisionalUI.whatsAppSessionDays - days) : nil
      return .linked(days: days, warnDaysLeft: warn)
    case .expired, .relinking:
      return .relink(meta.linkedDevice)
    case .unknown:
      return .unknown
    }
  }

  var replacesTranscript: Bool {
    if case .relink = self { return true }
    return false
  }
}

/// The transcript's rows: the end-to-end line first, the history horizon
/// above the first turn at or after it (D-UI-143), then board 02's day
/// separators and bubbles.
enum WhatsAppRow: Equatable, Identifiable {
  case encrypted
  case horizon(String)
  case day(id: String, label: String)
  case turn(TranscriptLayout.Bubble, WhatsAppTurn)

  var id: String {
    switch self {
    case .encrypted: "encrypted"
    case .horizon: "horizon"
    case .day(let id, _): "day." + id
    case .turn(let bubble, _): "bubble." + bubble.turn.guid
    }
  }
}

enum WhatsAppThreadLayout {
  /// The index of the first turn at or after `horizon`: 0 when every turn
  /// is, `turns.count` when none is, nil without a horizon.
  static func horizonIndex(_ turns: [WhatsAppTurn], horizon: Date?) -> Int? {
    guard let horizon else { return nil }
    return turns.firstIndex { $0.turn.sentAt >= horizon } ?? turns.count
  }

  static func horizonLabel(_ horizon: Date, calendar: Calendar) -> String {
    let formatter = DateFormatter()
    formatter.calendar = calendar
    formatter.timeZone = calendar.timeZone
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.dateFormat = ProvisionalUI.whatsAppHorizonDayFormat
    return ProvisionalUI.whatsAppHorizonLine(day: formatter.string(from: horizon))
  }

  static func rows(
    _ turns: [WhatsAppTurn], horizon: Date?, asOf: Date, calendar: Calendar, isGroup: Bool,
    senderName: (String) -> String? = { _ in nil }
  ) -> [WhatsAppRow] {
    let byGuid = Dictionary(turns.map { ($0.turn.guid, $0) }, uniquingKeysWith: { first, _ in first })
    var rows: [WhatsAppRow] = TranscriptLayout.rows(
      turns.map(\.turn), asOf: asOf, calendar: calendar, isGroup: isGroup, senderName: senderName
    ).compactMap { row in
      switch row {
      case .day(let id, let label): return .day(id: id, label: label)
      case .bubble(let bubble): return byGuid[bubble.turn.guid].map { .turn(bubble, $0) }
      }
    }
    if let horizon, let index = horizonIndex(turns, horizon: horizon) {
      var at = rows.count
      if index < turns.count, let row = rows.firstIndex(where: { $0.id == "bubble." + turns[index].turn.guid }) {
        at = row
        if row > 0, case .day = rows[row - 1] { at = row - 1 }
      }
      rows.insert(.horizon(horizonLabel(horizon, calendar: calendar)), at: at)
    }
    rows.insert(.encrypted, at: 0)
    return rows
  }

  /// A group member's name: the contact's when known, else the number with
  /// a note that there is no name yet (03.G).
  static func memberName(_ handle: String, resolved: String?) -> String {
    resolved ?? handle + " \u{00B7} " + ProvisionalUI.whatsAppNoName
  }

  /// The thread head's line (D-UI-148).
  static func subline(isGroup: Bool, meta: WhatsAppThreadMeta, handle: String?, clock: String?) -> String {
    if isGroup {
      guard let members = meta.members else { return ShellModel.Scope.whatsapp.fullLabel }
      return ProvisionalUI.whatsAppGroupLine(members: members, adminOnly: meta.adminOnly)
    }
    var parts = [ShellModel.Scope.whatsapp.fullLabel]
    if let handle, !handle.isEmpty { parts.append(handle) }
    if let clock { parts.append(ProvisionalUI.whatsAppOpenedHere + " " + clock) }
    parts.append(ProvisionalUI.whatsAppNoReceipt)
    return parts.joined(separator: " \u{00B7} ")
  }

  /// The per-row channel tag is drawn in the All scope only (03.A legend 4,
  /// Rule 7): inside one channel's scope the container says the channel,
  /// and the rail, the head and the banner carry it.
  static func showsChannelTag(_ scope: ShellModel.Scope) -> Bool { scope == .all }
}

/// Board 03's own colours, swept by the NoGreen test with the tokens.
enum WhatsAppLook {
  /// A reaction chip's fill: the tint at .12 (D-UI-146).
  static let reactionFill = Tokens.Wash(rgb: Tokens.tint, alpha: ProvisionalUI.whatsAppReactionAlpha)

  static var all: [Tokens.RGB] { [reactionFill.rgb] }
}
