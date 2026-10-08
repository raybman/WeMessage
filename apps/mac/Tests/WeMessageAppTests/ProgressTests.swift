import Foundation
import Testing
import WeMessageKit

@testable import WeMessageApp

/// v2 S4m, board 17: the fixture's words and runs, and where the card's
/// export may write. Nothing here touches a pasteboard or the disk; the
/// export's destinations are checked by name and path only.
@Suite("Progress")
@MainActor
struct ProgressTests {
  let content = TestHooks.progressContent

  @Test("every stat tile carries a caveat, none prints a percentage, the unwelcome one is first and emphasized")
  func statCaveats() {
    #expect(content.stats.map(\.key) == StatKey.allCases)
    for item in content.stats {
      #expect(!item.caveat.trimmingCharacters(in: .whitespaces).isEmpty, "\(item.key)")
      #expect(!(item.label + item.value + item.caveat).contains("%"), "\(item.key)")
    }
    #expect(content.stats.first?.emphasized == true)
    #expect(content.stats.dropFirst().allSatisfy { !$0.emphasized })
  }

  @Test("the runs are computed: intact 11 across the away days, broken 3 after a run of 11, longest 23 in both")
  func runs() {
    #expect(!content.intact.broken)
    #expect(content.intact.streak.current == 11)
    #expect(content.intact.streak.longest == 23)
    #expect(content.broken.broken)
    #expect(content.broken.streak.current == 3)
    #expect(content.broken.streak.runBeforeBreak == 11)
    #expect(content.broken.streak.longest == 23)
    #expect(content.card.streakDays == content.intact.streak.current)
    #expect(content.card.longestRunDays == 23)
  }

  @Test("the three zeros: earned with a receipt, still clear with none, quiet with Verify; Verify never on the earned zero")
  func zeros() {
    #expect(content.earned.kind == .earned)
    #expect(content.earned.receipt != nil)
    #expect(!content.earned.verifies)
    if case .stillClear = content.still.kind {} else { Issue.record("still is \(content.still.kind)") }
    #expect(content.still.receipt == nil)
    #expect(!content.still.verifies)
    #expect(content.quiet.kind == .nothingArrived)
    #expect(content.quiet.receipt == nil)
    #expect(content.quiet.verifies)
    #expect(ZeroWords.heading(content.still.kind).hasPrefix("Still clear since "))
  }

  @Test("the global row is never an average: one stale source makes it cannot tell, all clear and fresh makes it clear")
  func globalRow() {
    #expect(content.notZero.global.state != .clear)
    #expect(content.atZero.global.state == .clear)
    #expect(content.degraded.global.state == .cannotTell)
    #expect(content.degraded.connected == 3)
  }

  @Test("the card's numbers are the only thing zeroed() changes")
  func zeroedCard() {
    let zero = content.card.zeroed()
    let numbers: [Int] = [zero.streakDays, zero.longestRunDays, zero.clearedThisWeek, zero.daysAtZeroInMonth]
    #expect(numbers == [0, 0, 0, 0])
    #expect(zero.periodStart == content.card.periodStart && zero.periodEnd == content.card.periodEnd)
  }

  @Test("under the flag, copy names the test pasteboard, never the general one; outside it, the general one")
  func exportPasteboard() {
    let test = ShareCardExport.pasteboardName(uiTest: true).rawValue
    let live = ShareCardExport.pasteboardName(uiTest: false).rawValue
    #expect(test == ProvisionalUI.cardTestPasteboard)
    #expect(test != live)
    // NSPasteboard.Name.general's raw value.
    #expect(live == "Apple CFPasteboard general")
  }

  @Test("under the flag, save writes into a folder in the temporary directory, never Downloads or the Desktop")
  func exportFolder() {
    let folder = ShareCardExport.testFolder()
    let temp = FileManager.default.temporaryDirectory.standardizedFileURL.path
    #expect(folder.standardizedFileURL.path.hasPrefix(temp))
    #expect(folder.lastPathComponent.hasPrefix(ProvisionalUI.cardTestExportFolder + "-"))
    #expect(!ShareCardExport.refused(folder))
    #expect(ShareCardExport.refused(URL(fileURLWithPath: "/Users/someone/Downloads/card.png")))
    #expect(ShareCardExport.refused(URL(fileURLWithPath: "/Users/someone/Desktop")))
  }
}
