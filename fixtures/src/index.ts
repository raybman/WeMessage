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

// s7 Scenario 3: the JSON Schema checker Scenario 2 wrote for the protocol
// package's own tests, relocated here so the daemon's WS/SSE parity rows can
// validate real wire bytes against the same schemas without importing across
// a package's `test/` boundary. Test-only, like everything else in here.
export { isValid, schemaErrors, type JsonSchema } from './schema-check.js';
