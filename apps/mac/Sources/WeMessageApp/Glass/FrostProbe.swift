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

  /// What the content pane shows, which moves the gradient patches.
  public enum Layout: Sendable {
    /// No thread open (board 01): the pane is empty but for its centred text.
    case shell
    /// A thread open (board 02). The head's hairline crosses the shell's top
    /// patch and the composer covers its bottom one, so the top patch moves
    /// into the head, between the title and the inspector button, and the
    /// bottom one into the rail under its last tile. The backdrop gradient
    /// is vertical, so only the heights matter to it. The stripe patch stays:
    /// the transcript is anchored to the bottom, so the space above a short
    /// thread is bare pane.
    case thread
    /// Board 08's specimen sheet. Its two columns leave `atlasGutter` bare
    /// from the title band down, so all three patches sit in the gutter,
    /// one above the stripe patch and one below it.
    case atlas
  }

  /// Board 08: the bare gutter between the specimen sheet's two columns,
  /// from the title band to the foot of the window. The sheet derives its
  /// columns from it, so nothing it draws can cross a patch. It is centred
  /// on the stripe patch.
  public static let atlasGutter = Rect(
    x: stripePatch.x - (68 - patchSide) / 2, y: 52, width: 68, height: .greatestFiniteMagnitude)

  /// Plain gradient near the top of the window, clear of every label.
  public static func gradientTop(windowWidth: Double, layout: Layout = .shell) -> Rect {
    switch layout {
    case .shell: Rect(x: windowWidth - 140, y: 80, width: patchSide, height: patchSide)
    case .thread: Rect(x: windowWidth - 140, y: 58, width: patchSide, height: patchSide)
    case .atlas: Rect(x: stripePatch.x, y: 58, width: patchSide, height: patchSide)
    }
  }

  /// Plain gradient near the bottom of the window, clear of every label.
  public static func gradientBottom(windowWidth: Double, windowHeight: Double, layout: Layout = .shell) -> Rect {
    switch layout {
    case .shell: Rect(x: windowWidth - 140, y: windowHeight - 120, width: patchSide, height: patchSide)
    case .thread: Rect(x: 9, y: windowHeight - 120, width: patchSide, height: patchSide)
    case .atlas: Rect(x: stripePatch.x, y: windowHeight - 120, width: patchSide, height: patchSide)
    }
  }
}
