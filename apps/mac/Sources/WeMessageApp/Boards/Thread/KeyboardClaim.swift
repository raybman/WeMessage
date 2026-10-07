import AppKit
import SwiftUI

/// Hands the composer's text view the keyboard when a thread opens, so the
/// draft hint's promise ("just start typing") holds for the first thread
/// after launch too.
///
/// Measured (run 37606555171): with the app active, the shell window key
/// and the window's first responder SwiftUI's KeyViewProxy, a FocusState
/// written from `.task` on the composer's first mount never reached the
/// text view, and neither did three clicks; a thread opened later (the
/// same field, re-focused) always did. So the claim is made in AppKit,
/// once the text view is in the window, rather than through a FocusState
/// written before the field has a platform view.
struct KeyboardClaim: NSViewRepresentable {
  /// A new token is a new claim: the thread's chat guid.
  let token: String

  func makeNSView(context: Context) -> ClaimView { ClaimView() }

  func updateNSView(_ view: ClaimView, context: Context) { view.want(token) }

  /// Under the UI-test flag only, the last claim's outcome, which the
  /// window's focus line carries: "found|missing", "ok|refused", attempts.
  @MainActor static var outcome = "none"

  /// A zero-content view laid behind the text editor. It never takes a
  /// click or the keyboard itself.
  final class ClaimView: NSView {
    private var wanted: String?
    private var claimed: String?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }

    func want(_ token: String) {
      guard token != wanted else { return }
      wanted = token
      schedule(attempt: 0)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      schedule(attempt: 0)
    }

    /// One attempt per main-queue turn, then every 50 ms, for about 2 s:
    /// the hosting view mounts the editor's platform view a pass or two
    /// after this view arrives.
    private func schedule(attempt: Int) {
      guard wanted != nil, wanted != claimed, attempt < 40 else { return }
      let delay: Double = attempt == 0 ? 0 : 0.05
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        MainActor.assumeIsolated { self?.claim(attempt: attempt) }
      }
    }

    private func claim(attempt: Int) {
      guard let token = wanted, token != claimed else { return }
      guard let window, let field = textView(in: window) else {
        KeyboardClaim.outcome = "missing:\(attempt)"
        schedule(attempt: attempt + 1)
        return
      }
      if window.firstResponder === field || window.makeFirstResponder(field) {
        claimed = token
        KeyboardClaim.outcome = "found:ok:\(attempt)"
      } else {
        KeyboardClaim.outcome = "found:refused:\(attempt)"
        schedule(attempt: attempt + 1)
      }
    }

    /// The editable text view this view sits behind: the one whose visible
    /// rect overlaps this view's frame, in window coordinates.
    private func textView(in window: NSWindow) -> NSTextView? {
      let mine = convert(bounds, to: nil)
      guard mine.width > 0, mine.height > 0 else { return nil }
      var queue: [NSView] = (window.contentView?.superview ?? window.contentView).map { [$0] } ?? []
      while !queue.isEmpty {
        let view = queue.removeFirst()
        if let text = view as? NSTextView, text.isEditable,
          text.convert(text.visibleRect, to: nil).intersects(mine)
        {
          return text
        }
        queue.append(contentsOf: view.subviews)
      }
      return nil
    }
  }
}
