import Foundation

/// Turns SIGTERM, SIGINT and SIGHUP into calls on a queue, so the host can pass
/// them to node instead of dying of them.
///
/// install() creates and activates one DispatchSource per signal, waits until
/// each is registered with the kernel, and only then sets the signal to SIG_IGN.
/// A registered source still sees a signal whose disposition is SIG_IGN (the
/// kernel's signal filter records every attempt to deliver it), and until the
/// sources are registered the default action is still in place, so a signal
/// that arrives that early ends a host that has not started node yet. No
/// window drops a signal.
///
/// cancel() stops delivery and leaves the three dispositions at SIG_IGN. The
/// host cancels only on its way out, after node has exited; putting the
/// default action back then would only let a late SIGTERM end the host before
/// it reports node's status. Code that needs the old dispositions back (the
/// tests) saves and restores them itself.
public final class SignalForwarder: @unchecked Sendable {
  public static let forwarded: [Int32] = [SIGTERM, SIGINT, SIGHUP]

  private let queue: DispatchQueue
  private let lock = NSLock()
  private var sources: [any DispatchSourceSignal] = []

  public init(queue: DispatchQueue = DispatchQueue(label: "sh.wemessage.gateway.host.signals")) {
    self.queue = queue
  }

  /// Installs SIG_IGN + DispatchSource for each forwarded signal and calls `deliver` on the queue.
  /// Returns once the sources are registered (at most 5 s), so a signal sent after it returns is
  /// delivered. A second install before cancel() does nothing. Never call it on the forwarder's
  /// own queue: registration is reported on that queue.
  public func install(deliver: @escaping @Sendable (Int32) -> Void) {
    lock.lock()
    defer { lock.unlock() }
    guard sources.isEmpty else { return }
    let registered = DispatchGroup()
    for sig in Self.forwarded {
      let source = DispatchSource.makeSignalSource(signal: sig, queue: queue)
      source.setEventHandler { deliver(sig) }
      registered.enter()
      source.setRegistrationHandler { registered.leave() }
      source.activate()
      sources.append(source)
    }
    _ = registered.wait(timeout: .now() + 5)
    for sig in Self.forwarded { signal(sig, SIG_IGN) }
  }

  /// Stops delivery. The dispositions stay SIG_IGN; see the type's comment.
  public func cancel() {
    lock.lock()
    let active = sources
    sources = []
    lock.unlock()
    for source in active { source.cancel() }
  }
}
