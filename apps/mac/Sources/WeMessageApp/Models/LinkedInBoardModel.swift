import Foundation
import Observation
import WeMessageKit

// v2 B3, board 04: LinkedIn over fixtures. The board's words are pure (the
// same availability, account and inbox scope always give the same banner);
// the desk holds what this window alone knows about the board: the
// category tab, the inbox scope, whether the inbox switch is open, and the
// composers' phases. Nothing here sends: Make draft ends in a pending draft
// for Needs You (D-UI-168), and nothing at all is written while LinkedIn
// has pushed back (04.H).

/// Board 04's banner and empty state, as boards 03 and 05.
struct LinkedInBoardModel: Equatable, Sendable {
  /// The channel banner's line (D-UI-160).
  let banner: String
  /// The inbox scope the banner names, the switch's own label.
  let scope: String
  let headline: String
  let detail: String
  /// The fixture chip (D-UI-132): only a board drawn over fixtures has one.
  let chip: String?

  /// The board for a channel's availability, or nil when there is none to
  /// draw: a channel not connected keeps the not-connected zero.
  static func make(
    _ availability: ChannelAvailability?, account: String?, inbox: LinkedInInbox?, chipText: String
  ) -> LinkedInBoardModel? {
    let chip: String?
    switch availability {
    case .connected: chip = nil
    case .preview: chip = chipText
    case .notConnected, nil: return nil
    }
    let scope = inbox?.shortTitle ?? ProvisionalUI.linkedInAllInboxes
    return LinkedInBoardModel(
      banner: ProvisionalUI.linkedInBanner(account: account, scope: scope), scope: scope,
      headline: ProvisionalUI.linkedInEmptyHeadline, detail: ProvisionalUI.linkedInEmptyDetail, chip: chip)
  }
}

/// One LinkedIn message as the board draws it: a bubble, an InMail card or
/// a commercial card.
enum LinkedInDisplay: Equatable, Sendable {
  case bubble
  case inMail(LinkedInInMail)
  case commercial(LinkedInCommercial)

  /// A commercial payload outranks the InMail form it may arrive in: a
  /// recruiter's InMail is drawn as the recruiter card, its subject on it.
  static func of(_ meta: LinkedInTurnMeta) -> Self {
    if let commercial = meta.commercial { return .commercial(commercial) }
    if let inMail = meta.inMail { return .inMail(inMail) }
    return .bubble
  }
}

/// Where a composer is after Make draft (D-UI-168).
enum LinkedInDraftPhase: Equatable, Sendable {
  case composing
  /// POST /v1/drafts in flight.
  case drafting
  /// The pending draft's id: it waits in Needs You for an approve.
  case drafted(String)
  case failed

  var value: String {
    switch self {
    case .composing: "composing"
    case .drafting: "drafting"
    case .drafted: "drafted"
    case .failed: "failed"
    }
  }

  var line: String {
    switch self {
    case .composing: ProvisionalUI.linkedInComposingLine
    case .drafting: ProvisionalUI.linkedInDraftingLine
    case .drafted: ProvisionalUI.linkedInDraftedLine
    case .failed: ProvisionalUI.linkedInDraftFailedLine
    }
  }

  /// The create in flight, or the draft made: never drafted twice.
  var busy: Bool {
    switch self {
    case .drafting, .drafted: true
    case .composing, .failed: false
    }
  }
}

/// What this window knows about board 04 beyond the daemon's pages.
@MainActor
@Observable
final class LinkedInDesk {
  /// The category tab and the inbox scope (04.A, 04.E).
  private(set) var filter = LinkedInFilter()
  /// The inbox switch's popover is open.
  var switchShown = false
  /// Each composer's phase, by chatGuid.
  private(set) var phases: [String: LinkedInDraftPhase] = [:]

  @ObservationIgnored private let client: GatewayClient

  init(client: GatewayClient) {
    self.client = client
  }

  /// Whether the list shows `thread` under `scope`: the tab and the inbox
  /// scope filter the LinkedIn tile only.
  func admits(_ thread: ThreadSummary, scope: ShellModel.Scope) -> Bool {
    guard scope == .linkedin else { return true }
    return filter.admits(thread)
  }

  func setCategory(_ category: LinkedInCategory) { filter.category = category }

  /// Nil shows all three inboxes. Choosing closes the popover.
  func setInbox(_ inbox: LinkedInInbox?) {
    filter.inbox = inbox
    switchShown = false
  }

  func phase(_ chatGuid: String) -> LinkedInDraftPhase { phases[chatGuid] ?? .composing }

  /// Make draft: one pending draft on the thread, and only while `gate`
  /// (the composer resolved against the status as it is now) allows one. A
  /// pause, a request, an ad or a thread no step reaches writes nothing.
  /// The subject stays in this window (D-UI-168).
  func makeDraft(chatGuid: String, body: String, gate: LinkedInComposer) async {
    guard gate.allowsDraft, !phase(chatGuid).busy else { return }
    let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    phases[chatGuid] = .drafting
    do {
      let created = try await client.createDraft(DraftCreateInput(chatGuid: chatGuid, body: text))
      phases[chatGuid] = .drafted(created.draft.id)
    } catch {
      phases[chatGuid] = .failed
    }
  }
}

extension ShellModel {
  /// LinkedIn's status meta, read only while the fixture gate is open (only
  /// the UI-test flag opens it, H-B-1): the real daemon never says it.
  var linkedInStatus: LinkedInStatusMeta {
    LinkedInStatusMeta(status: state.previewGate != .closed ? status : nil)
  }

  /// The open LinkedIn thread's loaded page, while board 04 shows one.
  var openLinkedIn: (thread: ThreadSummary, page: ThreadMessagesPage)? {
    guard let thread = selected, linkedInBoard(for: thread) != nil,
      case .loaded(let page) = self.thread.load, page.chatGuid == thread.chatGuid
    else { return nil }
    return (thread, page)
  }

  /// The composer `thread` gets now: an ad first, then the pause, then the
  /// request, then the ladder (04.B, 04.F, 04.H). Before the page is read a
  /// thread's commercial payload is unknown, so no composer is offered.
  func linkedInComposer(_ thread: ThreadSummary) -> LinkedInComposer {
    let paused = linkedInStatus.paused
    guard let open = openLinkedIn, open.thread.chatGuid == thread.chatGuid else {
      return .absent(paused ? .paused : .noRung)
    }
    return LinkedInComposer.resolve(
      LinkedInThreadMeta(thread), commercial: LinkedInTurnMeta.commercial(in: open.page.turns)?.kind, paused: paused)
  }

  /// Make draft on the open LinkedIn thread: resolved again here, at the
  /// press, so a pause that arrived after the composer was drawn still
  /// stops it (04.H).
  func draftLinkedIn(body: String) async {
    guard let open = openLinkedIn else { return }
    await linkedIn.makeDraft(chatGuid: open.thread.chatGuid, body: body, gate: linkedInComposer(open.thread))
  }

  /// The origin tag a LinkedIn row carries: in the LinkedIn tile, while
  /// every inbox shows (D-UI-161).
  func linkedInOriginTag(_ thread: ThreadSummary) -> String? {
    guard scope == .linkedin, thread.channel == Channel.linkedin.rawValue, linkedIn.filter.showsOriginTags else {
      return nil
    }
    return LinkedInThreadMeta(thread).inbox.tag
  }
}
