import Foundation
import WeMessageKit

/// v2 B0, board 03: the WhatsApp board's words. Pure: the same availability
/// always gives the same board. B0 draws the banner and the empty state;
/// B1 adds the thread list and the linked device from a thread's meta.
struct WhatsAppBoardModel: Equatable, Sendable {
  /// The channel banner's line (D-UI-135).
  let banner: String
  /// The empty state's headline and its one line (D-UI-135).
  let headline: String
  let detail: String
  /// The chip at the banner's trailing edge (D-UI-132). Only a board drawn
  /// over fixtures carries one; a connected board never does.
  let chip: String?

  /// The board for a channel's availability, or nil when there is none to
  /// draw: a channel not connected keeps the not-connected zero.
  static func make(
    _ availability: ChannelAvailability?, linkedDevice: String? = nil, chipText: String
  ) -> WhatsAppBoardModel? {
    let chip: String?
    switch availability {
    case .connected: chip = nil
    case .preview: chip = chipText
    case .notConnected, nil: return nil
    }
    return WhatsAppBoardModel(
      banner: banner(linkedDevice: linkedDevice), headline: ProvisionalUI.whatsAppEmptyHeadline,
      detail: ProvisionalUI.whatsAppEmptyDetail, chip: chip)
  }

  /// The banner names the channel, then the linked device when one is known.
  static func banner(linkedDevice: String?) -> String {
    guard let device = linkedDevice, !device.isEmpty else { return ProvisionalUI.whatsAppBannerName }
    return ProvisionalUI.whatsAppBannerName + " " + ProvisionalUI.whatsAppLinkedDeviceLabel + ": " + device + "."
  }
}
