import Foundation

/// The event stream's connection status.
public enum StreamStatus: Equatable, Sendable {
  case connected
  case reconnecting(attempt: Int)
  case down(reason: String)
}

/// One numbered frame from the event stream: a live event, or the snapshot a
/// (re)connect takes before live events are trusted again.
public enum StreamFrame: Equatable, Sendable {
  case event(seq: Int, event: GatewayEvent)
  case snapshot(seq: Int, at: String, missed: Int, drafts: [DraftPayload])
}

/// A response to an effect the reducer asked for.
public enum AppResponse: Equatable, Sendable {
  case drafts([DraftPayload])
}

/// Everything that can change AppState.
public enum AppAction: Equatable, Sendable {
  case status(StreamStatus)
  case frame(StreamFrame)
  case response(AppResponse)
}

/// Something worth recording that changes no state.
public enum LogEvent: Equatable, Sendable {
  case droppedEvent(name: String)
}

/// Work the reducer asks the app to do; it never does any itself.
public enum Effect: Equatable, Sendable {
  case listAudit(since: String, limit: Int)
  case listDrafts
  case log(LogEvent)
}
