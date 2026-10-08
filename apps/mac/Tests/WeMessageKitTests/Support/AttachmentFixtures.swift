import Foundation
import WeMessageKit

/// Board 15's synthetic files for the kit's tests: no real names, no real
/// pixels, sizes chosen to land on the board's printed figures.
enum AttachmentFixtures {
  /// 15.C: four images from the attach button, two HEIC, three with a
  /// location. 18.7 MB, largest 6.2 MB.
  static let attached: [StagedFile] = [
    StagedFile(id: "a1", name: "IMG_4417.HEIC", kind: .image(.heic), bytes: 6_200_000, width: 4032, height: 3024, hasLocation: true),
    StagedFile(id: "a2", name: "IMG_4418.HEIC", kind: .image(.heic), bytes: 5_100_000, width: 4032, height: 3024, hasLocation: true),
    StagedFile(id: "a3", name: "site-plan.png", kind: .image(.png), bytes: 2_100_000, width: 1440, height: 900),
    StagedFile(id: "a4", name: "north-elevation.jpg", kind: .image(.jpeg), bytes: 5_300_000, width: 3000, height: 2000, hasLocation: true),
  ]

  /// 15.A: three files dropped, one a 412 MB, 4:12 video over iMessage's wall.
  static let dropped: [StagedFile] = [
    StagedFile(id: "d1", name: "roof-east.jpg", kind: .image(.jpeg), bytes: 6_200_000, width: 4000, height: 3000),
    StagedFile(id: "d2", name: "roof-west.png", kind: .image(.png), bytes: 2_100_000, width: 1440, height: 900),
    StagedFile(id: "d3", name: "pilot-walkthrough.mov", kind: .video(seconds: 252), bytes: 412_000_000, width: 3840, height: 2160),
  ]

  /// 15.F: a thread's seven attachments in thread order: four images, two
  /// videos, one PDF.
  static let thread: [StagedFile] = [
    StagedFile(id: "t1", name: "IMG_4410.HEIC", kind: .image(.heic), bytes: 2_300_000, width: 3024, height: 4032),
    StagedFile(id: "t2", name: "IMG_4412.HEIC", kind: .image(.heic), bytes: 2_200_000, width: 3024, height: 4032),
    StagedFile(id: "t3", name: "IMG_4417.HEIC", kind: .image(.heic), bytes: 2_400_000, width: 3024, height: 4032),
    StagedFile(id: "t4", name: "trail-01.mov", kind: .video(seconds: 41), bytes: 18_000_000, width: 1920, height: 1080),
    StagedFile(id: "t5", name: "IMG_4420.HEIC", kind: .image(.heic), bytes: 2_500_000, width: 3024, height: 4032),
    StagedFile(id: "t6", name: "trail-02.mov", kind: .video(seconds: 73), bytes: 31_000_000, width: 1920, height: 1080),
    StagedFile(id: "t7", name: "permit.pdf", kind: .document("PDF"), bytes: 400_000),
  ]
}
