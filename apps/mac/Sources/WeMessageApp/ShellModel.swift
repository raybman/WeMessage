import Foundation
import Observation

/// The shell's state. In S3a it is inert: the connection stays idle until
/// S3b wires the kit's client to it.
@MainActor
@Observable
public final class ShellModel {
  public enum Connection: Equatable, Sendable {
    case idle
    case connected(state: String)
    case reconnecting(attempt: Int)
    case down(reason: String)
  }

  /// The channel the rail has selected.
  public enum Scope: String, CaseIterable, Sendable {
    case all, imessage, whatsapp, linkedin, email

    /// The rail tile's short label (D-UI-1, provisional).
    public var label: String { ProvisionalUI.railShortLabels[rawValue] ?? rawValue }

    /// The full channel name, for accessibility.
    public var fullLabel: String {
      switch self {
      case .all: "All channels"
      case .imessage: "iMessage"
      case .whatsapp: "WhatsApp"
      case .linkedin: "LinkedIn"
      case .email: "Email"
      }
    }
  }

  /// The sidebar's lens.
  public enum Lens: String, CaseIterable, Sendable {
    case recent, needsYou, triage

    public var label: String {
      switch self {
      case .recent: "Recent"
      case .needsYou: "Needs You"
      case .triage: "Triage"
      }
    }
  }

  public private(set) var connection: Connection = .idle
  public var scope: Scope = .all
  public var lens: Lens = .recent

  public init() {}

  /// The connection line, in words (D-UI-3, provisional).
  public var connectionLine: String {
    switch connection {
    case .idle: ProvisionalUI.idleLine
    case .connected(let state): ProvisionalUI.connectedLine(state: state)
    case .reconnecting(let attempt): ProvisionalUI.reconnectingLine(attempt: attempt)
    case .down: ProvisionalUI.downLine
    }
  }
}
