import Foundation
import Observation
import WeMessageKit

// v2 S4j, board 14: compose. Person-first (14.A): one field, To, and no
// channel until a person exists. The channel is derived and named in the
// banner (14.B rule, kit rule 7). The proposal region is written by
// opt-cmd-D and never touches the input; only Approve, a human act, moves
// its text down (14.E). Send waits out a 4 s undo window and then creates a
// pending draft through POST /v1/drafts: the approve that sends is the
// queue's, so compose has no send call site at all (D-UI-96, H-S4-10).
//
// v2 F5: choosing someone asks the daemon which conversation their handle
// would be written to (GET /v1/threads/by-handle/:handle, a read). Only an
// existing iMessage 1:1 gets a composer, and the draft goes on the guid the
// daemon named (macOS 26 mints any;-; guids); anything else is refused in
// words before a draft exists. Compose never starts a conversation (D-F5-1).

/// Someone compose can resolve to: a person with a name, or a bare handle
/// with none (14.A ruling 5: a handle is never given a guessed name).
struct ComposePerson: Equatable, Sendable, Identifiable {
  let id: String
  /// nil for a handle that is in no Contacts card.
  let name: String?
  let initials: String
  /// Evidence, not just a name: role, last exchange, where (14.A ruling 2).
  let evidence: String
  /// ISO day of the last exchange, nil when never messaged.
  let lastExchange: String?
  /// The iMessage handle, nil when there is none (14.B's "No handle").
  let imessage: String?
  let email: String?

  /// What a row and the To chip print: the name, or the number spelled out.
  var title: String { name ?? ComposeModel.printed(imessage ?? "") }
  var firstName: String { name?.components(separatedBy: " ").first ?? title }
}

/// The four channels, in the rail's order: the kit's `Channel` (v2 B0), with
/// the compose cards' words on it.
typealias ComposeChannel = Channel

extension Channel {
  var title: String {
    switch self {
    case .imessage: "iMessage"
    case .whatsapp: "WhatsApp"
    case .linkedin: "LinkedIn"
    case .email: "Email"
    }
  }

  var tag: String {
    switch self {
    case .imessage: "iM"
    case .whatsapp: "WA"
    case .linkedin: "LI"
    case .email: "EM"
    }
  }
}

/// One 14.B card: a report, not a choice. Only iMessage is live in S4.
struct ChannelCardState: Equatable, Sendable {
  enum Kind: String, Sendable {
    /// Live and chosen: the banner names it.
    case `default`
    /// Live, but this person has no handle on it.
    case noHandle = "no handle"
    /// The channel is not connected on this Mac in this version.
    case notConnected = "not connected"
    /// v2 F5: a handle, but nothing on this Mac compose can write to.
    case noConversation = "no conversation"
    /// v2 F5: the lookup is in flight.
    case checking
  }

  let channel: ComposeChannel
  let kind: Kind
  let headline: String
  let detail: String
}

/// One of the capability strip's twelve slots (14.C): the same twelve, in
/// one order, on every channel; a slot the channel lacks is struck, never
/// dropped.
struct CapabilitySlot: Equatable, Sendable {
  let id: String
  let title: String
  let can: Bool

  /// What VoiceOver says for the slot. The title, except where the title
  /// would repeat the role a static text already announces (D-UI-101).
  var spoken: String { ProvisionalUI.composeSpokenSlots[id] ?? title }
}

/// The six send states 14.F draws, and how each is bordered. Only Sent is
/// filled; before it everything is dashed, and a failure is dotted.
enum SendState: String, CaseIterable, Sendable {
  case composed, undo, queued, sending, sent, failed

  enum Border: Sendable { case none, dashed, filled, dotted }

  var border: Border {
    switch self {
    case .composed: .none
    case .undo, .queued, .sending: .dashed
    case .sent: .filled
    case .failed: .dotted
    }
  }

  var title: String {
    switch self {
    case .composed: "Composed"
    case .undo: "Undo window"
    case .queued: "Queued"
    case .sending: "Sending"
    case .sent: "Sent"
    case .failed: "Failed"
    }
  }

  /// The small print on the specimen's bubble (14.F), iMessage's words.
  var tag: String {
    switch self {
    case .composed: "In the box. No bubble exists yet."
    case .undo: "DRAFT IN 3s \u{00B7} Undo \u{2318}Z"
    case .queued: "QUEUED 9:41 \u{00B7} pacing cap \u{00B7} next attempt 9:43"
    case .sending: "SENDING on iMessage"
    case .sent: "Sent 9:41 \u{00B7} Delivered 9:41"
    case .failed: "FAILED on iMessage 9:42 \u{00B7} not delivered"
    }
  }

  /// What the specimen means, in a sentence.
  var caption: String {
    switch self {
    case .composed: "Nothing sent. The words are yours and only yours."
    case .undo: "Nothing has left this Mac. Dashed, because it is not sent."
    case .queued: "Queued is dated and names its next attempt. A spinner with no time is a stall."
    case .sending: "Still dashed. Undo is gone: this one is out of our hands."
    case .sent: "The only filled state: the transport has accepted it."
    case .failed: "Dotted is for failed, dashed for unsent. Two facts, two borders."
    }
  }
}

@MainActor
@Observable
final class ComposeModel {
  enum Page: String, CaseIterable, Sendable {
    case new, states

    var title: String { self == .new ? "New message" : "Send states" }
  }

  /// The proposal region (14.E). It holds text; the input never does until
  /// Approve.
  enum Proposal: Equatable, Sendable {
    case empty
    case ready(String)
    case moved(String)

    var value: String {
      switch self {
      case .empty: "empty"
      case .ready: "proposal"
      case .moved: "moved"
      }
    }
  }

  /// Where the live message is after Send.
  enum Phase: Equatable, Sendable {
    case composing
    /// The 4 s window: nothing has left this Mac.
    case undo(secondsLeft: Int)
    /// POST /v1/drafts in flight.
    case drafting
    /// The pending draft's id: it waits in Needs You for an approve.
    case drafted(String)
    case failed(String)

    var value: String {
      switch self {
      case .composing: "composing"
      case .undo: "undo"
      case .drafting: "drafting"
      case .drafted: "drafted"
      case .failed: "failed"
      }
    }
  }

  /// v2 F5: what this Mac's Messages holds for the chosen handle. Only
  /// `.existing` (an iMessage 1:1) can be written to.
  enum Resolution: Equatable, Sendable {
    /// No handle chosen, so nothing to look up.
    case idle
    case checking
    case existing(chatGuid: String)
    /// The handle's only 1:1 is not iMessage (SMS, RCS, or a service this
    /// Mac never recorded, which the send gate treats as SMS too).
    case smsOnly
    case none
    case groupOnly
    /// The lookup failed: chat.db unreadable or the daemon unreachable.
    case unavailable
  }

  static let undoSeconds = ProvisionalUI.composeUndoSeconds

  let people: [ComposePerson]
  var page: Page = .new
  var query = ""
  private(set) var person: ComposePerson?
  /// The input. Only the human writes it: typing, or Approve on a proposal.
  var body = ""
  private(set) var proposal: Proposal = .empty
  private(set) var phase: Phase = .composing
  /// The text Send took, which the live bubble draws after the input clears.
  private(set) var sending = ""
  private(set) var resolution: Resolution = .idle

  @ObservationIgnored private let client: GatewayClient
  @ObservationIgnored private let propose: @Sendable (ComposePerson) -> String
  @ObservationIgnored private let tick: @Sendable () async throws -> Void
  @ObservationIgnored private var pending: Task<Void, Never>?
  @ObservationIgnored private var lookup: Task<Void, Never>?
  /// Bumped by every choose and clear: a lookup answers only the choice
  /// that started it.
  @ObservationIgnored private var lookups = 0

  /// `people` and `propose` come from the hooks (fixtures only in this
  /// version: D-UI-98, D-UI-100). `tick` waits one second of the undo
  /// window; tests pass an instant one.
  init(
    client: GatewayClient, people: [ComposePerson], propose: @escaping @Sendable (ComposePerson) -> String,
    tick: @escaping @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 1_000_000_000) }
  ) {
    self.client = client
    self.people = people
    self.propose = propose
    self.tick = tick
  }

  // MARK: 14.A, resolution

  /// The rows for the query: a name containing it, or (three digits or
  /// more) a handle containing its digits. Ordered by last exchange, the
  /// most recent first, never alphabetically; never messaged sorts last.
  var matches: [ComposePerson] {
    let q = query.trimmingCharacters(in: .whitespaces).lowercased()
    guard !q.isEmpty, person == nil else { return [] }
    let digits = q.filter(\.isNumber)
    let hits = people.filter { p in
      if let name = p.name, name.lowercased().contains(q) { return true }
      guard digits.count >= 3 else { return false }
      return [p.imessage].compactMap { $0 }.contains { $0.contains(digits) }
    }
    return hits.enumerated().sorted { a, b in
      switch (a.element.lastExchange, b.element.lastExchange) {
      case let (x?, y?) where x != y: return x > y
      case (.some, nil): return true
      case (nil, .some): return false
      default: return a.offset < b.offset
      }
    }.map(\.element)
  }

  /// v2 F5 (D-F5-3): a query that is a whole handle, + and 8 to 15 digits
  /// or an address, and matches no person, gets one row. Never a name.
  var typed: ComposePerson? {
    guard person == nil, matches.isEmpty, let handle = Self.typedHandle(query) else { return nil }
    return ComposePerson(
      id: "typed:" + handle, name: nil, initials: ProvisionalUI.composeTypedInitials,
      evidence: ProvisionalUI.composeTypedEvidence, lastExchange: nil, imessage: handle, email: nil)
  }

  /// v2 F5 (D-F5-4): ten bare digits match nothing and get the hint, not a
  /// guessed country code.
  var hint: String? {
    let q = query.trimmingCharacters(in: .whitespaces)
    guard person == nil, matches.isEmpty, q.count == 10, q.allSatisfy(\.isNumber) else { return nil }
    return ProvisionalUI.composeCountryCodeHint
  }

  /// "+15550100099" (separators dropped) or "sam@example.com" (lowercased),
  /// or nil. A plus is required: the country code is never guessed.
  nonisolated static func typedHandle(_ query: String) -> String? {
    let q = query.trimmingCharacters(in: .whitespaces)
    if q.hasPrefix("+") {
      let rest = q.dropFirst()
      guard rest.allSatisfy({ $0.isASCII && ($0.isNumber || " -().".contains($0)) }) else { return nil }
      let digits = rest.filter(\.isNumber)
      return (8...15).contains(digits.count) ? "+" + digits : nil
    }
    let parts = q.split(separator: "@", omittingEmptySubsequences: false)
    guard parts.count == 2, !parts[0].isEmpty, parts[1].contains("."), !parts[1].hasPrefix("."),
      !parts[1].hasSuffix("."), !q.contains(where: { $0.isWhitespace || $0 == ";" })
    else { return nil }
    return q.lowercased()
  }

  /// Chooses someone and, when they have a handle, asks the daemon which
  /// conversation it would be written to. Choosing again asks again.
  func choose(_ chosen: ComposePerson) {
    person = chosen
    query = ""
    lookup?.cancel()
    lookups += 1
    guard let handle = chosen.imessage else {
      resolution = .idle
      lookup = nil
      return
    }
    resolution = .checking
    let mine = lookups
    lookup = Task { [weak self] in
      guard let self else { return }
      let found: Resolution
      do {
        switch try await self.client.resolveHandle(handle) {
        case .ok(let answer): found = Self.resolution(of: answer.conversation)
        case .refused: found = .unavailable
        }
      } catch {
        found = .unavailable
      }
      // A stale answer, for a choice since replaced, is dropped.
      guard mine == self.lookups else { return }
      self.resolution = found
    }
  }

  /// Waits for the lookup the last choose started (tests).
  func lookedUp() async {
    await lookup?.value
  }

  /// The daemon's answer as compose reads it: only an iMessage 1:1 is
  /// somewhere to write.
  nonisolated static func resolution(of conversation: ResolvedConversation?) -> Resolution {
    guard let conversation else { return .none }
    if conversation.isGroup { return .groupOnly }
    return conversation.service == "imessage" ? .existing(chatGuid: conversation.chatGuid) : .smsOnly
  }

  /// Clears the To chip: back to one field, and nothing written survives.
  func clearPerson() {
    pending?.cancel()
    pending = nil
    lookup?.cancel()
    lookup = nil
    lookups += 1
    resolution = .idle
    person = nil
    body = ""
    proposal = .empty
    phase = .composing
  }

  // MARK: 14.B, channels

  /// No person, no cards: not even a disabled one (14.A ruling 1).
  var channels: [ChannelCardState] {
    guard let person else { return [] }
    return ComposeChannel.allCases.map { channel in
      switch channel {
      case .imessage:
        if let handle = person.imessage {
          if resolution == .checking || resolution == .idle {
            return ChannelCardState(channel: channel, kind: .checking, headline: ProvisionalUI.composeChecking, detail: "")
          }
          if let why = refusalParts {
            return ChannelCardState(channel: channel, kind: .noConversation, headline: why.headline, detail: why.detail)
          }
          return ChannelCardState(
            channel: channel, kind: .default,
            headline: "Free. " + Self.printed(handle) + " \u{00B7} on this Mac",
            detail: "Default because " + defaultReason(person) + ". Words and emoji only in this version.")
        }
        return ChannelCardState(
          channel: channel, kind: .noHandle,
          headline: "No handle.",
          detail: "No phone number and no Apple address for \(person.firstName). Not \u{201C}not on iMessage\u{201D}, which we have not checked.")
      case .whatsapp, .linkedin, .email:
        return ChannelCardState(
          channel: channel, kind: .notConnected,
          headline: "Not connected on this Mac.",
          detail: "\(channel.title) is not in this version, so nothing here can reach \(person.firstName) on it.")
      }
    }
  }

  /// The derived channel, or nil (14.B rule 4: better to ask than to pick
  /// badly). Never a channel that costs, never one not connected.
  var defaultChannel: ComposeChannel? {
    chatGuid == nil ? nil : .imessage
  }

  private func defaultReason(_ person: ComposePerson) -> String {
    person.lastExchange == nil ? "it is the one connected channel with a handle" : "you last exchanged here"
  }

  /// The chat a draft is created on: the iMessage 1:1 the daemon named for
  /// the handle, and nothing compose made up (v2 F5).
  var chatGuid: String? {
    guard person?.imessage != nil, case .existing(let guid) = resolution else { return nil }
    return guid
  }

  /// v2 F5 (D-F5-2): why there is no composer for a handle, in the card's
  /// two parts, or nil while checking or when there is somewhere to write.
  private var refusalParts: (headline: String, detail: String)? {
    guard let handle = person?.imessage.map(Self.printed) else { return nil }
    switch resolution {
    case .none: return ProvisionalUI.composeNoConversation(handle)
    case .smsOnly: return ProvisionalUI.composeSMSOnly
    case .groupOnly: return ProvisionalUI.composeGroupOnly(handle)
    case .unavailable: return (ProvisionalUI.composeCheckFailed, "")
    case .idle, .checking, .existing: return nil
    }
  }

  /// The one static line that replaces the composer.
  var refusal: String? {
    refusalParts.map { $0.detail.isEmpty ? $0.headline : $0.headline + " " + $0.detail }
  }

  /// Kit rule 7: the channel and the handle are named from the first
  /// keystroke, and so is where Send puts the message.
  var banner: String? {
    guard let channel = defaultChannel, let handle = person?.imessage else { return nil }
    return "Sending on " + channel.title + " to " + Self.printed(handle) + " \u{00B7} free"
  }

  /// The banner's second line: where Send actually puts the message in this
  /// version (D-UI-96).
  static let bannerTail = "Send puts it in Needs You as a draft. Nothing leaves this Mac until you approve it there."

  /// 14.C for iMessage in this version: text and emoji, and nothing else
  /// the strip names. Hold until is D-UI-17's absent-with-reason.
  static let capabilities: [CapabilitySlot] = [
    ("attach", "Attach", false), ("emoji", "Emoji", true), ("richtext", "Rich text", false),
    ("quote", "Quote-reply", false), ("voice", "Voice note", false), ("reaction", "Send reaction", false),
    ("edit", "Edit after send", false), ("unsend", "Unsend", false), ("envelope", "Envelope", false),
    ("typing", "Typing shown", false), ("later", "Send later", false), ("hold", "Hold until", false),
  ].map { CapabilitySlot(id: $0.0, title: $0.1, can: $0.2) }

  // MARK: 14.E, the proposal region

  /// opt-cmd-D: fills the region. Never the input.
  func askForDraft() {
    guard let person, case .existing = resolution, case .empty = proposal else { return }
    proposal = .ready(propose(person))
  }

  /// Approve on the proposal: the handoff, the one way its text reaches the
  /// input, and a human press.
  func takeProposal() {
    guard case .ready(let text) = proposal else { return }
    body = text
    proposal = .moved(text)
  }

  /// Hold on the proposal: it goes, and the input is untouched.
  func dropProposal() {
    guard case .ready = proposal else { return }
    proposal = .empty
  }

  // MARK: 14.F, Send

  /// The undo window or the create in flight: the input is held.
  var busy: Bool {
    switch phase {
    case .undo, .drafting: true
    default: false
    }
  }

  var canSend: Bool {
    guard case .existing = resolution else { return false }
    return chatGuid != nil && !busy && !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The live bubble's small print for the phase.
  var phaseLine: String {
    switch phase {
    case .composing: ""
    case .undo(let left): "DRAFT IN \(left)s \u{00B7} nothing has left this Mac"
    case .drafting: "CREATING THE DRAFT"
    case .drafted: "IN NEEDS YOU \u{00B7} waiting for your approve, not sent"
    case .failed(let words): words
    }
  }

  /// Opens the undo window; when it runs out, the draft is created. The
  /// window is written before the task that can reach the client.
  func send() {
    guard canSend, let guid = chatGuid else { return }
    let text = body
    sending = text
    phase = .undo(secondsLeft: Self.undoSeconds)
    pending = Task { [weak self] in
      guard let self else { return }
      for left in stride(from: Self.undoSeconds - 1, through: 0, by: -1) {
        do { try await self.tick() } catch { return }
        guard !Task.isCancelled, case .undo = self.phase else { return }
        if left > 0 { self.phase = .undo(secondsLeft: left) }
      }
      await self.createDraft(chatGuid: guid, body: text)
    }
  }

  /// Undo within the window: nothing was created, and the text is back.
  func undo() {
    guard case .undo = phase else { return }
    pending?.cancel()
    pending = nil
    phase = .composing
  }

  /// Waits for the window and the create to finish, or for an undo.
  func settle() async {
    await pending?.value
  }

  private func createDraft(chatGuid: String, body text: String) async {
    guard !Task.isCancelled, case .undo = phase else { return }
    phase = .drafting
    do {
      let created = try await client.createDraft(DraftCreateInput(chatGuid: chatGuid, body: text))
      phase = .drafted(created.draft.id)
      body = ""
    } catch {
      phase = .failed(Self.failure)
    }
  }

  static let failure = "The daemon did not take the draft. Nothing was sent, and the text is still here."

  // MARK: printing

  /// "+15550100001" as "+1 555 010 0001"; anything else as given.
  nonisolated static func printed(_ handle: String) -> String {
    let digits = handle.filter(\.isNumber)
    guard handle.hasPrefix("+1"), digits.count == 11 else { return handle }
    let d = Array(digits)
    return "+1 " + String(d[1...3]) + " " + String(d[4...6]) + " " + String(d[7...10])
  }
}
