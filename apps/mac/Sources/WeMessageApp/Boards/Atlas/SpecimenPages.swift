import SwiftUI
import WeMessageKit

/// One page of board 08: a section of the atlas golden, drawn by the
/// thread's own components (BubbleView in its specimen style, DraftBubble,
/// ChannelBanner), with the wireframe's labels and notes around them. The
/// left column is the gutter's left; the right runs to the window's edge.
struct AtlasPage: View {
  let slug: String
  let content: SpecimenContent
  let palette: Tokens.Palette
  let left: Double
  let gutter: Double
  let right: Double

  private var zone: TimeZone { SpecimenContent.zone }

  var body: some View {
    switch slug {
    case "anatomy": anatomy
    case "text": text
    case "reactions": reactions
    case "media": media
    case "voice": voice
    case "payloads": payloads
    case "delivery": delivery
    case "draft": draft
    case "native": native
    default: coverage
    }
  }

  private func columns<L: View, R: View>(@ViewBuilder _ leading: () -> L, @ViewBuilder _ trailing: () -> R)
    -> some View
  {
    AtlasColumns(left: left, gutter: gutter, right: right, leading: leading, trailing: trailing)
  }

  /// The widest a specimen bubble may be in a column `width` wide.
  private func widest(_ width: Double) -> Double { TranscriptLayout.maxBubbleWidth(paneWidth: width) }

  /// One turn of the golden in the specimen style, on its side.
  @ViewBuilder private func bubble(
    _ guid: String, id: String? = nil, width: Double, showsTime: Bool = false
  ) -> some View {
    if let turn = content.turn(guid) {
      BubbleView(
        bubble: TranscriptLayout.Bubble(
          turn: turn, gap: 0, continuesRun: false, senderName: nil, showsTime: showsTime),
        sms: false, title: content.thread.title, maxWidth: widest(width), palette: palette, style: .specimen,
        zone: zone
      )
      .accessibilityIdentifier(id ?? ShellID.bubblePrefix + guid)
      .frame(maxWidth: .infinity, alignment: turn.direction == .outbound ? .trailing : .leading)
    }
  }

  /// A labelled specimen.
  private func specimen(_ label: String, _ guid: String, id: String? = nil, width: Double) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      AtlasLabel(label, palette: palette)
      bubble(guid, id: id, width: width)
    }
  }

  private func lead(_ text: String) -> some View { AtlasLead(text, palette: palette) }
  private func note(_ number: Int, _ text: String) -> some View { AtlasNote(number, text, palette: palette) }

  // MARK: 08.A

  private var anatomy: some View {
    columns {
      lead(
        "The only direction cue is fill: **outbound is solid ink, inbound is outlined.** No colour carries meaning. One sender's run groups at 4 pt and squares its inner corner; a new sender restarts the run and prints the time again."
      )
      note(1, "Max bubble width is 64% of the message pane, never a fixed width, so a wide window cannot make unreadable lines.")
      note(2, "Corner radius 17 pt, squaring to 5 pt on a run's inner corner.")
      note(3, "Status lives inside the last outbound bubble, not as its own row, so receipts never double a thread's line count.")
    } _: {
      AtlasCard(palette: palette) {
        let width = right - 24
        let turns = SpecimenText.statusOnLastOutbound(content.section("anatomy")?.turns ?? [])
        let calendar: Calendar = {
          var c = Calendar(identifier: .gregorian)
          c.timeZone = zone
          return c
        }()
        VStack(spacing: 0) {
          ForEach(TranscriptLayout.rows(turns, asOf: content.asOf, calendar: calendar, isGroup: false)) { row in
            switch row {
            case .day(let id, let label):
              DaySeparator(label: label, palette: palette)
                .accessibilityIdentifier(ShellID.dayPrefix + id)
            case .bubble(let bubble):
              BubbleView(
                bubble: bubble, sms: false, title: content.thread.title,
                maxWidth: TranscriptLayout.maxBubbleWidth(paneWidth: width), palette: palette, style: .specimen,
                zone: zone
              )
              .accessibilityIdentifier(ShellID.bubblePrefix + bubble.turn.guid)
              .frame(maxWidth: .infinity, alignment: bubble.turn.direction == .outbound ? .trailing : .leading)
            }
          }
        }
      }
    }
  }

  // MARK: 08.B

  private var text: some View {
    columns {
      lead(
        "Emoji-only messages draw at **2.6x**. Mentions are **underlined, never tinted**: the underline survives a grayscale print."
      )
      specimen("Plain", "atlas-b1", width: left)
      specimen("Long, wrapping", "atlas-b2", width: left)
      specimen("With mention", "atlas-b4", width: left)
      specimen("Forwarded", "atlas-b5", width: left)
    } _: {
      specimen("Emoji only, 2.6x", "atlas-b3", width: right)
      specimen("Reply / quote", "atlas-b6", width: right)
      specimen("Edited", "atlas-b7", width: right)
      specimen("Unsent / deleted for everyone", "atlas-b8", width: right)
      note(1, "The emoji keeps its bubble here, filled as outbound: fill is the only direction cue, so a bubble with no fill would read as inbound.")
      note(2, "Monochrome by construction: U+2665 then U+FE0E, a text glyph in every renderer, never a colour bitmap.")
    }
  }

  // MARK: 08.C

  private var reactions: some View {
    columns {
      lead(
        "The vocabularies barely differ. **The gap is capability: we can read every network's reactions and cannot write iMessage's.**"
      )
      capabilities
      note(1, "**Absent, never disabled**, whenever the act can never succeed. Disabled is for not right now.")
      note(2, "Every absence names its reason on demand, and the reason is the platform's, not an apology.")
      note(3, "An agent never sends a reaction on any channel. A reaction is a send, and it goes through the same approval.")
    } _: {
      AtlasLabel("Display is uniform. One renderer, every source.", palette: palette)
      bubble("atlas-c1", width: right)
      caption("iMessage: a classic tapback and an emoji tapback, side by side. The renderer does not tell them apart.")
      bubble("atlas-c2", width: right)
      caption("Same renderer, same geometry, counts only.")
      AtlasLabel("Sending, on a channel where it cannot work", palette: palette)
        .padding(.top, 4)
      bubble("atlas-c3", width: right)
      HStack(alignment: .top, spacing: 8) {
        Circle()
          .fill(Tokens.color(palette.ink))
          .overlay(Text("!").font(.system(size: 9, weight: .bold)).foregroundStyle(Tokens.color(palette.layer1)))
          .frame(width: 16, height: 16)
          .accessibilityHidden(true)
        Text(
          "No react affordance is drawn on an iMessage bubble. Not greyed, not refusing: absent, with the reason on the thread's capability sheet."
        )
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
      }
      .padding(8)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(Hatch(palette: palette))
      .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      .accessibilityElement(children: .combine)
      caption("The escape hatch is offered instead of the refusal: a one-line reply, or the native thread.")
      HStack(spacing: 8) {
        Text("\u{2197}").accessibilityHidden(true)
        Text("React in Messages").font(.system(size: 11, weight: .semibold))
        Spacer(minLength: 8)
        Text("Reveal thread")
          .font(.system(size: 10))
          .padding(.vertical, 2)
          .padding(.horizontal, 6)
          .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(Tokens.color(palette.layer1), lineWidth: 1))
      }
      .foregroundStyle(Tokens.color(palette.layer1))
      .padding(.vertical, 6)
      .padding(.horizontal, 10)
      .background(RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.ink)))
      .accessibilityElement(children: .combine)
    }
  }

  private func caption(_ text: String) -> some View {
    Text(text)
      .font(.system(size: 9))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
  }

  /// 08.C's table: what each channel's reactions are, and whether the app
  /// can read and write them.
  private var capabilities: some View {
    let rows: [(String, String, String)] = [
      ("iMessage", "Read from the local store", "No. There is no hook for tapbacks."),
      ("WhatsApp", "Yes", "Yes"),
      ("LinkedIn", "Yes", "Desktop surface only"),
      ("Email", "\u{00B7}", "\u{00B7}"),
    ]
    return Grid(alignment: .leading, horizontalSpacing: 8, verticalSpacing: 4) {
      GridRow {
        AtlasLabel("Channel", palette: palette)
        AtlasLabel("We can display", palette: palette)
        AtlasLabel("We can send", palette: palette)
      }
      ForEach(rows, id: \.0) { row in
        GridRow {
          Text(row.0).font(.system(size: 10, weight: .semibold))
          Text(row.1).font(.system(size: 10))
          Text(row.2).font(.system(size: 10)).fixedSize(horizontal: false, vertical: true)
        }
        .foregroundStyle(Tokens.color(palette.ink))
      }
    }
    .padding(8)
    .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }

  // MARK: 08.D

  private var media: some View {
    columns {
      lead(
        "Media draws **without a bubble**: the asset is the bubble, a 1 pt rule and a 6 pt radius. Albums of 2 are 2-up at 88 pt; 3 to 5 are 3-up at 64 pt with a +N cell. **Video always shows its duration.**"
      )
      specimen("Single image", "atlas-d1", width: left)
      specimen("With caption", "atlas-d5", width: left)
    } _: {
      specimen("Album, 2 up", "atlas-d2", width: right)
      specimen("Album, 5 with overflow", "atlas-d3", width: right)
      specimen("Video, inline", "atlas-d4", width: right)
    }
  }

  // MARK: 08.E

  private var voice: some View {
    columns {
      lead(
        "On a desktop a voice note can be **read in two seconds**. The transcript is drawn by default and collapsed only past four lines."
      )
      specimen("Inbound, transcribed by default", "atlas-e1", width: left)
    } _: {
      specimen("Outbound, sent", "atlas-e2", width: right)
      note(1, "Release reviews, it does not send. A draft-then-approve product cannot ship the accidental voice note.")
      note(2, "Transcription is local. A transcript that leaves the machine breaks the privacy claim.")
    }
  }

  // MARK: 08.F

  private var payloads: some View {
    columns {
      specimen("Document", "atlas-f1", width: left)
      specimen("Downloading", "atlas-f2", width: left)
      specimen("Expired media", "atlas-f3", width: left)
      specimen("Poll, read-only", "atlas-f7", width: left)
    } _: {
      specimen("Link preview", "atlas-f4", width: right)
      specimen("Location", "atlas-f5", width: right)
      specimen("Contact card", "atlas-f6", width: right)
      specimen(
        "Unsupported type, the honest fallback", "atlas-f8", id: ShellID.unsupportedPrefix + "atlas-f8", width: right)
    }
  }

  // MARK: 08.G

  private var delivery: some View {
    columns {
      lead(
        "System lines are centred, tertiary and **never bubbled**. Delivery escalates only on failure: a dotted 2 pt rule and an inline retry."
      )
      AtlasLabel("System messages", palette: palette)
      AtlasCard(palette: palette) {
        VStack(spacing: 4) {
          ForEach(["atlas-g1", "atlas-g2", "atlas-g3", "atlas-g4"], id: \.self) { guid in
            bubble(guid, width: left - 24)
          }
        }
      }
    } _: {
      AtlasLabel("Delivery ladder", palette: palette)
      ForEach(["atlas-g5", "atlas-g6", "atlas-g7", "atlas-g8", "atlas-g9"], id: \.self) { guid in
        bubble(guid, width: right)
      }
      note(1, "Never collapse failure into a quiet tick. The failed bubble keeps its text, retryable in place.")
      note(2, "Failure names the channel's own cause: four transports fail four ways.")
    }
  }

  // MARK: 08.H

  private var draft: some View {
    columns {
      lead(
        "An agent draft is drawn **where the reply will land**: a 2 pt dashed outbound bubble, unfilled because it has not been sent."
      )
      AtlasLabel("Draft in place, awaiting approval", palette: palette)
      AtlasCard(palette: palette) {
        VStack(alignment: .leading, spacing: 8) {
          ChannelBanner(thread: content.thread, palette: palette)
          bubble("atlas-h1", width: left - 24, showsTime: true)
          DraftBubble(draft: content.draft, isGroup: false, maxWidth: widest(left - 24), palette: palette)
            .accessibilityIdentifier(ShellID.draftSpecimenPrefix + content.draft.id)
          // Drawn, not bound: the sheet sends nothing.
          DraftVerbs(palette: palette, approve: {}, edit: {}, hold: {})
        }
      }
    } _: {
      AtlasLabel("Draft states", palette: palette)
      ForEach(DraftStateSpecimen.Kind.allCases, id: \.self) { kind in
        DraftStateSpecimen(kind: kind, words: content.draft.body, expires: expires, palette: palette)
      }
      note(1, "Expired and held read as absent, not pending: a draft that looks live but cannot send is how a reply is believed sent.")
      note(2, "A sent draft keeps its provenance, approved by you.")
    }
  }

  /// The draft's time to live, printed in the sheet's zone.
  private var expires: String {
    WireDate.parse(content.draft.expiresAt).map { ShellText.shortClock($0, zone: zone) } ?? ""
  }

  // MARK: 08.I

  private var native: some View {
    columns {
      lead(
        "Specimens that exist on one channel. **Render the native concept natively**; never invent a lowest common denominator."
      )
      note(
        1,
        "In Messages.app the SMS bubble is green. **Green is forbidden here.** The downgrade is an inset rail and a printed tag, never a dashed rule: dashed means unsent, and this message was sent."
      )
      note(2, "It is history, not a capability: WeMessage renders SMS threads and never produces one.")
      note(3, "LinkedIn InMail, message requests, email and WhatsApp disappearing messages are not drawn: this build has no such transport.")
    } _: {
      specimen("iMessage \u{00B7} SMS fallback", "atlas-i1", id: ShellID.smsPrefix + "atlas-i1", width: right)
      specimen("iMessage \u{00B7} effect", "atlas-i2", id: ShellID.effectPrefix + "atlas-i2", width: right)
    }
  }

  // MARK: 08.J

  private var coverage: some View {
    VStack(alignment: .leading, spacing: 8) {
      lead(
        "Which specimens exist per channel, and what the app does when one does not. **DEGRADE** means the affordance is absent and the reason is stated."
      )
      .frame(width: left, alignment: .leading)
      columns {
        matrix(CoverageMatrix.channels)
        note(1, "A channel column is what the transport carries; the treatment is what WeMessage may do with it.")
        note(2, "Typing indicator is no on all four, and is drawn nowhere.")
      } _: {
        matrix(CoverageMatrix.treatments)
      }
    }
  }

  private func matrix(_ lines: [String]) -> some View {
    Text(lines.joined(separator: "\n"))
      .font(.system(size: 8, design: .monospaced))
      .foregroundStyle(Tokens.color(palette.ink))
      .lineSpacing(1.5)
      .fixedSize()
  }
}

/// 08.H's five draft states, drawn static: the strokes the live draft takes
/// on its way through approval, undo, send, expiry and hold.
struct DraftStateSpecimen: View {
  enum Kind: CaseIterable {
    case awaiting, approved, sent, expired, held
  }

  let kind: Kind
  let words: String
  let expires: String
  let palette: Tokens.Palette

  private var title: String {
    switch kind {
    case .awaiting: "Awaiting approval"
    case .approved: "Approved, in undo window"
    case .sent: "Sent"
    case .expired: "Expired"
    case .held: "Held"
    }
  }

  private var line: String? {
    switch kind {
    case .awaiting: nil
    case .approved: "Sends in 4s. Undo"
    case .sent: "Sent 09:47 \u{00B7} approved by you"
    case .expired: "TTL passed at " + expires + ". Never sent."
    case .held: "Outside arming window. Held, not queued."
    }
  }

  private var muted: Bool { kind == .expired || kind == .held }
  private var ink: Color {
    kind == .sent ? Tokens.color(palette.layer1) : Tokens.color(muted ? palette.inkDim : palette.ink)
  }

  var body: some View {
    VStack(alignment: .trailing, spacing: 3) {
      AtlasLabel(title, palette: palette)
      VStack(alignment: .leading, spacing: 3) {
        Text(words).font(.system(size: 11)).foregroundStyle(ink)
        if let line {
          Text(line).font(.system(size: 9)).foregroundStyle(ink.opacity(0.85))
        }
      }
      .padding(.vertical, 6)
      .padding(.horizontal, TranscriptLayout.horizontalPadding)
      .background(shape.fill(kind == .sent ? Tokens.color(palette.ink) : Tokens.color(palette.layer1)))
      .overlay { stroke }
    }
    .frame(maxWidth: .infinity, alignment: .trailing)
    .accessibilityElement(children: .combine)
  }

  private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: TranscriptLayout.radius) }

  @ViewBuilder private var stroke: some View {
    switch kind {
    case .awaiting: shape.strokeBorder(Tokens.color(Tokens.draftOutline), style: BubbleStroke.dashed)
    case .approved: shape.strokeBorder(Tokens.color(palette.ink), lineWidth: 2)
    case .sent: EmptyView()
    case .expired, .held: shape.strokeBorder(Tokens.color(palette.inkDim), style: BubbleStroke.placeholder)
    }
  }
}

/// 08.J's coverage matrix, as the wireframe prints it, split at the
/// treatment column so the gutter between the page's columns stays bare.
/// The SMS row is corrected to D-UI-39 (an inset rail and a tag, not a
/// dashed rule); typing is drawn nowhere.
enum CoverageMatrix {
  static let rows: [(String, String, String, String, String, String)] = [
    ("TYPE", "iMESSAGE", "WHATSAPP", "LINKEDIN", "EMAIL", "UNIFIED TREATMENT"),
    ("text", "yes", "yes", "yes", "yes", "bubble / reading pane"),
    ("emoji-only 2.6x", "yes", "yes", "no", "no", "scale on chat channels only"),
    ("reply / quote", "yes", "yes", "no", "yes (header)", "quote block; absent on LinkedIn"),
    ("reaction", "6+emoji+stk", "any emoji", "any emoji", "none", "read where it exists. CANNOT SEND on iM"),
    ("edit", "yes 15min", "yes 15min", "yes 60min", "no", "countdown shown. iM read-only (02.H)"),
    ("unsend", "yes 2min", "yes 2days", "yes 60min", "no", "iM read-only. LI removes for all"),
    ("image", "yes", "yes", "yes", "yes", "identical"),
    ("album grid", "yes", "yes", "no", "attachments", "2-up / 3-up + overflow"),
    ("video inline", "yes", "yes", "limited", "attachment", "duration always shown"),
    ("voice note", "yes", "yes", "mobile only", "no", "TRANSCRIBE BY DEFAULT. No record on iM"),
    ("file", "yes", "yes", "yes", "yes", "identical"),
    ("link preview", "yes", "yes", "yes", "yes", "identical"),
    ("location", "yes", "yes", "no", "no", "static map still"),
    ("contact card", "yes", "yes", "no", "vcard", "identical"),
    ("poll", "read-only", "read-only", "no", "no", "RENDER ONLY. No vote hook"),
    ("view-once", "no", "yes", "no", "no", "DEGRADE, will not auto-open"),
    ("disappearing", "no", "yes", "no", "no", "REFUSED until the bridge stores it"),
    ("send later", "no", "no", "no", "no", "NO HOOK anywhere. Absent (02.H)"),
    ("effects", "yes", "no", "no", "no", "double rule + label. No picker"),
    ("SMS fallback", "yes", "n/a", "n/a", "n/a", "inset rail + tag. NEVER green"),
    ("subject line", "no", "no", "subject-ish", "yes", "email gets a reading pane"),
    ("cc / bcc", "no", "no", "no", "yes", "email only"),
    ("InMail credits", "no", "no", "yes", "no", "LinkedIn only, cost shown"),
    ("message request", "no", "no", "yes", "no", "LinkedIn only, accept/delete"),
    ("read receipt", "yes", "no", "yes", "no", "per channel. iM reads, never sends"),
    ("typing indicator", "no", "no", "no", "no", "NOT DRAWN EITHER WAY"),
    ("agent draft", "yes", "yes", "yes", "yes", "THE DIFFERENTIATOR"),
  ]

  private static func pad(_ s: String, _ width: Int) -> String {
    s.count >= width ? s : s + String(repeating: " ", count: width - s.count)
  }

  /// TYPE and the four channels, fixed width.
  static var channels: [String] {
    rows.map { pad($0.0, 17) + pad($0.1, 13) + pad($0.2, 11) + pad($0.3, 12) + $0.4 }
  }

  /// The unified treatment, one line per row.
  static var treatments: [String] { rows.map(\.5) }
}
