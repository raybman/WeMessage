import SwiftUI
import WeMessageKit

/// Board 11.A: search everything. While it is up it takes the list and the
/// thread panes (D-UI-86), so the composer and its Send are not in the
/// window. The field, its tokens, what was searched and what was not, the
/// results grouped by channel, and the facets. Everything here reads; the
/// only act is opening a result, which is a navigation.
///
/// Keys: shift-cmd-F opens it, the arrows move, cmd-Return opens the
/// highlighted result (D-UI-81), Esc closes. A highlight is ink, bold and
/// underlined: never a colour.
struct SearchPane: View {
  let model: ShellModel
  @Bindable var search: SearchModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SearchHeader(title: "Search", scope: "all channels", palette: palette)
      VStack(alignment: .leading, spacing: 8) {
        field
        if !search.query.chips.isEmpty {
          TokenRow(search: search, palette: palette)
        }
        if let results = search.results {
          CoverageBlock(results: results, palette: palette)
        } else if let failure = search.failure {
          Text(failure.line)
            .font(.system(size: 10))
            .foregroundStyle(Tokens.color(palette.ink))
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityIdentifier(ShellID.searchCoverage)
        }
      }
      .padding(.horizontal, 16)
      .padding(.bottom, 10)
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25)).frame(height: 0.5)
      content
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Search")
    .accessibilityIdentifier(ShellID.search)
  }

  private var summary: String {
    if search.searching { return ProvisionalUI.searchingWord }
    guard let results = search.results else { return "" }
    return results.fieldSummary + " \u{00B7} \(search.lastMillis)ms"
  }

  private var field: some View {
    HStack(spacing: 8) {
      Text("\u{2315}")
        .font(.system(size: 14, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .accessibilityHidden(true)
      TextField("", text: $search.text, prompt: Text(SearchCopy.fieldPrompt))
        .textFieldStyle(.plain)
        .font(.system(size: 14))
        .foregroundStyle(Tokens.color(palette.ink))
        .background(FieldClaim(token: search.shown ? "search" : nil))
        .onKeyPress(.upArrow, phases: [.down, .repeat]) { press in
          guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
          search.move(-1)
          return .handled
        }
        .onKeyPress(.downArrow, phases: [.down, .repeat]) { press in
          guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
          search.move(1)
          return .handled
        }
        .onKeyPress(phases: .down) { press in Board11Keys.route(press, model: model) }
        .onKeyPress(.escape) {
          model.escapeBoard11()
          return .handled
        }
        // D-UI-81: a bare Return does nothing here; cmd-Return opens.
        .onKeyPress(.return, phases: .down) { press in
          guard press.modifiers.contains(.command) else { return .ignored }
          if let hit = search.selectedHit { model.open(hit) }
          return .handled
        }
        .accessibilityLabel("Search all channels")
        .accessibilityIdentifier(ShellID.searchField)
      if !summary.isEmpty {
        Text(summary)
          .font(.system(size: 10, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .lineLimit(1)
          .fixedSize()
          .accessibilityIdentifier(ShellID.searchSummary)
      }
    }
    .padding(.vertical, 8)
    .padding(.horizontal, 10)
    .background(RoundedRectangle(cornerRadius: 8).fill(Tokens.color(palette.layer1)))
    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
  }

  @ViewBuilder private var content: some View {
    if let failure = search.failure {
      SearchPromptView(line: failure.line, palette: palette)
    } else if let empty = search.empty {
      // Board 10's "Nothing for ..." (and its not-connected empty), reused.
      EmptyStateView(copy: EmptyStates.copy(empty, search.emptyFacts(asOf: model.queueClock)), palette: palette)
        .frame(maxWidth: 460, maxHeight: 280)
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    } else if let results = search.results {
      HStack(alignment: .top, spacing: 0) {
        ResultsList(model: model, search: search, results: results, palette: palette)
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25)).frame(width: 0.5)
        FacetsColumn(search: search, results: results, palette: palette)
          .frame(width: 210)
      }
    } else {
      SearchPromptView(line: SearchCopy.emptyField, palette: palette)
    }
  }
}

/// Board 11's words.
enum SearchCopy {
  static let fieldPrompt = "Search messages, or from: in: has: before: after: channel:"
  static let emptyField = "Type to search. Operators: from:me, from:name, in:\"Thread\", has:attachment, has:link, has:voice, before:2025, after:2024-06-01, channel:imessage."
  static let hint = "Esc closes \u{00B7} \u{2191}\u{2193} move \u{00B7} \u{2318}Return opens"
  static let switcherHint = "Esc closes \u{00B7} \u{2191}\u{2193} move \u{00B7} \u{2318}Return opens"
  static let footnote =
    "Sorted by sent time, newest first, within each channel group. Facets are filters: choose one to add its token."

  /// What an unparsed token says it is (D-UI-80).
  static func unparsed(_ chip: TokenChip) -> String {
    "unparsed, " + (chip.reason?.rawValue ?? "unknown") + ", matched as text"
  }
}

/// The title row of a board 11 pane: the name, its scope, and its keys.
struct SearchHeader: View {
  let title: String
  let scope: String
  let palette: Tokens.Palette
  var hint: String = SearchCopy.hint

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(title)
        .font(.system(size: 15, weight: .semibold))
        .foregroundStyle(Tokens.color(palette.ink))
        .accessibilityAddTraits(.isHeader)
      Text(scope)
        .font(.system(size: 11))
        .foregroundStyle(Tokens.color(palette.inkDim))
      Spacer(minLength: 8)
      Text(hint)
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
        .lineLimit(1)
    }
    .padding(.horizontal, 16)
    .padding(.top, 12)
    .padding(.bottom, 10)
  }
}

/// The empty field's line, or the corpus loading.
struct SearchPromptView: View {
  let line: String
  let palette: Tokens.Palette

  var body: some View {
    Text(line)
      .font(.system(size: 12))
      .foregroundStyle(Tokens.color(palette.inkDim))
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: 520, alignment: .leading)
      .padding(24)
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
      .accessibilityIdentifier(ShellID.searchPrompt)
  }
}

/// 11.B: the query as tokens. A parsed token has a solid rule; one that
/// did not parse is dashed and says why, and still constrains the search as
/// text (D-UI-80). Each has an x that takes its text out of the field.
struct TokenRow: View {
  @Bindable var search: SearchModel
  let palette: Tokens.Palette

  var body: some View {
    HStack(spacing: 6) {
      ForEach(search.query.chips) { chip in
        TokenChipView(chip: chip, note: search.results?.applied(chip), palette: palette) { search.remove(chip) }
      }
      Spacer(minLength: 0)
    }
  }
}

struct TokenChipView: View {
  let chip: TokenChip
  /// D-UI-207: how far the daemon honoured this token, when not fully.
  var note: (word: String, reason: String)? = nil
  let palette: Tokens.Palette
  let remove: () -> Void

  private var spoken: String {
    var words = chip.parsed ? "Token " + chip.text : "Token " + chip.text + ", " + SearchCopy.unparsed(chip)
    if let note {
      words += ", " + note.word
      if !note.reason.isEmpty { words += ", " + note.reason }
    }
    return words
  }

  var body: some View {
    HStack(spacing: 4) {
      if !chip.parsed {
        Text("?")
          .font(.system(size: 10, weight: .bold))
          .foregroundStyle(Tokens.color(palette.ink))
      }
      // The op carries its own colon ("from:"); the CI shots of run
      // 37764667738 drew "from:: me".
      if let op = chip.op {
        Text(op)
          .font(.system(size: 11, weight: .semibold, design: .monospaced))
          .foregroundStyle(Tokens.color(palette.ink))
      }
      Text(chip.value)
        .font(.system(size: 11, design: .monospaced))
        .italic(!chip.parsed)
        .foregroundStyle(Tokens.color(palette.ink))
      if !chip.parsed {
        Text(chip.reason?.rawValue ?? "")
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      if let note {
        Text(ProvisionalUI.searchChipSeparator + note.word)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
      }
      Button(action: remove) {
        Text("\u{00D7}")
          .font(.system(size: 11, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .focusable()
      .accessibilityLabel("Remove " + chip.text)
    }
    .padding(.vertical, 3)
    .padding(.horizontal, 8)
    .background {
      if chip.parsed {
        Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1)
      } else {
        Capsule().strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.placeholder)
      }
    }
    // One element: a container's value never reaches AX on macOS (run
    // 37756434645 read "" on every chip). Ignored alone it is role Other,
    // which still drops the value and fails the audit as "Unknown role"
    // (run 37761444224); as a button, like a result row, the value
    // reaches AX. Its press removes it, as its x does.
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(spoken)
    .accessibilityValue(chip.parsed ? "parsed" : "unparsed")
    .accessibilityHint("Removes the token")
    .accessibilityAction { remove() }
    .accessibilityAction(named: "Remove") { remove() }
    .accessibilityIdentifier(ShellID.searchTokenPrefix + String(chip.id))
  }
}

/// The results, grouped by channel in rail order, newest first in each.
struct ResultsList: View {
  let model: ShellModel
  @Bindable var search: SearchModel
  let results: SearchResults
  let palette: Tokens.Palette

  var body: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(results.groups) { group in
            GroupHeader(group: group, palette: palette)
            ForEach(group.hits) { hit in
              ResultRow(hit: hit, selected: search.selection == hit.id, palette: palette) { model.open(hit) }
                .id(hit.id)
            }
          }
          if let more = results.moreCount, more > 0 {
            Button {
              search.more()
            } label: {
              Text(String(format: ProvisionalUI.searchMoreFormat, more))
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(Tokens.color(palette.ink))
                .padding(.vertical, 6)
                .padding(.horizontal, 10)
                .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .focusable()
            .disabled(search.loadingMore)
            .padding(.top, 10)
            .accessibilityIdentifier(ShellID.searchMore)
          }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
      }
      .onChange(of: search.selection) { _, selection in
        guard let selection else { return }
        proxy.scrollTo(selection)
      }
      .onAppear {
        if let selection = search.selection { proxy.scrollTo(selection, anchor: .center) }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// D-UI-203..209: what was searched, how far the index reaches, and what the
/// daemon left out, one line each, with a 1 pt ink bar under the indexing
/// line. Read as one element, opening "Searched ".
struct CoverageBlock: View {
  let results: SearchResults
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 3) {
      ForEach(Array(results.coverageLines.enumerated()), id: \.offset) { _, line in
        Text(line)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
        if line == results.indexingLine {
          GeometryReader { geo in
            ZStack(alignment: .leading) {
              Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25))
              Rectangle().fill(Tokens.color(palette.ink))
                .frame(width: geo.size.width * Double(results.indexingPercent) / 100)
            }
          }
          .frame(maxWidth: 240)
          .frame(height: ProvisionalUI.searchIndexingBarHeight)
        }
      }
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(results.coverageLines.joined(separator: " "))
    .accessibilityIdentifier(ShellID.searchCoverage)
  }
}

/// "IMESSAGE   4 · newest May 20, 2025".
struct GroupHeader: View {
  let group: SearchGroup
  let palette: Tokens.Palette

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 8) {
      Text(group.channel.label.uppercased())
        .font(.system(size: 9, weight: .bold))
        .tracking(1.2)
        .foregroundStyle(Tokens.color(palette.ink))
      Text(group.header())
        .font(.system(size: 10))
        .foregroundStyle(Tokens.color(palette.inkDim))
      Spacer(minLength: 0)
    }
    .padding(.top, 10)
    .padding(.bottom, 4)
    .padding(.horizontal, 4)
    .overlay(alignment: .bottom) {
      Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25)).frame(height: 0.5)
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.isHeader)
    .accessibilityIdentifier(ShellID.searchGroupPrefix + group.channel.rawValue)
  }
}

/// One result (11.A): who, which way, when, and the sentence with the
/// match in bold, underlined ink.
struct ResultRow: View {
  let hit: SearchHit
  let selected: Bool
  let palette: Tokens.Palette
  let open: () -> Void

  private var doc: SearchDoc { hit.doc }

  private var direction: String {
    let way = SearchText.direction(outbound: doc.outbound)
    return doc.isGroup ? "in " + doc.threadTitle + "  " + way : way
  }

  private var plain: String { hit.snippet.map(\.text).joined() }

  private var spoken: String {
    let when = SearchText.stamp(doc.sentAt)
    return "\(doc.sender), \(direction), \(when): \(plain)"
  }

  /// The snippet's runs: a match is bold and underlined, in the same ink.
  static func styled(_ parts: [SnippetPart]) -> AttributedString {
    var out = AttributedString()
    for part in parts {
      var run = AttributedString(part.text)
      if part.match {
        run.font = .system(size: 12, weight: .bold)
        run.underlineStyle = .single
      }
      out += run
    }
    return out
  }

  private var initials: String {
    let words = doc.sender.split(separator: " ").prefix(2)
    let letters = words.compactMap { $0.first.map(String.init) }.joined()
    return letters.isEmpty ? "?" : letters.uppercased()
  }

  var body: some View {
    Button(action: open) {
      HStack(alignment: .top, spacing: 10) {
        Text(initials)
          .font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
          .frame(width: 26, height: 26)
          .background(Circle().fill(Tokens.color(palette.layer2)))
          .overlay(Circle().strokeBorder(Tokens.color(palette.inkDim, opacity: 0.5), lineWidth: 1))
        VStack(alignment: .leading, spacing: 3) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(doc.sender)
              .font(.system(size: 12, weight: .semibold))
              .foregroundStyle(Tokens.color(palette.ink))
              .lineLimit(1)
            Text(direction)
              .font(.system(size: 10))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .lineLimit(1)
            Spacer(minLength: 8)
            Text(SearchText.stamp(doc.sentAt))
              .font(.system(size: 10, design: .monospaced))
              .foregroundStyle(Tokens.color(palette.inkDim))
              .fixedSize()
          }
          Text(Self.styled(hit.snippet))
            .font(.system(size: 12))
            .foregroundStyle(Tokens.color(palette.ink))
            .lineLimit(2)
            .fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.vertical, 8)
      .padding(.horizontal, 10)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background {
        if selected { RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.ink, opacity: 0.07)) }
      }
      .overlay(alignment: .leading) {
        if selected { Rectangle().fill(Tokens.color(palette.ink)).frame(width: 2).padding(.vertical, 4) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(spoken)
    .accessibilityValue(selected ? "selected" : "")
    // Ignoring children drops the Button's press; give it back.
    .accessibilityAction { open() }
    .accessibilityIdentifier(ShellID.searchResultPrefix + hit.id)
  }
}

/// 11.A's right column: CHANNEL, PEOPLE and YEAR. A facet is a filter:
/// choosing one adds its token to the field.
struct FacetsColumn: View {
  @Bindable var search: SearchModel
  let results: SearchResults
  let palette: Tokens.Palette

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: 14) {
        section("CHANNEL", slug: "channel", results.channelFacets)
        section(
          "PEOPLE", slug: "people", Array(results.peopleFacets.prefix(ProvisionalUI.facetPeopleCap)),
          more: max(0, results.peopleFacets.count - ProvisionalUI.facetPeopleCap))
        section("YEAR", slug: "year", results.yearFacets)
        Text(SearchCopy.footnote)
          .font(.system(size: 9))
          .foregroundStyle(Tokens.color(palette.inkDim))
          .fixedSize(horizontal: false, vertical: true)
      }
      .padding(14)
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Facets")
    .accessibilityIdentifier(ShellID.searchFacets)
  }

  static func spoken(_ facet: SearchFacet) -> String { "\(facet.label), \(facet.count), adds \(facet.token)" }

  static func identifier(_ slug: String, _ index: Int) -> String { "\(ShellID.searchFacetPrefix)\(slug).\(index)" }

  @ViewBuilder
  private func section(_ title: String, slug: String, _ facets: [SearchFacet], more: Int = 0) -> some View {
    if !facets.isEmpty {
      VStack(alignment: .leading, spacing: 4) {
        Text(title)
          .font(.system(size: 9, weight: .semibold))
          .tracking(1.2)
          .foregroundStyle(Tokens.color(palette.inkDim))
          .accessibilityAddTraits(.isHeader)
        ForEach(Array(facets.enumerated()), id: \.element.id) { index, facet in
          Button {
            search.add(facet)
          } label: {
            HStack {
              Text(facet.label)
                .font(.system(size: 11))
                .foregroundStyle(Tokens.color(palette.ink))
                .lineLimit(1)
              Spacer(minLength: 6)
              Text("\(facet.count)")
                .font(.system(size: 10, design: .monospaced))
                .foregroundStyle(Tokens.color(palette.inkDim))
            }
            .padding(.vertical, 3)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .focusable()
          .accessibilityLabel(Self.spoken(facet))
          .accessibilityIdentifier(Self.identifier(slug, index))
        }
        if more > 0 {
          Text("\(more) more")
            .font(.system(size: 10))
            .foregroundStyle(Tokens.color(palette.inkDim))
        }
      }
    }
  }
}

/// 11.H: the quick switcher, cmd-K. It opens empty every time and matches
/// thread titles, handles and channels (D-UI-84). cmd-Return opens the
/// highlighted row; Esc closes.
struct QuickSwitcherPane: View {
  let model: ShellModel
  @Bindable var switcher: QuickSwitcherModel
  let palette: Tokens.Palette

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      SearchHeader(title: "Go to", scope: "threads and channels", palette: palette, hint: SearchCopy.switcherHint)
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: 8) {
          Text("\u{2318}K")
            .font(.system(size: 10, weight: .semibold, design: .monospaced))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .accessibilityHidden(true)
          TextField("", text: $switcher.text, prompt: Text("A name, a number or a channel"))
            .textFieldStyle(.plain)
            .font(.system(size: 14))
            .foregroundStyle(Tokens.color(palette.ink))
            .background(FieldClaim(token: switcher.shown ? "switcher" : nil))
            .onKeyPress(.upArrow, phases: [.down, .repeat]) { press in
              guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
              switcher.move(-1)
              return .handled
            }
            .onKeyPress(.downArrow, phases: [.down, .repeat]) { press in
              guard !press.modifiers.contains(.command) else { return Board11Keys.route(press, model: model) }
              switcher.move(1)
              return .handled
            }
            .onKeyPress(phases: .down) { press in Board11Keys.route(press, model: model) }
            .onKeyPress(.escape) {
              model.escapeBoard11()
              return .handled
            }
            // D-UI-81: a bare Return does nothing here; cmd-Return opens.
            .onKeyPress(.return, phases: .down) { press in
              guard press.modifiers.contains(.command) else { return .ignored }
              if let row = switcher.selectedRow { model.open(row) }
              return .handled
            }
            .accessibilityLabel("Go to a thread or channel")
            .accessibilityIdentifier(ShellID.switcherField)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 12)
        Rectangle().fill(Tokens.color(palette.inkDim, opacity: 0.25)).frame(height: 0.5)
        if switcher.rows.isEmpty {
          Text(switcher.text.isEmpty ? "Type a name, a number or a channel." : "No thread or channel matches.")
            .font(.system(size: 11))
            .foregroundStyle(Tokens.color(palette.inkDim))
            .padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
        } else {
          VStack(spacing: 0) {
            ForEach(switcher.rows) { row in
              SwitcherRow(row: row, selected: switcher.selection == row.id, palette: palette) { model.open(row) }
            }
          }
          .padding(6)
        }
      }
      .background(RoundedRectangle(cornerRadius: 10).fill(Tokens.color(palette.layer1)))
      .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Tokens.color(palette.ink), lineWidth: 1))
      .frame(maxWidth: 520)
      .padding(.horizontal, 16)
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Go to")
    .accessibilityIdentifier(ShellID.switcher)
  }
}

struct SwitcherRow: View {
  let row: QuickSwitcherModel.Row
  let selected: Bool
  let palette: Tokens.Palette
  let open: () -> Void

  private var spoken: String {
    var words = row.title + ", " + row.detail
    if row.draftWaiting { words += ", " + ProvisionalUI.switcherDraftHint }
    return words
  }

  var body: some View {
    Button(action: open) {
      HStack(spacing: 8) {
        Text(row.title)
          .font(.system(size: 12, weight: .semibold))
          .foregroundStyle(Tokens.color(palette.ink))
        Text(row.detail)
          .font(.system(size: 10))
          .foregroundStyle(Tokens.color(palette.inkDim))
        Spacer(minLength: 8)
        if row.draftWaiting {
          Text(ProvisionalUI.switcherDraftHint)
            .font(.system(size: 9, weight: .semibold))
            .foregroundStyle(Tokens.color(palette.ink))
            .padding(.vertical, 2)
            .padding(.horizontal, 6)
            .overlay(Capsule().strokeBorder(Tokens.color(palette.ink), style: BubbleStroke.placeholder))
        }
      }
      .padding(.vertical, 7)
      .padding(.horizontal, 8)
      .background {
        if selected { RoundedRectangle(cornerRadius: 6).fill(Tokens.color(palette.ink, opacity: 0.07)) }
      }
      .overlay(alignment: .leading) {
        if selected { Rectangle().fill(Tokens.color(palette.ink)).frame(width: 2).padding(.vertical, 4) }
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .focusable()
    .accessibilityElement(children: .ignore)
    .accessibilityAddTraits(.isButton)
    .accessibilityLabel(spoken)
    .accessibilityValue(selected ? "selected" : "")
    .accessibilityAction { open() }
    .accessibilityIdentifier(ShellID.switcherRowPrefix + row.id)
  }
}

/// Board 11's keys, always in the window (not test-only): shift-cmd-F
/// search, cmd-K the switcher, cmd-F find in the open thread, opt-cmd-G
/// the year scrubber, opt-cmd-up and opt-cmd-down a year, and while search
/// or the switcher is up, cmd-Return to open. Every one carries cmd
/// (H-A2+). The arrows and Esc are the focused field's own, and Esc in the
/// list or the composer climbs board 11 first (ShellModel.escape), so the
/// composer's arrows stay the composer's. Zero size and hidden: the keys
/// are the controls.
struct Board11Keys: View {
  let model: ShellModel

  var body: some View {
    ZStack {
      Button("") { model.openSearch() }
        .keyboardShortcut("f", modifiers: [.command, .shift])
      Button("") { model.openSwitcher() }
        .keyboardShortcut("k", modifiers: .command)
      Button("") { model.openFind() }
        .keyboardShortcut("f", modifiers: .command)
      Button("") { model.toggleScrubber() }
        .keyboardShortcut("g", modifiers: [.command, .option])
      if model.scrubberShown {
        Button("") { model.stepYear(-1) }
          .keyboardShortcut(.upArrow, modifiers: [.command, .option])
        Button("") { model.stepYear(1) }
          .keyboardShortcut(.downArrow, modifiers: [.command, .option])
      }
      if model.search.shown {
        Button("") { if let hit = model.search.selectedHit { model.open(hit) } }
          .keyboardShortcut(.return, modifiers: .command)
        // D-UI-211: cmd-Down reads the next page.
        Button("") { model.search.more() }
          .keyboardShortcut(.downArrow, modifiers: .command)
      } else if model.switcher.shown {
        Button("") { if let row = model.switcher.selectedRow { model.open(row) } }
          .keyboardShortcut(.return, modifiers: .command)
      }
    }
    .frame(width: 0, height: 0)
    .opacity(0)
    .accessibilityHidden(true)
  }

  /// The same keys, heard by a field that holds the keyboard: the composer
  /// and board 11's own fields. A text view can keep a key equivalent from
  /// the hidden buttons (the composer's cmd-Return, run 37594298009), so a
  /// field passes board 11's chords here; anything else is ignored.
  static func route(_ press: KeyPress, model: ShellModel) -> KeyPress.Result {
    route(press.key, press.characters, press.modifiers, model: model) ? .handled : .ignored
  }

  /// True when the chord was board 11's and has been acted on.
  static func route(_ key: KeyEquivalent, _ characters: String, _ modifiers: EventModifiers, model: ShellModel) -> Bool {
    guard modifiers.contains(.command), !modifiers.contains(.control) else { return false }
    let letter = String(key.character).lowercased()
    let typed = characters.lowercased()
    let named: (String) -> Bool = { letter == $0 || typed == $0 }
    if modifiers.contains(.option) {
      if key == .upArrow || key == .downArrow {
        guard model.scrubberShown else { return false }
        model.stepYear(key == .upArrow ? -1 : 1)
        return true
      }
      guard named("g"), !modifiers.contains(.shift) else { return false }
      model.toggleScrubber()
      return true
    }
    if key == .downArrow, !modifiers.contains(.shift), model.search.shown {
      model.search.more()
      return true
    }
    if named("f") {
      if modifiers.contains(.shift) { model.openSearch() } else { model.openFind() }
      return true
    }
    if named("k"), !modifiers.contains(.shift) {
      model.openSwitcher()
      return true
    }
    return false
  }
}
