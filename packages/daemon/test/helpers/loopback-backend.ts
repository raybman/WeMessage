/**
 * Test-only `SendBackend` (s3-execution Scenario 8, Part 3 fixture extension;
 * Fable design consult Q4). Kept entirely under test/ (never imported from
 * any packages/<pkg>/src, per the no-fixtures-in-prod-path cruiser rule) so the
 * checkpoint spec can exercise `dispatchApproved`'s full verify-poll loop
 * with zero AppleScript: `send()` writes a real is_from_me=1 row into the
 * fixture chat.db via `appendOutbound`, which `reader.findOutboundMessage`
 * (the real ingest SQL, unmocked) then discovers exactly as it would a live
 * Messages send. This proves the verify half of dispatchApproved for real,
 * not via a stub that always says "verified."
 *
 * `sabotage()` flips to "accept but never write" — the row 2 unverified-
 * timeout case: the backend still reports `{ accepted: true }` (Messages.app
 * genuinely can accept a send that never lands, e.g. a stalled delivery), but
 * no outbound row appears, so `findOutboundMessage` polls out its full
 * VERIFY_BUDGET_MS budget and returns null every time.
 */
import type { ChatDbFixture } from '@wemessage/fixtures';
import type {
  ChatDbReader,
  Clock,
  SendBackend,
  SendInput,
  SendOutcome,
} from '@wemessage/core';

export interface LoopbackSendBackend extends SendBackend {
  /** Total `send()` invocations so far (checkpoint rows 3/4 assert 0). */
  callCount(): number;
  /** All inputs `send()` was called with, in call order. */
  calls(): SendInput[];
  /** After calling this, `send()` still accepts but stops writing rows. */
  sabotage(): void;
}

export function createLoopbackSendBackend(
  fixture: ChatDbFixture,
  clock: Clock,
): LoopbackSendBackend {
  const seen: SendInput[] = [];
  let sabotaged = false;

  return {
    isAvailable: () => Promise.resolve(true),
    send(input: SendInput): Promise<SendOutcome> {
      seen.push(input);
      if (!sabotaged) {
        fixture.appendOutbound({
          chatGuid: input.chatGuid,
          text: input.body,
          atIso: clock.now(),
        });
      }
      return Promise.resolve({ accepted: true });
    },
    callCount: () => seen.length,
    calls: () => [...seen],
    sabotage: () => {
      sabotaged = true;
    },
  };
}

/**
 * `StartDaemonOptions.backend` became REQUIRED in Scenario 8 (mirroring the
 * `doctorProbes` precedent from Scenario 7: no production default is safe,
 * so every call site — including every pre-existing test that never
 * exercises `POST /v1/send` — must pass something explicit). This is that
 * something: a fake that throws the moment it is touched, so any test using
 * it that accidentally starts exercising send gets a loud, immediate failure
 * instead of a silently-wrong pass.
 */
export function createUnusedSendBackend(): SendBackend {
  const boom = (): never => {
    throw new Error(
      'SendBackend must not be called: this test does not exercise POST /v1/send',
    );
  };
  return { isAvailable: boom, send: boom };
}

/**
 * Companion to `createUnusedSendBackend`: a `ChatDbReader` for tests that
 * must supply `DaemonOptions.send` (e.g. to reach `GET /v1/doctor` via
 * `buildServer`) but never exercise `POST /v1/send`'s `dispatchApproved`
 * call, so no real fixture chat.db is worth opening.
 */
export function createUnusedChatDbReader(): ChatDbReader {
  const boom = (): never => {
    throw new Error(
      'ChatDbReader must not be called: this test does not exercise POST /v1/send',
    );
  };
  return {
    readSince: boom,
    readMutatedSince: boom,
    resolveChat: boom,
    findOutboundMessage: boom,
  };
}
