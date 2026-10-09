import Foundation

// PROVISIONAL pending Eric's D-UI-137 and 160..169 decisions (v2 B3, board
// 04, LinkedIn over fixtures). D-UI-137 is the plan's row 107 renumbered +30
// past the tree's rows; D-UI-160..169 are the defaults this build took where
// board 04 leaves a choice open. The same rule as ProvisionalUI.swift holds
// here: every value is a default chosen so the board can be built and
// tested before the questions are answered, this file is the whole edit
// when they are, and Board04HygieneTests (H-B-4) fails if a copy string
// here is repeated as a literal in another app or UI test source.
//
// Foundation only: the CI-only UI test bundle compiles this file too (see
// apps/mac/project.yml), so the XCUITests read the values the app draws.
extension ProvisionalUI {
  // D-UI-137: Focused and Other (04.A) are a two-capsule segmented control,
  // left-aligned under the banner while the LinkedIn tile is selected. No
  // hairline and no fill run across the pane under it, and no unread dot
  // sits on either side: the thread list carries no unread field to count.
  // Focused is on at launch, as on LinkedIn.
  public enum LinkedInCategoryPlacement: Sendable {
    case segmentedUnderBanner
  }
  public static let linkedInCategoryPlacement: LinkedInCategoryPlacement = .segmentedUnderBanner
  public static let linkedInCategoriesLabel = "LinkedIn categories"

  // D-UI-160: the banner names the channel, the account and the inbox scope.
  // The scope is the inbox switch (04.E): pressing it opens a popover. The
  // fixture chip (D-UI-132) sits at the trailing edge, as on boards 03 and 05.
  public static let linkedInAllInboxes = "All 3 inboxes"
  public static func linkedInBanner(account: String?, scope: String) -> String {
    if let account, !account.isEmpty { return "LinkedIn \u{00B7} \(account) \u{00B7} \(scope)" }
    return "LinkedIn \u{00B7} \(scope)"
  }
  public static let linkedInSwitchMark = "\u{25BE}"
  public static let linkedInEmptyHeadline = "Pick a LinkedIn thread."
  public static let linkedInEmptyDetail = "A reply here makes a draft for Needs You, in the inbox the thread came from. Nothing is sent from this board."

  // D-UI-161: the inbox switch's popover lists All 3 inboxes, then each
  // inbox with how many threads it holds. Every inbox stays listed at zero.
  // While All shows, each LinkedIn row carries its origin tag (MSG, SN,
  // REC); narrowed to one inbox the tag is dropped.
  public static let linkedInSwitchTitle = "Show threads from"
  public static func linkedInInboxRow(_ title: String, threads: Int) -> String {
    threads == 1 ? "\(title) \u{00B7} 1 thread" : "\(title) \u{00B7} \(threads) threads"
  }

  // D-UI-162: the thread head's line says where a reply goes: always the
  // inbox the thread was born in (04.E), then the degree and the headline.
  public static func linkedInReplyingVia(_ inbox: String) -> String { "Replying on LinkedIn via \(inbox)" }

  // D-UI-163: the eligibility ladder (04.B) is read only. The inspector's
  // Reach section lists the five steps with the one that reaches this
  // person marked by the tint bar; the composer's meta line names the step.
  // Nothing on the board changes the step.
  public static let linkedInLadderTitle = "Reach"
  public static func linkedInRungTitle(_ step: Int) -> String {
    switch step {
    case 0: "Message, 1st degree, free"
    case 1: "InMail to an Open Profile, no credit"
    case 2: "InMail, 1 credit"
    case 3: "Message request through shared context, free"
    default: "No way to message them"
    }
  }
  public static func linkedInComposerMeta(_ step: Int, degree: String?) -> String {
    let how: String
    switch step {
    case 0: how = "free \u{00B7} plain text only"
    case 1: how = "Open Profile \u{00B7} no credit"
    case 2: how = "InMail \u{00B7} 1 credit"
    default: how = "a request \u{00B7} free \u{00B7} no attachments"
    }
    if let degree { return "\(degree) degree \u{00B7} \(how)" }
    return how
  }

  // D-UI-164: an InMail (04.C) is drawn as a card on its sender's side: the
  // subject over the body, and what it cost under them.
  public static let linkedInInMailTag = "INMAIL"
  public static func linkedInInMailCost(_ credits: Int) -> String {
    switch credits {
    case 0: "No credit spent"
    case 1: "1 InMail credit spent"
    default: "\(credits) InMail credits spent"
    }
  }

  // D-UI-165: a pending request (04.D) replaces the composer with a card:
  // who wrote, through what, and what cannot happen until accepted. Accept
  // and Decline privately are drawn and inert in this version; the card
  // says so.
  public static let linkedInRequestTitle = "Message request"
  public static func linkedInRequestLine(_ shared: String?) -> String {
    let rest = "No reactions, no reply, and no attachments until you accept. Declining is private: they are not notified."
    if let shared { return "They wrote first. \(shared). \(rest)" }
    return "They wrote first. \(rest)"
  }
  public static let linkedInAcceptLabel = "Accept"
  public static let linkedInDeclineLabel = "Decline privately"
  public static let linkedInRequestInert = "Accepting and declining happen on LinkedIn in this version."
  public static let linkedInRequestNoComposer = "No composer until their request is accepted."
  public static let linkedInDeclinedLine = "Declined privately. Kept read only."

  // D-UI-166: the commercial payloads (04.F). A sponsored message has no
  // composer and says why; Delete and Report are drawn and inert. A
  // recruiter InMail shows LinkedIn's two templated answers, inert. A job
  // application is a card with its title, detail line and file, never
  // fetched.
  public static let linkedInSponsoredLine = "No composer. This is an ad, not a person. Nothing you type here reaches anyone."
  public static let linkedInDeleteLabel = "Delete ad"
  public static let linkedInReportLabel = "Report ad"
  public static let linkedInAdInert = "Deleting and reporting an ad happen on LinkedIn in this version."
  public static let linkedInInterestedLabel = "Yes, interested"
  public static let linkedInNoThanksLabel = "No thanks"
  public static let linkedInTemplated = "Templated by LinkedIn. Answering from here is not in this version."
  public static let linkedInNotFetched = "Not fetched. This Mac holds the name and size only."

  // D-UI-167: the inspector (04.G) opens with the thread head's toggle, as
  // board 02's does, at 270 pt: who this is, the ladder, history on every
  // channel ("none" where there is none), an address from their own
  // profile, and the account's dated unread and credit counts per inbox.
  public static let linkedInInspectorWidth: Double = 270
  public static let linkedInWhoTitle = "Who this is"
  public static let linkedInHistoryTitle = "History, all channels"
  public static let linkedInHistoryNone = "none"
  public static let linkedInAlsoTitle = "Also reachable"
  public static let linkedInAlsoInert = "Reply by email instead\u{2026} is not in this version."
  public static let linkedInInboxesTitle = "Inboxes"
  public static let linkedInCreditsTitle = "InMail credits left"
  public static func linkedInAsOf(_ clock: String) -> String { "as of \(clock)" }
  public static func linkedInUnreadRow(_ inbox: String, unread: Int) -> String { "\(inbox) \u{00B7} \(unread) unread" }
  public static func linkedInCreditRow(_ inbox: String, credits: Int) -> String { "\(inbox) \u{00B7} \(credits) left" }

  // D-UI-168: the composer sits at the foot of the thread, per step. The
  // InMail steps carry a subject; both fields stop at LinkedIn's caps and
  // say what is left. Make draft creates a pending draft for Needs You at
  // once, with no undo window, since nothing leaves before an approve; the
  // subject stays in this window. Hold until is not offered, with the
  // wireframe's reason, and the pacing budget is printed dated.
  public static let linkedInSubjectLabel = "InMail subject"
  public static let linkedInBodyPrompt = "Write to them here"
  public static func linkedInLeft(_ left: Int, of cap: Int) -> String { "\(left) left of \(cap)" }
  public static let linkedInDraftLabel = "Make draft"
  public static let linkedInHoldLine =
    "Hold until is not offered on LinkedIn. Sends here are hard-paced, and a message that fires on a clock rather than from a keystroke is exactly the pattern that gets an account restricted."
  public static func linkedInPacing(left: Int, clock: String, resets: String?) -> String {
    let base = "\(left) sends left this hour as of \(clock)"
    if let resets { return "\(base) \u{00B7} resets \(resets)" }
    return base
  }
  public static let linkedInComposingLine = "Make draft puts it in Needs You. Nothing leaves until you approve it there."
  public static let linkedInDraftingLine = "Making the LinkedIn draft."
  public static let linkedInDraftedLine = "Waiting in Needs You as a draft. Nothing was sent."
  public static let linkedInDraftFailedLine = "The daemon did not take the draft. Nothing was sent; the text is still here."
  public static let linkedInNoRungLine = "No step of the ladder reaches them from this account, so there is no composer."

  // D-UI-169: LinkedIn pushing back (04.H) is a blocking banner under the
  // channel banner, in the danger colour, on the whole board. No composer
  // is drawn while it holds, and no send queue is offered: reading still
  // works.
  public static func linkedInPausedLine(until clock: String?) -> String {
    let rest = "Reading cached threads still works. Nothing will be sent by you or your agent before then."
    if let clock { return "LinkedIn asked us to slow down. All LinkedIn activity paused until \(clock). \(rest)" }
    return "LinkedIn asked us to slow down. All LinkedIn activity paused for now. \(rest)"
  }
  public static let linkedInPausedComposer = "Paused. No composer while LinkedIn holds us back."
}
