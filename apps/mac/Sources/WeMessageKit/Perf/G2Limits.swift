import Foundation

/// G2's performance limits (docs/plans/v2-swift-S5-B.md, S7a), in one table
/// so a test that loosens a limit has to loosen it here, where a pin test
/// reads it. Hard rows fail the run; soft rows are measured and reported.
///
/// Every measurement prints one `G2|` line, which tools/swift/g2-report.sh
/// turns into G2-REPORT.md:
///
///     G2|<metric>|<value>|<unit>|<limit or ->|<hard or soft>
public enum G2Limits {
  /// First paint: the first thread row hittable, from `app.launch()` return.
  public static let firstPaintMs = 300
  /// The transcript mounts at most this many rows, however long the thread.
  public static let mountedTranscriptRows = 120
  /// The reducer's p95 step over `reduceEvents` synthetic events.
  public static let reduceP95Ms = 50
  public static let reduceEvents = 1_000

  public enum Kind: String, Sendable {
    case hard
    case soft
  }

  /// One report line. A soft row with no limit prints `-` in its place.
  public static func line(metric: String, value: Double, unit: String, limit: Int?, kind: Kind) -> String {
    let shown = String(format: "%.2f", value)
    let bound = limit.map(String.init) ?? "-"
    return ["G2", metric, shown, unit, bound, kind.rawValue].joined(separator: "|")
  }

  /// The nearest-rank percentile of `values`: the smallest value with at
  /// least `percent` of the sample at or below it. Zero for no sample.
  public static func percentile(_ values: [Double], _ percent: Int) -> Double {
    guard !values.isEmpty else { return 0 }
    let sorted = values.sorted()
    let rank = Int((Double(percent) / 100 * Double(sorted.count)).rounded(.up))
    return sorted[min(max(rank, 1), sorted.count) - 1]
  }
}
