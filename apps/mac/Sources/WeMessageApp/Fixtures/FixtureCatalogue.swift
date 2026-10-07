import Foundation
import WeMessageKit

/// Board 08's specimens, for the specimen sheet the UI tests open with
/// WEMESSAGE_UI_BOARD=08 (plan S4e). The turns are fixtures/atlas's golden,
/// embedded byte for byte because the package carries no resources
/// (AppHygiene's catalogue row decodes both and holds them equal). The
/// draft and the thread are what 08.H draws around h1, as the daemon would
/// serve them. Named only here and in TestHooks (H-S4-1).
enum FixtureCatalogue {
  /// The sheet's content: every section of the golden, 08.H's draft and its
  /// thread, and the moment the sheet is drawn as of.
  static func specimens() throws -> SpecimenContent {
    let decoder = JSONDecoder()
    let golden = try decoder.decode(AtlasGolden.self, from: Data(atlasGolden.utf8))
    let draft = try decoder.decode(DraftPayload.self, from: Data(draftJSON.utf8))
    let thread = try decoder.decode(ThreadSummary.self, from: Data(threadJSON.utf8))
    guard let asOf = WireDate.parse("2026-09-01T12:00:00.000Z") else {
      throw CocoaError(.coderInvalidValue)
    }
    return SpecimenContent(golden: golden, draft: draft, thread: thread, asOf: asOf)
  }

  /// 08.H's pending draft, replying to atlas-h1.
  static let draftJSON = #"""
    {
      "id": "draft-atlas-h1",
      "inboundGuid": "atlas-h1",
      "chatGuid": "iMessage;-;+15550100004",
      "ruleId": "reschedule",
      "adapterId": "sol",
      "idempotencyKey": "atlas-h1-reschedule",
      "body": "Friday works. Same time, 2pm?",
      "originalBody": "Friday works. Same time, 2pm?",
      "state": "pending",
      "stateChangedAt": "2026-09-01T09:42:00.000Z",
      "expiresAt": "2026-09-01T10:41:00.000Z",
      "createdAt": "2026-09-01T09:42:00.000Z"
    }
    """#

  /// The one-to-one thread 08.H's draft sits in.
  static let threadJSON = #"""
    {
      "chatGuid": "iMessage;-;+15550100004",
      "channel": "imessage",
      "title": "Priya",
      "isGroup": false,
      "lastLine": "Can you do Friday instead?",
      "lastFromMe": false,
      "lastAt": "2026-09-01T09:41:00.000Z"
    }
    """#

  /// fixtures/atlas/threads.messages.atlas.json, verbatim.
  static let atlasGolden = #"""
    {
      "sections": [
        {
          "slug": "anatomy",
          "title": "Bubble anatomy, direction, and grouping",
          "turns": [
            {
              "guid": "atlas-a1",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Hey, are we still on for Thursday?",
              "sentAt": "2026-09-01T09:41:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-a2",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "I can move things if not",
              "sentAt": "2026-09-01T09:41:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-a3",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Thursday works. 2pm?",
              "sentAt": "2026-09-01T09:43:00.000Z",
              "delivery": {
                "state": "sent",
                "at": "2026-09-01T09:43:00.000Z"
              }
            },
            {
              "guid": "atlas-a4",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "I'll send the address",
              "sentAt": "2026-09-01T09:43:00.000Z",
              "delivery": {
                "state": "delivered"
              }
            },
            {
              "guid": "atlas-a5",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Perfect",
              "sentAt": "2026-09-01T09:44:00.000Z",
              "handle": "+15550100004"
            }
          ]
        },
        {
          "slug": "text",
          "title": "Text variants",
          "turns": [
            {
              "guid": "atlas-b1",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Running about ten minutes behind, sorry.",
              "sentAt": "2026-09-01T09:45:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-b2",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "I read through the whole proposal last night and I think the second option is stronger, mostly because it does not depend on the vendor shipping anything new.",
              "sentAt": "2026-09-01T09:45:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-b3",
              "direction": "outbound",
              "kind": {
                "type": "emojiOnly"
              },
              "text": "♥︎",
              "sentAt": "2026-09-01T09:46:00.000Z"
            },
            {
              "guid": "atlas-b4",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "@Jordan can you take this one?",
              "sentAt": "2026-09-01T09:46:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-b5",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Gate 4 opens at 6.",
              "sentAt": "2026-09-01T09:46:00.000Z",
              "handle": "+15550100004",
              "isForwarded": true
            },
            {
              "guid": "atlas-b6",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Yes, 2pm.",
              "sentAt": "2026-09-01T09:47:00.000Z",
              "quote": "Are we still on for Thursday?"
            },
            {
              "guid": "atlas-b7",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Make that 2:30",
              "sentAt": "2026-09-01T09:47:00.000Z",
              "isEdited": true
            },
            {
              "guid": "atlas-b8",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "sentAt": "2026-09-01T09:48:00.000Z",
              "isUnsent": true
            }
          ]
        },
        {
          "slug": "reactions",
          "title": "Reactions: the gap is on the send side",
          "turns": [
            {
              "guid": "atlas-c1",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Booked it",
              "sentAt": "2026-09-01T09:50:00.000Z",
              "handle": "+15550100004",
              "reactions": [
                {
                  "glyph": "♥︎",
                  "count": 1
                },
                {
                  "glyph": "‼︎",
                  "count": 2
                },
                {
                  "glyph": "☺︎",
                  "count": 1
                }
              ]
            },
            {
              "guid": "atlas-c2",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Landed ✈︎",
              "sentAt": "2026-09-01T09:51:00.000Z",
              "handle": "+15550100004",
              "reactions": [
                {
                  "glyph": "★︎",
                  "count": 3
                },
                {
                  "glyph": "✔︎",
                  "count": 1
                }
              ]
            },
            {
              "guid": "atlas-c3",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Can you do Friday?",
              "sentAt": "2026-09-01T09:52:00.000Z"
            }
          ]
        },
        {
          "slug": "media",
          "title": "Images, albums, video",
          "turns": [
            {
              "guid": "atlas-d1",
              "direction": "inbound",
              "kind": {
                "type": "media",
                "items": [
                  {
                    "name": "IMG_0412.heic",
                    "mime": "image/heic",
                    "width": 3024,
                    "height": 4032
                  }
                ]
              },
              "sentAt": "2026-09-01T10:01:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-d2",
              "direction": "inbound",
              "kind": {
                "type": "media",
                "items": [
                  {
                    "name": "1.jpg",
                    "mime": "image/jpeg"
                  },
                  {
                    "name": "2.jpg",
                    "mime": "image/jpeg"
                  }
                ]
              },
              "sentAt": "2026-09-01T10:02:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-d3",
              "direction": "inbound",
              "kind": {
                "type": "media",
                "items": [
                  {
                    "name": "1.jpg",
                    "mime": "image/jpeg"
                  },
                  {
                    "name": "2.jpg",
                    "mime": "image/jpeg"
                  },
                  {
                    "name": "3.jpg",
                    "mime": "image/jpeg"
                  },
                  {
                    "name": "4.jpg",
                    "mime": "image/jpeg"
                  },
                  {
                    "name": "5.jpg",
                    "mime": "image/jpeg"
                  }
                ]
              },
              "sentAt": "2026-09-01T10:02:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-d4",
              "direction": "inbound",
              "kind": {
                "type": "media",
                "items": [
                  {
                    "name": "clip.mov",
                    "mime": "video/quicktime",
                    "seconds": 42
                  }
                ]
              },
              "sentAt": "2026-09-01T10:03:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-d5",
              "direction": "outbound",
              "kind": {
                "type": "media",
                "items": [
                  {
                    "name": "room.jpg",
                    "mime": "image/jpeg"
                  }
                ]
              },
              "text": "The view from the room",
              "sentAt": "2026-09-01T10:04:00.000Z"
            }
          ]
        },
        {
          "slug": "voice",
          "title": "Voice notes, transcript first",
          "turns": [
            {
              "guid": "atlas-e1",
              "direction": "inbound",
              "kind": {
                "type": "voice",
                "transcript": "Hey, quick one. The Thursday thing moved to Friday because the venue double booked. Let me know if that breaks anything on your end and I will figure something out. Also the parking garage on Third closes at nine, so the lot behind the venue is the better bet, and bring the badge from last time because they still check at the side door.",
                "seconds": 34
              },
              "sentAt": "2026-09-01T10:10:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-e2",
              "direction": "outbound",
              "kind": {
                "type": "voice",
                "transcript": "Friday is fine, see you there.",
                "seconds": 19
              },
              "sentAt": "2026-09-01T10:12:00.000Z"
            }
          ]
        },
        {
          "slug": "payloads",
          "title": "Files, links, and structured payloads",
          "turns": [
            {
              "guid": "atlas-f1",
              "direction": "inbound",
              "kind": {
                "type": "file",
                "file": {
                  "name": "Q3-terms-v4.pdf",
                  "mime": "application/pdf",
                  "bytes": 2400000
                }
              },
              "sentAt": "2026-09-01T10:20:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f2",
              "direction": "inbound",
              "kind": {
                "type": "file",
                "file": {
                  "name": "assets.zip",
                  "mime": "application/zip",
                  "bytes": 64000000,
                  "received": 18200000
                }
              },
              "sentAt": "2026-09-01T10:20:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f3",
              "direction": "inbound",
              "kind": {
                "type": "file",
                "file": {
                  "name": "photo.jpg",
                  "mime": "image/jpeg",
                  "expired": true
                }
              },
              "sentAt": "2026-09-01T10:21:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f4",
              "direction": "inbound",
              "kind": {
                "type": "link",
                "link": {
                  "title": "The unified inbox nobody finished",
                  "host": "example.com"
                }
              },
              "sentAt": "2026-09-01T10:22:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f5",
              "direction": "inbound",
              "kind": {
                "type": "location",
                "address": "1 Ferry Building, SF"
              },
              "sentAt": "2026-09-01T10:22:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f6",
              "direction": "inbound",
              "kind": {
                "type": "contactCard",
                "card": {
                  "name": "Jordan Lee",
                  "handle": "+15550100142"
                }
              },
              "sentAt": "2026-09-01T10:23:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f7",
              "direction": "inbound",
              "kind": {
                "type": "poll",
                "poll": {
                  "question": "Dinner Thursday?",
                  "options": [
                    {
                      "title": "Italian",
                      "votes": 4
                    },
                    {
                      "title": "Thai",
                      "votes": 3
                    }
                  ]
                }
              },
              "sentAt": "2026-09-01T10:24:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-f8",
              "direction": "inbound",
              "kind": {
                "type": "unsupported",
                "name": "View-once photo"
              },
              "sentAt": "2026-09-01T10:25:00.000Z",
              "handle": "+15550100004"
            }
          ]
        },
        {
          "slug": "delivery",
          "title": "System messages and delivery states",
          "turns": [
            {
              "guid": "atlas-g1",
              "direction": "inbound",
              "kind": {
                "type": "system"
              },
              "text": "You changed the group name to “Thursday Crew”",
              "sentAt": "2026-09-01T10:30:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-g2",
              "direction": "inbound",
              "kind": {
                "type": "system"
              },
              "text": "Jordan joined the conversation",
              "sentAt": "2026-09-01T10:31:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-g3",
              "direction": "inbound",
              "kind": {
                "type": "system"
              },
              "text": "Missed call from Jordan · 11:04 AM",
              "sentAt": "2026-09-01T10:32:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-g4",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Morning",
              "sentAt": "2026-09-01T10:33:00.000Z",
              "handle": "+15550100004"
            },
            {
              "guid": "atlas-g5",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Sending",
              "sentAt": "2026-09-01T10:34:00.000Z",
              "delivery": {
                "state": "sending"
              }
            },
            {
              "guid": "atlas-g6",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Sent",
              "sentAt": "2026-09-01T10:34:00.000Z",
              "delivery": {
                "state": "sent",
                "at": "2026-09-01T09:51:00.000Z"
              }
            },
            {
              "guid": "atlas-g7",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Delivered",
              "sentAt": "2026-09-01T10:35:00.000Z",
              "delivery": {
                "state": "delivered"
              }
            },
            {
              "guid": "atlas-g8",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Read",
              "sentAt": "2026-09-01T10:35:00.000Z",
              "delivery": {
                "state": "read",
                "at": "2026-09-01T09:53:00.000Z"
              }
            },
            {
              "guid": "atlas-g9",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Not delivered",
              "sentAt": "2026-09-01T10:36:00.000Z",
              "delivery": {
                "state": "notDelivered",
                "reason": "Not registered with iMessage"
              }
            }
          ]
        },
        {
          "slug": "draft",
          "title": "The agent draft",
          "turns": [
            {
              "guid": "atlas-h1",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Can you do Friday instead?",
              "sentAt": "2026-09-01T09:41:00.000Z",
              "handle": "+15550100004"
            }
          ]
        },
        {
          "slug": "native",
          "title": "Channel-native types that resist unification",
          "turns": [
            {
              "guid": "atlas-i1",
              "direction": "outbound",
              "kind": {
                "type": "text"
              },
              "text": "Sent as text message",
              "sentAt": "2026-09-01T11:00:00.000Z",
              "service": "sms"
            },
            {
              "guid": "atlas-i2",
              "direction": "inbound",
              "kind": {
                "type": "text"
              },
              "text": "Happy birthday!",
              "sentAt": "2026-09-01T11:01:00.000Z",
              "handle": "+15550100004",
              "effect": "Fireworks"
            }
          ]
        },
        {
          "slug": "coverage",
          "title": "Coverage matrix",
          "turns": []
        }
      ]
    }
    """#
}
