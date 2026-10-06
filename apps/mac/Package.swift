// swift-tools-version: 6.2
//
// WeMessageKit: the Foundation-only client for the WeMessage daemon (v2 S1).
//
// Zero package dependencies, by rule (test/arch.spec.ts, "v2 S1: the Swift
// tree"). The kit speaks the S0 contract in fixtures/contract and nothing else.
// Language mode 6 with the default (nonisolated) actor isolation: the kit is a
// library, so it does not opt its types into the main actor; the app target
// that lands in a later slice chooses its own isolation.
import PackageDescription

let package = Package(
  name: "WeMessage",
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "WeMessageKit", targets: ["WeMessageKit"])
  ],
  targets: [
    .target(
      name: "WeMessageKit",
      path: "Sources/WeMessageKit"
    ),
    .testTarget(
      name: "WeMessageKitTests",
      dependencies: ["WeMessageKit"],
      path: "Tests/WeMessageKitTests"
    ),
  ],
  swiftLanguageModes: [.v6]
)
