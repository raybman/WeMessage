import Foundation

/// Where the bearer comes from, in the desktop app's order: WEMESSAGE_TOKEN
/// when set, else `<config dir>/daemon.token`, where the config dir is
/// WEMESSAGE_DIR or ~/Library/Application Support/WeMessage.
///
/// `resolve()` never throws: a missing, unreadable or malformed token is nil.
/// A malformed WEMESSAGE_TOKEN is nil too, with no fallback to the file, so a
/// typo in the environment cannot quietly authenticate as someone else. An
/// empty WEMESSAGE_TOKEN or WEMESSAGE_DIR counts as unset, as it does in the
/// desktop app's JavaScript.
public struct TokenSource: Sendable {
  public typealias Reader = @Sendable (URL) throws -> Data?

  public let environment: [String: String]
  public let home: URL
  private let read: Reader

  /// A source over an injected reader (the tests' fake file).
  public init(environment: [String: String], home: URL, read: @escaping Reader) {
    self.environment = environment
    self.home = home
    self.read = read
  }

  /// A source over the real file system.
  public init(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    home: URL = FileManager.default.homeDirectoryForCurrentUser
  ) {
    self.init(environment: environment, home: home, read: { url in try Data(contentsOf: url) })
  }

  /// WEMESSAGE_DIR, else ~/Library/Application Support/WeMessage.
  public var configDir: URL {
    if let dir = environment["WEMESSAGE_DIR"], !dir.isEmpty {
      return URL(filePath: dir, directoryHint: .isDirectory)
    }
    return home.appending(path: "Library/Application Support/WeMessage", directoryHint: .isDirectory)
  }

  /// `<config dir>/daemon.token`.
  public var tokenFile: URL {
    configDir.appending(path: Defaults.tokenFile, directoryHint: .notDirectory)
  }

  /// The current token, read fresh on every call.
  public func resolve() -> BearerToken? {
    if let fromEnvironment = environment["WEMESSAGE_TOKEN"], !fromEnvironment.isEmpty {
      return BearerToken(raw: fromEnvironment)
    }
    guard let data = try? read(tokenFile), let text = String(bytes: data, encoding: .utf8) else {
      return nil
    }
    return BearerToken(raw: text)
  }
}
