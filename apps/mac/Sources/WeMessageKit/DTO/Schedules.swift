import Foundation

public enum Weekday: String, Codable, CaseIterable, Equatable, Sendable {
  case mon, tue, wed, thu, fri, sat, sun
}

/// One weekly window, in the schedule's own time zone ("09:00" to "17:00").
public struct ScheduleWindow: Codable, Equatable, Sendable {
  public var days: [Weekday]
  public var start: String
  public var end: String

  public init(days: [Weekday], start: String, end: String) {
    self.days = days
    self.start = start
    self.end = end
  }

  enum CodingKeys: String, CodingKey, CaseIterable {
    case days, start, end
  }

  var json: JSONValue {
    [
      "days": .array(days.map { .string($0.rawValue) }),
      "start": .string(start),
      "end": .string(end),
    ]
  }
}

extension ScheduleWindow {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    days = try c.decode([Weekday].self, forKey: .days)
    start = try c.decode(String.self, forKey: .start)
    end = try c.decode(String.self, forKey: .end)
  }
}

public struct SchedulePayload: Codable, Equatable, Sendable {
  public var id: String
  public var name: String
  public var timezone: String
  public var windows: [ScheduleWindow]
  public var enabled: Bool

  enum CodingKeys: String, CodingKey, CaseIterable {
    case id, name, timezone, windows, enabled
  }
}

extension SchedulePayload {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    name = try c.decode(String.self, forKey: .name)
    timezone = try c.decode(String.self, forKey: .timezone)
    windows = try c.decode([ScheduleWindow].self, forKey: .windows)
    enabled = try c.decode(Bool.self, forKey: .enabled)
  }
}

public struct ScheduleEnvelope: Codable, Equatable, Sendable {
  public var schedule: SchedulePayload

  enum CodingKeys: String, CodingKey, CaseIterable {
    case schedule
  }
}

extension ScheduleEnvelope {
  public init(from decoder: any Decoder) throws {
    let c = try decoder.strictContainer(keyedBy: CodingKeys.self)
    schedule = try c.decode(SchedulePayload.self, forKey: .schedule)
  }
}

// MARK: requests

/// `POST /v1/schedules`.
public struct ScheduleInput: Equatable, Sendable {
  public var name: String
  public var timezone: String
  public var windows: [ScheduleWindow]
  public var enabled: Bool?

  public init(name: String, timezone: String, windows: [ScheduleWindow], enabled: Bool? = nil) {
    self.name = name
    self.timezone = timezone
    self.windows = windows
    self.enabled = enabled
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [
      "name": .string(name), "timezone": .string(timezone), "windows": .array(windows.map(\.json)),
    ]
    if let enabled { fields["enabled"] = .bool(enabled) }
    return .object(fields)
  }
}

/// `PATCH /v1/schedules/:id`. Nil leaves a field alone.
public struct SchedulePatch: Equatable, Sendable {
  public var name: String?
  public var timezone: String?
  public var windows: [ScheduleWindow]?
  public var enabled: Bool?

  public init(name: String? = nil, timezone: String? = nil, windows: [ScheduleWindow]? = nil, enabled: Bool? = nil) {
    self.name = name
    self.timezone = timezone
    self.windows = windows
    self.enabled = enabled
  }

  var json: JSONValue {
    var fields: [String: JSONValue] = [:]
    if let name { fields["name"] = .string(name) }
    if let timezone { fields["timezone"] = .string(timezone) }
    if let windows { fields["windows"] = .array(windows.map(\.json)) }
    if let enabled { fields["enabled"] = .bool(enabled) }
    return .object(fields)
  }
}
