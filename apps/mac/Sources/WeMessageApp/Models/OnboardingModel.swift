import Foundation
import Observation

// v2 S4h, board 12: onboarding. The model holds no client: nothing here can
// reach the daemon, so onboarding cannot send, draft, or arm anything
// (H-S4-7). Full Disk Access is asked through FullDiskAccessSeam, whose
// fixture under the UI-test flag opens nothing and grants on a count.

/// Board 12's screens, in the order the flow reaches them.
public enum OnboardingStep: String, Codable, CaseIterable, Sendable {
  /// 12.A, step 1: the pitch and the four cards.
  case channels
  /// 12.B, step 2a: Full Disk Access, before asking.
  case fdaAsk
  /// 12.B, step 2b: waiting, polling every 2 s.
  case fdaWaiting
  /// 12.B, step 2c: granted, the copy sized before it is made.
  case fdaSized
  /// 12.B, step 2c: CopyProgress, dated.
  case copying
  /// 12.C, step 3.
  case whatsapp
  /// 12.D, step 4.
  case linkedin
  /// 12.E, step 5.
  case email
  /// 12.F, step 6: AgentStep and KillIntro.
  case agent
  /// 12.G: setup complete, a line per channel.
  case done
  /// 12.I: the first thread, FirstThreadCoach.
  case firstThread

  /// The slug the UI tests and the shots use.
  public var slug: String {
    switch self {
    case .channels: "1"
    case .fdaAsk: "2a"
    case .fdaWaiting: "2b"
    case .fdaSized: "2c"
    case .copying: "2c-copy"
    case .whatsapp: "3"
    case .linkedin: "4"
    case .email: "5"
    case .agent: "6"
    case .done: "done"
    case .firstThread: "I"
    }
  }

  /// "Step n of 6", fixed at launch (12.A legend 5); nil past the six.
  public var number: Int? {
    switch self {
    case .channels: 1
    case .fdaAsk, .fdaWaiting, .fdaSized, .copying: 2
    case .whatsapp: 3
    case .linkedin: 4
    case .email: 5
    case .agent: 6
    case .done, .firstThread: nil
    }
  }
}

/// The four channels, in channel order (12.A: never reordered).
public enum OnboardingChannel: String, Codable, CaseIterable, Sendable {
  case imessage, whatsapp, linkedin, email

  public var name: String {
    switch self {
    case .imessage: "iMessage"
    case .whatsapp: "WhatsApp"
    case .linkedin: "LinkedIn"
    case .email: "Email"
    }
  }

  public var monogram: String {
    switch self {
    case .imessage: "iM"
    case .whatsapp: "WA"
    case .linkedin: "LI"
    case .email: "EM"
    }
  }

  /// The channel's own setup step.
  var step: OnboardingStep {
    switch self {
    case .imessage: .fdaAsk
    case .whatsapp: .whatsapp
    case .linkedin: .linkedin
    case .email: .email
    }
  }
}

/// Everything onboarding persists, after every step (12.B legend 4: macOS
/// quits the app on the grant, so progress lives on disk).
public struct OnboardingProgress: Codable, Equatable, Sendable {
  public var step: OnboardingStep = .channels
  /// Skipped on its card or its step: "declined by you" (12.G legend 1).
  public var declined: Set<OnboardingChannel> = []
  /// Make the copy was pressed (12.B legend 2: never a side effect of the
  /// grant).
  public var copyStarted = false
  /// AgentStep (12.F): off by default, and drawn selected.
  public var drafting = false
  /// Per-channel drafting, unchecked even after choosing Draft (12.F legend 3).
  public var draftChannels: Set<OnboardingChannel> = []
  /// The coach row took its one keypress (12.I legend 1).
  public var coachDismissed = false
  /// The rail took its one tile click (12.I legend 6).
  public var railCollapsed = false

  public init() {}

  /// Nothing left to show: the handover is spent.
  public var finished: Bool { step == .firstThread && coachDismissed && railCollapsed }
}

/// Where onboarding progress is kept.
@MainActor
public protocol OnboardingStore: AnyObject {
  func load() -> OnboardingProgress?
  func save(_ progress: OnboardingProgress)
}

/// In memory: the UI-test flag's store, and the unit tests' "disk" across
/// a simulated relaunch.
@MainActor
public final class MemoryOnboardingStore: OnboardingStore {
  public private(set) var saved: OnboardingProgress?
  public private(set) var saves = 0
  public init(_ saved: OnboardingProgress? = nil) { self.saved = saved }
  public func load() -> OnboardingProgress? { saved }
  public func save(_ progress: OnboardingProgress) {
    saved = progress
    saves += 1
  }
}

/// The shipped store: one JSON value in the app's defaults. Never built
/// under the UI-test flag (H-S4-7), so a CI run leaves the runner's
/// defaults alone.
@MainActor
public final class DefaultsOnboardingStore: OnboardingStore {
  static let key = "WeMessageOnboardingProgress"
  public init() {
    precondition(!TestHooks.isUITest, "the defaults onboarding store under the UI-test flag")
  }
  public func load() -> OnboardingProgress? {
    UserDefaults.standard.data(forKey: Self.key).flatMap { try? JSONDecoder().decode(OnboardingProgress.self, from: $0) }
  }
  public func save(_ progress: OnboardingProgress) {
    if let data = try? JSONEncoder().encode(progress) { UserDefaults.standard.set(data, forKey: Self.key) }
  }
}

/// The count query 2c shows before the copy is made (12.B legend 2).
public struct CopySizing: Equatable, Sendable {
  public let messages: Int
  public let chats: Int
  public let megabytes: Int
  /// yyyy-mm-dd.
  public let historyFrom: String
  public init(messages: Int, chats: Int, megabytes: Int, historyFrom: String) {
    self.messages = messages
    self.chats = chats
    self.megabytes = megabytes
    self.historyFrom = historyFrom
  }
}

/// CopyProgress (12.B): how many are left and copied, and when that was true.
public struct CopyProgressFacts: Equatable, Sendable {
  public let left: Int
  public let copied: Int
  public let asOf: Date
  public init(left: Int, copied: Int, asOf: Date) {
    self.left = left
    self.copied = copied
    self.asOf = asOf
  }
}

/// Board 12's state. Persisted after every change; the FDA poll runs only
/// on 2b and stops on the grant.
@MainActor
@Observable
public final class OnboardingModel {
  /// 12.B: "Checking every 2 seconds."
  public static let pollEvery: Duration = .seconds(2)

  public private(set) var progress: OnboardingProgress
  /// 2c's count, once the grant has landed.
  public private(set) var sizing: CopySizing?
  /// CopyProgress, once the copy was asked for.
  public private(set) var copyProgress: CopyProgressFacts?
  /// The poll is running (2b only).
  public private(set) var polling = false
  /// Probes this model made.
  public private(set) var probes = 0
  /// Open System Settings asks, mirrored from the seam.
  public private(set) var asked = 0

  let seam: any FullDiskAccessSeam
  private let store: any OnboardingStore
  private let interval: Duration
  private var pollTask: Task<Void, Never>?

  public init(store: any OnboardingStore, seam: any FullDiskAccessSeam, interval: Duration = OnboardingModel.pollEvery) {
    self.store = store
    self.seam = seam
    self.interval = interval
    self.progress = store.load() ?? OnboardingProgress()
  }

  public var step: OnboardingStep { progress.step }

  /// After a relaunch: 2b probes once at once, so a grant made while the
  /// app was quit lands on 2c without a 2 s wait, then polls; 2c and the
  /// copy read their facts again.
  public func resume() async {
    switch progress.step {
    case .fdaWaiting:
      polling = true
      await pollOnce()
      if polling { startPolling() }
    case .fdaSized:
      sizing = await seam.sizing()
    case .copying:
      sizing = await seam.sizing()
      copyProgress = await seam.copyProgress()
    default:
      break
    }
  }

  // MARK: 12.A

  /// A card's Connect: that channel's own step.
  public func connect(_ channel: OnboardingChannel) {
    update { $0.declined.remove(channel) }
    go(channel.step)
  }

  /// A card's Skip, a toggle: the channel reads declined until pressed again.
  public func toggleSkip(_ channel: OnboardingChannel) {
    update {
      if $0.declined.contains(channel) { $0.declined.remove(channel) } else { $0.declined.insert(channel) }
    }
  }

  /// Continue with n connected (12.A legend 2): a real button.
  public func continueFromChannels() { go(next(after: .channels)) }

  /// The channels that are not declined, for the Continue label. Nothing is
  /// connected on step 1, so it is always 0 here.
  public var connectedCount: Int { progress.step == .channels ? 0 : (progress.copyStarted ? 1 : 0) }

  // MARK: 12.B

  /// Open System Settings: the seam, then 2b and the poll.
  public func openSettings() {
    seam.openSettings()
    asked = seam.asked
    if progress.step == .fdaAsk {
      go(.fdaWaiting)
      startPolling()
    }
  }

  /// Every 2 s on 2b until the grant.
  func startPolling() {
    guard pollTask == nil, progress.step == .fdaWaiting else { return }
    polling = true
    let interval = interval
    pollTask = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: interval)
        guard let self, self.polling else { return }
        await self.pollOnce()
      }
    }
  }

  /// One probe. On the grant the poll stops, the copy is sized, and the
  /// flow moves to 2c. Never probes once the poll has stopped.
  @discardableResult
  public func pollOnce() async -> Bool {
    guard polling else { return false }
    probes += 1
    guard await seam.probe() else { return false }
    stopPolling()
    sizing = await seam.sizing()
    if progress.step == .fdaWaiting { go(.fdaSized) }
    return true
  }

  public func stopPolling() {
    polling = false
    pollTask?.cancel()
    pollTask = nil
  }

  /// Make the copy: asked for here, never by the grant.
  public func makeCopy() async {
    update { $0.copyStarted = true }
    go(.copying)
    copyProgress = await seam.copyProgress()
  }

  // MARK: 12.B to 12.E

  /// Skip <channel>: declined, then the next step.
  public func skip(_ channel: OnboardingChannel) {
    if channel == .imessage { stopPolling() }
    update { $0.declined.insert(channel) }
    go(next(after: progress.step))
  }

  /// Continue past the copy.
  public func continueFromCopy() { go(next(after: .copying)) }

  // MARK: 12.F

  /// No drafting or Draft, never send. Changes this value only: nothing
  /// here reaches the daemon.
  public func setDrafting(_ on: Bool) {
    update {
      $0.drafting = on
      if !on { $0.draftChannels = [] }
    }
  }

  public func toggleDraftChannel(_ channel: OnboardingChannel) {
    guard progress.drafting else { return }
    update {
      if $0.draftChannels.contains(channel) { $0.draftChannels.remove(channel) } else { $0.draftChannels.insert(channel) }
    }
  }

  public func finish() { go(.done) }

  // MARK: 12.G, 12.I

  public func openInbox() { go(.firstThread) }

  /// The coach row is up: 12.I, until its one keypress.
  public var coachShown: Bool { progress.step == .firstThread && !progress.coachDismissed }
  /// The rail has words: 12.I, until its one tile click.
  public var railExpanded: Bool { progress.step == .firstThread && !progress.railCollapsed }

  /// Any key dismisses the coach row (12.I legend 1), whatever key it is.
  public func coachKeyDown(keyCode: UInt16) {
    guard coachShown else { return }
    update { $0.coachDismissed = true }
  }

  /// Any tile click collapses the rail, once.
  public func railTileClicked() {
    guard railExpanded else { return }
    update { $0.railCollapsed = true }
  }

  // MARK: plumbing

  /// The next channel step after `step` that was not declined, else the
  /// agent step.
  func next(after step: OnboardingStep) -> OnboardingStep {
    let order: [OnboardingStep] = [.channels, .fdaAsk, .whatsapp, .linkedin, .email, .agent]
    let from: OnboardingStep =
      switch step {
      case .fdaWaiting, .fdaSized, .copying: .fdaAsk
      default: step
      }
    guard let at = order.firstIndex(of: from) else { return .agent }
    for candidate in order[(at + 1)...] {
      if let channel = OnboardingChannel.allCases.first(where: { $0.step == candidate }), progress.declined.contains(channel) {
        continue
      }
      return candidate
    }
    return .agent
  }

  private func go(_ step: OnboardingStep) { update { $0.step = step } }

  private func update(_ change: (inout OnboardingProgress) -> Void) {
    change(&progress)
    store.save(progress)
  }
}

/// Board 12's words, from the wireframe.
public enum OnboardingCopy {
  public static let app = "WeMessage"
  public static func stepLine(_ step: OnboardingStep) -> String {
    switch step {
    case .channels: "Step 1 of 6 \u{00B7} Connect channels"
    case .fdaAsk, .fdaWaiting: "Step 2 of 6"
    case .fdaSized, .copying: "Step 2 of 6 \u{00B7} access granted"
    case .whatsapp: "Step 3 of 6"
    case .linkedin: "Step 4 of 6"
    case .email: "Step 5 of 6"
    case .agent: "Step 6 of 6"
    case .done, .firstThread: "Setup complete"
    }
  }

  // 12.A
  public static let pitch: [(String, String)] = [
    (
      "What this is",
      "One inbox for iMessage, WhatsApp, LinkedIn, and email, on this Mac. An AI agent can draft replies if you turn that on later. It can never send one."
    ),
    (
      "What it will need",
      "Each channel below states exactly what it costs to connect. Three of the four cost something real. Read the card before you click."
    ),
    (
      "What it will never do",
      "Never upload your messages anywhere. Never send a message you did not approve, on any channel, from any agent. Never connect a channel you did not click."
    ),
  ]

  /// Each card's cost, in two sentences before Connect (12.A legend 1).
  public static func cost(_ channel: OnboardingChannel) -> String {
    switch channel {
    case .imessage:
      "Needs Full Disk Access to read Apple's message database. Makes a second copy of your entire iMessage history on this disk, kept up to date. Sends go through Messages.app on your own account."
    case .whatsapp:
      "Pairs as a linked device by scanning a QR. There is no official API for personal accounts: this is against WhatsApp's terms and your phone number can be banned. Session expires after about 20 days. History is partial."
    case .linkedin:
      "No messaging API exists. Signs in through a real LinkedIn window and reads your inbox at a paced rate. LinkedIn can restrict your account for this. The session expires without notice."
    case .email:
      "Standard protocols: Gmail API, Microsoft Graph, or IMAP/SMTP. Fully supported by your provider. No terms broken, full history, no surprise expiry. The only channel where this app is a normal mail client."
    }
  }

  /// The bold clause each card carries; Email carries none (12.A legend 4).
  public static func warning(_ channel: OnboardingChannel) -> String? {
    switch channel {
    case .imessage: "second copy of your entire iMessage history on this disk"
    case .whatsapp: "against WhatsApp's terms and your phone number can be banned"
    case .linkedin: "LinkedIn can restrict your account for this."
    case .email: nil
    }
  }

  public static let notConnected = "NOT CONNECTED"
  public static let skipped = "SKIPPED"
  public static let connect = "Connect"
  public static let skip = "Skip"
  public static let anySubset = "Any subset works. You can add or remove a channel at any time in Settings."
  public static func continueWith(_ n: Int) -> String { "Continue with \(n) connected" }

  // 12.B
  public static let setUpIMessage = "Set up iMessage"
  public static let waiting = "Waiting for Full Disk Access."
  public static let waitingDetail =
    "Checking every 2 seconds. macOS will ask you to quit WeMessage; reopen it and setup resumes here."
  public static let openAgain = "Open System Settings again"
  public static let sizedTitle = "Here is what the second copy will be"
  public static let sizedFoot =
    "The copy goes to ~/Library/Application Support/WeMessage/wemessage.db and stays there until you delete it. The original chat.db is opened read-only and never modified."
  public static let attachments = "not copied; read in place"
  public static let makeCopy = "Make the copy"
  public static let copying = "Copying, dated"
  public static func copied(_ n: Int) -> String {
    "\(count(n)) copied. You can use the app now; search covers what has arrived so far."
  }
  public static let continueLabel = "Continue"

  // 12.C to 12.E: the disclosures, drawn before anything is asked.
  public static func setUp(_ channel: OnboardingChannel) -> String { "Set up \(channel.name)" }
  public static func disclosure(_ channel: OnboardingChannel) -> (String, String) {
    switch channel {
    case .imessage:
      ("", "")
    case .whatsapp:
      (
        "Read this before you scan",
        "WhatsApp has no official way for an app like this to reach a personal account. WeMessage connects by behaving as a linked device, the same protocol WhatsApp's own desktop app uses. That is against WhatsApp's terms of service. WhatsApp can ban your phone number for it, and if that happens we cannot get it back for you."
      )
    case .linkedin:
      (
        "What connecting LinkedIn means",
        "LinkedIn offers no messaging API to anyone. WeMessage signs in as you and reads your inbox through the same private endpoints LinkedIn's own site uses, slowly, at a fixed pace it will not exceed. LinkedIn can restrict or suspend accounts that do this."
      )
    case .email:
      (
        "Email uses standard protocols",
        "Email uses standard protocols your provider supports on purpose. Nothing here is against anyone's terms, and there is no ban risk."
      )
    }
  }
  public static func notBuilt(_ channel: OnboardingChannel) -> String {
    "Connecting \(channel.name) is not in this version of WeMessage. Nothing is asked for and nothing is connected."
  }
  public static func skipChannel(_ channel: OnboardingChannel) -> String { "Skip \(channel.name)" }

  // 12.F
  public static let agentTitle = "AI agent"
  public static let agentQuestion = "Should an agent draft replies for you?"
  public static let noDrafting = "No drafting"
  public static let noDraftingDetail =
    "The agent can summarize, search, and triage when you ask. It writes nothing in your voice. You can turn drafting on later in Settings."
  public static let draftNeverSend = "Draft, never send"
  public static let draftDetail =
    "The agent may write a reply and park it as a dashed draft in the thread. Nothing leaves this Mac until you read that exact text and approve it."
  public static let draftOn = "Draft on:"
  public static let invariantTitle = "Either way, this is true"
  public static let invariant =
    "The agent cannot send. Not \u{201C}will not,\u{201D} cannot: there is one send function in the app, it requires an approval record that only your keypress can create, and no agent, including one connected over MCP, has a code path to it. This is not a setting. There is nothing to turn off."
  public static let finish = "Finish setup"
  public static let killTitle = "Introduced now: the kill switch"
  public static let killWhere = "KILL SWITCH \u{00B7} menu bar \u{00B7} \u{21E7}\u{2318}K \u{00B7} Settings"
  public static let killDetail =
    "One control stops every outbound action at once: yours, the agent's, and anything connected over MCP. Reading continues. Held drafts stay held. You do not need it today. You need to know it is there."
  public static let killOn = "KILL SWITCH ON. No message can be sent by anything."
  public static let killOnDetail =
    "Reading continues. Held drafts will not send. Agents over MCP receive an explicit refusal. This is what it looks like."

  // 12.G
  public static func complete(_ connected: Int) -> String { "Setup complete \u{00B7} \(connected) of 4 connected" }
  public static func agentLine(_ progress: OnboardingProgress) -> String {
    guard progress.drafting else { return "Agent: no drafting." }
    let on = OnboardingChannel.allCases.filter { progress.draftChannels.contains($0) }.map(\.name)
    return on.isEmpty ? "Agent: drafting chosen, on no channel yet." : "Agent: drafts on " + on.joined(separator: ", ") + ", never sends."
  }
  public static func doneLine(_ channel: OnboardingChannel, _ progress: OnboardingProgress) -> String {
    if progress.declined.contains(channel) { return "declined by you" }
    if channel == .imessage && progress.copyStarted { return "copy started" }
    return "not connected"
  }
  public static let openInbox = "Open inbox"

  // 12.I
  public static let coachLead = "These four work whenever the list has focus. Never while you are typing. Z undoes any of them."
  public static let coachKeys: [(String, String)] = [("R", "Reply"), ("E", "Done"), ("H", "Snooze"), ("M", "Mute")]
  public static let coachDismiss = "Press any key to dismiss this bar. Click any channel to collapse the sidebar."
  public static let voiceIdle = "Idle"
  public static let voiceInvocation = "\u{21E7}\u{2318}V or hold Fn"

  static func count(_ n: Int) -> String {
    let f = NumberFormatter()
    f.numberStyle = .decimal
    f.locale = Locale(identifier: "en_US")
    return f.string(from: NSNumber(value: n)) ?? String(n)
  }
}
