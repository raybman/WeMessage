import Foundation
import Testing

@testable import WeMessageApp

/// v2 S4h, board 12: onboarding's state. Progress survives a relaunch (12.B
/// legend 4: macOS quits the app on the grant), the Full Disk Access poll
/// stops on the grant, AgentStep is off by default, and the coach row takes
/// any key. Nothing here reaches the daemon: the model holds no client.
@Suite("OnboardingModel")
@MainActor
struct OnboardingModelTests {
  /// The flow from step 1 to 2c over the fixture seam, polling by hand.
  static func toSized(_ store: MemoryOnboardingStore, grantAfter: Int = 1) async -> OnboardingModel {
    let model = OnboardingModel(store: store, seam: FixtureFullDiskAccess(grantAfter: grantAfter), interval: .seconds(3600))
    model.continueFromChannels()
    #expect(model.step == .fdaAsk)
    model.openSettings()
    #expect(model.step == .fdaWaiting)
    #expect(model.polling)
    while model.step == .fdaWaiting { await model.pollOnce() }
    return model
  }

  @Test("a relaunch interrupted at 2c resumes at 2c, sized again, not at the welcome screen")
  func resumesAt2c() async {
    let store = MemoryOnboardingStore()
    let first = await Self.toSized(store)
    #expect(first.step == .fdaSized)
    #expect(store.saved?.step == .fdaSized)
    // The process dies (System Settings' Quit Now); the store is the disk.
    let relaunched = OnboardingModel(store: store, seam: FixtureFullDiskAccess(), interval: .seconds(3600))
    #expect(relaunched.step == .fdaSized, "resumed at \(relaunched.step)")
    #expect(relaunched.sizing == nil)
    await relaunched.resume()
    #expect(relaunched.step == .fdaSized)
    #expect(relaunched.sizing?.messages == 527_147)
    #expect(!relaunched.polling)
  }

  @Test("a relaunch while waiting at 2b, with access granted meanwhile, lands on 2c at once")
  func resumesFrom2bTo2c() async {
    var saved = OnboardingProgress()
    saved.step = .fdaWaiting
    let store = MemoryOnboardingStore(saved)
    let seam = FixtureFullDiskAccess(grantAfter: 1)
    seam.openSettings()
    let model = OnboardingModel(store: store, seam: seam, interval: .seconds(3600))
    #expect(model.step == .fdaWaiting)
    await model.resume()
    #expect(model.step == .fdaSized)
    #expect(store.saved?.step == .fdaSized)
    #expect(!model.polling)
  }

  @Test("every step is saved as it is reached")
  func savedAfterEveryStep() async {
    let store = MemoryOnboardingStore()
    let model = await Self.toSized(store)
    await model.makeCopy()
    #expect(store.saved?.step == .copying)
    #expect(store.saved?.copyStarted == true)
    model.continueFromCopy()
    #expect(store.saved?.step == .whatsapp)
    model.skip(.whatsapp)
    model.skip(.linkedin)
    model.skip(.email)
    #expect(store.saved?.step == .agent)
    #expect(store.saved?.declined == [.whatsapp, .linkedin, .email])
  }

  @Test("the poll stops on the grant: no probe after it, through the timer loop")
  func pollStopsOnGrant() async throws {
    let store = MemoryOnboardingStore()
    let seam = FixtureFullDiskAccess(grantAfter: 2)
    let model = OnboardingModel(store: store, seam: seam, interval: .milliseconds(10))
    model.continueFromChannels()
    model.openSettings()
    #expect(model.polling)
    // The deadline is generous on purpose: every suite here is @MainActor and
    // Swift Testing runs them in parallel, so a heavy sibling (the T5 contrast
    // sweep takes 8 s on a CI runner) can hold the main actor past a short
    // wall-clock deadline before the poll task ever wakes. The loop exits the
    // moment the grant lands, so a long deadline costs nothing when green.
    let deadline = Date().addingTimeInterval(60)
    while model.step == .fdaWaiting && Date() < deadline { try await Task.sleep(for: .milliseconds(5)) }
    #expect(model.step == .fdaSized)
    #expect(seam.probes == 2)
    #expect(!model.polling)
    // Ten more intervals: a poll that kept running would have probed again.
    try await Task.sleep(for: .milliseconds(150))
    #expect(seam.probes == 2, "the poll probed \(seam.probes - 2) times after the grant")
    #expect(model.probes == 2)
  }

  @Test("the poll stops on the grant: a stray tick after it probes nothing")
  func strayTickAfterGrant() async {
    let store = MemoryOnboardingStore()
    let model = await Self.toSized(store)
    let seam = model.seam
    let probes = seam.probes
    #expect(await model.pollOnce() == false)
    #expect(seam.probes == probes)
  }

  @Test("the poll runs every 2 seconds, only on 2b, and not before Open System Settings")
  func pollCadence() async {
    #expect(OnboardingModel.pollEvery == .seconds(2))
    let model = OnboardingModel(store: MemoryOnboardingStore(), seam: FixtureFullDiskAccess(), interval: .seconds(3600))
    #expect(!model.polling)
    model.continueFromChannels()
    #expect(!model.polling)
    #expect(await model.pollOnce() == false)
    #expect(model.probes == 0)
  }

  @Test("Skip iMessage on 2b stops the poll and moves on")
  func skipStopsPoll() {
    let model = OnboardingModel(store: MemoryOnboardingStore(), seam: FixtureFullDiskAccess(), interval: .seconds(3600))
    model.continueFromChannels()
    model.openSettings()
    #expect(model.polling)
    model.skip(.imessage)
    #expect(!model.polling)
    #expect(model.step == .whatsapp)
  }

  @Test("AgentStep defaults off, with no channel ticked; choosing Draft ticks none")
  func agentStepDefaultsOff() {
    #expect(OnboardingProgress().drafting == false)
    #expect(OnboardingProgress().draftChannels.isEmpty)
    let model = OnboardingModel(store: MemoryOnboardingStore(), seam: FixtureFullDiskAccess())
    #expect(model.progress.drafting == false)
    model.toggleDraftChannel(.email)
    #expect(model.progress.draftChannels.isEmpty, "a channel ticked while drafting is off")
    model.setDrafting(true)
    #expect(model.progress.draftChannels.isEmpty, "choosing Draft ticked a channel")
    model.toggleDraftChannel(.email)
    #expect(model.progress.draftChannels == [.email])
    model.setDrafting(false)
    #expect(model.progress.draftChannels.isEmpty)
    #expect(OnboardingCopy.agentLine(OnboardingProgress()) == "Agent: no drafting.")
  }

  @Test("step 1 skips nothing on its own; a card's Skip passes over that channel's step")
  func cardSkip() {
    let model = OnboardingModel(store: MemoryOnboardingStore(), seam: FixtureFullDiskAccess())
    #expect(model.step == .channels)
    #expect(OnboardingCopy.continueWith(model.connectedCount) == "Continue with 0 connected")
    model.toggleSkip(.imessage)
    model.toggleSkip(.linkedin)
    model.continueFromChannels()
    #expect(model.step == .whatsapp)
    model.skip(.whatsapp)
    #expect(model.step == .email)
    model.skip(.email)
    #expect(model.step == .agent)
    model.finish()
    #expect(model.step == .done)
    for channel in OnboardingChannel.allCases {
      #expect(OnboardingCopy.doneLine(channel, model.progress) == "declined by you")
    }
  }

  @Test("any key dismisses the coach row, Escape or not, once; a tile click collapses the rail, once")
  func coachDismissedByAnyKey() {
    // x, r, e, h, m, space, Return, Escape, a function key, and no text.
    for key: String? in ["x", "r", "e", "h", "m", " ", "\r", "\u{1B}", "\u{F704}", nil] {
      var saved = OnboardingProgress()
      saved.step = .firstThread
      let store = MemoryOnboardingStore(saved)
      let model = OnboardingModel(store: store, seam: FixtureFullDiskAccess())
      #expect(model.coachShown)
      #expect(model.railExpanded)
      model.coachKeyDown(key)
      #expect(!model.coachShown, "key \(String(describing: key)) left the coach row up")
      #expect(model.railExpanded, "a key collapsed the rail")
      let relaunched = OnboardingModel(store: store, seam: FixtureFullDiskAccess())
      #expect(!relaunched.coachShown, "the coach row came back")
    }
    var saved = OnboardingProgress()
    saved.step = .firstThread
    let store = MemoryOnboardingStore(saved)
    let model = OnboardingModel(store: store, seam: FixtureFullDiskAccess())
    model.railTileClicked()
    #expect(!model.railExpanded)
    #expect(model.coachShown, "a click dismissed the coach row")
    model.coachKeyDown("x")
    #expect(store.saved?.finished == true)
  }

  @Test("the coach row and the rail's words are 12.I's only")
  func handoverOnlyOnFirstThread() {
    for step in OnboardingStep.allCases where step != .firstThread {
      var saved = OnboardingProgress()
      saved.step = step
      let model = OnboardingModel(store: MemoryOnboardingStore(saved), seam: FixtureFullDiskAccess())
      #expect(!model.coachShown)
      #expect(!model.railExpanded)
    }
  }

  @Test("the step counter reads n of 6 for the six steps, and the slugs are distinct")
  func stepLines() {
    #expect(OnboardingCopy.stepLine(.channels) == "Step 1 of 6 \u{00B7} Connect channels")
    #expect(OnboardingCopy.stepLine(.agent) == "Step 6 of 6")
    #expect(Set(OnboardingStep.allCases.map(\.slug)).count == OnboardingStep.allCases.count)
    #expect(Set(OnboardingStep.allCases.compactMap(\.number)) == Set(1...6))
    #expect(OnboardingCopy.warning(.email) == nil, "Email carries a bold warning")
    for channel in OnboardingChannel.allCases where channel != .email {
      #expect(OnboardingCopy.warning(channel) != nil)
    }
  }
}
