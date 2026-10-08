import SwiftUI
import WeMessageKit

/// Board 02's thread under its head: in a group the INV-5 strip, then the
/// transcript (bottom-anchored), the channel banner and the composer. It
/// reads through ThreadModel and sends only through Outbound (plan 2.2).
struct ThreadView: View {
  @Bindable var model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var loadValue: String {
    switch model.thread.load {
    case .idle: "idle"
    case .loading: "loading"
    case .loaded: "loaded"
    case .unknownChat: "unknown chat"
    case .failed: "failed"
    }
  }

  var body: some View {
    VStack(spacing: 0) {
      if thread.isGroup { Inv5Strip(palette: palette) }
      TranscriptView(model: model, thread: thread, palette: palette)
      ChannelBanner(thread: thread, palette: palette)
      if model.lens == .triage {
        VerbRow(model: model, thread: thread, palette: palette)
      }
      ComposerView(model: model, thread: thread, palette: palette)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    // Measured (run 37553425686): a container's value never reaches AX on
    // macOS, so the load state rides the label too.
    .accessibilityLabel("Conversation: " + loadValue)
    .accessibilityValue(loadValue)
    .accessibilityIdentifier(ShellID.thread)
  }
}

/// INV-5 (02.E): a solid strip, not a setting row, because it is the one
/// rule in the scope that is not a preference.
struct Inv5Strip: View {
  let palette: Tokens.Palette

  static let line = "INV-5 \u{00B7} The agent never auto-responds in a group. There is no setting that enables it."

  var body: some View {
    Text(Self.line)
      .font(.system(size: 10, weight: .semibold))
      .foregroundStyle(Tokens.color(palette.layer1))
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(.vertical, 6)
      .padding(.horizontal, 12)
      .background(Tokens.color(palette.ink))
      .accessibilityElement(children: .contain)
      .accessibilityLabel(Self.line)
      .accessibilityIdentifier(ShellID.inv5)
  }
}

/// The reply banner above the composer (02.A): the channel tag, "Replying
/// on iMessage" (no number, D-UI-20), and on the right what the app can
/// say about the transport: Apple chooses it at send time. An SMS chat
/// says its last transport instead (02.D), from the chat guid's service.
struct ChannelBanner: View {
  let thread: ThreadSummary
  let palette: Tokens.Palette

  static let chooses = "sends through Messages.app \u{00B7} transport chosen by Apple at send time"
  static let lastSMS = "last transport: SMS \u{00B7} carrier rates"

  private var cap: String { isSMSChat(thread.chatGuid) ? Self.lastSMS : Self.chooses }

  var body: some View {
    HStack(spacing: 8) {
      ChannelTag(channel: ShellModel.Scope.imessage.rawValue, palette: palette)
      Text(ProvisionalUI.replyingBanner)
        .font(.system(size: 11, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .fixedSize()
      Spacer(minLength: 8)
      Text(cap)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .lineLimit(1)
        .truncationMode(.head)
    }
    .padding(.vertical, 6)
    .padding(.horizontal, 12)
    .background(Hatch(palette: palette))
    .overlay(alignment: .bottom) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.2)).frame(height: 2)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.replyingBanner + ", " + cap)
    .accessibilityIdentifier(ShellID.threadBanner)
  }
}

/// The wireframe's diagonal hatch for a band the app, not a person, wrote.
struct Hatch: View {
  let palette: Tokens.Palette

  var body: some View {
    Canvas { context, size in
      var path = Path()
      var x = -size.height
      while x < size.width {
        path.move(to: CGPoint(x: x, y: size.height))
        path.addLine(to: CGPoint(x: x + size.height, y: 0))
        x += 8
      }
      context.stroke(path, with: .color(Tokens.color(palette.inkDim, opacity: 0.07)), lineWidth: 3)
    }
    .accessibilityHidden(true)
  }
}

/// True when a chat guid names the SMS service (D-UI-28: the daemon serves
/// no per-message service, so the chat's stands in).
func isSMSChat(_ chatGuid: String) -> Bool {
  chatGuid.hasPrefix("SMS;")
}
