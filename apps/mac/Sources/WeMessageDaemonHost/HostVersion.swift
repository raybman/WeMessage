import Foundation

/// The version the host hands node as WEMESSAGE_HOST_VERSION.
public enum HostVersion {
  /// CFBundleShortVersionString of Bundle.main, else "0.0.0-dev" (unbundled runs in CI/tests).
  public static func current(bundle: Bundle = .main) -> String {
    guard
      let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
      !version.isEmpty
    else { return "0.0.0-dev" }
    return version
  }
}
