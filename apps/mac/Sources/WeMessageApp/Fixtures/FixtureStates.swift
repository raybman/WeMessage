import Foundation
import WeMessageKit

/// Board 10.B's facts, for the states sheet the UI tests open with
/// WEMESSAGE_UI_BOARD=10.B (H-S4-6): the six empties' numbers, a healthy
/// age table, today's pacing count and the agent that collided. Every date
/// is in the fixtures' day, 2026-09-01, printed in UTC (D-UI-63).
enum FixtureStates {
  static func at(_ wire: String) -> Date {
    WireDate.parse(wire) ?? Date(timeIntervalSince1970: 1_788_264_000)
  }

  static func content() -> StatesContent {
    let asOf = at("2026-09-01T18:07:41.000Z")
    let facts = EmptyFacts(
      channel: "iMessage", cleared: 23, arrived: 23, snoozed: 4, waitingOn: "Priya", asOf: asOf,
      syncedAt: at("2026-09-01T18:07:29.000Z"), lastArrival: at("2026-09-01T08:14:00.000Z"), query: "quarterly",
      searched: 527_147, channels: 1, searchMillis: 240, indexAsOf: at("2026-09-01T18:07:38.000Z"),
      unconnectedChannel: "LinkedIn", newThreadWith: "Priya Raman")
    let rows = ShellModel.Scope.allCases.filter { $0 != .all }.map { scope in
      scope == .imessage
        ? FreshnessRow(scope: scope, state: .live(asOf: at("2026-09-01T18:07:38.000Z")), today: 14)
        : FreshnessRow(scope: scope, state: .notConnected, today: nil)
    }
    return StatesContent(facts: facts, rows: rows, sendsToday: 14, asOf: asOf, agent: "Sol")
  }
}
