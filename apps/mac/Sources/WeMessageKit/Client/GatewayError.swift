import Foundation

// Every way a daemon call can fail, classified from the HTTP status, the body
// and the endpoint. The mapping mirrors request() in
// packages/client/src/index.ts wherever it can. Where the S1 spec (section
// 3.3) is richer, the kit keeps the richer shape, and every divergence is
// listed here in the same words as the test that pins it:
//
//   401 any body -> unauthorized
//     [diverges from TS: request() throws DaemonAuthError]
//   403 other, or gate-denied without a string reason -> forbidden(body)
//     [diverges from TS: request() throws DaemonAuthError]
//   404 not-found -> notFound
//     [diverges from TS: request() throws a plain DaemonRequestError(404)]
//   503 no-auth-token -> noAuthToken
//     [diverges from TS: request() throws DaemonAuthError(503)]
//   503 other -> request(503, body)
//     [diverges from TS: request() throws DaemonAuthError(503)]
//   400 settings refusal without its typed companion field -> request(400)
//     [diverges from TS: setSettings casts the body unchecked]
//   400 unknown-event on GET /v1/events/sse -> streamRefused(name)
//     [diverges from TS: the WS transport closes with 4400]
//   an unreachable daemon -> transport(URLError)
//     [diverges from TS: request() throws DaemonUnreachableError]
//   health carries no Authorization and reads no token
//     [diverges from TS: createClient sends the bearer to /v1/health]
//   WEMESSAGE_PORT above 65535 falls back to 47100
//     [diverges from TS: desktop auth.ts takes any positive parseInt]
//   a 503 no-auth-token stops as token-rejected, any other 503 retries
//     [diverges from TS: DaemonAuthError(503) stops on every 503 but source-unavailable]

/// The body of a 409, with every companion field the daemon may send.
public struct ConflictDetail: Equatable, Sendable {
  public var error: String
  public var from: String?
  public var requested: String?
  public var sentMessageGuid: String?
  public var ruleIds: [String]?
  public var id: String?
  public var attempts: Int?
  public var detail: JSONValue?

  public init(
    error: String,
    from: String? = nil,
    requested: String? = nil,
    sentMessageGuid: String? = nil,
    ruleIds: [String]? = nil,
    id: String? = nil,
    attempts: Int? = nil,
    detail: JSONValue? = nil
  ) {
    self.error = error
    self.from = from
    self.requested = requested
    self.sentMessageGuid = sentMessageGuid
    self.ruleIds = ruleIds
    self.id = id
    self.attempts = attempts
    self.detail = detail
  }

  init(error: String, body: JSONValue) {
    var ruleIds: [String]? = nil
    if let items = body["ruleIds"]?.arrayValue {
      let strings = items.compactMap(\.stringValue)
      if strings.count == items.count { ruleIds = strings }
    }
    self.init(
      error: error,
      from: body["from"]?.stringValue,
      requested: body["requested"]?.stringValue,
      sentMessageGuid: body["sentMessageGuid"]?.stringValue,
      ruleIds: ruleIds,
      id: body["id"]?.stringValue,
      attempts: body["attempts"]?.intValue,
      detail: body["detail"])
  }
}

/// The typed refusals of PATCH /v1/settings, one per TS wire variant.
public enum SettingsRefusal: Equatable, Sendable {
  case unknownKey(key: String)
  case readOnlyKey(key: String, use: String)
  case wrongType(key: String, expected: String)
  case belowFloor(key: String, floor: Double)
  case aboveCeiling(key: String, ceiling: Double)

  /// Nil unless the body is a complete refusal: the code, the key and the
  /// variant's companion field, with the companion of the right type.
  init?(body: JSONValue) {
    guard let code = body["error"]?.stringValue, let key = body["key"]?.stringValue else { return nil }
    switch code {
    case "unknown-key":
      self = .unknownKey(key: key)
    case "read-only-key":
      guard let use = body["use"]?.stringValue else { return nil }
      self = .readOnlyKey(key: key, use: use)
    case "wrong-type":
      guard let expected = body["expected"]?.stringValue, expected == "int" || expected == "bool" else {
        return nil
      }
      self = .wrongType(key: key, expected: expected)
    case "below-floor":
      guard let floor = body["floor"]?.doubleValue else { return nil }
      self = .belowFloor(key: key, floor: floor)
    case "above-ceiling":
      guard let ceiling = body["ceiling"]?.doubleValue else { return nil }
      self = .aboveCeiling(key: key, ceiling: ceiling)
    default:
      return nil
    }
  }
}

/// A refusal is an answer, not a fault: the daemon understood the request
/// and said no. Calls that can be refused return it as a result.
public enum Refusal: Equatable, Sendable {
  case conflict(code: String, from: String?, requested: String?)
  case denied(reason: String)
  case sourceUnavailable
  case unknownChat
}

/// A classified HTTP exchange: the body to decode (nil on 204), or the error.
public enum HTTPOutcome: Equatable, Sendable {
  case success(Data?)
  case failure(GatewayError)
}

public enum GatewayError: Error, Equatable, Sendable {
  case unauthorized
  case noAuthToken
  case notFound
  case unknownChat
  case sourceUnavailable
  case forbidden(body: JSONValue)
  case request(status: Int, body: JSONValue)
  case gateDenied(reason: String)
  case conflict(ConflictDetail)
  case settingsRefused(SettingsRefusal)
  case streamRefused(name: String)
  case decoding(path: String, underlying: String)
  case transport(URLError)

  /// The refusal this error carries, if it is one.
  public var refusal: Refusal? {
    switch self {
    case .conflict(let detail):
      return .conflict(code: detail.error, from: detail.from, requested: detail.requested)
    case .gateDenied(let reason):
      return .denied(reason: reason)
    case .sourceUnavailable:
      return .sourceUnavailable
    case .unknownChat:
      return .unknownChat
    default:
      return nil
    }
  }

  /// Classifies one response. Pure: no I/O, no token, no retry.
  public static func classify(status: Int, body: Data, endpoint: Endpoint) -> HTTPOutcome {
    if (200..<300).contains(status) {
      return .success(status == 204 ? nil : body)
    }
    let json = parseErrorBody(body)
    let code = json["error"]?.stringValue
    switch status {
    case 400:
      if case .setSettings = endpoint, let refusal = SettingsRefusal(body: json) {
        return .failure(.settingsRefused(refusal))
      }
      if case .events = endpoint, code == "unknown-event", let name = json["name"]?.stringValue {
        return .failure(.streamRefused(name: name))
      }
      return .failure(.request(status: 400, body: json))
    case 401:
      return .failure(.unauthorized)
    case 403:
      if code == "gate-denied", let reason = json["reason"]?.stringValue {
        return .failure(.gateDenied(reason: reason))
      }
      return .failure(.forbidden(body: json))
    case 404:
      if code == "not-found" { return .failure(.notFound) }
      if case .readThread = endpoint, code == "unknown-chat" { return .failure(.unknownChat) }
      return .failure(.request(status: 404, body: json))
    case 409:
      if let code { return .failure(.conflict(ConflictDetail(error: code, body: json))) }
      return .failure(.request(status: 409, body: json))
    case 503:
      if code == "source-unavailable" { return .failure(.sourceUnavailable) }
      if code == "no-auth-token" { return .failure(.noAuthToken) }
      return .failure(.request(status: 503, body: json))
    default:
      return .failure(.request(status: status, body: json))
    }
  }

  /// An empty body is null, JSON is parsed, anything else is kept as text.
  static func parseErrorBody(_ body: Data) -> JSONValue {
    if body.isEmpty { return .null }
    if let parsed = try? JSONValue.parse(body) { return parsed }
    return .string(String(decoding: body, as: UTF8.self))
  }

  /// Any thrown error as a GatewayError: decoding failures keep their path,
  /// URL failures are transport, anything else is an unknown transport fault.
  static func wrap(_ error: any Error) -> GatewayError {
    if let error = error as? GatewayError { return error }
    if let error = error as? DecodingError {
      return .decoding(path: error.renderedPath, underlying: error.summary)
    }
    if let error = error as? URLError { return .transport(error) }
    return .transport(URLError(.unknown))
  }
}
