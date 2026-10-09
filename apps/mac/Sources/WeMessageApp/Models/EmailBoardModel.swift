import Foundation
import Observation
import WeMessageKit

// v2 B2, board 05: Email over fixtures. The board's words are pure (the same
// availability always gives the same board); the desk holds what this
// window alone knows about the board: the category chip, which messages
// had their images revealed, how far a long thread is unfolded, and the
// inline compose. Nothing here sends: compose ends in a draft (D-UI-156).

/// Board 05's banner and empty state, as board 03's (v2 B0).
struct EmailBoardModel: Equatable, Sendable {
  /// The channel banner's line (D-UI-150).
  let banner: String
  /// The empty state's headline and its one line (D-UI-152).
  let headline: String
  let detail: String
  /// The chip at the banner's trailing edge (D-UI-132). Only a board drawn
  /// over fixtures carries one; a connected board never does.
  let chip: String?

  /// The board for a channel's availability, or nil when there is none to
  /// draw: a channel not connected keeps the not-connected zero.
  static func make(_ availability: ChannelAvailability?, account: String? = nil, chipText: String) -> EmailBoardModel? {
    let chip: String?
    switch availability {
    case .connected: chip = nil
    case .preview: chip = chipText
    case .notConnected, nil: return nil
    }
    return EmailBoardModel(
      banner: ProvisionalUI.emailBanner(account: account), headline: ProvisionalUI.emailEmptyHeadline,
      detail: ProvisionalUI.emailEmptyDetail, chip: chip)
  }
}

/// One message drawn as a card (05.A, D-UI-136), never a bubble.
struct EmailCard: Equatable, Sendable, Identifiable {
  /// The turn's guid.
  let id: String
  let mine: Bool
  /// Who it is from: the envelope's sender, else the turn's handle.
  let from: String
  let fromPrinted: String
  /// "To: a, b" and "Cc: c", nil when empty.
  let toLine: String?
  let ccLine: String?
  let at: Date?
  let body: String
  let meta: EmailTurnMeta

  init(_ turn: ThreadTurn) {
    let meta = EmailTurnMeta(turn)
    id = turn.guid
    mine = turn.from == "me"
    let sender = meta.envelope.from
    from = sender?.shown ?? turn.handle ?? turn.from
    fromPrinted = sender?.printed ?? from
    toLine = Self.line(ProvisionalUI.emailFieldTo, meta.envelope.to)
    ccLine = Self.line(ProvisionalUI.emailFieldCc, meta.envelope.cc)
    at = WireDate.parse(turn.at)
    body = turn.text ?? ""
    self.meta = meta
  }

  private static func line(_ label: String, _ list: [EmailParticipant]) -> String? {
    guard !list.isEmpty else { return nil }
    return label + ": " + list.map(\.shown).joined(separator: ", ")
  }

  /// The page's messages as cards, oldest first.
  static func cards(_ page: ThreadMessagesPage) -> [EmailCard] {
    page.turns.sorted { $0.at < $1.at }.map(EmailCard.init)
  }

  /// D-UI-153: the cards drawn open and how many fold above them. A thread
  /// of up to the expanded count, or one unfolded, folds nothing.
  static func fold(_ cards: [EmailCard], expanded: Bool) -> (folded: Int, shown: [EmailCard]) {
    let keep = ProvisionalUI.emailExpandedCount
    guard !expanded, cards.count > keep else { return (0, cards) }
    return (cards.count - keep, Array(cards.suffix(keep)))
  }
}

/// What this window knows about board 05 beyond the daemon's pages.
@MainActor
@Observable
final class EmailDesk {
  /// The category chip on (05.G, D-UI-151); nil shows every category.
  private(set) var category: EmailCategory?
  /// Threads whose earlier messages are unfolded, by chatGuid.
  private(set) var expanded: Set<String> = []
  /// Messages whose remote images were revealed, by turn guid. Per message
  /// and for this window only (D-UI-159): nothing is persisted.
  private(set) var revealed: Set<String> = []
  /// The inline compose, while one is open (D-UI-156).
  private(set) var compose: EmailComposeModel?

  @ObservationIgnored private let client: GatewayClient
  @ObservationIgnored private let tick: @Sendable () async throws -> Void

  /// `tick` waits one second of a compose's undo window; tests pass an
  /// instant one.
  init(
    client: GatewayClient,
    tick: @escaping @Sendable () async throws -> Void = { try await Task.sleep(nanoseconds: 1_000_000_000) }
  ) {
    self.client = client
    self.tick = tick
  }

  /// Whether the list shows `thread` under `scope`: the chip filters the
  /// Email tile only, and a thread with no category is never filtered out.
  func admits(_ thread: ThreadSummary, scope: ShellModel.Scope) -> Bool {
    guard scope == .email, let category, thread.channel == Channel.email.rawValue else { return true }
    guard let own = EmailThreadMeta(thread).category else { return true }
    return own == category
  }

  /// A chip tap: on, or off when it is already on (D-UI-151).
  func toggle(_ chosen: EmailCategory) {
    category = category == chosen ? nil : chosen
  }

  func isExpanded(_ chatGuid: String) -> Bool { expanded.contains(chatGuid) }

  func expand(_ chatGuid: String) { expanded.insert(chatGuid) }

  /// Remote images load only for a message revealed here (05.E). The
  /// fixture's own "allowed" is not honoured in this version: the default
  /// is blocked, and only a human press lifts it.
  func isRevealed(_ turnGuid: String) -> Bool { revealed.contains(turnGuid) }

  func reveal(_ turnGuid: String) { revealed.insert(turnGuid) }

  /// Opens compose under the thread's last card; a compose already open is
  /// closed first, its window cancelled.
  func startCompose(_ mode: EmailComposeModel.Mode, chatGuid: String, card: EmailCard, account: String, subject: String?) {
    closeCompose()
    compose = EmailComposeModel(
      client: client, mode: mode, chatGuid: chatGuid, card: card, account: account, subject: subject, tick: tick)
  }

  /// Discard: the compose goes, and an undo window still open goes with it.
  func closeCompose() {
    compose?.discard()
    compose = nil
  }
}

extension ShellModel {
  /// The open email thread and its loaded page, while board 05 shows one.
  var openEmail: (thread: ThreadSummary, page: ThreadMessagesPage)? {
    guard emailBoard != nil, let thread = selected, thread.channel == Channel.email.rawValue,
      case .loaded(let page) = self.thread.load, page.chatGuid == thread.chatGuid
    else { return nil }
    return (thread, page)
  }

  /// Reply, Reply all or Forward on the open thread's last message: the
  /// inline compose opens under it (D-UI-156). Nothing is written.
  func composeEmail(_ mode: EmailComposeModel.Mode) {
    guard let open = openEmail, let last = EmailCard.cards(open.page).last else { return }
    let meta = EmailThreadMeta(open.thread)
    email.startCompose(
      mode, chatGuid: open.thread.chatGuid, card: last, account: meta.account ?? "", subject: meta.subject ?? open.thread.title)
  }

  /// Shift-R (05.C).
  func replyAllEmail() { composeEmail(.replyAll) }
}
