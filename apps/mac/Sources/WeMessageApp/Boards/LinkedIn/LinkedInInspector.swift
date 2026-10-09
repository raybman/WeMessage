import SwiftUI
import WeMessageKit

// v2 B3, board 04: the inspector (04.G, D-UI-167). It opens with the
// thread head's toggle, as board 02's does. Who this is, the read-only
// ladder (04.B, D-UI-163), history on every channel, an address from their
// own profile, and the account's unread and credit counts per inbox, each
// dated. Nothing here is a control.

struct LinkedInInspector: View {
  let model: ShellModel
  let thread: ThreadSummary
  let palette: Tokens.Palette

  private var meta: LinkedInThreadMeta { LinkedInThreadMeta(thread) }
  private var status: LinkedInStatusMeta { model.linkedInStatus }
  private var asOf: String? { status.asOf.map { ProvisionalUI.linkedInAsOf(ShellText.shortClock($0)) } }

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        who
        ladder
        section(ProvisionalUI.linkedInHistoryTitle) {
          ForEach(meta.historyRows, id: \.channel) { row in
            line(channelName(row.channel) + ": " + (row.line ?? ProvisionalUI.linkedInHistoryNone), dim: row.line == nil)
          }
        }
        if let also = meta.alsoReachable {
          section(ProvisionalUI.linkedInAlsoTitle) {
            line(also, dim: false)
            line(ProvisionalUI.linkedInAlsoInert, dim: true)
          }
        }
        if !status.unread.isEmpty {
          section(ProvisionalUI.linkedInInboxesTitle) {
            ForEach(LinkedInInbox.allCases, id: \.self) { inbox in
              line(ProvisionalUI.linkedInUnreadRow(inbox.title, unread: status.unread[inbox] ?? 0), dim: false)
            }
            if let asOf { line(asOf, dim: true) }
          }
        }
        if !status.credits.isEmpty {
          section(ProvisionalUI.linkedInCreditsTitle) {
            ForEach(LinkedInInbox.allCases, id: \.self) { inbox in
              line(ProvisionalUI.linkedInCreditRow(inbox.title, credits: status.credits[inbox] ?? 0), dim: false)
            }
            line([status.plan, asOf].compactMap { $0 }.joined(separator: " \u{00B7} "), dim: true)
          }
        }
      }
      .padding(12)
      .frame(maxWidth: .infinity, alignment: .leading)
    }
    .frame(width: ProvisionalUI.linkedInInspectorWidth)
    .frame(maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(ProvisionalUI.linkedInWhoTitle)
    .accessibilityIdentifier(ShellID.linkedInInspector)
  }

  private var who: some View {
    section(ProvisionalUI.linkedInWhoTitle) {
      HStack(spacing: 8) {
        AvatarView(thread: thread, image: model.avatars.image(for: thread), size: 36)
        VStack(alignment: .leading, spacing: 2) {
          Text(thread.title)
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
          if let degree = meta.degree { line(degree + " \u{00B7} " + meta.inbox.title, dim: true) }
        }
      }
      ForEach([meta.headline, meta.location, meta.shared, meta.project].compactMap { $0 }, id: \.self) { text in
        line(text, dim: false)
      }
    }
  }

  /// D-UI-163: the five steps, the one that reaches this person marked by
  /// the tint bar. One element: its value is the step.
  private var ladder: some View {
    let current = ProvisionalUI.linkedInRungTitle(meta.rung.rawValue)
    return section(ProvisionalUI.linkedInLadderTitle) {
      VStack(alignment: .leading, spacing: 3) {
        ForEach(LinkedInRung.allCases, id: \.self) { rung in
          let on = rung == meta.rung
          HStack(spacing: 6) {
            Rectangle().fill(Tokens.color(Tokens.tint, opacity: on ? 1 : 0)).frame(width: 3, height: 14)
            Text(ProvisionalUI.linkedInRungTitle(rung.rawValue))
              .font(.system(size: 11, weight: on ? .semibold : .regular))
              .foregroundStyle(Tokens.color(on ? palette.ink : palette.inkDim))
              .fixedSize(horizontal: false, vertical: true)
          }
        }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(ProvisionalUI.linkedInLadderTitle)
      .accessibilityValue(current)
      .accessibilityIdentifier(ShellID.linkedInLadder)
    }
  }

  private func channelName(_ channel: Channel) -> String {
    ShellModel.Scope(rawValue: channel.rawValue)?.fullLabel ?? channel.rawValue
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(title)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityAddTraits(.isHeader)
      content()
    }
  }

  private func line(_ text: String, dim: Bool) -> some View {
    Text(text)
      .font(.system(size: 11))
      .foregroundStyle(Tokens.color(dim ? palette.inkDim : palette.ink))
      .fixedSize(horizontal: false, vertical: true)
  }
}
