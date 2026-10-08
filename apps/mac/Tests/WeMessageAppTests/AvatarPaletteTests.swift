import Foundation
import Testing

@testable import WeMessageApp

/// S4g: the initials discs (D-UI-8). A handle always lands on the same disc
/// (FNV-1a into six steps), no disc in any D-UI-8 option is green, and the
/// ink drawn on a disc reads at 7:1 in both appearances.
@Suite("AvatarPalette")
struct AvatarPaletteTests {
  static let options: [ProvisionalUI.AvatarPalette] = [.blueFamily, .mixedNoGreen, .monochrome]

  /// No hue in 75...165 at all, unless the colour is a true grey (hue 0,
  /// saturation 0). Stricter than T1, which lets a near-grey green pass.
  static func hasGreenHue(_ rgb: Tokens.RGB) -> Bool {
    rgb.saturation > 0 && (75...165).contains(rgb.hue)
  }

  /// Ten thousand synthetic handles: +1555 numbers, example.com addresses
  /// and group guids.
  static let handles: [String] = (0..<10_000).map { i in
    switch i % 3 {
    case 0: "+1555" + String(format: "%07d", i)
    case 1: "person\(i)@example.com"
    default: "group:iMessage;+;chat555\(i)"
    }
  }

  @Test("AP1: no disc of any D-UI-8 option has a hue in 75...165, across 10,000 handles, light and dark")
  func noGreenAcrossHandles() {
    var drawn = 0
    for option in Self.options {
      for dark in [false, true] {
        for handle in Self.handles {
          let disc = Tokens.Avatar.disc(for: handle, dark: dark, palette: option)
          drawn += 1
          if Self.hasGreenHue(disc) {
            Issue.record("\(option) dark=\(dark) \(handle): \(disc) hue \(disc.hue)")
            return
          }
        }
      }
    }
    #expect(drawn == 60_000)
    // Non-vacuity: the predicate calls a green green.
    #expect(Self.hasGreenHue(Tokens.RGB(0x34, 0xC7, 0x59)))
    #expect(!Self.hasGreenHue(Tokens.RGB(0x80, 0x80, 0x80)))
  }

  @Test("AP2: deterministic: a handle maps to the same step every time, and FNV-1a matches its published vectors")
  func deterministic() {
    #expect(AvatarKey.fnv1a("") == 2_166_136_261)
    #expect(AvatarKey.fnv1a("a") == 0xE40C_292C)
    #expect(AvatarKey.fnv1a("foobar") == 0xBF9C_F968)
    for handle in Self.handles {
      let step = AvatarKey.step(for: handle)
      #expect((0..<6).contains(step))
      #expect(AvatarKey.step(for: handle) == step)
      #expect(Tokens.Avatar.disc(for: handle, dark: false) == Tokens.Avatar.disc(for: handle, dark: false))
    }
    // All six steps are used, none by more than a third of the handles.
    var counts = [Int](repeating: 0, count: 6)
    for handle in Self.handles { counts[AvatarKey.step(for: handle)] += 1 }
    #expect(counts.allSatisfy { $0 > 0 && $0 < Self.handles.count / 3 }, "steps: \(counts)")
  }

  @Test("AP3: each option is six distinct discs per appearance; blueFamily keeps every hue in 200...240")
  func sixSteps() {
    for option in Self.options {
      for dark in [false, true] {
        let discs = Tokens.Avatar.discs(option, dark: dark)
        #expect(discs.count == 6, "\(option) dark=\(dark)")
        #expect(Set(discs.map(\.description)).count == 6, "\(option) dark=\(dark) repeats a disc")
      }
    }
    for dark in [false, true] {
      for disc in Tokens.Avatar.discs(.blueFamily, dark: dark) {
        #expect((200...240).contains(disc.hue), "\(disc) hue \(disc.hue)")
        #expect(disc.saturation > 0.10, "\(disc) reads as grey")
      }
    }
    #expect(ProvisionalUI.avatarPalette == .blueFamily)
  }

  @Test("AP4: the ink on every disc reads at 7:1 or better, light and dark, in every option")
  func inkContrast() {
    for option in Self.options {
      for dark in [false, true] {
        let ink = Tokens.palette(dark: dark).ink
        for disc in Tokens.Avatar.discs(option, dark: dark) {
          let ratio = Tokens.contrast(ink, disc)
          #expect(ratio >= 7, "\(option) dark=\(dark) \(disc): \(ratio)")
        }
      }
    }
  }

  @Test("AP5: every disc is in Tokens.all, so T1's sweep covers it")
  func sweptByT1() {
    for option in Self.options {
      for dark in [false, true] {
        for disc in Tokens.Avatar.discs(option, dark: dark) {
          #expect(Tokens.all.contains(disc), "\(disc) is not in the sweep")
        }
      }
    }
  }

  @Test("AP6: keys are the normalised handle: E.164 for a phone, a lowercased address, the guid for a group")
  func keys() {
    #expect(AvatarKey.normalise("+1 (555) 010-0001") == "+15550100001")
    #expect(AvatarKey.normalise("5550100001") == "+15550100001")
    #expect(AvatarKey.normalise("15550100001") == "+15550100001")
    #expect(AvatarKey.normalise("+1 555 010 0009") == "+15550100009")
    #expect(AvatarKey.normalise(" Sam.Whitfield@Example.COM ") == "sam.whitfield@example.com")
    #expect(AvatarKey.normalise("+15550100001") == AvatarKey.normalise("555-010-0001"))
  }

  @Test("AP7: the face on a disc: two initials, a glyph for a title with no letters (D-UI-56), and D-UI-10's options")
  func faces() {
    #expect(AvatarFace.make(title: "Maya Okafor", handle: "+15550100001", denied: .initialsDisc) == .letters("MO"))
    #expect(AvatarFace.make(title: "+15550100007", handle: "+15550100007", denied: .initialsDisc) == .glyph)
    #expect(AvatarFace.make(title: "Maya Okafor", handle: "+15550100001", denied: .silhouette) == .glyph)
    #expect(AvatarFace.make(title: "Maya Okafor", handle: "+15550100001", denied: .lastFourDigits) == .letters("0001"))
    #expect(
      AvatarFace.make(title: "Sam Whitfield", handle: "sam.whitfield@example.com", denied: .lastFourDigits)
        == .letters("SW"))
    #expect(AvatarFace.make(title: "Saturday hike", handle: nil, denied: .lastFourDigits) == .letters("SH"))
    #expect(ProvisionalUI.deniedAvatar == .initialsDisc)
  }
}
