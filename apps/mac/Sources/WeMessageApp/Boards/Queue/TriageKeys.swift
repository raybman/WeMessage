import AppKit
import SwiftUI
import WeMessageKit

/// The single-key verbs of Needs You and Triage (06.C, 09.A): J and K or
/// the arrows move, A approves the open draft, R replies or edits, E, H and
/// M are Done, Snooze and Mute, X selects, Z undoes, Backspace holds, shift-A
/// opens the bulk confirm and Escape climbs out (06.C's ladder).
///
/// A zero-size view behind the list takes the keyboard whenever the
/// composer does not want it (R, Edit or a click put it there; Escape gives
/// it back). Keys with cmd, ctrl or opt pass through untouched, so every
/// menu shortcut still works. Bare Return does one thing in the whole app:
/// it confirms the bulk card while that card is open (09.D). Anywhere else
/// it does nothing here, and the composer's Return is a newline.
///
/// Nothing here reaches the client: every verb goes through the shell
/// model, and an approval through Outbound's undo window.
struct TriageKeys: NSViewRepresentable {
  let model: ShellModel
  /// A new token is a new claim (a lens, a selection, a closed card).
  let token: String

  func makeNSView(context: Context) -> KeyView {
    let view = KeyView()
    view.model = model
    return view
  }

  func updateNSView(_ view: KeyView, context: Context) {
    view.model = model
    view.want(token, composerWants: model.composerClaim != nil)
  }

  final class KeyView: NSView {
    weak var model: ShellModel?
    private var wanted: String?
    private var claimed: String?

    static let returnKey: UInt16 = 36
    static let enterKey: UInt16 = 76
    static let escapeKey: UInt16 = 53
    static let backspaceKey: UInt16 = 51
    static let downKey: UInt16 = 125
    static let upKey: UInt16 = 126

    override init(frame: NSRect) {
      super.init(frame: frame)
      setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { nil }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var acceptsFirstResponder: Bool { true }

    func want(_ token: String, composerWants: Bool) {
      if composerWants {
        wanted = nil
        claimed = nil
        return
      }
      guard token != wanted else { return }
      wanted = token
      claimed = nil
      schedule(attempt: 0)
    }

    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      schedule(attempt: 0)
    }

    /// One attempt per main-queue turn, then every 50 ms for about 2 s,
    /// as KeyboardClaim does: the window may still be settling.
    private func schedule(attempt: Int) {
      guard wanted != nil, wanted != claimed, attempt < 40 else { return }
      let delay: Double = attempt == 0 ? 0 : 0.05
      DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
        MainActor.assumeIsolated { self?.claim(attempt: attempt) }
      }
    }

    private func claim(attempt: Int) {
      guard let token = wanted, token != claimed else { return }
      guard let window else {
        schedule(attempt: attempt + 1)
        return
      }
      if window.firstResponder === self || window.makeFirstResponder(self) {
        claimed = token
      } else {
        schedule(attempt: attempt + 1)
      }
    }

    override func keyDown(with event: NSEvent) {
      guard let model else { return super.keyDown(with: event) }
      let flags = event.modifierFlags.intersection(.deviceIndependentFlagsMask)
      if !flags.intersection([.command, .control, .option]).isEmpty { return super.keyDown(with: event) }
      let shift = flags.contains(.shift)
      let target = model.selectedThread
      let picked = model.queue.selection.isEmpty ? target.map { [$0] } ?? [] : Array(model.queue.selection)

      switch event.keyCode {
      case Self.returnKey, Self.enterKey:
        // Bare Return approves only on the bulk confirm card (09.D).
        guard model.bulkSheetShown else { return }
        model.approveAll()
        return
      case Self.escapeKey:
        if model.bulkSheetShown {
          model.bulkSheetShown = false
        } else if model.auditShown {
          model.auditShown = false
        } else {
          model.escape(fromComposer: false)
        }
        return
      case Self.backspaceKey:
        if let target { model.holdPending(in: target) }
        return
      case Self.downKey:
        model.step(1)
        return
      case Self.upKey:
        model.step(-1)
        return
      default: break
      }

      switch event.charactersIgnoringModifiers?.lowercased() {
      case "a" where shift:
        if model.killSwitch == false && !model.bulkPlan.included.isEmpty {
          model.auditShown = false
          model.bulkSheetShown = true
        }
      case "a":
        if let target { model.approvePending(in: target) }
      case "r":
        if let target { model.replyOrEdit(in: target) }
      case "e":
        model.act(.done, on: picked)
      case "h":
        model.act(.snooze, on: picked)
      case "m":
        model.act(.mute, on: picked)
      case "x":
        if let target {
          if model.queue.selection.contains(target) {
            model.queue.selection.remove(target)
          } else {
            model.queue.selection.insert(target)
          }
        }
      case "z":
        model.undoLast()
      case "j":
        model.step(1)
      case "k":
        model.step(-1)
      default:
        super.keyDown(with: event)
      }
    }
  }
}
