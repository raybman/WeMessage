import Foundation
import Testing

@testable import WeMessageKit

/// S4e (board 08.G): the delivery ladder only climbs, a failure always names
/// its cause, and the wire form round-trips.
@Suite("Delivery")
struct DeliveryTests {
  static let at = Date(timeIntervalSince1970: 1_788_256_380)

  static func decode(_ json: String) throws -> Delivery {
    try JSONDecoder().decode(Delivery.self, from: Data(json.utf8))
  }

  @Test("the rungs climb sending, sent, delivered, read; a failure is off the ladder")
  func rungs() {
    #expect(Delivery.sending.rung == 0)
    #expect(Delivery.sent(at: nil).rung == 1)
    #expect(Delivery.delivered.rung == 2)
    #expect(Delivery.read(at: Self.at).rung == 3)
    #expect(Delivery.notDelivered(reason: "x").rung == nil)
    #expect(Delivery.notDelivered(reason: "x").isFailure)
    for quiet in [Delivery.sending, .sent(at: nil), .delivered, .read(at: Self.at)] { #expect(!quiet.isFailure) }
  }

  @Test("a higher rung wins and a stale one is ignored")
  func climbs() {
    #expect(Delivery.sending.merged(with: .delivered) == .delivered)
    #expect(Delivery.read(at: Self.at).merged(with: .sent(at: nil)) == .read(at: Self.at))
    #expect(Delivery.delivered.merged(with: .delivered) == .delivered)
  }

  @Test("a failure replaces only sending or sent; a later rung replaces a failure")
  func failures() {
    let failed = Delivery.notDelivered(reason: "Not registered with iMessage")
    #expect(Delivery.sending.merged(with: failed) == failed)
    #expect(Delivery.sent(at: Self.at).merged(with: failed) == failed)
    #expect(Delivery.delivered.merged(with: failed) == .delivered)
    #expect(Delivery.read(at: Self.at).merged(with: failed) == .read(at: Self.at))
    #expect(failed.merged(with: .sent(at: nil)) == .sent(at: nil))
    let other = Delivery.notDelivered(reason: "Timed out")
    #expect(failed.merged(with: other) == other)
  }

  @Test("every state round-trips through its wire form")
  func roundTrip() throws {
    for state in [
      Delivery.sending, .sent(at: nil), .sent(at: Self.at), .delivered, .read(at: Self.at),
      .notDelivered(reason: "Not registered with iMessage"),
    ] {
      let data = try JSONEncoder().encode(state)
      #expect(try JSONDecoder().decode(Delivery.self, from: data) == state)
    }
  }

  @Test("an unknown state, a read with no time and a failure with no cause do not decode")
  func refuses() throws {
    #expect(try Self.decode(#"{"state":"read","at":"2026-09-01T09:53:00.000Z"}"#) == .read(at: Self.at))
    #expect(throws: DecodingError.self) { try Self.decode(#"{"state":"seen"}"#) }
    #expect(throws: DecodingError.self) { try Self.decode(#"{"state":"read"}"#) }
    #expect(throws: DecodingError.self) { try Self.decode(#"{"state":"notDelivered","reason":""}"#) }
    #expect(throws: DecodingError.self) { try Self.decode(#"{"state":"notDelivered"}"#) }
    #expect(throws: DecodingError.self) { try Self.decode(#"{"state":"sent","at":"yesterday"}"#) }
  }
}
