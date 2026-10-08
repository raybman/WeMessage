import Foundation

// v2 S4k, board 15.B: the four walls, dated. Three of the four are not
// queryable, so each one is a config row with the day it was last checked
// and the thing that imposed it. A change to a wall is an edit to this
// JSON, never to a send routine. Every row needs an asOf: a row without one
// does not decode (SizeWallTests).

extension SizeWallTable {
  /// The dated wall config. Bytes are decimal (1 MB = 1,000,000 bytes, as
  /// Finder counts); encodingOverhead is the wire factor (base64 on email).
  public static let config = """
    {
      "walls": [
        {
          "channel": "imessage",
          "bytes": 100000000,
          "basis": "perItem",
          "assumed": true,
          "asOf": "2026-09-22",
          "source": "Apple's own figure. Not queryable: AppleScript reports nothing and there is no API.",
          "encodingOverhead": 1.0
        },
        {
          "channel": "whatsapp",
          "bytes": 16000000,
          "basis": "perItem",
          "assumed": false,
          "asOf": "2026-09-22",
          "source": "Bridge constant, not a server answer. 2 GB as a document.",
          "encodingOverhead": 1.0
        },
        {
          "channel": "linkedin",
          "bytes": 20000000,
          "basis": "perItem",
          "assumed": true,
          "asOf": "2026-09-22",
          "source": "Published nowhere we trust. Derived by probe.",
          "encodingOverhead": 1.0
        },
        {
          "channel": "email",
          "bytes": 25000000,
          "basis": "perMessage",
          "assumed": false,
          "asOf": "2026-09-22",
          "source": "Per account: Gmail and Graph publish it, SMTP advertises SIZE, otherwise 20 MB.",
          "encodingOverhead": 1.37
        }
      ]
    }
    """
}
