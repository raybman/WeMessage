import Foundation
import Testing
@testable import WeMessageKit

/// R5: where the bearer comes from, and that it never leaks out again.
@Suite("TokenSource")
struct TokenSourceTests {
  static let a = TestTokens.make("a")
  static let b = TestTokens.make("b")

  @Test("WEMESSAGE_TOKEN wins over the file")
  func envWins() throws {
    let file = FakeTokenFile([Self.b])
    let token = try #require(file.source(env: ["WEMESSAGE_TOKEN": Self.a]).resolve())
    #expect(token.headerValue == "Bearer " + Self.a)
    #expect(file.reads == 0, "the file was read although the environment named a token")

    let malformed = FakeTokenFile([Self.b])
    #expect(malformed.source(env: ["WEMESSAGE_TOKEN": "garbage"]).resolve() == nil)
    #expect(malformed.reads == 0, "a malformed WEMESSAGE_TOKEN fell back to the file")
  }

  @Test("WEMESSAGE_DIR overrides ~/Library/Application Support/WeMessage")
  func dirOverride() throws {
    let file = FakeTokenFile([Self.a])
    let source = file.source(env: ["WEMESSAGE_DIR": "/var/empty/wemessage-config"])
    #expect(source.configDir.path == "/var/empty/wemessage-config")
    #expect(source.tokenFile.path == "/var/empty/wemessage-config/daemon.token")
    let token = try #require(source.resolve())
    #expect(token.headerValue == "Bearer " + Self.a)
    #expect(file.urls.map(\.path) == ["/var/empty/wemessage-config/daemon.token"])

    let fallback = FakeTokenFile([Self.a]).source()
    #expect(fallback.configDir.path == FakeTokenFile.home.path + "/Library/Application Support/WeMessage")
    #expect(fallback.tokenFile.lastPathComponent == Defaults.tokenFile)
  }

  @Test("no env and no file -> nil, never throws")
  func nothing() {
    #expect(FakeTokenFile([nil]).source().resolve() == nil)
    struct Unreadable: Error {}
    let throwing = TokenSource(environment: [:], home: FakeTokenFile.home, read: { _ in throw Unreadable() })
    #expect(throwing.resolve() == nil)
    #expect(FakeTokenFile(["not a token"]).source().resolve() == nil)
    #expect(FakeTokenFile([""]).source().resolve() == nil)

    let missing = "/var/empty/wemessage-missing-" + UUID().uuidString
    let real = TokenSource(environment: ["WEMESSAGE_DIR": missing], home: FakeTokenFile.home)
    #expect(real.resolve() == nil)
  }

  @Test("BearerToken.description and debugDescription are \"wm_[redacted]\"")
  func redaction() throws {
    let raw = Self.a
    let hex = String(raw.dropFirst(3))
    let token = try #require(BearerToken(raw: raw))
    #expect(token.description == "wm_[redacted]")
    #expect(token.debugDescription == "wm_[redacted]")
    #expect("\(token)" == "wm_[redacted]")
    #expect(String(reflecting: token) == "wm_[redacted]")
    #expect(Mirror(reflecting: token).children.isEmpty)
    var dumped = ""
    dump(token, to: &dumped)
    #expect(!dumped.contains(hex), "dump leaked the token")
    #expect(token.headerValue == "Bearer " + raw, "headerValue is the one accessor that reveals it")
  }

  @Test("token never appears in any Encodable output (encode the client's config and grep)")
  func encodable() throws {
    let raw = Self.a
    let hex = String(raw.dropFirst(3))
    let config = ClientConfig(environment: ["WEMESSAGE_TOKEN": raw, "WEMESSAGE_PORT": "47123"])
    let token = try #require(BearerToken(raw: raw))
    #expect(config.token == token, "the config pins the environment's token")

    let plist = PropertyListEncoder()
    plist.outputFormat = .xml
    let json = String(decoding: try JSONEncoder().encode(config), as: UTF8.self)
    var dumped = ""
    dump(config, to: &dumped)
    let outputs = [
      json,
      String(decoding: try JSONEncoder().encode(token), as: UTF8.self),
      String(decoding: try JSONEncoder().encode([token]), as: UTF8.self),
      String(decoding: try plist.encode(config), as: UTF8.self),
      String(describing: config),
      String(reflecting: config),
      dumped,
    ]
    for output in outputs {
      #expect(!output.contains(hex), "the raw token leaked: \(output)")
    }
    #expect(json.contains("wm_[redacted]"))
    #expect(json.contains("47123"))
  }

  @Test("BearerToken(raw:) trims whitespace and newlines before validating")
  func trims() throws {
    let raw = Self.a
    for wrapped in [raw + "\n", raw + "\r\n", "  " + raw + "\t\n", "\n" + raw, " " + raw + " "] {
      let token = try #require(BearerToken(raw: wrapped), "\(wrapped.count) characters")
      #expect(token.headerValue == "Bearer " + raw)
    }
    #expect(FakeTokenFile([raw + "\n"]).source().resolve()?.headerValue == "Bearer " + raw)
    #expect(FakeTokenFile([raw + "\n"]).source(env: ["WEMESSAGE_TOKEN": raw + "\n"]).resolve()?.headerValue == "Bearer " + raw)
  }

  @Test("BearerToken(raw:) refuses anything but wm_ and 64 lowercase hex")
  func rejects() {
    let a64 = String(repeating: "a", count: 64)
    let bad = [
      "wm_", "", "   ", a64,
      "wm_" + String(repeating: "a", count: 63),
      "wm_" + String(repeating: "a", count: 65),
      "wm_" + String(repeating: "g", count: 64),
      "xx_" + a64, "WM_" + a64,
      "wm_" + String(repeating: "A", count: 64),
      "wm_" + String(repeating: "a", count: 32) + " " + String(repeating: "a", count: 31),
    ]
    for text in bad {
      #expect(BearerToken(raw: text) == nil, "accepted \(text.count) characters")
    }
  }

  @Test("AdapterCredential.description redacts the token")
  func adapterCredential() throws {
    let fixture = try Fixtures.response("adapters.create")
    let credential = try JSONDecoder().decode(AdapterCredential.self, from: fixture.bodyData)
    let token = try #require(fixture.body["token"]?.stringValue)
    #expect(credential.token == token, "the raw token stays readable for the one-time reveal")
    var dumped = ""
    dump(credential, to: &dumped)
    for text in [credential.description, credential.debugDescription, "\(credential)", String(reflecting: credential), dumped] {
      #expect(!text.contains(token), "leaked: \(text)")
    }
    #expect(credential.description.contains("wm_[redacted]"))
  }
}
