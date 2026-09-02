// @wemessage/fixtures — fixture chat.db builder + typedstream corpus (Part 3).
// Test-only library; never ships (§2.1).
export {
  createChatDb,
  appleEpochNs,
  APPLE_EPOCH_OFFSET_SECONDS,
  type ChatDbFixture,
  type AddMessageOptions,
  type MessageRef,
  type AttachmentOptions,
} from './chatdb-builder.js';
