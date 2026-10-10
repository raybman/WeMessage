import Foundation
import Testing

@testable import WeMessageApp

/// v2 S7a (D-S7a-7): the first-row stamp Board00PerfTests reads off the
/// thread list's label. Set once, only under the UI-test flag, and read back
/// by the same two words that wrote it.
@Suite("FirstRowStamp")
@MainActor
struct FirstRowStampTests {
  static let at = Date(timeIntervalSince1970: 1_791_000_000.1239)

  @Test("off the flag the stamp is never set and the list is just 'Threads'")
  func offTheFlag() {
    let stamp = FirstRowStamp()
    stamp.mark(enabled: false, now: Self.at)
    #expect(stamp.ms == nil)
    #expect(FirstRowStamp.label(stamp.ms) == "Threads")
  }

  @Test("under the flag the first mark wins, in whole milliseconds, and later marks change nothing")
  func firstMarkWins() {
    let stamp = FirstRowStamp()
    stamp.mark(enabled: true, now: Self.at)
    stamp.mark(enabled: true, now: Self.at.addingTimeInterval(5))
    #expect(stamp.ms == 1_791_000_000_123)
    #expect(FirstRowStamp.label(stamp.ms) == "Threads, first row drawn at 1791000000123")
  }

  @Test("parse reads back exactly what label writes, and nothing else")
  func roundTrip() {
    #expect(FirstRowStamp.parse(FirstRowStamp.label(42)) == 42)
    #expect(FirstRowStamp.parse("Threads") == nil)
    #expect(FirstRowStamp.parse("Threads, first row drawn at soon") == nil)
    #expect(FirstRowStamp.parse("Messages, first row drawn at 42") == nil)
  }
}
