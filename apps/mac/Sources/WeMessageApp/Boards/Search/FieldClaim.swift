import AppKit
import SwiftUI

/// Hands a board 11 field (search, the switcher, find) the keyboard when it
/// is shown, so cmd-K, shift-cmd-F and cmd-F are typed into at once, with no
/// click. KeyboardClaim does the same for the composer's text view; this one
/// looks for the editable text field laid over it. A FocusState written on
/// a field's first mount does not reach the platform view (KeyboardClaim's
/// measurement), so the claim is made in AppKit.
struct FieldClaim: NSViewRepresentable {
  /// A new token is a new claim; nil makes none and forgets the last.
  let token: String?

  func makeNSView(context: Context) -> ClaimView { ClaimView() }

  func updateNSView(_ view: ClaimView, context: Context) { view.want(token) }

  final class ClaimView: NSView {
    private var wanted: String?
    private var claimed: String?

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { false }

    func want(_ token: String?) {
      guard let token else {
        wanted = nil
        claimed = nil
        return
      }
      guard token != wanted else { return }
      wanted = token
      schedule(attempt: 0)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      schedule(attempt: 0)
    }

    /// One attempt per main-queue turn, then every 50 ms for about 2 s.
    private func schedule(attempt: Int) {
      guard wanted != nil, wanted != claimed, attempt < 40 else { return }
      let delay: Double = attempt == 0 ? 0 : 0.05
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        MainActor.assumeIsolated { self?.claim(attempt: attempt) }
      }
    }

    private func claim(attempt: Int) {
      guard let token = wanted, token != claimed else { return }
      guard let window, let field = textField(in: window) else {
        schedule(attempt: attempt + 1)
        return
      }
      if let editor = field.currentEditor(), window.firstResponder === editor {
        claimed = token
      } else if window.makeFirstResponder(field) {
        claimed = token
      } else {
        schedule(attempt: attempt + 1)
      }
    }

    /// The editable text field this view sits behind.
    private func textField(in window: NSWindow) -> NSTextField? {
      let mine = convert(bounds, to: nil)
      guard mine.width > 0, mine.height > 0 else { return nil }
      var queue: [NSView] = (window.contentView?.superview ?? window.contentView).map { [$0] } ?? []
      while !queue.isEmpty {
        let view = queue.removeFirst()
        if let field = view as? NSTextField, field.isEditable, field.convert(field.bounds, to: nil).intersects(mine) {
          return field
        }
        queue.append(contentsOf: view.subviews)
      }
      return nil
    }
  }
}
