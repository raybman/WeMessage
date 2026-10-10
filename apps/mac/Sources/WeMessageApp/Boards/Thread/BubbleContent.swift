import SwiftUI
import WeMessageKit

/// Board 08's words, pure: what a specimen prints for a size, a duration, a
/// long transcript and an emoji. AppTests hold each one.
enum SpecimenText {
  /// Decimal megabytes, one place when it is not whole: 2400000 is
  /// "2.4 MB", 64000000 is "64 MB". Under a megabyte, whole kilobytes.
  static func size(_ bytes: Int) -> String {
    if bytes < 1_000_000 { return "\(max(1, Int((Double(bytes) / 1000).rounded()))) KB" }
    return megabytes(bytes) + " MB"
  }

  /// A download's progress: "18.2 of 64 MB".
  static func progress(received: Int, of total: Int) -> String {
    megabytes(received) + " of " + megabytes(total) + " MB"
  }

  static func megabytes(_ bytes: Int) -> String {
    let tenths = Int((Double(bytes) / 100_000).rounded())
    return tenths % 10 == 0 ? "\(tenths / 10)" : "\(tenths / 10).\(tenths % 10)"
  }

  /// m:ss.
  static func duration(_ seconds: Int) -> String {
    String(format: "%d:%02d", seconds / 60, seconds % 60)
  }

  /// 08.E: a transcript is drawn in full up to `lines` lines of about
  /// `perLine` characters, and past that cut at the last word that fits,
  /// with an ellipsis. Pure, so the collapse never depends on a line limit
  /// the accessibility audit would read as clipped text.
  static func collapse(_ transcript: String, lines: Int = 4, perLine: Int = 52) -> (shown: String, collapsed: Bool) {
    let budget = lines * perLine
    guard transcript.count > budget else { return (transcript, false) }
    var shown = ""
    for word in transcript.split(separator: " ", omittingEmptySubsequences: true) {
      let next = shown.isEmpty ? String(word) : shown + " " + word
      if next.count + 1 > budget { break }
      shown = next
    }
    while let last = shown.last, last == "," || last == "." || last == ";" { shown.removeLast() }
    return (shown + "\u{2026}", true)
  }

  /// D-UI-40: every emoji in `text` in its text presentation (U+FE0E
  /// after it, any U+FE0F dropped), so no glyph can draw in colour.
  static func textPresentation(_ text: String) -> String {
    guard ProvisionalUI.emojiPresentation == .textMonochrome else { return text }
    var out = String.UnicodeScalarView()
    for scalar in text.unicodeScalars where scalar.value != 0xFE0F && scalar.value != 0xFE0E {
      out.append(scalar)
      if scalar.value > 0x7F, scalar.properties.isEmoji, let text = Unicode.Scalar(0xFE0E) { out.append(text) }
    }
    return String(out)
  }

  /// "@name" underlined, never tinted (08.B: the underline survives a
  /// grayscale print).
  static func mentions(_ text: String) -> AttributedString {
    var out = AttributedString()
    var first = true
    for word in text.split(separator: " ", omittingEmptySubsequences: false) {
      if !first { out += AttributedString(" ") }
      first = false
      var piece = AttributedString(String(word))
      if word.hasPrefix("@"), word.count > 1 { piece.underlineStyle = .single }
      out += piece
    }
    return out
  }

  /// What a delivery state says inside its bubble.
  static func delivery(_ delivery: Delivery, zone: TimeZone) -> String {
    switch delivery {
    case .sending: return "Sending\u{2026}"
    case .sent(let at): return at.map { "Sent " + ShellText.shortClock($0, zone: zone) } ?? "Sent"
    case .delivered: return "Delivered"
    case .read(let at): return "Read " + ShellText.shortClock(at, zone: zone)
    case .notDelivered(let reason): return "Not delivered: " + reason
    }
  }

  /// 08.A note 3: the delivery state rides the last outbound turn only, so
  /// a long thread does not double its lines with receipts. Every other
  /// turn comes back as it was, less its delivery. v2 F4: a failure stays
  /// where it happened, because a message that never arrived is not a
  /// receipt (D-UI-197).
  static func statusOnLastOutbound(_ turns: [MessageTurn]) -> [MessageTurn] {
    let last = turns.lastIndex { $0.direction == .outbound }
    return turns.indices.map { index in
      let turn = turns[index]
      guard index != last, let delivery = turn.delivery, !delivery.isFailure else { return turn }
      return MessageTurn(
        guid: turn.guid, direction: turn.direction, kind: turn.kind, text: turn.text, sentAt: turn.sentAt,
        handle: turn.handle, isEdited: turn.isEdited, isUnsent: turn.isUnsent, attachments: turn.attachments,
        service: turn.service, delivery: nil, reactions: turn.reactions, effect: turn.effect, quote: turn.quote,
        isForwarded: turn.isForwarded)
    }
  }

  /// v2 F4: a file's name, or the words for one the source did not name
  /// (D-UI-200). A sticker is the word, not its file name (D-UI-202).
  static func fileName(_ attachment: MessageTurn.Attachment) -> String {
    if attachment.sticker == true { return ProvisionalUI.stickerLine }
    return attachment.name ?? ProvisionalUI.untitledFile
  }

  /// v2 F4: media with no dimensions, as its tile reads: the name and,
  /// when known, the size (D-UI-201).
  static func mediaTile(_ attachment: MessageTurn.Attachment) -> String {
    [fileName(attachment), attachment.bytes.map(size)].compactMap { $0 }.joined(separator: " \u{00B7} ")
  }

  /// What a reaction chip says to a screen reader. v2 F4: a chip with a
  /// word says it ("Loved, 1"), and one that counts mine says so
  /// (D-UI-196). A chip with no word keeps its glyph.
  static func reactionLabel(_ reaction: MessageTurn.Reaction) -> String {
    guard let name = reaction.name else {
      return "Reaction \(textPresentation(reaction.glyph)), \(reaction.count)"
    }
    return "\(name), \(reaction.count)" + (reaction.isMine ? ProvisionalUI.reactionMineSuffix : "")
  }

  /// A file's badge: its type's short name ("PDF", "ZIP").
  static func badge(_ attachment: MessageTurn.Attachment) -> String {
    let sub = (attachment.mime ?? "").split(separator: "/").last.map(String.init) ?? ""
    let short = sub.split(separator: "-").last.map(String.init) ?? sub
    return String(short.prefix(4)).uppercased()
  }

  /// What a payload is, for its spoken label.
  static func spoken(_ kind: MessageTurn.Kind, text: String?) -> String? {
    switch kind {
    case .media(let items):
      let what = items.count == 1 ? ((items[0].mime ?? "").hasPrefix("video/") ? "Video" : "Photo") : "Album of \(items.count)"
      return [what, text].compactMap { $0 }.joined(separator: ", ")
    case .voice(let transcript, let seconds):
      guard let transcript else { return nil }
      return "Voice note" + (seconds.map { " " + duration($0) } ?? "") + ", transcript: " + transcript
    case .file(let file):
      if file.expired == true { return "Photo unavailable, expired on the server" }
      var parts = ["File " + fileName(file)]
      if let bytes = file.bytes {
        parts.append(file.received.map { progress(received: $0, of: bytes) } ?? size(bytes))
      }
      return parts.joined(separator: ", ")
    case .link(let link): return "Link, " + link.title + ", " + link.host
    case .location(let address): return "Location, " + address
    case .contactCard(let card): return "Contact card, " + card.name + ", " + card.handle
    case .poll(let poll):
      return "Poll, " + poll.question + ", " + poll.options.map { "\($0.title) \($0.votes)" }.joined(separator: ", ")
    case .unsupported(let name): return "Unsupported, " + name
    default: return nil
    }
  }
}

/// Hugs its one child up to `maxWidth`: the child's own width for that
/// proposal, so a short bubble is short and a long one wraps.
struct Hug: Layout {
  let maxWidth: Double

  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    guard let child = subviews.first else { return .zero }
    let width = min(proposal.width ?? maxWidth, maxWidth)
    return child.sizeThatFits(ProposedViewSize(width: width, height: nil))
  }

  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    for child in subviews {
      child.place(at: bounds.origin, proposal: ProposedViewSize(width: bounds.width, height: bounds.height))
    }
  }
}

/// A media placeholder (08.D): paper, a 1 pt rule, a 6 pt radius, the
/// wireframe's crossed lines and a centred label. The window never holds
/// the bytes, so this is what an image is until the asset work lands.
struct MediaCell: View {
  let label: String
  let width: Double
  let height: Double
  let palette: Tokens.Palette
  var shaded = false

  var body: some View {
    ZStack {
      RoundedRectangle(cornerRadius: 6).fill(Tokens.color(shaded ? palette.layer2 : palette.layer1))
      Canvas { context, size in
        var path = Path()
        path.move(to: .zero)
        path.addLine(to: CGPoint(x: size.width, y: size.height))
        path.move(to: CGPoint(x: size.width, y: 0))
        path.addLine(to: CGPoint(x: 0, y: size.height))
        context.stroke(path, with: .color(Tokens.color(palette.inkDim, opacity: 0.22)), lineWidth: 1)
      }
      .clipShape(RoundedRectangle(cornerRadius: 6))
      .accessibilityHidden(true)
      RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
      if !label.isEmpty {
        Text(label)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .padding(.horizontal, 3)
          .background(Tokens.color(shaded ? palette.layer2 : palette.layer1))
          .accessibilityHidden(true)
      }
    }
    .frame(width: width, height: height)
  }
}

/// 08.D: an image, an album or a video, with no bubble round it: the asset
/// is the bubble. Albums of 2 are a 2-up 88 pt grid; 3 or more a 3-up 64 pt
/// grid that shows four and a +N cell.
struct MediaBody: View {
  let items: [MessageTurn.Attachment]
  let palette: Tokens.Palette
  /// v2 F4: a single image the source gave no dimensions for is a fixed
  /// 4:3 tile with its name and size (D-UI-201). Off on board 08, whose
  /// specimens are drawn at the wireframe's size.
  var fixedTile = false

  var body: some View {
    Group {
      if items.count == 1, let item = items.first {
        single(item)
      } else if items.count == 2 {
        HStack(spacing: 4) {
          ForEach(0..<2, id: \.self) { MediaCell(label: "\($0 + 1)", width: 88, height: 88, palette: palette) }
        }
      } else {
        grid
      }
    }
    .accessibilityHidden(true)
  }

  @ViewBuilder private func single(_ item: MessageTurn.Attachment) -> some View {
    if (item.mime ?? "").hasPrefix("video/") {
      ZStack(alignment: .bottomTrailing) {
        MediaCell(label: "", width: 184, height: 128, palette: palette)
          .overlay {
            Circle()
              .fill(Tokens.color(palette.layer1))
              .overlay(Circle().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
              .overlay(
                Image(systemName: "play.fill").font(.system(size: 9)).foregroundStyle(Tokens.color(palette.ink))
              )
              .frame(width: 26, height: 26)
          }
        Text(SpecimenText.duration(item.seconds ?? 0))
          .font(.system(size: 9, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.ink))
          .padding(.horizontal, 3)
          .background(Tokens.color(palette.layer1))
          .padding(6)
      }
    } else {
      let dims = item.width.flatMap { w in item.height.map { "IMG \(w)\u{00D7}\($0)" } }
      if fixedTile, dims == nil {
        let width = ProvisionalUI.mediaTileWidth
        MediaCell(
          label: SpecimenText.mediaTile(item), width: width, height: width / ProvisionalUI.mediaTileAspect,
          palette: palette)
      } else {
        MediaCell(label: dims ?? "IMG", width: 184, height: 128, palette: palette)
      }
    }
  }

  private var grid: some View {
    let shown = items.count > 4 ? 4 : items.count
    let cells = Array(0..<shown) + (items.count > 4 ? [-1] : [])
    let rows = stride(from: 0, to: cells.count, by: 3).map { Array(cells[$0..<min($0 + 3, cells.count)]) }
    return VStack(alignment: .leading, spacing: 4) {
      ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
        HStack(spacing: 4) {
          ForEach(row, id: \.self) { i in
            if i < 0 {
              MediaCell(label: "+\(items.count - 4)", width: 64, height: 64, palette: palette, shaded: true)
            } else {
              MediaCell(label: "\(i + 1)", width: 64, height: 64, palette: palette)
            }
          }
        }
      }
    }
  }
}

/// 08.E: a voice note, transcript first. The waveform is drawn, not
/// sampled (the daemon serves no envelope), so it is decoration and hidden.
struct VoiceBody: View {
  let guid: String
  let transcript: String
  let seconds: Int?
  let ink: Color
  let palette: Tokens.Palette

  var body: some View {
    let collapsed = SpecimenText.collapse(transcript)
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 8) {
        Circle()
          .strokeBorder(ink, lineWidth: 1.5)
          .overlay(Image(systemName: "play.fill").font(.system(size: 8)).foregroundStyle(ink))
          .frame(width: 22, height: 22)
        Waveform(seed: guid, ink: ink)
          .frame(width: 92, height: 18)
        Spacer(minLength: 8)
        Text(SpecimenText.duration(seconds ?? 0))
          .font(.system(size: 9, weight: .semibold, design: .monospaced))
          .foregroundStyle(ink)
      }
      .accessibilityHidden(true)
      Rectangle().fill(ink.opacity(0.6)).frame(height: 1).accessibilityHidden(true)
      Text("\u{201C}" + collapsed.shown + "\u{201D}")
        .font(.system(size: 10))
        .foregroundStyle(ink)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityHidden(true)
    }
    .frame(maxWidth: 286, alignment: .leading)
  }
}

/// Bars of a made-up envelope, steady for a guid.
struct Waveform: View {
  let seed: String
  let ink: Color

  var body: some View {
    let levels = seed.unicodeScalars.reduce(into: [Double]()) { out, s in out.append(Double(s.value % 7) / 6) }
    Canvas { context, size in
      let count = 22
      let step = size.width / Double(count)
      for i in 0..<count {
        let level = levels.isEmpty ? 0.5 : levels[(i * 3) % levels.count]
        let h = max(3, size.height * (0.3 + 0.7 * abs(sin(Double(i) * 1.3 + level * 3))))
        let rect = CGRect(x: Double(i) * step, y: (size.height - h) / 2, width: 1.5, height: h)
        context.fill(Path(rect), with: .color(ink.opacity(i < count / 2 ? 1 : 0.45)))
      }
    }
    .accessibilityHidden(true)
  }
}

/// 08.F: a document, a download in flight, or media gone from the server.
struct FileBody: View {
  let file: MessageTurn.Attachment
  let ink: Color
  let dim: Color
  let palette: Tokens.Palette

  var body: some View {
    HStack(alignment: .center, spacing: 8) {
      if file.expired == true {
        RoundedRectangle(cornerRadius: 2)
          .strokeBorder(dim, style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
          .overlay(Text("\u{00D7}").font(.system(size: 9)).foregroundStyle(dim))
          .frame(width: 26, height: 32)
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 2) {
          Text("Photo unavailable").font(.system(size: 11, weight: .semibold)).foregroundStyle(dim)
          Text("Expired on the server. Re-request.").font(.system(size: 9)).foregroundStyle(dim)
        }
      } else {
        Text(SpecimenText.badge(file))
          .font(.system(size: 8, weight: .bold, design: .monospaced))
          .foregroundStyle(ink)
          .frame(width: 26, height: 32)
          .overlay(RoundedRectangle(cornerRadius: 2).strokeBorder(ink, lineWidth: 1))
          .accessibilityHidden(true)
        VStack(alignment: .leading, spacing: 3) {
          Text(SpecimenText.fileName(file)).font(.system(size: 11, weight: .semibold)).foregroundStyle(ink)
          if let bytes = file.bytes {
            if let received = file.received {
              Text(SpecimenText.progress(received: received, of: bytes)).font(.system(size: 9)).foregroundStyle(dim)
              ZStack(alignment: .leading) {
                Rectangle().fill(dim.opacity(0.3)).frame(width: 116, height: 3)
                Rectangle().fill(ink).frame(width: 116 * Double(received) / Double(max(bytes, 1)), height: 3)
              }
              .accessibilityHidden(true)
            } else {
              Text(SpecimenText.size(bytes)).font(.system(size: 9)).foregroundStyle(dim)
            }
          }
        }
      }
      Spacer(minLength: 0)
    }
    .frame(width: 196, alignment: .leading)
  }
}

/// 08.F: a link preview: the image area, the title and the host.
struct LinkBody: View {
  let link: MessageTurn.LinkPreview
  let ink: Color
  let dim: Color
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Text("OG IMAGE")
        .font(.system(size: 9))
        .foregroundStyle(dim)
        .frame(maxWidth: .infinity, minHeight: 78)
        .accessibilityHidden(true)
      Rectangle().fill(ink).frame(height: 1).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(link.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(ink)
          .fixedSize(horizontal: false, vertical: true)
        Text(link.host).font(.system(size: 9)).foregroundStyle(dim)
      }
      .padding(8)
    }
    .frame(width: 216)
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(ink, lineWidth: 1))
  }
}

/// 08.F: a place: a static map still and the address under it.
struct LocationBody: View {
  let address: String
  let ink: Color
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      MediaCell(label: "MAP", width: 190, height: 92, palette: palette)
        .accessibilityHidden(true)
      Text(address).font(.system(size: 10)).foregroundStyle(ink)
    }
  }
}

/// 08.F: a contact card: initials, the name, the handle.
struct ContactBody: View {
  let card: MessageTurn.ContactCard
  let ink: Color
  let dim: Color

  var body: some View {
    HStack(spacing: 8) {
      Circle()
        .strokeBorder(ink, lineWidth: 1)
        .overlay(Text(ShellText.initials(card.name)).font(.system(size: 9, weight: .semibold)).foregroundStyle(ink))
        .frame(width: 28, height: 28)
        .accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 2) {
        Text(card.name).font(.system(size: 11, weight: .semibold)).foregroundStyle(ink)
        Text(card.handle + " \u{00B7} Contact card").font(.system(size: 9)).foregroundStyle(dim)
      }
      Spacer(minLength: 0)
    }
    .frame(width: 196, alignment: .leading)
  }
}

/// 08.F: a poll, read-only: the bars are the share of the votes, and
/// there is no vote hook (02.H, 03.F).
struct PollBody: View {
  let poll: MessageTurn.Poll
  let ink: Color
  let dim: Color

  var body: some View {
    let total = max(1, poll.options.reduce(0) { $0 + $1.votes })
    VStack(alignment: .leading, spacing: 6) {
      Text(poll.question).font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
      ForEach(Array(poll.options.enumerated()), id: \.offset) { _, option in
        VStack(alignment: .leading, spacing: 3) {
          HStack {
            Text(option.title).font(.system(size: 11, weight: .medium)).foregroundStyle(dim)
            Spacer()
            Text("\(option.votes)").font(.system(size: 11, weight: .medium)).foregroundStyle(dim)
          }
          // One element per option, and 11 pt: at 9 pt the 1x audit found
          // two ink pixels in "Italian, 4" (runs 37618816522, 37621034024).
          .accessibilityElement(children: .combine)
          ZStack(alignment: .leading) {
            Rectangle().fill(dim.opacity(0.3)).frame(width: 172, height: 3)
            Rectangle().fill(ink).frame(width: 172 * Double(option.votes) / Double(total), height: 3)
          }
          .accessibilityHidden(true)
        }
      }
    }
    .frame(width: 172, alignment: .leading)
  }
}

/// 08.F: a type the app cannot render, by its name, and why it is not
/// opened. The honest fallback, never a blank bubble.
struct UnsupportedBody: View {
  let name: String
  let ink: Color
  let dim: Color

  static let reason = "WeMessage will not open this. Doing so would mark it viewed without your intent."

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      Text(name).font(.system(size: 12, weight: .semibold)).foregroundStyle(ink)
      Text(Self.reason).font(.system(size: 9)).foregroundStyle(dim)
        .fixedSize(horizontal: false, vertical: true)
    }
    .frame(width: 220, alignment: .leading)
  }
}

/// 08.G: a system line, centred, tertiary and never bubbled.
struct SystemLine: View {
  let text: String
  let palette: Tokens.Palette

  var body: some View {
    Text(text)
      .font(.system(size: 10))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .multilineTextAlignment(.center)
      .frame(maxWidth: .infinity)
      .padding(.vertical, 4)
  }
}

/// 08.C: the reactions others left, read where they exist. One renderer for
/// every source; each chip is its own element. There is no affordance to
/// add one, on iMessage or anywhere (a reaction is a send).
struct ReactionRow: View {
  let guid: String
  let reactions: [MessageTurn.Reaction]
  let ink: Color
  /// The chip's fill: clear on board 08, the tint wash on board 03
  /// (D-UI-146).
  var fill: Color = .clear

  var body: some View {
    HStack(spacing: 4) {
      ForEach(Array(reactions.enumerated()), id: \.offset) { n, reaction in
        let glyph = SpecimenText.textPresentation(reaction.glyph)
        // U+FE0E is a request, not a guarantee: a thumbs up has no text
        // glyph, so the colour bitmap draws, and its yellow edge over the
        // tint wash reads as green (board 03, dark). The glyph alone is
        // drawn without saturation, so a reaction is monochrome whatever
        // emoji arrives; the count keeps the ink.
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          Text(glyph).saturation(0)
          Text(" \(reaction.count)")
        }
        .font(.system(size: 11, weight: .medium))
        .foregroundStyle(ink)
        .padding(.vertical, 2)
        .padding(.horizontal, 6)
        .background(Capsule().fill(fill))
        .overlay(Capsule().strokeBorder(ink.opacity(0.6), lineWidth: 1))
        // D-UI-196: mine gets one more rule round the chip, never a colour.
        .padding(reaction.isMine ? ProvisionalUI.reactionMineRule + 1 : 0)
        .overlay {
          if reaction.isMine {
            Capsule().strokeBorder(ink, lineWidth: ProvisionalUI.reactionMineRule)
          }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SpecimenText.reactionLabel(reaction))
        .accessibilityIdentifier(ShellID.reactionPrefix + guid + ".\(n)")
      }
    }
  }
}

/// v2 F4: the app's reaction table (D-UI-195), passed to the Kit where a
/// page of turns is mapped.
extension ReactionGlyphs {
  static let provisional = ReactionGlyphs(glyphs: ProvisionalUI.reactionGlyphs, names: ProvisionalUI.reactionNames)
}
