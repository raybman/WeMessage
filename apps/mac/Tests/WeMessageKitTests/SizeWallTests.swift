import Foundation
import Testing
import WeMessageKit

/// v2 S4k, boards 15.B to 15.D: the walls come from a dated config, never
/// from a send routine; the tray prints the conversions and the recipient's
/// grid; every video carries its duration, in the tray and in every row of
/// the compression table.
@Suite("SizeWall")
struct SizeWallTests {
  static let walls = SizeWallTable.standard

  @Test("the iMessage wall comes from the config with a date: about 100 MB per attachment, assumed, Apple's own figure")
  func iMessageWall() throws {
    let table = try SizeWallTable.decode(Data(SizeWallTable.config.utf8))
    #expect(table == Self.walls)
    let wall = try #require(table.wall(for: .imessage))
    #expect(wall.bytes == 100_000_000)
    #expect(wall.basis == .perItem)
    #expect(wall.assumed)
    #expect(wall.asOf == "2026-09-22")
    #expect(wall.source.contains("Apple"))
    #expect(wall.printed == "about 100 MB per attachment")
    #expect(wall.dated == "about 100 MB per attachment, as of 2026-09-22")
    // Every wall in the config carries a date: one with none is a wall
    // hardcoded somewhere else.
    for w in table.walls { #expect(w.asOf.count == 10, "\(w.channel) is undated") }
    #expect(Set(table.walls.map(\.channel)) == Set(MediaChannel.allCases))
  }

  @Test("a config without a date does not decode")
  func undated() {
    let undated = SizeWallTable.config.replacingOccurrences(of: "\"asOf\": \"2026-09-22\",", with: "")
    #expect(undated != SizeWallTable.config)
    #expect(throws: (any Error).self) { try SizeWallTable.decode(Data(undated.utf8)) }
  }

  @Test("fit: a chat channel moves bytes, email carries base64; an assumed cap is tight near its edge")
  func fit() throws {
    let im = try #require(Self.walls.wall(for: .imessage))
    #expect(im.fit(412_000_000) == .no)
    #expect(im.fit(96_000_000) == .tight)
    #expect(im.fit(42_000_000) == .yes)
    let mail = try #require(Self.walls.wall(for: .email))
    #expect(mail.encodingOverhead == 1.37)
    #expect(mail.fit(13_000_000) == .yes)
    #expect(mail.fit(19_000_000) == .no)
  }

  @Test("every video names its duration, in the tray chip and in every row of the compression table")
  func videoDuration() throws {
    let video = try #require(AttachmentFixtures.dropped.first { $0.isVideo })
    #expect(video.chip == "\u{25B6} 4:12")
    #expect(video.meta.contains("4:12"))
    let im = try #require(Self.walls.wall(for: .imessage))
    let rows = CompressionTable.rows(for: video, wall: im)
    #expect(rows.count == 4)
    for row in rows {
      #expect(row.duration == "4:12", "\(row.target) has no duration")
      #expect(row.line.contains("4:12"), "\(row.target) prints no duration")
    }
    #expect(rows.map(\.target) == ["Original", "1080p H.264", "720p H.264", "540p H.264"])
    #expect(rows.map(\.size) == ["412 MB exact", "96 MB estimate", "42 MB estimate", "13 MB estimate"])
    #expect(rows.map(\.fit) == [.no, .tight, .yes, .yes])
    #expect(CompressionTable.duration(48) == "0:48")
    #expect(CompressionTable.duration(3723) == "1:02:03")
  }

  @Test("the tray prints HEIC to JPEG, the location strip, the counter, and the recipient's grid")
  func tray() throws {
    var tray = StagingTray(channel: .imessage, walls: Self.walls)
    #expect(tray.header == "Nothing staged")
    #expect(!tray.canSend)
    tray.stage(AttachmentFixtures.attached)
    #expect(tray.header == "Staged \u{00B7} 4 images")
    #expect(tray.totals == "18.7 MB \u{00B7} largest 6.2 MB")
    #expect(tray.conversionLine == "2 HEIC will be sent as JPEG. Quality 0.9, dimensions unchanged, originals untouched on disk.")
    #expect(tray.locationLine == "Location metadata removed from 3 of 4. Orientation, date and dimensions are kept.")
    #expect(tray.counter == "93.8 MB left under iMessage's wall of about 100 MB per attachment. Largest staged item 6.2 MB.")
    #expect(tray.items.map(\.wireName).first == "IMG_4417.jpg")
    #expect(tray.grid == RecipientGrid(columns: 3, cell: 64, shown: 4, overflow: 0))
    #expect(tray.canSend)
    // Seven: 3-up with five cells and a +2.
    tray.stage(AttachmentFixtures.dropped)
    #expect(tray.items.count == 7)
    #expect(tray.grid == RecipientGrid(columns: 3, cell: 64, shown: 5, overflow: 2))
    // Over the wall: Send is inert, and nothing offers to send anyway.
    #expect(tray.overWall.count == 1)
    #expect(!tray.canSend)
    #expect(tray.counter.contains("over iMessage's wall"))
    let video = try #require(tray.items.first { $0.isVideo })
    tray.remove(video.id)
    #expect(tray.canSend)
    #expect(RecipientGrid.for(2) == RecipientGrid(columns: 2, cell: 88, shown: 2, overflow: 0))
  }

  @Test("a pasted image arrives with an invented name, shown before the send")
  func pastedName() {
    let at = ISO8601DateFormatter().date(from: "2026-09-22T14:03:00Z")!
    let pasted = StagedFile.pasted(bytes: 2_100_000, width: 1440, height: 900, at: at, timeZone: TimeZone(identifier: "UTC")!)
    #expect(pasted.name == "pasted-2026-09-22-1403.png")
    #expect(pasted.wireName == pasted.name)
  }

  @Test("the viewer's set does not wrap, and counts its kinds in words")
  func viewer() {
    var set = ViewerSet(items: AttachmentFixtures.thread, index: 2)
    #expect(set.position == "3 / 7")
    #expect(set.kinds == "4 images, 2 videos, 1 PDF")
    set.previous(); set.previous(); set.previous()
    #expect(set.position == "1 / 7")
    #expect(!set.canGoBack)
    for _ in 0..<10 { set.next() }
    #expect(set.position == "7 / 7")
    #expect(!set.canGoForward)
    for item in AttachmentFixtures.thread where item.isVideo {
      #expect(item.chip.contains(":"), "\(item.name) shows no duration")
    }
  }
}
