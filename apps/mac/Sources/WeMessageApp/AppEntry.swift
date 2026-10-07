import Foundation

/// The window's way in. main.swift calls this only after it has decided the
/// process is not `--daemon`, so the launchd path never reaches the UI.
public enum AppEntry {
  @MainActor
  public static func run(environment: [String: String]) -> Never {
    TestHooks.install(from: environment)
    ShellApp.main()
    // ShellApp.main() does not return in practice; this satisfies Never.
    exit(0)
  }
}
