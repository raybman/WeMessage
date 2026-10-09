import Foundation

// v2 B3, board 04: LinkedIn over fixtures. Every type here is a typed reading
// of the per-board `meta` carrier on ThreadSummary, ThreadTurn and
// StatusPayload. Nothing is required: a field that is absent or the wrong
// shape falls back to the safe default, and the safe default is always the
// one that offers less: no composer rather than a composer that might fail,
// paused rather than live, a request rather than an open thread.

/// The three places one LinkedIn identity can hold threads (04.E). A reply
/// always goes back to the inbox the thread was born in.
public enum LinkedInInbox: String, CaseIterable, Sendable {
  case personal, salesNav, recruiter

  /// An absent or unknown inbox reads as plain messaging.
  public init(wire: String?) { self = wire.flatMap(Self.init(rawValue:)) ?? .personal }

  /// The soft origin tag a row carries while the scope shows every inbox.
  public var tag: String {
    switch self {
    case .personal: "MSG"
    case .salesNav: "SN"
    case .recruiter: "REC"
    }
  }

  /// The product's name, as the banner prints it.
  public var title: String {
    switch self {
    case .personal: "Messaging"
    case .salesNav: "Sales Navigator"
    case .recruiter: "Recruiter"
    }
  }

  /// The name where space is short: the inbox switch and the inspector.
  public var shortTitle: String {
    switch self {
    case .personal: "Messaging"
    case .salesNav: "Sales Nav"
    case .recruiter: "Recruiter"
    }
  }
}

/// LinkedIn's own classifier (04.A). We display it; we cannot re-derive it.
public enum LinkedInCategory: String, CaseIterable, Sendable {
  case focused, other

  /// An absent or unknown category reads as Focused, LinkedIn's default tab.
  public init(wire: String?) { self = wire.flatMap(Self.init(rawValue:)) ?? .focused }

  public var title: String {
    switch self {
    case .focused: "Focused"
    case .other: "Other"
    }
  }
}

/// The eligibility ladder (04.B): which path reaches this person, resolved
/// on thread open. The wire carries the step as 0 to 4.
public enum LinkedInRung: Int, CaseIterable, Comparable, Sendable {
  /// 1st degree: a plain message, free.
  case message = 0
  /// Open Profile: the InMail form, no credit charged.
  case openProfile = 1
  /// InMail: one credit.
  case inMail = 2
  /// A message request through shared context: free, no attachments.
  case request = 3
  /// Nothing reaches them: no composer.
  case none = 4

  /// A missing, unknown or out-of-range step is the bottom of the ladder:
  /// the app never draws a composer it cannot vouch for.
  public init(wire: Int?) { self = wire.flatMap(Self.init(rawValue:)) ?? .none }

  public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

  /// Only InMail spends a credit.
  public var costsCredit: Bool { self == .inMail }

  /// Open Profile and InMail use the InMail form: a subject and a body.
  public var hasSubject: Bool { self == .openProfile || self == .inMail }

  /// LinkedIn refuses attachments in a request, and nothing goes where
  /// nothing can be sent.
  public var allowsAttachments: Bool { self != .request && self != .none }

  /// Whether any composer can be drawn for this step.
  public var hasComposer: Bool { self != .none }
}

/// An inbound message request (04.D). Accepting opens the thread; declining
/// is private.
public enum LinkedInRequestState: String, Sendable {
  case none, pending, accepted, declined

  /// Absent means no request. A request state this version does not know
  /// reads as pending: nothing can be replied to until it is understood.
  public init(_ value: JSONValue?) {
    guard let raw = value?.stringValue else {
      self = .none
      return
    }
    self = Self(rawValue: raw) ?? .pending
  }
}

/// What a thread lets you do, after its request state and its rung. Absent
/// means absent: the board draws only what is true here.
public struct LinkedInCapabilities: Equatable, Sendable {
  public let canReply: Bool
  public let canReact: Bool
  public let canAttach: Bool
  public let canAccept: Bool
  public let canDeclinePrivately: Bool

  public init(request: LinkedInRequestState, rung: LinkedInRung) {
    switch request {
    case .pending:
      // "No reactions, no reply, and no attachments until you accept."
      canReply = false
      canReact = false
      canAttach = false
      canAccept = true
      canDeclinePrivately = true
    case .declined:
      // Kept read-only, and the user may still accept after all.
      canReply = false
      canReact = false
      canAttach = false
      canAccept = true
      canDeclinePrivately = false
    case .none, .accepted:
      canReply = rung.hasComposer
      canReact = true
      canAttach = rung.allowsAttachments
      canAccept = false
      canDeclinePrivately = false
    }
  }
}

/// One row of the inspector's cross-channel history (04.G). A nil line is
/// printed as "none", never dropped: an absent row and an unsearched row
/// must not look the same.
public struct LinkedInHistoryRow: Equatable, Sendable {
  public let channel: Channel
  public let line: String?
}

/// `thread.meta` for a LinkedIn thread.
public struct LinkedInThreadMeta: Equatable, Sendable {
  public let inbox: LinkedInInbox
  public let category: LinkedInCategory
  public let requestState: LinkedInRequestState
  public let rung: LinkedInRung
  /// "1st", "2nd" or "3rd"; nil for a company page.
  public let degree: String?
  public let headline: String?
  public let location: String?
  /// The shared group or employer, as LinkedIn names it.
  public let shared: String?
  /// The Recruiter project a thread belongs to.
  public let project: String?
  /// An address from the person's own profile. The inspector offers it and
  /// never uses it unasked.
  public let alsoReachable: String?
  /// Prior history per channel, by the channel's raw value.
  public let history: [String: String]

  public init(meta: [String: JSONValue]?) {
    let m = meta ?? [:]
    inbox = LinkedInInbox(wire: m["inbox"]?.stringValue)
    category = LinkedInCategory(wire: m["category"]?.stringValue)
    requestState = LinkedInRequestState(m["requestState"])
    rung = LinkedInRung(wire: m["eligibility"]?.intValue)
    degree = Self.text(m["degree"])
    headline = Self.text(m["headline"])
    location = Self.text(m["location"])
    shared = Self.text(m["shared"])
    project = Self.text(m["project"])
    alsoReachable = Self.text(m["alsoReachable"])
    var history: [String: String] = [:]
    for (key, value) in m["history"]?.objectValue ?? [:] {
      if let line = Self.text(value) { history[key] = line }
    }
    self.history = history
  }

  public init(_ thread: ThreadSummary) { self.init(meta: thread.meta) }

  public var capabilities: LinkedInCapabilities { LinkedInCapabilities(request: requestState, rung: rung) }

  /// LinkedIn first, then email, WhatsApp and iMessage, every one present.
  public var historyRows: [LinkedInHistoryRow] {
    [Channel.linkedin, .email, .whatsapp, .imessage].map { LinkedInHistoryRow(channel: $0, line: history[$0.rawValue]) }
  }

  private static func text(_ value: JSONValue?) -> String? {
    guard let s = value?.stringValue, !s.isEmpty else { return nil }
    return s
  }
}

/// An InMail's own fields: its subject and the credits it cost.
public struct LinkedInInMail: Equatable, Sendable {
  public let subject: String
  public let credits: Int

  /// Nil without a subject: an InMail with nothing to name is drawn as a
  /// plain message.
  public init?(_ value: JSONValue?) {
    guard let subject = value?["subject"]?.stringValue, !subject.isEmpty else { return nil }
    self.subject = subject
    credits = max(0, value?["credits"]?.intValue ?? 0)
  }
}

/// The three inbound payloads that are not text (04.F).
public enum LinkedInCommercialKind: String, CaseIterable, Sendable {
  case sponsored, recruiter, job

  /// The soft tag the header prints.
  public var tag: String {
    switch self {
    case .sponsored: "SPONSORED"
    case .recruiter: "RECRUITER"
    case .job: "JOB"
    }
  }
}

/// A commercial payload on one message.
public struct LinkedInCommercial: Equatable, Sendable {
  public let kind: LinkedInCommercialKind
  public let title: String?
  public let detail: String?
  public let file: String?
  public let fileBytes: Int64

  /// Nil for a kind this version does not know: it is drawn as text.
  public init?(_ value: JSONValue?) {
    guard let kind = value?["kind"]?.stringValue.flatMap(LinkedInCommercialKind.init(rawValue:)) else { return nil }
    self.kind = kind
    title = value?["title"]?.stringValue
    detail = value?["detail"]?.stringValue
    file = value?["file"]?.stringValue
    fileBytes = Int64(max(0, value?["fileBytes"]?.intValue ?? 0))
  }
}

/// `turn.meta` for one LinkedIn message.
public struct LinkedInTurnMeta: Equatable, Sendable {
  public let inMail: LinkedInInMail?
  public let commercial: LinkedInCommercial?

  public init(meta: [String: JSONValue]?) {
    inMail = LinkedInInMail(meta?["inMail"])
    commercial = LinkedInCommercial(meta?["commercial"])
  }

  public init(_ turn: ThreadTurn) { self.init(meta: turn.meta) }

  /// The first commercial payload in a thread's turns: it names the thread.
  public static func commercial(in turns: [ThreadTurn]) -> LinkedInCommercial? {
    turns.lazy.compactMap { LinkedInTurnMeta($0).commercial }.first
  }
}

/// `status.meta.linkedin`: the account's dated counters, and the pause.
public struct LinkedInStatusMeta: Equatable, Sendable {
  public let account: String?
  public let asOf: Date?
  public let plan: String?
  /// Our pacing budget left this hour.
  public let sendsLeft: Int?
  public let resetsAt: Date?
  public let credits: [LinkedInInbox: Int]
  public let unread: [LinkedInInbox: Int]
  /// Present while LinkedIn has pushed back (04.H).
  public let pausedUntilRaw: String?

  public init(_ value: JSONValue?) {
    account = value?["account"]?.stringValue
    asOf = value?["asOf"]?.stringValue.flatMap(WireDate.parse)
    plan = value?["plan"]?.stringValue
    sendsLeft = value?["sendsLeft"]?.intValue.map { max(0, $0) }
    resetsAt = value?["resetsAt"]?.stringValue.flatMap(WireDate.parse)
    credits = Self.perInbox(value?["credits"])
    unread = Self.perInbox(value?["unread"])
    let paused = value?["pausedUntil"]
    // Anything there at all pauses, even a value that does not parse: a
    // pushback we cannot read is still a pushback.
    pausedUntilRaw = paused == nil || paused == .null ? nil : (paused?.stringValue ?? "")
  }

  /// Reads `meta.linkedin` off a status payload.
  public init(status: StatusPayload?) { self.init(status?.meta?["linkedin"]) }

  public var paused: Bool { pausedUntilRaw != nil }

  public var pausedUntil: Date? { pausedUntilRaw.flatMap(WireDate.parse) }

  /// The rail's figure is the sum; the inspector shows the split.
  public var totalUnread: Int { unread.values.reduce(0, +) }

  private static func perInbox(_ value: JSONValue?) -> [LinkedInInbox: Int] {
    var out: [LinkedInInbox: Int] = [:]
    for inbox in LinkedInInbox.allCases {
      if let n = value?[inbox.rawValue]?.intValue { out[inbox] = max(0, n) }
    }
    return out
  }
}

/// The list's two LinkedIn lenses: the category tab, and the inbox switch.
public struct LinkedInFilter: Equatable, Sendable {
  public var category: LinkedInCategory
  /// Nil shows all three inboxes.
  public var inbox: LinkedInInbox?

  public init(category: LinkedInCategory = .focused, inbox: LinkedInInbox? = nil) {
    self.category = category
    self.inbox = inbox
  }

  public func admits(_ meta: LinkedInThreadMeta) -> Bool {
    guard meta.category == category else { return false }
    guard let inbox else { return true }
    return meta.inbox == inbox
  }

  /// A thread on another channel is never this filter's business.
  public func admits(_ thread: ThreadSummary) -> Bool {
    guard thread.channel == Channel.linkedin.rawValue else { return true }
    return admits(LinkedInThreadMeta(thread))
  }

  /// Rows carry an origin tag only while every inbox shows: narrowed to one,
  /// the container disambiguates and the tag is dropped (04.E).
  public var showsOriginTags: Bool { inbox == nil }
}

/// Where a reply goes (04.E): the origin decides, always.
public enum LinkedInRoute {
  public static func replyInbox(_ meta: LinkedInThreadMeta) -> LinkedInInbox { meta.inbox }

  /// LinkedIn threads per inbox, every inbox present.
  public static func counts(_ threads: [ThreadSummary]) -> [LinkedInInbox: Int] {
    var out = Dictionary(uniqueKeysWithValues: LinkedInInbox.allCases.map { ($0, 0) })
    for t in threads where t.channel == Channel.linkedin.rawValue {
      out[LinkedInThreadMeta(t).inbox, default: 0] += 1
    }
    return out
  }
}

/// The composer a thread gets, decided before it is drawn (04.B, 04.F, 04.H).
public enum LinkedInComposer: Equatable, Sendable {
  /// A composer for this rung.
  case composer(LinkedInRung)
  /// No composer, and why.
  case absent(Reason)

  public enum Reason: String, Sendable {
    /// An ad: nothing typed here reaches anyone.
    case sponsored
    /// LinkedIn pushed back: nothing leaves before the pause ends.
    case paused
    /// An inbound request waiting on accept or decline.
    case requestPending
    /// A request declined privately, kept read-only.
    case requestDeclined
    /// No rung of the ladder reaches them.
    case noRung
  }

  /// Sponsored first (an ad has no listener, paused or not), then the pause
  /// (it stops every rung at once), then the request, then the ladder.
  public static func resolve(_ meta: LinkedInThreadMeta, commercial: LinkedInCommercialKind?, paused: Bool) -> Self {
    if commercial == .sponsored { return .absent(.sponsored) }
    if paused { return .absent(.paused) }
    switch meta.requestState {
    case .pending: return .absent(.requestPending)
    case .declined: return .absent(.requestDeclined)
    case .none, .accepted: break
    }
    guard meta.rung.hasComposer else { return .absent(.noRung) }
    return .composer(meta.rung)
  }

  public var allowsDraft: Bool {
    if case .composer = self { return true }
    return false
  }
}

/// InMail's hard caps (04.C). The field stops at the cap; it never lets you
/// type past it and fail on send.
public enum LinkedInCaps {
  public static let subject = 200
  public static let body = 2000

  /// `text` cut to `cap` characters.
  public static func clamp(_ text: String, _ cap: Int) -> String {
    text.count <= cap ? text : String(text.prefix(cap))
  }

  /// Characters left under `cap`, never below zero.
  public static func left(_ text: String, _ cap: Int) -> Int { max(0, cap - text.count) }
}
