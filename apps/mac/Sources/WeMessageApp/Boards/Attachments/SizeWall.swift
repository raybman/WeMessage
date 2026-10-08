import SwiftUI
import WeMessageKit

// v2 S4k, board 15.B: the walls, read from the kit's dated config and never
// from a send routine. Each row says the wall, whether it is per item or
// per message, whether it is assumed, the day it was last checked and what
// imposed it. Below, the dropped video against iMessage's wall: the wall
// drawn as a property of each choice, not a failure after the send.

struct WallsPage: View {
  let model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("The walls, as of the dates they were last checked")
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      ForEach(model.walls.walls, id: \.channel) { wall in
        WallRow(wall: wall, palette: palette)
      }
      Text("A wall that turns out wrong is fixed in the dated config, never by retrying a send.")
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
      if let video = model.content.dropped.first(where: \.isVideo), let wall = model.wall {
        Text("The dropped video, before anything goes")
          .font(.system(size: 13, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .padding(.top, 6)
        CompressionTableView(video: video, wall: wall, palette: palette)
      }
    }
  }
}

struct WallRow: View {
  let wall: SizeWall
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      HStack(spacing: 10) {
        Text(wall.channel.title)
          .font(.system(size: 13, weight: .semibold))
          .frame(width: 90, alignment: .leading)
        Text(wall.printed)
          .font(.system(size: 12).monospacedDigit())
        Text(wall.assumed ? "assumed" : "known")
          .font(.system(size: 10, weight: .semibold))
          .padding(.vertical, 1)
          .padding(.horizontal, 6)
          .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
        Spacer()
        Text("as of " + wall.asOf)
          .font(.system(size: 11).monospacedDigit())
      }
      .foregroundStyle(Tokens.color(palette.ink))
      Text(wall.source)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
    }
    .padding(10)
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
    .accessibilityElement(children: .combine)
    .accessibilityValue(wall.dated)
    .accessibilityIdentifier(ShellID.mediaWallPrefix + wall.channel.rawValue)
  }
}
