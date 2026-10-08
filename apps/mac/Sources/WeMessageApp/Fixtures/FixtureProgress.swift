import Foundation
import WeMessageKit

/// Board 17's fixtures (D-UI-121): the wireframe's week of Sep 15 to Sep
/// 21, 2026, in the runner's zone, so the clocks read 16:42:07 and
/// 18:07:41 anywhere. Every run and every global row is computed by
/// ProgressRules from the rows and days below; none is typed.
enum FixtureProgress {
  static func at(_ day: Int, _ hour: Int, _ minute: Int, _ second: Int = 0) -> Date {
    let parts = DateComponents(year: 2026, month: 9, day: day, hour: hour, minute: minute, second: second)
    return Calendar.current.date(from: parts) ?? Date(timeIntervalSince1970: 0)
  }

  static func row(_ scope: ShellModel.Scope, left: Int, arrived: Int, cleared: Int, connected: Bool = true, fresh: Bool = true)
    -> MeterRow
  {
    MeterRow(
      channel: scope.rawValue, remaining: left, arrivedToday: arrived, clearedToday: cleared, connected: connected,
      fresh: fresh)
  }

  static var notZero: MeterPanel {
    MeterPanel(
      caption: "Not at zero \u{00B7} 16:42:07 \u{00B7} four channels, one total",
      lines: [
        MeterLine(
          scope: .imessage, row: row(.imessage, left: 2, arrived: 3, cleared: 1),
          evidence: "3 arrived today, 1 cleared. Newest inbound 9:38.", live: "Live, 4s ago.", note: ""),
        MeterLine(
          scope: .whatsapp, row: row(.whatsapp, left: 3, arrived: 4, cleared: 1),
          evidence: "4 arrived today, 1 cleared. 1 of the 3 has a draft ready.", live: "Live, 11s ago.", note: ""),
        MeterLine(
          scope: .linkedin, row: row(.linkedin, left: 4, arrived: 5, cleared: 1),
          evidence: "5 arrived today, 1 cleared. 40 first-contact messages are not counted here.",
          live: "Live, 2m ago.", note: ""),
        MeterLine(
          scope: .email, row: row(.email, left: 0, arrived: 2, cleared: 2),
          evidence: "2 arrived today, 2 cleared, last at 11:20.", live: "Live, 30s ago.",
          note: "Clear means no unreplied thread in the window, not an empty mailbox."),
      ],
      globalEvidence: "14 arrived today, 5 cleared.", globalSynced: "4 of 4 sources synced 16:42:07.",
      globalNote: "Identical to the rail total, the Dock badge and the menu bar extra's badge.")
  }

  static var atZero: MeterPanel {
    MeterPanel(
      caption: "At zero \u{00B7} 18:07:41 \u{00B7} the same five rows, earned",
      lines: [
        MeterLine(
          scope: .imessage, row: row(.imessage, left: 0, arrived: 3, cleared: 3),
          evidence: "3 arrived, 3 cleared. 2 replied, 1 done.", live: "Live, 6s ago.", note: ""),
        MeterLine(
          scope: .whatsapp, row: row(.whatsapp, left: 0, arrived: 4, cleared: 4),
          evidence: "4 arrived, 4 cleared. 2 replied, 2 approved.", live: "Live, 9s ago.",
          note: "Re-link needed in 3 days."),
        MeterLine(
          scope: .linkedin, row: row(.linkedin, left: 0, arrived: 5, cleared: 5),
          evidence: "5 arrived, 5 cleared. 1 replied, 3 done, 1 muted.", live: "Live, 1m ago.", note: ""),
        MeterLine(
          scope: .email, row: row(.email, left: 0, arrived: 2, cleared: 2),
          evidence: "2 arrived, 2 cleared. 1 replied, 1 approved.", live: "Live, 30s ago.", note: ""),
      ],
      globalEvidence: "14 arrived today, 14 cleared. 6 replied \u{00B7} 3 approved \u{00B7} 4 done \u{00B7} 1 muted \u{00B7} 0 failed.",
      globalSynced: "4 of 4 sources synced 18:07:41.", globalNote: "")
  }

  /// The two rows that are not zero and not clear (17.A): LinkedIn stale,
  /// WhatsApp not connected; the global row cannot tell, over 3 sources.
  static var degraded: MeterPanel {
    MeterPanel(
      caption: "Degraded \u{00B7} 16:42:07 \u{00B7} one source stale, one not connected",
      lines: [
        MeterLine(
          scope: .imessage, row: row(.imessage, left: 2, arrived: 3, cleared: 1),
          evidence: "3 arrived today, 1 cleared. Newest inbound 9:38.", live: "Live, 4s ago.", note: ""),
        MeterLine(
          scope: .whatsapp, row: row(.whatsapp, left: 0, arrived: 0, cleared: 0, connected: false),
          evidence: "Not connected. Contributes no 0 to the total and cannot be cleared.", live: "", note: ""),
        MeterLine(
          scope: .linkedin, row: row(.linkedin, left: 4, arrived: 5, cleared: 1, fresh: false),
          evidence: "We cannot tell. Last succeeded 4 hours ago.", live: "",
          note: "No number, no fill, hatched track."),
        MeterLine(
          scope: .email, row: row(.email, left: 0, arrived: 2, cleared: 2),
          evidence: "2 arrived today, 2 cleared, last at 11:20.", live: "Live, 30s ago.", note: ""),
      ],
      globalEvidence: "We cannot tell while LinkedIn is stale.", globalSynced: "2 of 3 sources synced 16:42:07.",
      globalNote: "WhatsApp is not connected, so this row is over 3 sources, never 4.")
  }

  static let ribbonLabels = Array(1...17)

  /// 17.C intact: Sep 4 to 7 away, Sep 9 nothing arrived; the run crosses
  /// them. Sep 1 is drawn as nothing arrived so the computed run is the
  /// headline's 11 (D-UI-125).
  static var intact: StreakPanel {
    let c = Day.cleared
    let away = Day.notOpened
    return StreakPanel(
      caption: "Intact \u{00B7} the vacation is in the middle of it", labels: ribbonLabels,
      days: [.nothingArrived, c, c, away, away, away, away, c, .nothingArrived, c, c, c, c, c, c, c, c],
      history: [.leftUnclear], longestBefore: 23, currentSince: "Current run, since Sep 2.",
      longestSpan: "Longest run, Jun 2 to Jun 24. Never resets.",
      evidence: [
        "Sep 4 to Sep 7 you were away and did not open the app, so four days are skipped and the run continues across them. Sep 9 nothing arrived."
      ])
  }

  /// 17.C broken: Sep 14 opened and left unclear. Three cleared days before
  /// the drawn ribbon make the run it ended 11.
  static var broken: StreakPanel {
    let c = Day.cleared
    let away = Day.notOpened
    return StreakPanel(
      caption: "Broken \u{00B7} the honest way to say so", labels: ribbonLabels,
      days: [c, c, c, away, away, away, away, c, .nothingArrived, c, c, c, c, .leftUnclear, c, c, c],
      history: [c, c, c], longestBefore: 23, currentSince: "Current run, since Sep 15.",
      longestSpan: "Longest run, Jun 2 to Jun 24. Never resets.",
      evidence: ["Sep 14: opened at 08:12, 6 items arrived, 2 cleared, 4 still open at 04:00."])
  }

  static var stats: [StatItem] {
    [
      StatItem(
        key: .longestWaiting, label: "Longest waiting, still open", value: "11 days",
        caveat:
          "Email, one thread, oldest inbound Sep 10. Leaves the 14-day window in 3 days and stops being counted anywhere.",
        emphasized: true),
      StatItem(
        key: .cleared, label: "Threads cleared", value: "63",
        caveat: "40 produced a reply, 18 Done, 5 Muted. The split is always shown.", emphasized: false),
      StatItem(
        key: .draftSplit, label: "Agent drafted vs you wrote", value: "12 / 11 / 17",
        caveat:
          "Of 40 replies: 12 agent drafts approved unedited, 11 agent drafts you edited first, 17 you wrote with no draft offered.",
        emphasized: false),
      StatItem(
        key: .waited, label: "How long things waited", value: "3h 51m",
        caveat:
          "Median arrival to cleared, of the items you cleared. It excludes the 11-day thread above. iM 34m \u{00B7} WA 1h 12m \u{00B7} EM 6h 40m \u{00B7} LI 2d 3h.",
        emphasized: false),
      StatItem(
        key: .daysAtZero, label: "Days at zero this month", value: "14 of 22",
        caveat:
          "Fourteen days reached CLEAR, out of the twenty-two that had anything to clear. Eight days had no arrivals and are in neither number.",
        emphasized: false),
    ]
  }

  static var card: ShareCard {
    ProgressRules.card(
      streak: intact.streak, clearedThisWeek: 63, daysAtZeroInMonth: 14, periodStart: at(15, 12, 0),
      periodEnd: at(21, 12, 0))
  }

  static var earned: ZeroContent {
    let kind = ProgressRules.zeroKind(
      arrivedToday: 14, clearedToday: 14, lastClearAt: at(21, 18, 7, 38), now: at(21, 18, 7, 41),
      praiseFor: ProvisionalUI.zeroPraiseSeconds)
    return ZeroContent(
      kind: kind, heading: ZeroWords.heading(kind), lines: ["14 arrived today. 14 cleared."],
      receipt: "6 replied \u{00B7} 3 approved \u{00B7} 4 done \u{00B7} 1 muted \u{00B7} 0 failed",
      footer: ["4 of 4 sources synced 18:07:41, 3 seconds ago.", "Next snooze returns Monday 9:00."],
      streakLine: "\(intact.streak.current) days cleared in a row.")
  }

  static var still: ZeroContent {
    let kind = ProgressRules.zeroKind(
      arrivedToday: 14, clearedToday: 14, lastClearAt: at(21, 18, 7, 41), now: at(21, 21, 14, 2),
      praiseFor: ProvisionalUI.zeroPraiseSeconds)
    return ZeroContent(
      kind: kind, heading: ZeroWords.heading(kind),
      lines: [ZeroWords.quietFor(at(21, 21, 14, 2).timeIntervalSince(at(21, 18, 7, 2)))], receipt: nil,
      footer: ["14 cleared today. 4 of 4 sources synced 21:14:02.", "Next snooze returns Monday 9:00."],
      streakLine: nil)
  }

  static var quiet: ZeroContent {
    let kind = ProgressRules.zeroKind(
      arrivedToday: 0, clearedToday: 0, lastClearAt: nil, now: at(21, 21, 14, 2),
      praiseFor: ProvisionalUI.zeroPraiseSeconds)
    return ZeroContent(
      kind: kind, heading: ZeroWords.heading(kind), lines: [ZeroWords.quietLine], receipt: nil,
      footer: ["4 of 4 sources synced 21:14:02. Last inbound Sep 20, 17:51.", ZeroWords.wrongLine], streakLine: nil)
  }

  static func content() -> ProgressContent {
    ProgressContent(
      notZero: notZero, atZero: atZero, degraded: degraded, intact: intact, broken: broken,
      statsCaption: "Kept \u{00B7} the Progress window, week of Sep 15 to Sep 21", stats: stats, card: card,
      earned: earned, still: still, quiet: quiet,
      rail: [.all: .stale, .imessage: .digit(2), .whatsapp: .digit(3), .linkedin: .stale, .email: .baseline],
      titleLeft: .left(9, asOf: at(21, 16, 42, 7)), titleClear: .clear(asOf: at(21, 18, 7, 41)))
  }
}
