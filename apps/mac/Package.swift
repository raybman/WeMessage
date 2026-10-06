// swift-tools-version: 6.2
//
// WeMessageKit: the Foundation-only client for the WeMessage daemon (v2 S1).
// WeMessageDaemonHost and the WeMessage executable: `WeMessage --daemon`, the
// Foundation-only host that launchd runs and that posix_spawns the bundled
// Node daemon as its child (v2 S2).
//
// Zero package dependencies, by rule (test/arch.spec.ts, "v2 S1: the Swift
// tree"). The kit speaks the S0 contract in fixtures/contract and nothing else.
// Language mode 6 with the default (nonisolated) actor isolation: the kit and
// the host are libraries, so they do not opt their types into the main actor;
// the app target that lands in a later slice chooses its own isolation.
import PackageDescription

let package = Package(
  name: "WeMessage",
  platforms: [.macOS(.v26)],
  products: [
    .library(name: "WeMessageKit", targets: ["WeMessageKit"]),
    .library(name: "WeMessageDaemonHost", targets: ["WeMessageDaemonHost"]),
    .executable(name: "WeMessage", targets: ["WeMessage"]),
  ],
  targets: [
    .target(
      name: "WeMessageKit",
      path: "Sources/WeMessageKit"
    ),
    // Debug only: lets a bare debug exe run a stub node named in its
    // environment (HostLayout.override). A release build compiles no code
    // that reads those keys, and ci-swift checks the release binary for them.
    .target(
      name: "WeMessageDaemonHost",
      path: "Sources/WeMessageDaemonHost",
      swiftSettings: [.define("WEMESSAGE_HOST_OVERRIDES", .when(configuration: .debug))]
    ),
    .executableTarget(
      name: "WeMessage",
      dependencies: ["WeMessageDaemonHost"],
      path: "Sources/WeMessage"
    ),
    .testTarget(
      name: "WeMessageKitTests",
      dependencies: ["WeMessageKit"],
      path: "Tests/WeMessageKitTests"
    ),
    .testTarget(
      name: "WeMessageDaemonHostTests",
      dependencies: ["WeMessageDaemonHost"],
      path: "Tests/WeMessageDaemonHostTests"
    ),
  ],
  swiftLanguageModes: [.v6]
)
