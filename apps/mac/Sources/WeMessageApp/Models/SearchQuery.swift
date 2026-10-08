import Foundation

// v2 S4i, board 11.B: the search grammar. Operators are typed and become
// tokens; a token is the truth: what the user sees drawn is exactly what the
// matcher received. A chunk that looks like an operator and does not parse
// is never dropped: it becomes an unparsed token, drawn dashed, and it still
// constrains the search as literal text (D-UI-80). Pure: no clock, no I/O.

/// The four channels a channel: token may name (11.B: "offers exactly the four").
public enum SearchChannel: String, CaseIterable, Sendable {
  case imessage, whatsapp, linkedin, email

  public var label: String {
    switch self {
    case .imessage: "iMessage"
    case .whatsapp: "WhatsApp"
    case .linkedin: "LinkedIn"
    case .email: "Email"
    }
  }
}

/// What a has: token may ask for.
public enum SearchHas: String, CaseIterable, Sendable {
  case attachment, link, voice
}

/// A before: or after: bound: the start of a day or of a year, in the
/// calendar the query was parsed in. Compared against sent time only (11.C).
public struct SearchDate: Equatable, Sendable {
  public enum Grain: Equatable, Sendable { case day, year }
  public let start: Date
  public let grain: Grain
  /// What the user typed after the colon.
  public let text: String
}

/// Who a from: token names.
public enum SearchFrom: Equatable, Sendable {
  /// from:me, the user's own messages, every channel.
  case me
  /// A sender by name, handle, number or address; matched case-insensitively.
  case name(String)
}

/// Why a chunk stayed text.
public enum UnparsedReason: String, Equatable, Sendable {
  /// "foo:bar": no such operator.
  case unknownOperator = "unknown operator"
  /// "from:" with nothing after it.
  case emptyValue = "no value"
  /// "before:last" or "after:2024-02-30".
  case badDate = "not a date"
  /// "channel:sms".
  case badChannel = "not a channel"
  /// "has:gif".
  case badHas = "not a kind"
  /// in:"Family (6 with no closing quote.
  case unclosedQuote = "unclosed quote"
}

/// One token of a query, in the order typed.
public enum SearchToken: Equatable, Sendable {
  /// A bare word, or a quoted phrase without its quotes.
  case term(String)
  case from(SearchFrom)
  case inThread(String)
  case channel(SearchChannel)
  case has(SearchHas)
  case before(SearchDate)
  case after(SearchDate)
  /// Typed like an operator and did not parse: drawn dashed, matched as text.
  case unparsed(raw: String, reason: UnparsedReason)

  public var isParsed: Bool {
    if case .unparsed = self { return false }
    return true
  }
}

/// A chip's words: the operator ("from:", nil for a bare term), its value,
/// and whether it parsed.
public struct TokenChip: Equatable, Sendable, Identifiable {
  public let id: Int
  public let op: String?
  public let value: String
  public let parsed: Bool
  /// The chunk of the raw query this chip came from, so removing the chip
  /// removes exactly that text.
  public let source: String
  /// Why it did not parse, when it did not.
  public let reason: UnparsedReason?

  /// "from: jordan", "after: 2024-01-01", "invoice".
  public var text: String { op.map { "\($0) \(value)" } ?? value }
}

public struct SearchQuery: Equatable, Sendable {
  public static let operators = ["from", "in", "channel", "has", "before", "after"]

  public let raw: String
  public let tokens: [SearchToken]
  public let chips: [TokenChip]

  public var isEmpty: Bool { tokens.isEmpty }
  public var unparsed: [SearchToken] { tokens.filter { !$0.isParsed } }

  /// The words a message body must contain, lowercased: every bare term and
  /// every unparsed chunk, which stays text (D-UI-80).
  public var terms: [String] {
    tokens.compactMap {
      switch $0 {
      case .term(let word): word
      case .unparsed(let raw, _): raw
      default: nil
      }
    }
  }

  /// The bare terms only: what the snippet underlines.
  public var highlightTerms: [String] {
    tokens.compactMap { if case .term(let word) = $0 { return word } else { return nil } }
  }

  public static func parse(_ raw: String, calendar: Calendar = .current) -> SearchQuery {
    let chunks = split(raw)
    var tokens: [SearchToken] = []
    var chips: [TokenChip] = []
    var i = 0
    while i < chunks.count {
      let chunk = chunks[i]
      i += 1
      guard let colon = chunk.text.firstIndex(of: ":"), isOperatorName(chunk.text[..<colon]) else {
        let word = unquote(chunk.text)
        if chunk.unclosed {
          tokens.append(.unparsed(raw: chunk.text, reason: .unclosedQuote))
          chips.append(TokenChip(id: chips.count, op: nil, value: chunk.text, parsed: false, source: chunk.text, reason: .unclosedQuote))
        } else if !word.isEmpty {
          tokens.append(.term(word))
          chips.append(TokenChip(id: chips.count, op: nil, value: word, parsed: true, source: chunk.text, reason: nil))
        }
        continue
      }
      let name = chunk.text[..<colon].lowercased()
      var value = String(chunk.text[chunk.text.index(after: colon)...])
      var source = chunk.text
      var unclosed = chunk.unclosed
      // "from: jordan": an operator with a space before its value takes the
      // next chunk, when that chunk is not itself an operator.
      if value.isEmpty, i < chunks.count, !looksLikeOperator(chunks[i].text) {
        value = chunks[i].text
        source += " " + chunks[i].text
        unclosed = chunks[i].unclosed
        i += 1
      }
      let token = unclosed ? .unparsed(raw: source, reason: .unclosedQuote) : operatorToken(name, unquote(value), source, calendar)
      tokens.append(token)
      switch token {
      case .unparsed(_, let reason):
        chips.append(TokenChip(id: chips.count, op: name + ":", value: unquote(value), parsed: false, source: source, reason: reason))
      default:
        chips.append(TokenChip(id: chips.count, op: name + ":", value: unquote(value), parsed: true, source: source, reason: nil))
      }
    }
    return SearchQuery(raw: raw, tokens: tokens, chips: chips)
  }

  /// The raw query without one chip's text: the chip's ×.
  public func removing(_ chip: TokenChip) -> String {
    guard let range = raw.range(of: chip.source) else { return raw }
    var out = raw
    out.removeSubrange(range)
    return out.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
  }

  // MARK: parsing helpers

  struct Chunk {
    let text: String
    let unclosed: Bool
  }

  /// Splits on whitespace outside double quotes. A quote left open runs to
  /// the end and marks its chunk unclosed.
  static func split(_ raw: String) -> [Chunk] {
    var out: [Chunk] = []
    var current = ""
    var quoted = false
    for ch in raw {
      if ch == "\"" {
        quoted.toggle()
        current.append(ch)
      } else if ch.isWhitespace && !quoted {
        if !current.isEmpty { out.append(Chunk(text: current, unclosed: false)) }
        current = ""
      } else {
        current.append(ch)
      }
    }
    if !current.isEmpty { out.append(Chunk(text: current, unclosed: quoted)) }
    return out
  }

  /// Letters only before the colon: "from:", "foo:". "10:30" and
  /// "https://" are not operator-shaped... except "https", which is letters,
  /// and so is surfaced as an unknown operator rather than silently matched.
  static func isOperatorName(_ name: Substring) -> Bool {
    !name.isEmpty && name.allSatisfy { $0.isASCII && $0.isLetter }
  }

  static func looksLikeOperator(_ text: String) -> Bool {
    guard let colon = text.firstIndex(of: ":") else { return false }
    return isOperatorName(text[..<colon])
  }

  static func unquote(_ text: String) -> String {
    var t = text
    if t.hasPrefix("\"") { t.removeFirst() }
    if t.hasSuffix("\"") && !t.isEmpty { t.removeLast() }
    return t
  }

  static func operatorToken(_ name: String, _ value: String, _ source: String, _ calendar: Calendar) -> SearchToken {
    guard operators.contains(name) else { return .unparsed(raw: source, reason: .unknownOperator) }
    let trimmed = value.trimmingCharacters(in: .whitespaces)
    guard !trimmed.isEmpty else { return .unparsed(raw: source, reason: .emptyValue) }
    switch name {
    case "from":
      return .from(trimmed.lowercased() == "me" ? .me : .name(trimmed))
    case "in":
      return .inThread(trimmed)
    case "channel":
      guard let channel = SearchChannel(rawValue: trimmed.lowercased()) else { return .unparsed(raw: source, reason: .badChannel) }
      return .channel(channel)
    case "has":
      guard let kind = SearchHas(rawValue: trimmed.lowercased()) else { return .unparsed(raw: source, reason: .badHas) }
      return .has(kind)
    case "before", "after":
      guard let date = date(trimmed, calendar: calendar) else { return .unparsed(raw: source, reason: .badDate) }
      return name == "before" ? .before(date) : .after(date)
    default:
      return .unparsed(raw: source, reason: .unknownOperator)
    }
  }

  /// "2024" or "2024-01-01", nothing else. A day that does not exist
  /// (2024-02-30) is not a date: it is never rolled into March.
  static func date(_ text: String, calendar: Calendar) -> SearchDate? {
    let parts = text.split(separator: "-", omittingEmptySubsequences: false)
    guard parts.allSatisfy({ !$0.isEmpty && $0.allSatisfy(\.isASCII) && $0.allSatisfy(\.isNumber) }) else { return nil }
    if parts.count == 1, parts[0].count == 4, let year = Int(parts[0]) {
      guard let start = calendar.date(from: DateComponents(year: year, month: 1, day: 1)) else { return nil }
      return SearchDate(start: start, grain: .year, text: text)
    }
    guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
      let year = Int(parts[0]), let month = Int(parts[1]), let day = Int(parts[2])
    else { return nil }
    guard let start = calendar.date(from: DateComponents(year: year, month: month, day: day)) else { return nil }
    let back = calendar.dateComponents([.year, .month, .day], from: start)
    guard back.year == year, back.month == month, back.day == day else { return nil }
    return SearchDate(start: start, grain: .day, text: text)
  }
}

// MARK: - matching

/// One searchable message: what the corpus holds per turn. Dates are sent
/// time; nothing here carries an ingest time (11.C).
public struct SearchDoc: Equatable, Sendable {
  public let guid: String
  public let threadGuid: String
  public let threadTitle: String
  public let isGroup: Bool
  public let channel: String
  public let outbound: Bool
  /// Who said it: "You" for the user, else the sender's name or handle.
  public let sender: String
  public let handle: String?
  public let text: String
  public let sentAt: Date
  public let hasAttachment: Bool
  public let hasLink: Bool
  public let hasVoice: Bool

  public init(
    guid: String, threadGuid: String, threadTitle: String, isGroup: Bool, channel: String, outbound: Bool, sender: String,
    handle: String?, text: String, sentAt: Date, hasAttachment: Bool = false, hasLink: Bool = false, hasVoice: Bool = false
  ) {
    self.guid = guid
    self.threadGuid = threadGuid
    self.threadTitle = threadTitle
    self.isGroup = isGroup
    self.channel = channel
    self.outbound = outbound
    self.sender = sender
    self.handle = handle
    self.text = text
    self.sentAt = sentAt
    self.hasAttachment = hasAttachment
    self.hasLink = hasLink
    self.hasVoice = hasVoice
  }
}

extension SearchQuery {
  static let fold: String.CompareOptions = [.caseInsensitive, .diacriticInsensitive]

  static func contains(_ haystack: String, _ needle: String) -> Bool {
    haystack.range(of: needle, options: fold) != nil
  }

  /// Every token must hold, except channel: tokens, which OR together
  /// (11.B: "repeatable; two tokens OR together").
  public func matches(_ doc: SearchDoc) -> Bool {
    var channels: [SearchChannel] = []
    for token in tokens {
      switch token {
      case .term(let word):
        if !Self.contains(doc.text, word) { return false }
      case .unparsed(let raw, _):
        if !Self.contains(doc.text, raw) { return false }
      case .from(.me):
        if !doc.outbound { return false }
      case .from(.name(let name)):
        if doc.outbound { return false }
        if !Self.contains(doc.sender, name) && !Self.contains(doc.handle ?? "", name) { return false }
      case .inThread(let title):
        if !Self.contains(doc.threadTitle, title) { return false }
      case .channel(let channel):
        channels.append(channel)
      case .has(.attachment):
        if !doc.hasAttachment { return false }
      case .has(.link):
        if !doc.hasLink { return false }
      case .has(.voice):
        if !doc.hasVoice { return false }
      case .before(let date):
        if !(doc.sentAt < date.start) { return false }
      case .after(let date):
        if !(doc.sentAt >= date.start) { return false }
      }
    }
    if !channels.isEmpty && !channels.contains(where: { $0.rawValue == doc.channel }) { return false }
    return true
  }
}
