import AppKit
import Foundation
import WeMessageKit

// v2 B2, board 05.E: remote images. Nothing here runs until a human presses
// Load images on one message (D-UI-154, D-UI-159): the card asks for a
// fetch only while EmailDesk.isRevealed says so. The fetch is a bare GET on
// an ephemeral session: no cookies, no cache on disk, no bearer, nothing of
// the daemon's. Under the UI-test flag the request goes to the fake
// daemon's /remote-image/ path instead of the Internet, so the journal can
// prove the zero-request default and the one reveal.

@MainActor
enum RemoteImageLoader {
  /// Where a fixture image is fetched from: the fake daemon under the
  /// flag, the image's own address otherwise. Nil for anything that is not
  /// http or https.
  static func address(_ image: EmailImage, uiTest: Bool = TestHooks.isUITest) -> URL? {
    guard let url = URL(string: image.url), let scheme = url.scheme?.lowercased(),
      scheme == "https" || scheme == "http"
    else { return nil }
    guard uiTest else { return url }
    return ClientConfig().baseURL.appendingPathComponent("remote-image").appendingPathComponent(url.lastPathComponent)
  }

  /// One image, or nil when it did not arrive or is not an image.
  static func fetch(_ image: EmailImage) async -> NSImage? {
    guard let url = address(image) else { return nil }
    let config = URLSessionConfiguration.ephemeral
    config.httpCookieStorage = nil
    config.httpShouldSetCookies = false
    config.urlCache = nil
    config.timeoutIntervalForRequest = 10
    let session = URLSession(configuration: config)
    defer { session.finishTasksAndInvalidate() }
    guard let (data, response) = try? await session.data(from: url),
      let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode)
    else { return nil }
    return NSImage(data: data)
  }
}
