import AppKit
import SwiftUI
import WeMessageKit

/// One avatar (S4g): the contact's photo clipped to a circle, or the
/// initials disc. The disc's fill is the D-UI-8 step for the thread's key
/// (a handle keeps its colour), and its letters are the appearance's ink,
/// 7:1 on every disc (D-UI-57). A title with no letters draws a person
/// glyph (D-UI-56); a group draws its title's initials (D-UI-55).
struct AvatarView: View {
  let thread: ThreadSummary
  let image: NSImage?
  let size: CGFloat
  @Environment(\.colorScheme) private var scheme

  private var dark: Bool { scheme == .dark }
  private var palette: Tokens.Palette { Tokens.palette(dark: dark) }

  var body: some View {
    Group {
      if let image {
        Image(nsImage: image)
          .resizable()
          .interpolation(.high)
          .scaledToFill()
          .clipShape(Circle())
      } else {
        Circle()
          .fill(Tokens.color(Tokens.Avatar.disc(for: AvatarKey.of(thread), dark: dark)))
          .overlay(face)
      }
    }
    .overlay(Circle().strokeBorder(Tokens.color(palette.inkDim, opacity: 0.35), lineWidth: 1))
    .frame(width: size, height: size)
    .accessibilityHidden(true)
  }

  @ViewBuilder private var face: some View {
    switch AvatarFace.make(title: thread.title, handle: threadHandle(thread), denied: ProvisionalUI.deniedAvatar) {
    case .letters(let letters):
      Text(letters)
        .font(.system(size: max(10, size * 0.36), weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
    case .glyph:
      Image(systemName: "person.fill")
        .font(.system(size: size * 0.44))
        .foregroundStyle(Tokens.color(palette.ink))
    }
  }
}
