import Foundation
import WeMessageKit

/// v2 S4k, board 15: one synthetic iMessage thread and the files its doors
/// bring. No real names, numbers or pixels: the handle is a +1 555 one, and
/// every file is a name and a size chosen to land on the board's printed
/// figures (18.7 MB staged, a 412 MB 4:12 video, seven attachments).
enum FixtureAttachments {
  static let attachments: [StagedFile] = [
    StagedFile(id: "t1", name: "IMG_4410.HEIC", kind: .image(.heic), bytes: 2_300_000, width: 3024, height: 4032),
    StagedFile(id: "t2", name: "IMG_4412.HEIC", kind: .image(.heic), bytes: 2_200_000, width: 3024, height: 4032),
    StagedFile(id: "t3", name: "IMG_4417.HEIC", kind: .image(.heic), bytes: 2_400_000, width: 3024, height: 4032),
    StagedFile(id: "t4", name: "trail-01.mov", kind: .video(seconds: 41), bytes: 18_000_000, width: 1920, height: 1080),
    StagedFile(id: "t5", name: "IMG_4420.HEIC", kind: .image(.heic), bytes: 2_500_000, width: 3024, height: 4032),
    StagedFile(id: "t6", name: "trail-02.mov", kind: .video(seconds: 73), bytes: 31_000_000, width: 1920, height: 1080),
    StagedFile(id: "t7", name: "permit.pdf", kind: .document("PDF"), bytes: 400_000),
  ]

  /// Fourteen messages; the viewer's origin, IMG_4417, is message m6.
  static let messages: [MediaMessage] = [
    MediaMessage(id: "m1", fromMe: false, text: "Are you still up for the ridge loop on Saturday?", attachment: nil, time: "Sep 18, 9:12"),
    MediaMessage(id: "m2", fromMe: true, text: "Yes. Send me what you have from the last one.", attachment: nil, time: "9:14"),
    MediaMessage(id: "m3", fromMe: false, text: nil, attachment: 0, time: "9:30"),
    MediaMessage(id: "m4", fromMe: false, text: nil, attachment: 1, time: "9:31"),
    MediaMessage(id: "m5", fromMe: true, text: "That switchback is steeper than I remember.", attachment: nil, time: "9:35"),
    MediaMessage(id: "m6", fromMe: false, text: nil, attachment: 2, time: "9:41"),
    MediaMessage(id: "m7", fromMe: false, text: "Two more from the roof of the hut.", attachment: nil, time: "9:42"),
    MediaMessage(id: "m8", fromMe: false, text: nil, attachment: 3, time: "9:44"),
    MediaMessage(id: "m9", fromMe: true, text: "Got them.", attachment: nil, time: "9:50"),
    MediaMessage(id: "m10", fromMe: false, text: nil, attachment: 4, time: "10:02"),
    MediaMessage(id: "m11", fromMe: false, text: nil, attachment: 5, time: "10:05"),
    MediaMessage(id: "m12", fromMe: true, text: "Can you send the permit as well?", attachment: nil, time: "10:20"),
    MediaMessage(id: "m13", fromMe: false, text: nil, attachment: 6, time: "10:31"),
    MediaMessage(id: "m14", fromMe: true, text: "Thanks. I will bring the walkthrough clip Friday.", attachment: nil, time: "10:40"),
  ]

  static let attached: [StagedFile] = [
    StagedFile(id: "a1", name: "IMG_4417.HEIC", kind: .image(.heic), bytes: 6_200_000, width: 4032, height: 3024, hasLocation: true),
    StagedFile(id: "a2", name: "IMG_4418.HEIC", kind: .image(.heic), bytes: 5_100_000, width: 4032, height: 3024, hasLocation: true),
    StagedFile(id: "a3", name: "site-plan.png", kind: .image(.png), bytes: 2_100_000, width: 1440, height: 900),
    StagedFile(id: "a4", name: "north-elevation.jpg", kind: .image(.jpeg), bytes: 5_300_000, width: 3000, height: 2000, hasLocation: true),
  ]

  static let dropped: [StagedFile] = [
    StagedFile(id: "d1", name: "roof-east.jpg", kind: .image(.jpeg), bytes: 6_200_000, width: 4000, height: 3000),
    StagedFile(id: "d2", name: "roof-west.png", kind: .image(.png), bytes: 2_100_000, width: 1440, height: 900),
    StagedFile(id: "d3", name: "pilot-walkthrough.mov", kind: .video(seconds: 252), bytes: 412_000_000, width: 3840, height: 2160),
  ]

  static func content() -> MediaContent {
    MediaContent(
      recipient: "Maya Lee", handle: "+15550100003", messages: messages, attachments: attachments,
      attached: attached, dropped: dropped,
      pasted: (bytes: 2_100_000, width: 1440, height: 900, at: Date(timeIntervalSince1970: 1_790_085_780)),
      draftedWords: "Friday works, same time. I will bring the projector so Sam does not have to carry it in.")
  }
}
