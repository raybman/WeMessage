import AppKit
import SwiftUI
import WeMessageKit

// v2 B2, board 05: the Email board over fixtures. The banner in board 03's
// register with the fixture chip; the open thread as cards at a 68
// character measure, never bubbles (05.A, D-UI-136); remote images blocked
// until one message is revealed (05.E); an invite drawn as an object card
// (05.F); the verbs and the inline compose whose Send ends in a draft
// (05.B). Monochrome plus the app's one blue tint, never green.

/// The card measure (D-UI-136): 68 figure zeros of the 13 pt body face,
/// plus the card's padding on both sides.
enum EmailMeasure {
  static func textWidth() -> Double {
    let zero = ("0" as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: ProvisionalUI.emailBodySize)])
    return (Double(zero.width) * ProvisionalUI.emailMeasureChars).rounded()
  }

  static func cardWidth() -> Double { textWidth() + 2 * ProvisionalUI.emailCardPadding }
}

/// Board 05 while the Email tile is selected and its channel draws one.
struct EmailBoardView: View {
  let model: ShellModel
  let board: EmailBoardModel
  let palette: Tokens.Palette

  private var thread: ThreadSummary? {
    guard let thread = model.selected, thread.channel == Channel.email.rawValue else { return nil }
    return thread
  }

  var body: some View {
    VStack(spacing: 0) {
      banner
      if let thread {
        EmailThreadView(model: model, thread: thread, palette: palette)
          .task(id: model.threadLoadKey) { await model.loadSelectedThread() }
      } else {
        empty
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.emailBoard)
  }

  private var empty: some View {
    VStack(spacing: 8) {
      Text(board.headline)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .multilineTextAlignment(.center)
        .accessibilityLabel(board.headline)
        .accessibilityAddTraits([.isHeader, .isStaticText])
        .accessibilityIdentifier(ShellID.emailEmpty)
      Text(board.detail)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(board.detail)
        .accessibilityAddTraits(.isStaticText)
    }
    .frame(maxWidth: 360)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }

  private var banner: some View {
    HStack(spacing: 10) {
      Text(board.banner)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .lineLimit(1)
        .truncationMode(.tail)
        .accessibilityLabel(board.banner)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityIdentifier(ShellID.emailBanner)
      Spacer(minLength: 8)
      if let chip = board.chip {
        BoardChip(text: chip, palette: palette)
      }
    }
    .padding(.horizontal, 12)
    .frame(height: KillBanner.height)
    .frame(maxWidth: .infinity)
    .background(Tokens.color(palette.layer1))
    .overlay(alignment: .leading) { Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true) }
  }
}

/// The open thread: its subject, the cards oldest first with the earlier
/// ones folded, the verbs, and the inline compose under the last card.
struct EmailThreadView: View {
  let model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var desk: EmailDesk { model.email }

  private var cards: [EmailCard] {
    guard case .loaded(let page) = model.thread.load, page.chatGuid == thread.chatGuid else { return [] }
    return EmailCard.cards(page)
  }

  private var subject: String { EmailThreadMeta(thread).subject ?? thread.title }

  /// The keys' claim: a new value whenever shift-R should be heard again.
  private var keysToken: String { thread.chatGuid + "-" + String(desk.compose == nil) }

  var body: some View {
    let all = cards
    let fold = EmailCard.fold(all, expanded: desk.isExpanded(thread.chatGuid))
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: ProvisionalUI.emailCardSpacing) {
          Text(subject)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityAddTraits(.isHeader)
          if fold.folded > 0 {
            earlier(fold.folded)
          }
          ForEach(fold.shown) { card in
            EmailCardView(card: card, desk: desk, palette: palette)
          }
          if !all.isEmpty {
            if let compose = desk.compose {
              EmailComposeView(compose: compose, desk: desk, palette: palette)
                .id(ShellID.emailCompose)
            } else {
              verbs
            }
          }
        }
        .frame(width: EmailMeasure.cardWidth(), alignment: .leading)
        .padding(.vertical, 16)
        .frame(maxWidth: .infinity)
      }
      .scrollIndicators(.never)
      // An opened compose sits under the last card, often below the fold:
      // it is scrolled into view whole.
      .onChange(of: desk.compose.map { ObjectIdentifier($0) }) { _, opened in
        guard opened != nil else { return }
        Task { @MainActor in
          await Task.yield()
          proxy.scrollTo(ShellID.emailCompose, anchor: .bottom)
        }
      }
    }
    .background {
      if model.lens == .recent && desk.compose == nil && !all.isEmpty {
        EmailKeys(model: model, token: keysToken).frame(width: 0, height: 0).accessibilityHidden(true)
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(subject)
    .accessibilityIdentifier(ShellID.emailThread)
  }

  private func earlier(_ count: Int) -> some View {
    Button {
      desk.expand(thread.chatGuid)
    } label: {
      Text(ProvisionalUI.emailEarlier(count))
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.4), lineWidth: 1))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(ProvisionalUI.emailEarlier(count))
    .accessibilityIdentifier(ShellID.emailEarlier)
  }

  /// D-UI-158: Reply, Reply all with its key printed, Forward.
  private var verbs: some View {
    HStack(spacing: 8) {
      SettingsButton(title: ProvisionalUI.emailReplyLabel, palette: palette, id: ShellID.emailReply) {
        model.composeEmail(.reply)
      }
      Button {
        model.composeEmail(.replyAll)
      } label: {
        HStack(spacing: 6) {
          Text(ProvisionalUI.emailReplyAllLabel)
            .font(.system(size: 12, weight: .semibold))
          Text(ProvisionalUI.emailReplyAllKey)
            .font(.system(size: 11))
        }
        .foregroundStyle(Tokens.color(palette.ink))
        .padding(.vertical, 5)
        .padding(.horizontal, 12)
        .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        .contentShape(Capsule())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel(ProvisionalUI.emailReplyAllLabel)
      .accessibilityIdentifier(ShellID.emailReplyAll)
      SettingsButton(title: ProvisionalUI.emailForwardLabel, palette: palette, id: ShellID.emailForward) {
        model.composeEmail(.forward)
      }
      Spacer(minLength: 0)
    }
  }
}

/// One message as a card (05.A): sender, time, envelope, the body at the
/// measure, its files, its invite and its remote images.
struct EmailCardView: View {
  let card: EmailCard
  let desk: EmailDesk
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(alignment: .firstTextBaseline, spacing: 8) {
        Text(card.from)
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .lineLimit(1)
        Spacer(minLength: 8)
        if let at = card.at {
          Text(ShellText.clock(at))
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize()
        }
      }
      ForEach([card.toLine, card.ccLine].compactMap { $0 }, id: \.self) { line in
        Text(line)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
      Text(card.body)
        .font(.system(size: ProvisionalUI.emailBodySize))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
      if !card.meta.attachments.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(card.meta.attachments, id: \.name) { file in
            Text(file.name + " \u{00B7} " + SizeText.megabytes(file.bytes))
              .font(.system(size: 11))
              .foregroundStyle(Tokens.color(palette.inkDim))
          }
        }
      }
      if let invite = card.meta.invite {
        EmailInviteCard(invite: invite, palette: palette)
      }
      if !card.meta.images.isEmpty {
        EmailImagesRow(card: card, desk: desk, palette: palette)
      }
    }
    .padding(ProvisionalUI.emailCardPadding)
    .frame(width: EmailMeasure.cardWidth(), alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.2), lineWidth: 1))
    .accessibilityElement(children: .contain)
    .accessibilityLabel(card.from)
    .accessibilityIdentifier(ShellID.emailCardPrefix + card.id)
  }
}

/// 05.E: the blocked line and Load images, or the images once revealed.
/// The state rides on the line, valued blocked or loaded: a containing
/// group drops its value on macOS.
struct EmailImagesRow: View {
  let card: EmailCard
  let desk: EmailDesk
  let palette: Tokens.Palette

  private var revealed: Bool { desk.isRevealed(card.id) }

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if revealed {
        ForEach(card.meta.images, id: \.url) { image in
          RemoteImageView(image: image, palette: palette)
        }
        Text(ProvisionalUI.emailImagesShown)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityValue("loaded")
          .accessibilityIdentifier(ShellID.emailImagesPrefix + card.id)
      } else {
        HStack(spacing: 8) {
          Text(ProvisionalUI.emailImagesBlocked(card.meta.images.count, trackers: card.meta.trackers))
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityValue("blocked")
            .accessibilityIdentifier(ShellID.emailImagesPrefix + card.id)
          Spacer(minLength: 8)
          SettingsButton(title: ProvisionalUI.emailLoadImages, palette: palette, id: ShellID.emailLoadPrefix + card.id) {
            desk.reveal(card.id)
          }
        }
      }
    }
    .padding(10)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer2)))
    .accessibilityElement(children: .contain)
  }
}

/// One revealed remote image. It is asked for only once drawn, and it is
/// drawn only after a reveal; a failure keeps the box with the file's name.
struct RemoteImageView: View {
  let image: EmailImage
  let palette: Tokens.Palette
  @State private var loaded: NSImage?

  private var size: CGSize {
    let width = min(Double(image.width > 0 ? image.width : 600), EmailMeasure.textWidth() - 20)
    let ratio = image.width > 0 && image.height > 0 ? Double(image.height) / Double(image.width) : 0.5
    return CGSize(width: width, height: (width * ratio).rounded())
  }

  var body: some View {
    ZStack {
      if let loaded {
        Image(nsImage: loaded).resizable().scaledToFit()
      } else {
        RoundedRectangle(cornerRadius: 6).strokeBorder(Tokens.color(palette.inkDim, opacity: 0.4), lineWidth: 1)
        Text(URL(string: image.url)?.lastPathComponent ?? image.url)
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
    }
    .frame(width: size.width, height: size.height)
    .task(id: image.url) { loaded = await RemoteImageLoader.fetch(image) }
  }
}

/// 05.F: the invite as an object card. No RSVP control in this version.
struct EmailInviteCard: View {
  let invite: EmailInvite
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text(ProvisionalUI.emailInviteHeader)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      Text(invite.title)
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize(horizontal: false, vertical: true)
      ForEach([invite.when, invite.place, invite.organizer?.printed].compactMap { $0 }, id: \.self) { line in
        Text(line)
          .font(.system(size: 12))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
      }
      if !invite.guests.isEmpty {
        Text(ProvisionalUI.emailInviteCounts(
          accepted: invite.count(.accepted), awaiting: invite.count(.awaiting) + invite.count(.maybe),
          declined: invite.count(.declined)))
          .font(.system(size: 11))
          .foregroundStyle(Tokens.color(palette.inkDim))
        ForEach(invite.guests, id: \.who.address) { guest in
          Text(guest.who.shown + " \u{00B7} " + guest.response.rawValue)
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.ink))
        }
      }
      Text(ProvisionalUI.emailInviteNoAnswer)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer2)))
    .overlay(alignment: .leading) {
      Rectangle().fill(Tokens.color(Tokens.tint)).frame(width: 3).accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(invite.title)
    .accessibilityIdentifier(ShellID.emailInvite)
  }
}

/// 05.B: the inline compose (D-UI-156). The parked Hold until sits above
/// Send with its reason (D-UI-139); the wall's line sits above Send too.
struct EmailComposeView: View {
  @Bindable var compose: EmailComposeModel
  let desk: EmailDesk
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      field(ProvisionalUI.emailFieldTo, text: $compose.to, id: ShellID.emailComposeTo)
      field(ProvisionalUI.emailFieldCc, text: $compose.cc, id: ShellID.emailComposeCc)
      field(ProvisionalUI.emailFieldBcc, text: $compose.bcc, id: ShellID.emailComposeBcc)
      field(ProvisionalUI.emailFieldSubject, text: $compose.subject, id: ShellID.emailComposeSubject)
      ZStack(alignment: .topLeading) {
        if compose.body.isEmpty {
          Text(ProvisionalUI.emailBodyPrompt)
            .font(.system(size: ProvisionalUI.emailBodySize))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .padding(.horizontal, 11)
            .padding(.vertical, 6)
            .accessibilityHidden(true)
        }
        TextEditor(text: $compose.body)
          .font(.system(size: ProvisionalUI.emailBodySize))
          .foregroundStyle(Tokens.color(palette.ink))
          .scrollContentBackground(.hidden)
          .padding(6)
          .disabled(compose.busy)
          // The body takes the keyboard when the compose opens (D-UI-156).
          // A first-mount click or FocusState does not reach a SwiftUI text
          // view on macOS (KeyboardClaim's measured note), so the claim is
          // made in AppKit, once the text view is in the window.
          .background(KeyboardClaim(token: "email-" + compose.mode.rawValue + "-" + compose.chatGuid))
          .accessibilityLabel(ProvisionalUI.emailBodyPrompt)
          .accessibilityIdentifier(ShellID.emailComposeBody)
      }
      .frame(minHeight: 72, maxHeight: 140)
      .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      if !compose.attachments.isEmpty {
        VStack(alignment: .leading, spacing: 4) {
          ForEach(compose.attachments, id: \.name) { file in
            HStack(spacing: 6) {
              Text(file.name + " \u{00B7} " + SizeText.megabytes(file.bytes))
                .font(.system(size: 11))
                .foregroundStyle(Tokens.color(palette.ink))
              Button {
                compose.remove(file)
              } label: {
                Text("\u{00D7}").font(.system(size: 12, weight: .semibold)).foregroundStyle(Tokens.color(palette.ink))
              }
              .buttonStyle(.plain)
              .disabled(compose.busy)
              .accessibilityLabel(file.name)
            }
          }
        }
      }
      hold
      if let line = compose.wallLine {
        Text(line)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(compose.wall == .block ? Tokens.danger : palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityLabel(line)
          .accessibilityValue(compose.wall.rawValue)
          .accessibilityIdentifier(ShellID.emailComposeWall)
      }
      HStack(spacing: 8) {
        SettingsButton(title: ProvisionalUI.emailSendLabel, palette: palette, id: ShellID.emailComposeSend) {
          compose.send()
        }
        .disabled(!compose.canSend)
        .opacity(compose.canSend ? 1 : 0.55)
        .accessibilityValue(compose.canSend ? "enabled" : "inert")
        if case .undo = compose.phase {
          SettingsButton(title: ProvisionalUI.emailUndoLabel, palette: palette, id: ShellID.emailComposeUndo) {
            compose.undo()
          }
        }
        SettingsButton(title: ProvisionalUI.emailDiscardLabel, palette: palette, id: ShellID.emailComposeDiscard) {
          desk.closeCompose()
        }
        Spacer(minLength: 0)
      }
      Text(compose.phaseLine)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityLabel(compose.phaseLine)
        .accessibilityValue(compose.phase.value)
        .accessibilityIdentifier(ShellID.emailComposeState)
    }
    .padding(ProvisionalUI.emailCardPadding)
    .frame(width: EmailMeasure.cardWidth(), alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(Tokens.tint), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    .accessibilityElement(children: .contain)
    .accessibilityIdentifier(ShellID.emailCompose)
  }

  private func field(_ label: String, text: Binding<String>, id: String) -> some View {
    HStack(spacing: 8) {
      Text(label)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .frame(width: 56, alignment: .leading)
      TextField(label, text: text)
        .textFieldStyle(.plain)
        .font(.system(size: 12))
        .foregroundStyle(Tokens.color(palette.ink))
        .disabled(compose.busy)
        .accessibilityLabel(label)
        .accessibilityIdentifier(id)
    }
    .padding(.vertical, 2)
    .overlay(alignment: .bottom) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 0.5).accessibilityHidden(true)
    }
  }

  /// D-UI-139: drawn and disabled, its reason beside it at full contrast;
  /// it never opens a picker. It is read as text, not as a button: a button
  /// with nothing to press fails the audit's "Action is missing", and an
  /// ignored-children group has no role and drops its value, so the two
  /// texts are combined into one element (as the compose recipient chip is).
  private var hold: some View {
    HStack(spacing: 8) {
      Text(ProvisionalUI.emailHoldLabel)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .padding(.vertical, 5)
        .padding(.horizontal, 12)
        .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), style: StrokeStyle(lineWidth: 1, dash: [3, 3])))
      Text(ProvisionalUI.emailHoldParked)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(ProvisionalUI.emailHoldLabel)
    .accessibilityValue(ProvisionalUI.emailHoldParked)
    .accessibilityIdentifier(ShellID.emailComposeHold)
    .disabled(true)
  }
}

/// 05.G: the category chips in the sidebar under All (D-UI-151). One on at
/// a time; the same chip again clears it.
struct EmailCategoryChips: View {
  let desk: EmailDesk
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 4) {
      ForEach(EmailCategory.allCases, id: \.self) { category in
        let on = desk.category == category
        Button {
          desk.toggle(category)
        } label: {
          Text(category.title)
            .font(.system(size: 10, weight: .medium))
            .foregroundStyle(Tokens.color(on ? palette.layer1 : palette.ink))
            .fixedSize()
            .padding(.vertical, 4)
            .padding(.horizontal, 7)
            .background(Capsule().fill(Tokens.color(on ? palette.ink : palette.layer1)))
            .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim, opacity: on ? 0 : 0.4), lineWidth: 1))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(category.title)
        .accessibilityValue(on ? "on" : "off")
        .accessibilityAddTraits(on ? .isSelected : [])
        .accessibilityIdentifier(ShellID.emailChipPrefix + category.rawValue.lowercased())
      }
      Spacer(minLength: 0)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 12)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.emailChipsLabel)
    .accessibilityIdentifier(ShellID.emailChips)
  }
}

/// Shift-R on an open email thread in Recent: Reply all (05.C, D-UI-158).
/// Triage and Needs You hear it through TriageKeys. A zero-size view that
/// takes the keyboard while no compose is open; keys with cmd, ctrl or opt
/// pass through, and every other key goes on up the chain untouched.
struct EmailKeys: NSViewRepresentable {
  let model: ShellModel
  let token: String

  func makeNSView(context: Context) -> KeyView {
    let view = KeyView()
    view.model = model
    return view
  }

  func updateNSView(_ view: KeyView, context: Context) {
    view.model = model
    view.want(token)
  }

  final class KeyView: NSView {
    weak var model: ShellModel?
    private var wanted: String?
    private var claimed: String?

    override init(frame: NSRect) {
      super.init(frame: frame)
      setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { true }

    func want(_ token: String) {
      guard token != wanted else { return }
      wanted = token
      claimed = nil
      schedule(attempt: 0)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      schedule(attempt: 0)
    }

    /// As TriageKeys: one attempt per main-queue turn, then every 50 ms
    /// for about 2 s, while the window settles.
    private func schedule(attempt: Int) {
      guard wanted != nil, wanted != claimed, attempt < 40 else { return }
      let delay: Double = attempt == 0 ? 0 : 0.05
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        MainActor.assumeIsolated { self?.claim(attempt: attempt) }
      }
    }

    private func claim(attempt: Int) {
      guard let token = wanted, token != claimed else { return }
      guard let window else {
        schedule(attempt: attempt + 1)
        return
      }
      if window.firstResponder === self || window.makeFirstResponder(self) {
        claimed = token
      } else {
        schedule(attempt: attempt + 1)
      }
    }

    override func keyDown(with event: NSEvent) {
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      guard let model, flags.intersection([.command, .control, .option]).isEmpty, flags.contains(.shift),
        event.charactersIgnoringModifiers?.lowercased() == "r"
      else { return super.keyDown(with: event) }
      model.replyAllEmail()
    }
  }
}
