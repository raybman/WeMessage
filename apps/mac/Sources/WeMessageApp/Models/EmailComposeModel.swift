import Foundation
import Observation
import WeMessageKit

// v2 B2, board 05.B: the inline email compose. The envelope is prefilled
// from the message replied to (Reply, Reply all, Forward), and Send opens
// the message's own undo window (the fixture's 30 s). When the window runs
// out, a pending draft is created through POST /v1/drafts and waits in
// Needs You: compose has no send call site at all, as board 14's does not
// (D-UI-156). Hold until is parked and has no state here (D-UI-139). The
// attachment wall (05.D) blocks Send from 25 MB.

@MainActor
@Observable
final class EmailComposeModel {
  enum Mode: String, CaseIterable, Sendable {
    case reply, replyAll, forward
  }

  /// Where the message is after Send, as board 14's.
  enum Phase: Equatable, Sendable {
    case composing
    /// The undo window: nothing has left this Mac.
    case undo(secondsLeft: Int)
    /// POST /v1/drafts in flight.
    case drafting
    /// The pending draft's id: it waits in Needs You for an approve.
    case drafted(String)
    case failed

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

  let mode: Mode
  let chatGuid: String
  /// The message replied to or forwarded.
  let replyTo: String
  /// The undo window, in whole seconds, from the message's own meta.
  let undoSeconds: Int
  var to: String
  var cc: String
  var bcc = ""
  var subject: String
  var body = ""
  /// The files going with it: a forward carries the original's.
  private(set) var attachments: [EmailAttachment]
  private(set) var phase: Phase = .composing

  @ObservationIgnored private let client: GatewayClient
  @ObservationIgnored private let tick: @Sendable () async throws -> Void
  @ObservationIgnored private var pending: Task<Void, Never>?

  init(
    client: GatewayClient, mode: Mode, chatGuid: String, card: EmailCard, account: String, subject: String?,
    tick: @escaping @Sendable () async throws -> Void
  ) {
    self.client = client
    self.tick = tick
    self.mode = mode
    self.chatGuid = chatGuid
    replyTo = card.id
    undoSeconds = card.meta.undoSeconds
    let envelope: EmailEnvelope
    switch mode {
    case .reply: envelope = card.meta.envelope.reply(me: account)
    case .replyAll: envelope = card.meta.envelope.replyAll(me: account)
    case .forward: envelope = card.meta.envelope.forward(me: account)
    }
    to = Self.list(envelope.to)
    cc = Self.list(envelope.cc)
    self.subject = Self.subject(subject ?? "", mode: mode)
    attachments = mode == .forward ? card.meta.attachments : []
  }

  static func list(_ people: [EmailParticipant]) -> String {
    people.map(\.address).joined(separator: ", ")
  }

  /// "Re: " or "Fwd: " once, never stacked.
  static func subject(_ original: String, mode: Mode) -> String {
    let prefix = mode == .forward ? "Fwd: " : "Re: "
    let trimmed = original.trimmingCharacters(in: .whitespaces)
    if trimmed.lowercased().hasPrefix(prefix.lowercased()) { return trimmed }
    return prefix + trimmed
  }

  // MARK: 05.D, the wall

  var attachmentBytes: Int64 { attachments.reduce(0) { $0 + $1.bytes } }

  var wall: EmailSizeWall.State { EmailSizeWall.state(attachmentBytes) }

  /// The wall's line above Send (D-UI-157), nil while clear.
  var wallLine: String? {
    let size = SizeText.megabytes(attachmentBytes)
    let limit = SizeText.megabytes(EmailSizeWall.blockBytes)
    switch wall {
    case .clear: return nil
    case .warn: return ProvisionalUI.emailWallWarn(size, limit: limit)
    case .block: return ProvisionalUI.emailWallBlock(size, limit: limit)
    }
  }

  /// Takes a file off the message, while it can still change.
  func remove(_ attachment: EmailAttachment) {
    guard !busy, let index = attachments.firstIndex(of: attachment) else { return }
    attachments.remove(at: index)
  }

  // MARK: Send, Undo, Discard

  /// The undo window, the create in flight, or the draft made: the fields
  /// are held, and a drafted message is never drafted twice.
  var busy: Bool {
    switch phase {
    case .undo, .drafting, .drafted: true
    case .composing, .failed: false
    }
  }

  var canSend: Bool {
    !busy && wall != .block
      && !to.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
      && !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
  }

  /// The small print under the buttons for the phase.
  var phaseLine: String {
    switch phase {
    case .composing: ProvisionalUI.emailComposingLine
    case .undo(let left): ProvisionalUI.emailUndoLine(left)
    case .drafting: ProvisionalUI.emailDraftingLine
    case .drafted: ProvisionalUI.emailDraftedLine
    case .failed: ProvisionalUI.emailDraftFailed
    }
  }

  /// Opens the undo window; when it runs out, the draft is created. The
  /// window is written before the task that can reach the client.
  func send() {
    guard canSend else { return }
    let text = body
    let guid = chatGuid
    let seconds = undoSeconds
    phase = .undo(secondsLeft: seconds)
    pending = Task { [weak self] in
      guard let self else { return }
      for left in stride(from: seconds - 1, through: 0, by: -1) {
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

  /// Discard: a window still open is cancelled, so nothing is created.
  func discard() {
    if case .undo = phase {
      pending?.cancel()
      pending = nil
      phase = .composing
    }
  }

  /// Waits for the window and the create to finish, or for an undo.
  func settle() async {
    await pending?.value
  }

  /// The one write: a pending draft on the thread. The envelope stays in
  /// this window; the draft carries the body (deviation, README board 05).
  private func createDraft(chatGuid: String, body text: String) async {
    guard !Task.isCancelled, case .undo = phase else { return }
    phase = .drafting
    do {
      let created = try await client.createDraft(DraftCreateInput(chatGuid: chatGuid, body: text))
      phase = .drafted(created.draft.id)
    } catch {
      phase = .failed
    }
  }
}
