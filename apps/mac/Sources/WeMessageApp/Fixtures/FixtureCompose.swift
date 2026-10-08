import Foundation

/// v2 S4j, board 14: the people compose resolves against. Fixtures only in
/// this version (D-UI-100): compose reads no Contacts and asks the daemon
/// for no resolution (G-14a). Every number is a synthetic +1 555 one and
/// every address is example.com. Maya, Daniel and the bare number have
/// threads in the rich scenario, so their iMessage chat guids are real
/// there; Marta has no Apple handle at all.
enum FixtureCompose {
  static let people: [ComposePerson] = [
    ComposePerson(
      id: "maya", name: "Maya Okafor", initials: "MO",
      evidence: "Contacts card \u{00B7} last exchange Oct 6 on iMessage",
      lastExchange: "2026-10-06", imessage: "+15550100001", email: "maya.okafor@example.com"),
    ComposePerson(
      id: "marta", name: "Marta Lindqvist", initials: "ML",
      evidence: "Contacts card \u{00B7} never messaged",
      lastExchange: nil, imessage: nil, email: "marta.lindqvist@example.com"),
    ComposePerson(
      id: "daniel", name: "Daniel Reyes", initials: "DR",
      evidence: "Contacts card \u{00B7} last exchange Oct 7 on iMessage",
      lastExchange: "2026-10-07", imessage: "+15550100002", email: nil),
    ComposePerson(
      id: "handle0007", name: nil, initials: "#",
      evidence: "Not in Contacts. Appears in one thread, Sep 4. No name known.",
      lastExchange: "2026-09-04", imessage: "+15550100007", email: nil),
  ]

  /// The proposal opt-cmd-D shows: a fixture, since no agent is connected in
  /// this version (D-UI-98).
  static func proposal(for person: ComposePerson) -> String {
    person.id == "maya" ? "Saturday works for me. Same trailhead at 9?" : "Thanks, talk soon."
  }
}
