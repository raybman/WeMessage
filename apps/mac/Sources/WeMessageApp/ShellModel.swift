import Foundation
import Observation
import WeMessageKit

/// The shell's state. `start()` reads status, the thread list and the draft
/// queue once, then follows the kit's event stream; `apply` folds each
/// status into the connection line and every frame into the kit's AppState.
/// `board` is board 01's marks, counter and list, folded from all of it.
/// Nothing here sends anything (Outbound does, after its undo window): the
/// one write is the kill switch, engaged from the chip and disengaged only
/// from the banner's click (D-UI-50), and Done, Snooze and Mute, which
/// QueueStateStore writes through to the daemon's thread state (v2 F3).
@MainActor
@Observable
public final class ShellModel {
  public enum Connection: Equatable, Sendable {
    case idle
    case connected(state: String)
    case reconnecting(attempt: Int)
    case down(reason: String)
  }

  /// The channel the rail has selected.
  public enum Scope: String, CaseIterable, Sendable {
    case all, imessage, whatsapp, linkedin, email

    /// The rail tile's short label (D-UI-1, provisional).
    public var label: String { ProvisionalUI.railShortLabels[rawValue] ?? rawValue }

    /// The full channel name, for accessibility.
    public var fullLabel: String {
      switch self {
      case .all: "All channels"
      case .imessage: "iMessage"
      case .whatsapp: "WhatsApp"
      case .linkedin: "LinkedIn"
      case .email: "Email"
      }
    }

    /// The kit's channel this tile reads; nil for ALL, the fold of the
    /// others (v2 B0).
    public var channel: Channel? { Channel(rawValue: rawValue) }

    /// The digit cmd binds to this tile, in rail order: cmd-1 is ALL.
    public var shortcutDigit: Character {
      let index = Self.allCases.firstIndex(of: self) ?? 0
      return Character(String(index + 1))
    }
  }

  /// The sidebar's lens.
  public enum Lens: String, CaseIterable, Sendable {
    case recent, needsYou, triage

    public var label: String {
      switch self {
      case .recent: "Recent"
      case .needsYou: "Needs You"
      case .triage: "Triage"
      }
    }
  }

  /// Settable inside the module so the reducer rows can start from any case.
  public internal(set) var connection: Connection = .idle
  public var scope: Scope = .all
  public var lens: Lens = .recent
  /// The thread the list has selected, by chatGuid.
  public var selectedThread: String?
  /// The inspector column beside the thread (toggled by its button; no key).
  public var inspectorShown = false
  /// The avatar photos for the listed threads (S4g). Contacts is asked for
  /// only from open(_:) and step(_:), the user's own acts (D-UI-54).
  let avatars: AvatarBook
  /// The latest avatar resolve, so a test can wait for it.
  private(set) var avatarTask: Task<Void, Never>?

  /// The last status read; nil until one succeeds. Every read also folds
  /// through the reducer, which derives the channels' availability from it.
  public internal(set) var status: StatusPayload? {
    didSet { if let status { fold(.response(.status(status))) } }
  }
  /// The thread list as read so far: page 1 and every older page the user
  /// scrolled to (v2 F1), rebuilt from `threadPages` after each read.
  public internal(set) var threads: ThreadsPage?
  /// v2 F1: the list's pages. Older chats append at the tail; a refresh
  /// re-reads page 1 and merges it, never collapsing what was opened.
  private(set) var threadPages = PagedList<ThreadSummary, String>(edge: .tail, key: { $0.chatGuid })
  /// The latest page read the list's approach started, so a test can wait for it.
  private(set) var pageTask: Task<Void, Never>?
  /// v2 F1: a row this close to the end of the list asks for the next page.
  static let prefetchRows = 20
  /// True while an older page of the list is on its way (D-UI-185's caption).
  public var loadingMoreThreads: Bool { threadPages.inFlight }
  /// The kit's state: the draft queue and the channels' availability,
  /// folded by AppReducer. Its gate is closed outside the UI-test flag
  /// (v2 B0, H-B-1).
  public internal(set) var state = AppState(previewGate: TestHooks.previewGate())

  /// The selected thread's transcript (board 02).
  public let thread: ThreadModel
  /// Board 05's chip, reveals and inline compose (v2 B2).
  let email: EmailDesk
  /// Board 04's tab, inbox scope and composers' phases (v2 B3).
  let linkedIn: LinkedInDesk
  /// The one send funnel: every send and approval goes through it.
  public let outbound: Outbound
  /// Board 11: search everything (shift-cmd-F), the quick switcher (cmd-K),
  /// find in thread (cmd-F) and the year scrubber (opt-cmd-G). All read;
  /// none writes (D-UI-79).
  public let search: SearchModel
  public let switcher = QuickSwitcherModel()
  public let find = FindBarModel()
  public var scrubberShown = false
  public internal(set) var scrubberYear: Int?
  /// The message a result or a year landed on: outlined 3 pt (11.D).
  public internal(set) var jumpAnchor: String?
  /// What the human has typed in each thread's composer, by chatGuid. Never
  /// sent from here: only Outbound sends.
  public var composerText: [String: String] = [:]
  /// The draft whose body Edit copied into a thread's field, by chatGuid:
  /// Approve then carries the field as the edited body.
  public var editedFrom: [String: String] = [:]

  /// Boards 06 and 09: the completion acts and the Triage selection, a
  /// cache over the daemon's thread state (v2 F3).
  public let queue: QueueStateStore
  /// The audit view (09.G) is open in the content pane.
  public var auditShown = false
  /// The audit rows last read, oldest first.
  public internal(set) var audit: [AuditLine] = []
  /// The bulk confirm card (06.F, 09.D) is open.
  public var bulkSheetShown = false
  /// A new value asks the composer's field for the keyboard (R in Triage,
  /// Edit); nil leaves the keyboard with the list.
  public var composerClaim: String?
  /// A new value hands the keyboard back to the Triage keys (Escape in the
  /// composer, a new selection).
  public internal(set) var triageClaim = 0

  // v2 S4h, board 10.
  /// The per-channel age table (10.A) is pinned open by the trust banner's
  /// action (D-UI-68).
  public var freshnessPinned = false
  /// The pointer is over the rail (D-UI-68); never set under the UI-test
  /// flag, so a click that leaves the pointer on the rail cannot open the
  /// table in another board's snapshot.
  public var freshnessHover = false
  /// The daemon's last thread list answered source-unavailable: it cannot
  /// read chat.db (10.C).
  public internal(set) var sourceUnavailable = false
  /// The last scan this window saw, held across a lost source (D-UI-65).
  public internal(set) var lastReadableScan: Date?
  /// The revoked banner's Fix opened the FDA screen (10.C).
  public var fdaScreenShown = false
  /// Skip iMessage for now, for this window (D-UI-64).
  public var fdaSkipped = false
  /// How often the FDA screen asked the seam to open System Settings,
  /// mirrored from the seam so the view redraws.
  public internal(set) var fdaAsked = 0
  /// Full Disk Access, behind its seam: the fixture under the UI-test flag.
  let fullDiskAccess: any FullDiskAccessSeam

  private let client: GatewayClient
  private var task: Task<Void, Never>?

  /// Board 01, folded from status, threads and the queue (D-UI-18 window).
  public var board: ShellBoard {
    let window = QueueWindow(days: ProvisionalUI.queueWindowDays)
    let clock = ShellBoard.clock(status: status, threads: threads, drafts: state.queue)
    return ShellBoard.fold(
      status: status, threads: threads, drafts: state.queue, window: window,
      excluding: excludedDrafts(clock: clock, window: window), channels: state.channels)
  }

  /// What the app may do with the channel a scope reads; nil for ALL.
  public func availability(_ scope: Scope) -> ChannelAvailability? {
    scope.channel.map(state.availability)
  }

  /// Board 03 while the WhatsApp tile is selected and its channel draws a
  /// board (v2 B0); nil otherwise, and nil for a channel not connected,
  /// which keeps the not-connected zero.
  var whatsAppBoard: WhatsAppBoardModel? {
    guard scope == .whatsapp else { return nil }
    return WhatsAppBoardModel.make(
      availability(.whatsapp), listed: !rows.isEmpty, chipText: TestHooks.previewChipText)
  }

  /// Board 03 around an open WhatsApp chat, in any scope (v2 B1): the same
  /// banner and chip, nil for any other channel's chat and for a channel
  /// not connected.
  func whatsAppBoard(for thread: ThreadSummary) -> WhatsAppBoardModel? {
    guard thread.channel == Scope.whatsapp.rawValue else { return nil }
    return WhatsAppBoardModel.make(availability(.whatsapp), listed: true, chipText: TestHooks.previewChipText)
  }

  // MARK: v2 B4, board 07

  /// The voice state the confirm card's Cancel disarmed: the card stays
  /// disarmed until the voice state changes (D-UI-173).
  public internal(set) var voiceCancelled: JSONValue?

  /// Board 07's dock over the open thread (v2 B4), from status.meta.voice.
  /// Nil unless the fixture gate is open (only the UI-test flag opens it,
  /// H-B-1), a thread is open and the status carries a voice state: the
  /// real daemon never sends one, so the released app never draws a dock.
  var voiceDock: VoiceDockModel? {
    guard state.previewGate != .closed, let thread = selected else { return nil }
    let voice = status?.meta?["voice"]
    guard
      let dock = VoiceDockModel.make(
        voice, threadTitle: thread.title, pendingDraftId: pendingDraft(for: thread.chatGuid)?.id)
    else { return nil }
    guard dock.armed, voice == voiceCancelled else { return dock }
    return VoiceDockModel(
      size: dock.size, chip: dock.chip, caption: dock.caption, micMuted: dock.micMuted,
      readbackToken: dock.readbackToken, failure: dock.failure, failureLine: dock.failureLine,
      draftId: dock.draftId, armed: false)
  }

  /// The confirm card's Cancel (a click, D-UI-177): disarms this voice
  /// state's card. The draft stays pending; nothing reaches the daemon.
  public func voiceCancel() {
    voiceCancelled = status?.meta?["voice"]
  }

  /// cmd-Return (or Send) on board 07's armed confirm card: the thread's
  /// pending draft, approved through approvePending, the same gates, the
  /// same funnel and the same undo window as A. A spoken approve only arms
  /// the card; this is the one way it proceeds. False, and nothing done,
  /// unless the card is armed for this thread's pending draft.
  @discardableResult
  public func voiceCommit(in chatGuid: String) -> Bool {
    guard selectedThread == chatGuid, let dock = voiceDock, dock.armed,
      let draft = pendingDraft(for: chatGuid), draft.id == dock.draftId
    else { return false }
    return approvePending(in: chatGuid)
  }

  /// Board 05 while the Email tile is selected and its channel draws a
  /// board (v2 B2); nil otherwise, as board 03's. The banner names the
  /// mailbox of the open thread, or of the first email thread listed.
  var emailBoard: EmailBoardModel? {
    guard scope == .email else { return nil }
    let mail = (threads?.threads ?? []).filter { $0.channel == Channel.email.rawValue }
    let shown = mail.first { $0.chatGuid == selectedThread } ?? mail.first
    return EmailBoardModel.make(
      availability(.email), account: shown.flatMap { EmailThreadMeta($0).account }, chipText: TestHooks.previewChipText)
  }

  // MARK: v2 B3, board 04

  /// Board 04 while the LinkedIn tile is selected and its channel draws a
  /// board (v2 B3); nil otherwise, as boards 03 and 05.
  var linkedInBoard: LinkedInBoardModel? {
    guard scope == .linkedin else { return nil }
    return LinkedInBoardModel.make(
      availability(.linkedin), account: linkedInStatus.account, inbox: linkedIn.filter.inbox,
      chipText: TestHooks.previewChipText)
  }

  /// Board 04 around an open LinkedIn thread, in any scope.
  func linkedInBoard(for thread: ThreadSummary) -> LinkedInBoardModel? {
    guard thread.channel == Channel.linkedin.rawValue else { return nil }
    let inbox = scope == .linkedin ? linkedIn.filter.inbox : nil
    return LinkedInBoardModel.make(
      availability(.linkedin), account: linkedInStatus.account, inbox: inbox, chipText: TestHooks.previewChipText)
  }

  /// Board 10.A: the trust banner's line, nil while no connected channel
  /// is stale.
  public var trustLine: String? { TrustBanner.line(board: board) }
  /// Board 10.A: the per-channel age rows.
  public var freshnessRows: [FreshnessRow] { Freshness.rows(board: board, status: status) }
  /// Board 10.C: Full Disk Access, as the seam folds the daemon's answer.
  public var fda: FDAState { fullDiskAccess.state(sourceUnavailable: sourceUnavailable, lastReadable: lastReadableScan) }
  /// The FDA screen takes the content pane: on first run until skipped, or
  /// after the revoked banner's Fix.
  public var fdaScreenUp: Bool { fdaScreenShown || (fda == .firstRun && !fdaSkipped) }

  /// Asks the seam to open System Settings (10.C). Nothing reaches the
  /// daemon.
  public func openFullDiskAccess() {
    fullDiskAccess.openSettings()
    fdaAsked = fullDiskAccess.asked
  }

  /// D-UI-44 mapped onto the Kit's rule.
  static var draftRule: DraftRule {
    switch ProvisionalUI.draftQueueRule {
    case .untilActedOn: .untilActedOn
    case .always: .always
    }
  }

  /// The pending drafts that are not waiting on the user: held here, in
  /// (or past) an approval this window started, or cleared by a Done,
  /// Snooze or Mute made after the draft (06.A under D-UI-44).
  func excludedDrafts(clock: Date?, window: QueueWindow) -> Set<String> {
    var out = Set<String>()
    for draft in state.queue where draft.state == .pending {
      if thread.held.contains(draft.id) {
        out.insert(draft.id)
        continue
      }
      if let entry = outbound.entries.last(where: { $0.intent.draftId == draft.id }) {
        switch entry.phase {
        case .counting, .sending, .approved, .sent:
          out.insert(draft.id)
          continue
        default: break
        }
      }
      guard let act = queue.acts[draft.chatGuid], let clock, let made = WireDate.parse(draft.createdAt) else { continue }
      let facts = ThreadFacts(pendingDraftAt: made, act: act)
      if !CompletionRules.inQueue(facts, now: clock, window: window, draftRule: Self.draftRule) {
        out.insert(draft.id)
      }
    }
    return out
  }

  /// The queue's clock, the moment every act is stamped with.
  public var queueClock: Date { board.asOf ?? Date() }

  /// Threads snoozed past the queue's clock: Triage still lists them, dimmed.
  public var snoozedThreads: [String: Date] {
    let clock = queueClock
    var out: [String: Date] = [:]
    for (guid, act) in queue.acts {
      if case .snoozed(_, let until) = act, until > clock { out[guid] = until }
    }
    return out
  }

  /// The channel the counter speaks for: the selected one, or under ALL the
  /// first channel that is stale (the one that makes ALL unable to say).
  public var counterChannel: String {
    guard scope == .all else { return scope.fullLabel }
    let stale = Scope.allCases.first { $0 != .all && board.mark($0) == .stale }
    return (stale ?? .imessage).fullLabel
  }

  /// The title counter's sentence for the selected scope; nil when hidden.
  public var counterSentence: String? { ShellText.counter(board.counter(scope), channel: counterChannel) }

  /// The kill switch as status last said it: nil when status has not said.
  public var killSwitch: Bool? { status?.killSwitch }

  /// The threads the list shows for the current scope and lens.
  public var rows: [ThreadSummary] {
    board.rows(threads?.threads ?? [], scope: scope, lens: lens, including: Set(snoozedThreads.keys))
      .filter { email.admits($0, scope: scope) }
      .filter { linkedIn.admits($0, scope: scope) }
  }

  /// The queue items in the selected scope, in list order.
  public var scopedQueue: [QueueItem] {
    let channel = ShellBoard.channel(of: scope)
    return board.queue.filter { item in channel.map { $0.rawValue == item.channel } ?? true }
  }

  /// Picks a lens. Entering Triage starts its burn-down; leaving it ends it.
  public func choose(_ lens: Lens) {
    if lens == .triage && self.lens != .triage { queue.beginTriage(count: scopedQueue.count) }
    if lens != .triage { queue.endTriage() }
    self.lens = lens
    triageClaim += 1
  }

  /// cmd-T: into Triage, or back out of it to Recent ("Leave ⌘T", 06.C).
  public func toggleTriage() {
    choose(lens == .triage ? .recent : .triage)
  }

  /// The gates 09.F and 06.F read for `chatGuid`.
  public func gates(for chatGuid: String) -> VerbGates {
    let draft = pendingDraft(for: chatGuid).flatMap { thread.held.contains($0.id) ? nil : $0 }
    let mark = board.mark(.imessage)
    let stale: Bool
    switch connection {
    case .connected: stale = mark == .stale || mark == RailMark.none
    default: stale = true
    }
    return VerbGates(
      killSwitch: killSwitch, sourceStale: stale, bodyRendered: draft.map { outbound.isRendered($0.id) } ?? false,
      hasDraft: draft != nil, unsavedEdit: hasUnsavedEdit(chatGuid))
  }

  /// The thread's field holds text the user typed (06.F, 09.D).
  public func hasUnsavedEdit(_ chatGuid: String) -> Bool {
    !(composerText[chatGuid] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The bulk approve over the scope's queue (06.F, 09.D): one draft per
  /// thread, each included only if its body was drawn this session.
  public var bulkPlan: QueueStateStore.BulkPlan {
    let ids = Set(scopedQueue.compactMap(\.draftId))
    let drafts = state.queue.filter { ids.contains($0.id) }
    let order = scopedQueue.compactMap(\.draftId)
    let sorted = order.compactMap { id in drafts.first { $0.id == id } }
    return QueueStateStore.bulkPlan(
      drafts: sorted, killSwitch: killSwitch, rendered: Set(outbound.renderedAt.keys),
      unsavedEdit: Set(sorted.map(\.chatGuid).filter { hasUnsavedEdit($0) }))
  }

  /// The bulk confirm's one gesture: one batch, one countdown, one undo.
  @discardableResult
  public func approveAll() -> Outbound.Refusal? {
    let plan = bulkPlan
    let intents = plan.included.map { Outbound.Intent.approve(draftId: $0.id, chatGuid: $0.chatGuid, editedBody: nil) }
    bulkSheetShown = false
    return outbound.approveAll(intents)
  }

  /// Done, Snooze or Mute on `guids` (the selection, else the open thread),
  /// gated by 06.E: never against a stale or unreachable source. Selects
  /// the next row; with none left the zero screen shows.
  public func act(_ kind: QueueStateStore.Kind, on guids: [String]) {
    let verb: Verb =
      switch kind {
      case .done: .done
      case .snooze: .snooze
      case .mute: .mute
      }
    let allowed = guids.filter { CompletionRules.permit(verb, gates(for: $0)) == nil }
    guard !allowed.isEmpty else { return }
    let before = rows.map(\.chatGuid)
    queue.act(kind, on: allowed, at: queueClock)
    advance(from: before, leaving: Set(allowed))
  }

  /// After an act, the next row below the one that left, else the one
  /// above, else nothing.
  func advance(from before: [String], leaving: Set<String>) {
    guard let current = selectedThread, leaving.contains(current) else { return }
    let live = Set(rows.map(\.chatGuid)).subtracting(leaving)
    let snoozed = Set(snoozedThreads.keys)
    guard let at = before.firstIndex(of: current) else {
      selectedThread = nil
      return
    }
    let after = before[(at + 1)...].first { live.contains($0) && !snoozed.contains($0) }
    let ahead = before[..<at].last { live.contains($0) && !snoozed.contains($0) }
    selectedThread = after ?? ahead
  }

  /// A click on a list row: selects the thread, and is the user act that
  /// may ask for Contacts (D-UI-54; AvatarCache asks at most once).
  public func open(_ chatGuid: String) {
    selectedThread = chatGuid
    userOpenedThread()
  }

  func userOpenedThread() {
    let avatars = self.avatars
    let listed = threads?.threads ?? []
    avatarTask = Task { await avatars.userActed(listed) }
  }

  /// J and K: the next or previous row.
  public func step(_ delta: Int) {
    let list = rows.map(\.chatGuid)
    guard !list.isEmpty else { return }
    defer { userOpenedThread() }
    guard let current = selectedThread, let at = list.firstIndex(of: current) else {
      selectedThread = delta >= 0 ? list.first : list.last
      return
    }
    selectedThread = list[min(max(at + delta, 0), list.count - 1)]
    // v2 F1: arrowing toward the end pages as scrolling does.
    if let selected = selectedThread, threadPages.cursor != nil {
      pageTask = Task { await self.threadRowAppeared(selected) }
    }
  }

  /// v2 F1: a list row was drawn. Within `prefetchRows` of the end of the
  /// rows shown, the next older page is read. Views report; they never read.
  public func threadRowAppeared(_ chatGuid: String) async {
    guard threadPages.cursor != nil, !threadPages.inFlight else { return }
    let shown = rows
    guard let at = shown.firstIndex(where: { $0.chatGuid == chatGuid }),
      threadPages.shouldFetch(nearIndex: at, of: shown.count, threshold: Self.prefetchRows)
    else { return }
    await loadMoreThreads()
  }

  /// Reads the next older page of the thread list and appends it. One page
  /// at a time; a failure keeps the list and lets the next approach ask
  /// again; a page whose cursor the list no longer holds (a refresh moved
  /// it) is dropped.
  func loadMoreThreads() async {
    guard let cursor = threadPages.cursor, threadPages.begin() else { return }
    let listed = try? await client.listThreads(cursor: cursor)
    guard case .ok(let page)? = listed, threadPages.cursor == cursor else {
      threadPages.fail()
      return
    }
    threadPages.appendPage(page.threads, next: page.nextCursor)
    publishThreads(total: page.total, asOf: threads?.asOf ?? page.asOf)
    let avatars = self.avatars
    let added = page.threads
    avatarTask = Task { await avatars.prefetch(added) }
  }

  /// `threads`, rebuilt from the pages: every board reads it unchanged.
  private func publishThreads(total: Int, asOf: String) {
    guard var out = threads else { return }
    out.threads = threadPages.items
    out.nextCursor = threadPages.cursor
    out.total = max(total, threadPages.items.count)
    out.asOf = asOf
    threads = out
  }

  /// Z: the newest send still counting comes back; else the newest act.
  @discardableResult
  public func undoLast() -> Bool {
    if let entry = outbound.entries.last(where: {
      if case .counting = $0.phase { return true } else { return false }
    }) {
      return outbound.undo(in: entry.batch == nil ? entry.intent.chatGuid : nil)
    }
    return queue.undo()
  }

  /// A (09.A, 06.C): the thread's pending draft, approved through the funnel
  /// with its approve gesture. Refused unless 09.F's gates pass: never under
  /// the kill switch, never a draft whose body was not drawn, never over an
  /// unsaved edit. Nothing reaches the daemon before the undo window closes.
  /// True when the undo window started.
  @discardableResult
  public func approvePending(in chatGuid: String) -> Bool {
    guard let draft = pendingDraft(for: chatGuid), !thread.held.contains(draft.id) else { return false }
    guard CompletionRules.permit(.approve, gates(for: chatGuid)) == nil else { return false }
    return outbound.perform(.approve(draftId: draft.id, chatGuid: chatGuid, editedBody: nil), gesture: .approveButton) == nil
  }

  /// R (06.D): the composer takes the keyboard, holding the agent's draft
  /// when there is one (Edit), else empty (Reply). Never while the kill
  /// switch is on: the field says sending is off.
  public func replyOrEdit(in chatGuid: String) {
    guard killSwitch == false else { return }
    if let draft = pendingDraft(for: chatGuid), !thread.held.contains(draft.id),
      (composerText[chatGuid] ?? "").isEmpty
    {
      composerText[chatGuid] = draft.body
      editedFrom[chatGuid] = draft.id
    }
    selectedThread = chatGuid
    composerClaim = chatGuid
  }

  /// Backspace (09.A): a local hold (D-UI-36). Absent under the kill switch,
  /// which already holds every draft.
  public func holdPending(in chatGuid: String) {
    guard let draft = pendingDraft(for: chatGuid), killSwitch == false else { return }
    thread.hold(draft.id, at: queueClock)
  }

  /// The draft as 09.B draws it: the daemon's state, plus an approval still
  /// counting here and a local hold, measured on the queue's clock.
  public func phase(of draft: DraftPayload) -> DraftPhase? {
    let counting = outbound.entries.last { entry in
      guard entry.intent.draftId == draft.id, case .counting = entry.phase else { return false }
      return true
    }
    // Expiry, the kill switch and a hold are read on the queue's clock (the
    // daemon's); a local approval counts on the wall clock it started on.
    let base = DraftPhase.project(draft, now: queueClock, heldAt: thread.heldAt[draft.id], killSwitch: killSwitch)
    guard case .awaiting = base, let counting else { return base }
    let sends = counting.startedAt.addingTimeInterval(Double(counting.window))
    return Date() < sends ? .approvedInUndo(approvedAt: counting.startedAt, sendsAt: sends) : base
  }

  /// 09.A and 09.B's meta line under a draft: its state, who, and when.
  /// `long` is the open draft's form in Needs You.
  public func metaLine(_ draft: DraftPayload, long: Bool) -> String? {
    phase(of: draft)?.meta(
      adapter: draft.adapterId, clock: { ShellText.shortClock($0) }, longClock: { ShellText.clock($0) }, long: long,
      heldTail: { ProvisionalUI.heldTail(expires: $0.map { ShellText.shortClock($0) }) })
  }

  /// The zero screen's receipt (06.E): this session's work.
  public var receipt: QueueStateStore.Receipt {
    QueueStateStore.receipt(entries: outbound.entries, acts: queue.sessionActs)
  }

  /// Escape's ladder (06.C): the composer gives the keyboard back to the
  /// list, then the selection clears, then Triage ends.
  public func escape(fromComposer: Bool) {
    if escapeIsBoard11 {
      // Board 11 first: a panel closes, or a jump goes back to its results.
      escapeBoard11()
    } else if fromComposer {
      composerClaim = nil
      triageClaim += 1
    } else if !queue.selection.isEmpty {
      queue.selection = []
    } else if selectedThread != nil {
      selectedThread = nil
    } else if lens == .triage {
      choose(.recent)
    }
  }

  /// The selected thread's summary, when it is still listed.
  public var selected: ThreadSummary? {
    guard let selectedThread else { return nil }
    return threads?.threads.first { $0.chatGuid == selectedThread }
  }

  public convenience init(client: GatewayClient) {
    self.init(client: client, avatars: AvatarBook.initialsOnly())
  }

  init(client: GatewayClient, avatars: AvatarBook) {
    self.client = client
    self.avatars = avatars
    self.thread = ThreadModel(client: client)
    self.email = EmailDesk(client: client)
    self.linkedIn = LinkedInDesk(client: client)
    self.search = SearchModel(source: DaemonSearchSource(client: client))
    self.queue = QueueStateStore(sync: GatewayThreadStateSync(client: client))
    self.fullDiskAccess = TestHooks.fullDiskAccess()
    let shell = WeakShell()
    self.outbound = Outbound(client: client, killSwitch: { shell.model?.killSwitch })
    shell.model = self
  }

  // MARK: board 11

  /// True while search or the switcher holds the list and thread panes
  /// (D-UI-86): the composer is not in the window then.
  public var searchUp: Bool { search.shown || switcher.shown }

  /// Shift-cmd-F: search everything, from an empty field.
  public func openSearch() {
    switcher.close()
    find.close()
    search.open()
  }

  /// cmd-K: the switcher, empty, over the current list.
  public func openSwitcher() {
    search.close()
    find.close()
    let waiting = Set(state.queue.filter { $0.state == .pending }.map(\.chatGuid))
    switcher.open(threads: threads?.threads ?? [], draftsWaiting: waiting)
  }

  /// cmd-F: find in the open thread, only when one is open.
  public func openFind() {
    guard selected != nil, !searchUp else { return }
    find.open(turns: thread.turns)
  }

  /// The find bar's Done and Escape. Recent's composer takes the keyboard
  /// back by itself; another lens hands it back to the list (06.C).
  public func closeFind() {
    find.close()
    if lens != .recent && composerClaim == nil { triageClaim += 1 }
  }

  /// opt-cmd-G: the year scrubber beside the open thread.
  public func toggleScrubber() {
    guard selected != nil, !searchUp else { return }
    scrubberShown.toggle()
  }

  /// The scrubber over what the open thread has loaded.
  public var scrubber: YearScrubber { YearScrubber(turns: thread.turns) }

  /// A year row: land on its first message, or the nearest (11.F).
  public func jump(toYear year: Int) {
    scrubberYear = year
    jumpAnchor = scrubber.anchor(for: year)
  }

  /// A result opens its thread at that message (11.D).
  public func open(_ hit: SearchHit) {
    search.opened(hit)
    find.close()
    lens = .recent
    scope = .all
    selectedThread = hit.doc.threadGuid
    jumpAnchor = hit.id
    var calendar = Calendar(identifier: .gregorian)
    calendar.timeZone = .current
    scrubberYear = calendar.component(.year, from: hit.doc.sentAt)
    scrubberShown = true
    userOpenedThread()
  }

  /// A switcher row: a thread opens, a channel selects its tile.
  public func open(_ row: QuickSwitcherModel.Row) {
    switcher.close()
    switch row.target {
    case .thread(let guid):
      jumpAnchor = nil
      scrubberShown = false
      open(guid)
    case .channel(let scope):
      self.scope = scope
    }
  }

  /// What the transcript scrolls to and outlines: the find bar's current
  /// match while it is up, else the jump.
  public var scrollTarget: String? { find.shown ? find.currentGuid : jumpAnchor }

  /// opt-cmd-up and opt-cmd-down on the scrubber: a newer or an older year.
  public func stepYear(_ delta: Int) {
    guard scrubberShown else { return }
    let years = scrubber.years.map(\.year)
    guard !years.isEmpty else { return }
    let at = scrubberYear.flatMap { years.firstIndex(of: $0) }
    let next = at.map { min(max($0 + delta, 0), years.count - 1) } ?? 0
    jump(toYear: years[next])
  }

  /// True while board 11 owns Escape: a panel is up, or a jump can go
  /// back to its results. Otherwise Escape is the list's (06.C).
  public var escapeIsBoard11: Bool {
    switcher.shown || search.shown || find.shown || scrubberShown
      || (jumpAnchor != nil && search.jumpedFrom != nil)
  }

  /// Board 11's Escape, innermost first: the switcher, search, the find
  /// bar, then a jump back to its results (11.D), then the scrubber.
  public func escapeBoard11() {
    if switcher.shown {
      switcher.close()
    } else if search.shown {
      search.escape()
    } else if find.shown {
      closeFind()
    } else if jumpAnchor != nil, search.jumpedFrom != nil {
      // 11.D: Esc from a jumped-to thread goes back to the same results.
      jumpAnchor = nil
      scrubberShown = false
      search.back()
    } else if scrubberShown {
      scrubberShown = false
      jumpAnchor = nil
    }
  }

  /// The pending agent draft for `chatGuid`, newest last in the queue.
  public func pendingDraft(for chatGuid: String) -> DraftPayload? {
    state.queue.last { $0.chatGuid == chatGuid && $0.state == .pending }
  }

  /// D-UI-35: a group sender's name is the title of the one-to-one thread
  /// with that handle, when the list has one.
  public func senderName(handle: String) -> String? {
    guard ProvisionalUI.groupSenderNames == .fromOneToOneTitles else { return nil }
    return threads?.threads.first { threadHandle($0) == handle }?.title
  }

  /// One task, however often it is called: read status, then follow the
  /// event stream until `stop()` or the model goes away.
  public func start() {
    guard task == nil else { return }
    let client = self.client
    task = Task { [weak self] in
      await self?.refresh()
      if Task.isCancelled { return }
      for await action in EventStream.live(client: client).run() {
        guard let self else { return }
        self.apply(action)
      }
    }
  }

  /// Reads status, the thread list and the draft queue once. The first read
  /// decides connected or down; a later one (the UI tests' reload key after
  /// a scenario switch) updates what a connected window says and leaves a
  /// lost connection to the stream.
  public func refresh() async {
    do {
      let status = try await client.status()
      self.status = status
      switch connection {
      case .idle, .connected: connection = .connected(state: status.connectionState)
      case .reconnecting, .down: break
      }
    } catch {
      if Task.isCancelled { return }
      if case .idle = connection { connection = .down(reason: "unreachable") }
      return
    }
    if let scan = status?.cursor.flatMap({ WireDate.parse($0.lastScanAt) }) { lastReadableScan = scan }
    let listed = try? await client.listThreads()
    if case .refused(.sourceUnavailable)? = listed { sourceUnavailable = true }
    if case .ok(let page)? = listed {
      sourceUnavailable = false
      threadPages.mergeHead(page.threads, next: page.nextCursor)
      threads = page
      publishThreads(total: page.total, asOf: page.asOf)
      let avatars = self.avatars
      avatarTask?.cancel()
      avatarTask = Task { await avatars.prefetch(page.threads) }
    }
    // 09.C: the agent undo window is send.undoGraceSeconds, clamped 5...30.
    if let envelope = try? await client.settings() {
      outbound.approveSeconds = UndoWindow.agent(fromSetting: envelope.settings["send.undoGraceSeconds"]?.value)
    }
    if let envelope = try? await client.listDrafts() { fold(.response(.drafts(envelope.drafts))) }
    // v2 F3: the daemon's Done, Snooze and Mute replace the cache.
    await queue.hydrate()
    await thread.reload()
  }

  /// Turns sending off (shift-cmd-K). Only ever this direction: turning it
  /// back on is the banner's Disengage, a click with no key (D-UI-50). The
  /// status read after it is what the chip shows; a refusal leaves the chip
  /// as it was.
  public func engageKillSwitch() async {
    guard killSwitch != true else { return }
    _ = try? await client.setKillSwitch(true)
    if let status = try? await client.status() { self.status = status }
  }

  /// The banner's Disengage (09.F): turns sending back on. Held drafts
  /// return to awaiting; nothing that was refused at the minute is resent.
  public func disengageKillSwitch() async {
    guard killSwitch == true else { return }
    _ = try? await client.setKillSwitch(false)
    if let status = try? await client.status() { self.status = status }
  }

  /// The audit view (09.G): reads the chain once per open, oldest first.
  public func loadAudit() async {
    guard let rows = try? await client.listAudit() else { return }
    audit = rows.map(AuditLine.init).sorted { $0.seq < $1.seq }
  }

  /// Cancels the task `start()` made; the stream ends with it.
  public func stop() {
    task?.cancel()
    task = nil
  }

  /// The reducer (§4.3). "Reconnecting" is only ever said about a
  /// connection the window actually had (P0-2): the kit's stream retries on
  /// a refused connection, and from `.idle` or `.down` that retry is still
  /// "not reachable", never "reconnecting".
  public func apply(_ action: AppAction) {
    fold(action)
    // S7a: a live connection.state frame names the state a connected window
    // shows. Only a connection the window has; the line never says
    // "connected" on the strength of a frame alone.
    if case .frame(.event(_, .connectionState(let live))) = action {
      if case .connected = connection { connection = .connected(state: live.state) }
      return
    }
    // v2 F3: another window's act (or the echo of this one's).
    if case .frame(.event(_, .threadState(let event))) = action {
      queue.apply(event.state, guid: event.chatGuid)
      return
    }
    guard case .status(let status) = action else { return }
    switch status {
    case .connected:
      if case .connected = connection { return }
      // A window that had the stream back re-reads what it missed.
      switch connection {
      case .reconnecting, .down: Task { [weak self] in await self?.queue.hydrate() }
      case .idle, .connected: break
      }
      connection = .connected(state: "connected")
    case .reconnecting(let attempt):
      switch connection {
      case .connected, .reconnecting: connection = .reconnecting(attempt: attempt)
      case .idle: connection = .down(reason: "unreachable")
      case .down: return
      }
    case .down(let reason):
      connection = .down(reason: reason)
    }
  }

  /// Folds `action` into the kit's state and runs the one effect the shell
  /// acts on: a fresh read of the draft queue.
  func fold(_ action: AppAction) {
    let (next, effects) = AppReducer.reduce(state, action)
    state = next
    guard effects.contains(.listDrafts) else { return }
    let client = self.client
    Task { [weak self] in
      if let envelope = try? await client.listDrafts() { self?.fold(.response(.drafts(envelope.drafts))) }
    }
  }

  /// The connection line, in words (D-UI-3, provisional).
  public var connectionLine: String {
    switch connection {
    case .idle: ProvisionalUI.idleLine
    case .connected(let state): ProvisionalUI.connectedLine(state: state)
    case .reconnecting(let attempt): ProvisionalUI.reconnectingLine(attempt: attempt)
    case .down: ProvisionalUI.downLine
    }
  }
}

/// Lets the send funnel read the shell's kill switch without the shell
/// owning a cycle.
@MainActor
private final class WeakShell {
  weak var model: ShellModel?
}
