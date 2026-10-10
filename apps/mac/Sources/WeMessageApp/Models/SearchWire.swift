import Foundation
import WeMessageKit

// v2 F2d: what the app sends `GET /v1/search` for a typed query. The token is
// the truth (board 11.B): every token the operator sees drawn reaches the
// daemon, and the daemon's coverage says how far each was honoured. Nothing
// typed is dropped here. Pure: no clock, no I/O.

public enum SearchWire {
  /// The structured query for `query`, parsed in a calendar whose zone is
  /// `zone`. Decisions (recorded in the F2d commit):
  /// - every bare term and every unparsed chunk is a `term` (D-UI-80: an
  ///   unparsed chunk still constrains the search as literal text);
  /// - several `before:` keep the earliest and several `after:` the latest,
  ///   which is exactly their AND;
  /// - the first `from:` and the first `in:` win, as the wire carries one of
  ///   each; the daemon's coverage tokens show what was applied;
  /// - channels and kinds are deduped in the order typed;
  /// - terms are never trimmed to the daemon's limit: more than it takes is
  ///   its 400, shown, not a silent drop.
  public static func params(
    _ query: SearchQuery, zone: TimeZone, limit: Int = 50, cursor: String? = nil
  ) -> SearchParams {
    var params = SearchParams(terms: query.terms, tz: zone.identifier, limit: limit, cursor: cursor)
    var sawFrom = false
    for token in query.tokens {
      switch token {
      case .from(let from) where !sawFrom:
        sawFrom = true
        switch from {
        case .me: params.fromMe = true
        case .name(let name): params.fromName = name
        }
      case .inThread(let thread) where params.inThread == nil:
        params.inThread = thread
      case .channel(let channel) where !params.channels.contains(channel.rawValue):
        params.channels.append(channel.rawValue)
      case .has(let kind) where !params.has.contains(kind.rawValue):
        params.has.append(kind.rawValue)
      case .before(let date):
        params.before = min(params.before ?? date.start, date.start)
      case .after(let date):
        params.after = max(params.after ?? date.start, date.start)
      default:
        break
      }
    }
    return params
  }
}
