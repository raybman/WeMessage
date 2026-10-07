import Foundation

/// Where the CI frost evidence looks, in window-local points with a
/// top-leading origin (plan 2.5, S4a.0 spike). The backdrop window draws its
/// stripe band under `stripeBand`; the UI tests sample the three patches.
///
/// Foundation only: the CI-only UI test bundle compiles this file too (see
/// apps/mac/project.yml), so the app and the tests read one set of numbers.
/// The patches sit on transparent pane background, clear of every label at
/// the runner's pinned window size.
public enum FrostProbe {
  /// A rectangle in points, top-leading.
  public struct Rect: Equatable, Sendable {
    public let x, y, width, height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
      self.x = x
      self.y = y
      self.width = width
      self.height = height
    }

    public var midY: Double { y + height / 2 }
  }

  /// The black and white stripe band on the backdrop, under the content
  /// pane, above its empty-state text.
  public static let stripeBand = Rect(x: 330, y: 100, width: 200, height: 200)
  /// One stripe's width: black, then white, repeating.
  public static let stripeWidth: Double = 2
  /// Every patch is this many points square.
  public static let patchSide: Double = 40

  /// The centre of the stripe band.
  public static var stripePatch: Rect {
    Rect(
      x: stripeBand.x + (stripeBand.width - patchSide) / 2, y: stripeBand.y + (stripeBand.height - patchSide) / 2,
      width: patchSide, height: patchSide)
  }

  /// Plain gradient near the top of the content pane, right of its text.
  public static func gradientTop(windowWidth: Double) -> Rect {
    Rect(x: windowWidth - 140, y: 80, width: patchSide, height: patchSide)
  }

  /// Plain gradient near the bottom of the content pane.
  public static func gradientBottom(windowWidth: Double, windowHeight: Double) -> Rect {
    Rect(x: windowWidth - 140, y: windowHeight - 120, width: patchSide, height: patchSide)
  }
}
