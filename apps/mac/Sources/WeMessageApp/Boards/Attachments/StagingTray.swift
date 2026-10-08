import SwiftUI
import WeMessageKit

// v2 S4k, board 15.C to 15.E: the staging tray, the one place every door
// lands. It prints what will change on the way out (HEIC to JPEG, the
// location strip), the wall and what is left under it, and the grid the
// recipient will get. A staged video carries its duration and the
// compression table beneath it. The composer row ends in the record slot,
// which on iMessage is a printed reason and no control at all (15.E), and
// the tray's Send, the only call to the sink (H-S4-11).

struct StagingTrayView: View {
  @Bindable var model: AttachmentsModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      if !model.tray.isEmpty {
        ScrollView(.vertical) {
          VStack(alignment: .leading, spacing: 8) {
            header
            cells
            lines
            HStack(alignment: .top, spacing: 16) {
              RecipientGridView(grid: model.tray.grid, recipient: model.content.recipient, palette: palette)
              if let video = model.tray.items.first(where: \.isVideo), let wall = model.wall {
                CompressionTableView(video: video, wall: wall, palette: palette)
              }
            }
          }
        }
        .frame(maxHeight: 300)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(model.tray.header)
        .accessibilityIdentifier(ShellID.mediaTray)
      }
      composer
    }
    .padding(.horizontal, AttachmentsWindow.margin)
    .padding(.vertical, 10)
  }

  private var header: some View {
    HStack(spacing: 10) {
      Text(model.tray.header)
        .font(.system(size: 12, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
      Text(model.tray.totals)
        .font(.system(size: 11).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.inkDim))
      Spacer()
    }
  }

  /// Numbered, in the order staged (D-UI-110): on some channels the order
  /// is the delivery order, so the numbers are never decoration.
  private var cells: some View {
    ScrollView(.horizontal) {
      HStack(spacing: 8) {
        ForEach(Array(model.tray.items.enumerated()), id: \.element.id) { index, item in
          VStack(alignment: .leading, spacing: 3) {
            ZStack(alignment: .topTrailing) {
              MediaThumb(item: item, palette: palette, width: 96, height: 72)
              Button {
                model.remove(item.id)
              } label: {
                Text("\u{2715}")
                  .font(.system(size: 10, weight: .bold))
                  .foregroundStyle(Tokens.color(palette.ink))
                  .frame(width: 22, height: 22)
                  .background(Circle().fill(Tokens.color(palette.layer1)))
                  .contentShape(Circle())
              }
              .buttonStyle(.plain)
              .focusable()
              .accessibilityLabel("Remove \(item.wireName)")
              .accessibilityIdentifier(ShellID.mediaTrayRemovePrefix + item.id)
            }
            Text("\(index + 1) \u{00B7} " + item.wireName)
              .font(.system(size: 10).monospaced())
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
              .frame(width: 96, alignment: .leading)
            Text(item.meta)
              .font(.system(size: 10).monospacedDigit())
              .foregroundStyle(Tokens.color(palette.inkDim))
              .lineLimit(1)
              .frame(width: 96, alignment: .leading)
          }
          .accessibilityElement(children: .contain)
          .accessibilityLabel(item.wireName + ", " + item.chip)
          .accessibilityIdentifier(ShellID.mediaTrayItemPrefix + item.id)
        }
      }
    }
  }

  private var lines: some View {
    VStack(alignment: .leading, spacing: 4) {
      if let conversion = model.tray.conversionLine {
        line(conversion, id: ShellID.mediaConversion)
      }
      if let location = model.tray.locationLine {
        line(location, id: ShellID.mediaLocation)
      }
      line(model.tray.counter, id: ShellID.mediaCounter, strong: !model.tray.overWall.isEmpty)
    }
  }

  private func line(_ words: String, id: String, strong: Bool = false) -> some View {
    Text(words)
      .font(.system(size: 11, weight: strong ? .semibold : .regular))
      .foregroundStyle(Tokens.color(strong ? palette.ink : palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
      .accessibilityIdentifier(id)
  }

  /// The composer: one caption for the set, the record slot, and Send.
  private var composer: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(spacing: 10) {
        TextField("Message", text: Binding(get: { model.composerWords }, set: { model.composerWords = $0 }))
          .textFieldStyle(.plain)
          .font(.system(size: 13))
          .padding(.vertical, 6)
          .padding(.horizontal, 10)
          .overlay(Capsule().strokeBorder(Tokens.color(palette.inkDim), lineWidth: 1))
          .accessibilityIdentifier(ShellID.mediaField)
        let live = model.tray.canSend
        SettingsButton(
          title: model.tray.isEmpty ? "Send" : "Send \(model.tray.items.count)  \u{2318}\u{21A9}", palette: palette,
          id: ShellID.mediaSend
        ) { model.sendTray() }
        .keyboardShortcut(.return, modifiers: .command)
        .opacity(live ? 1 : 0.55)
        .accessibilityValue(live ? "enabled" : "inert")
      }
      RecordSlot(control: model.record, palette: palette)
      if let note = model.note {
        Text(note)
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier(ShellID.mediaNote)
      }
    }
  }
}

/// Where a record control would be. On iMessage there is none to draw, so
/// the slot prints why, in the place it would have been (15.H: ABSENT).
/// A greyed control here would promise a condition the user can meet.
struct RecordSlot: View {
  let control: RecordControl
  let palette: Tokens.Palette

  var body: some View {
    if let reason = control.reason {
      Text(reason)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityIdentifier(ShellID.mediaRecord)
    }
  }
}

/// What the recipient gets, in 08.D's geometry: the same grid the inbound
/// side draws, previewed before the send.
struct RecipientGridView: View {
  let grid: RecipientGrid
  let recipient: String
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text("What " + (recipient.split(separator: " ").first.map(String.init) ?? recipient) + " gets")
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      let cells = grid.shown + (grid.overflow > 0 ? 1 : 0)
      LazyVGrid(
        columns: Array(repeating: GridItem(.fixed(Double(grid.cell) / 2), spacing: 3), count: grid.columns),
        alignment: .leading, spacing: 3
      ) {
        ForEach(0..<cells, id: \.self) { i in
          let overflowCell = grid.overflow > 0 && i == grid.shown
          Text(overflowCell ? "+\(grid.overflow)" : "\(i + 1)")
            .font(.system(size: 9, weight: .semibold).monospacedDigit())
            .foregroundStyle(Tokens.color(palette.ink))
            .frame(width: Double(grid.cell) / 2, height: Double(grid.cell) / 2)
            .background(RoundedRectangle(cornerRadius: 3).fill(Tokens.color(palette.layer2)))
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isImage)
    .accessibilityLabel("Recipient grid, \(grid.columns)-up \(grid.cell), \(grid.shown) shown, +\(grid.overflow)")
    .accessibilityIdentifier(ShellID.mediaGrid)
  }
}

/// 15.D: one row per target, each with the video's duration and a fit
/// token against the wall. A report, not a picker (D-UI-105).
struct CompressionTableView: View {
  let video: StagedFile
  let wall: SizeWall
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      Text(video.name + " \u{00B7} " + video.chip + " \u{00B7} against iMessage's " + wall.printed)
        .font(.system(size: 10, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
      ForEach(CompressionTable.rows(for: video, wall: wall), id: \.target) { row in
        HStack(spacing: 10) {
          Text(row.target).frame(width: 90, alignment: .leading)
          Text(row.frame).frame(width: 80, alignment: .leading)
          Text(row.size).frame(width: 100, alignment: .leading)
          Text(row.duration).frame(width: 44, alignment: .leading)
          Text(row.fit.token).fontWeight(row.fit == .no ? .semibold : .regular)
        }
        .font(.system(size: 11).monospacedDigit())
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isStaticText)
        .accessibilityLabel(row.line)
        .accessibilityIdentifier(ShellID.mediaCompressionRowPrefix + String(row.target.prefix(while: { $0 != " " })).lowercased())
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Compression")
    .accessibilityIdentifier(ShellID.mediaCompression)
  }
}
