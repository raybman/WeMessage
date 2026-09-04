/**
 * s5-execution Scenario 6 — inbound dispatch: `rule.matched` -> `draft.request`.
 *
 * This is the first place an inbound text reaches a third party's process, so
 * the whole file is about what is NOT allowed to happen on the way there:
 *
 *  - Ingestion is never gated (§2.4.3). A rule pointing at an adapter that
 *    does not exist, is disabled, or has no token still mirrors the message
 *    and still audits `rule.matched`. The refusal is about the dispatch,
 *    never about the record.
 *  - The agent sees the SANITIZED message and nothing else (§2.4.5). Raw
 *    `Message` fields (sourceRowid, isFromMe) and the rule's internals
 *    (matcher, schedule) are ours, not theirs — and the fixture below carries
 *    a BEL and a NUL so "sanitized" is a claim the bytes can falsify.
 *  - F-45: there is no queue. An adapter that was not listening when the text
 *    arrived does not get it later; the negative at the bottom of the
 *    "unreachable" block is the pin — a reconnect delivers nothing.
 *  - F-31: exactly one winner, so exactly one frame, even when two rules and
 *    two connected adapters could each plausibly answer.
 *  - F-47: `hasDraftForMessage` is a real store read now. An edit re-matches
 *    only when no live draft is already pending for that message.
 *
 * The dispatcher is driven directly rather than through `startDaemon`: the
 * §1.8 ordering assertions need the draft harness's broadcast witness (which
 * records the audit log as it stood at each broadcast), and a composed daemon
 * would swap that witness for a race against a real scan burst.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { AuditEvent, Message, Rule } from '@wemessage/core';
import { WIRE_VERSION } from '@wemessage/protocol';
import {
  createInboundDispatch,
  sanitizeInbound,
  toGatewayEvent,
} from '@wemessage/daemon';
import {
  auditEvents,
  auditTypes,
  CHAT,
  HANDLE,
  T0,
} from './helpers/draft-harness.js';
import {
  addAdapter,
  bootAgent,
  cleanupAgentHarness,
  connectAuthed,
  waitUntil,
  type AgentHarness,
  type FakeAdapterSocket,
} from './helpers/agent-harness.js';

afterEach(cleanupAgentHarness);

/** A BEL and a NUL, so "sanitized" is falsifiable on the wire. */
const BEL = '\u0007';
const NUL = '\u0000';
const DIRTY = `tacos ${BEL}tonight${NUL}?`;
const CLEAN = 'tacos tonight?';

function ruleId(tail: string): string {
  return `${'0'.repeat(26 - tail.length)}${tail}`;
}

function makeRule(over: Partial<Rule> & { id: string }): Rule {
  return {
    name: `rule-${over.id}`,
    enabled: true,
    matcher: { kind: 'keyword', keywords: ['tacos'], mode: 'any' },
    adapterId: 'echo-1',
    respondMode: 'draft-only',
    scheduleId: null,
    outsideWindow: 'draft-only',
    allowGroupDrafts: false,
    matchAttachmentOnly: false,
    draftTtlMinutes: 45,
    priority: 100,
    createdAt: T0,
    updatedAt: T0,
    ...over,
  };
}

function inbound(over: Partial<Message> = {}): Message {
  return {
    guid: 'GUID-INBOUND-1',
    sourceRowid: 41,
    chatGuid: CHAT,
    handle: HANDLE,
    isFromMe: false,
    isGroup: false,
    service: 'iMessage',
    kind: 'text',
    text: DIRTY,
    attachments: [],
    sentAt: T0,
    receivedAt: T0,
    ...over,
  };
}

/**
 * The daemon's `deliver` in miniature: mirror, broadcast, then match. Written
 * out here rather than imported so the test states the ordering it depends on
 * instead of inheriting it.
 */
function deliverer(h: AgentHarness): (message: Message) => Promise<void> {
  const dispatch = createInboundDispatch({
    store: h.store,
    clock: h.clockCtl.clock,
    sink: h.sink,
    reader: h.reader,
    transport: {
      isConnected: (id) => h.server.agentTransport?.isConnected(id) ?? false,
      sendTo: (id, frame) =>
        h.server.agentTransport?.sendTo(id, frame) ?? false,
    },
  });
  return async (message: Message): Promise<void> => {
    h.store.insertInboundMessage(message);
    h.sink.broadcast(toGatewayEvent(message));
    await dispatch.emitWinner(message, h.store.listRules());
  };
}

function auditOf(h: AgentHarness, type: string): AuditEvent[] {
  return auditEvents(h.store).filter((e) => e.type === type);
}

interface RequestFrame {
  v: number;
  type: string;
  payload: {
    correlation: Record<string, unknown>;
    message: unknown;
    context: Array<{ from: string; text: string | null; at: string }>;
    rule: Record<string, unknown>;
    constraints: { maxChars: number; deadlineMs: number };
  };
}

function requests(sock: FakeAdapterSocket): RequestFrame[] {
  return (sock.frames as RequestFrame[]).filter(
    (f) => f.type === 'draft.request',
  );
}

/** Let every queued socket callback run before asserting a NEGATIVE. */
async function settle(): Promise<void> {
  for (let i = 0; i < 25; i += 1) await new Promise(setImmediate);
}

/** Boot + one registered, enabled, connected adapter + one matching rule. */
async function ready(
  h: AgentHarness,
  adapterId = 'echo-1',
): Promise<FakeAdapterSocket> {
  const cred = await addAdapter(h, adapterId);
  h.store.insertRule(makeRule({ id: ruleId('R1'), adapterId }));
  return connectAuthed(h, cred);
}

describe('inbound dispatch: the happy path', () => {
  it('emits exactly one draft.request, after rule.matched is durable', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    await deliverer(h)(inbound());
    await sock.waitFor(1);

    expect(requests(sock)).toHaveLength(1);
    // §1.8: the log is the record. The frame leaves only once the match is
    // durable, so a crash mid-dispatch loses the courtesy, never the record.
    expect(auditTypes(h.store)).toContain('rule.matched');
    const matched = h.broadcasts.findIndex(
      (b) => (b.frame as { event?: string }).event === 'rule.matched',
    );
    expect(matched).toBeGreaterThanOrEqual(0);
    expect(h.broadcasts[matched]?.auditAtBroadcast).toContain('rule.matched');
  });
});

describe('inbound dispatch: frame contents (sanitized)', () => {
  it('carries the sanitized message, a fresh requestId, and no draftId', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    const message = inbound();
    await deliverer(h)(message);
    await sock.waitFor(1);
    const frame = requests(sock)[0] as RequestFrame;

    expect(frame.v).toBe(WIRE_VERSION);
    const correlation = frame.payload.correlation;
    expect(correlation['requestId']).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(correlation['inboundGuid']).toBe(message.guid);
    expect(correlation['chatGuid']).toBe(CHAT);
    // exactOptionalPropertyTypes: omitted, never `undefined`-valued — JSON
    // would drop the key anyway and break round-trip equality.
    expect('draftId' in correlation).toBe(false);

    // The teeth of this file: byte-equal to the sanitizer's output, which
    // means the BEL and the NUL are gone and `untrusted` is set.
    expect(frame.payload.message).toEqual(sanitizeInbound(message));
    expect(
      (frame.payload.message as { content: { text: string } }).content.text,
    ).toBe(CLEAN);
    const wire = JSON.stringify(frame.payload);
    expect(wire).not.toContain(BEL);
    expect(wire).not.toContain('\\u0007');
    expect(wire).not.toContain('\\u0000');
    expect(wire).not.toContain('sourceRowid');

    // The agent gets the rule's identity, not its internals.
    expect(frame.payload.rule).toEqual({
      id: ruleId('R1'),
      name: `rule-${ruleId('R1')}`,
      respondMode: 'draft-only',
    });
    expect(wire).not.toContain('matcher');
    expect(wire).not.toContain('scheduleId');
    expect(frame.payload.constraints).toEqual({
      maxChars: 2000,
      deadlineMs: 60000,
    });
  });
});

describe('inbound dispatch: conversation context', () => {
  function seed(h: AgentHarness, n: number): void {
    const chatId = (
      h.fixture.db
        .prepare('SELECT ROWID AS id FROM chat WHERE chat_identifier = ?')
        .get(HANDLE) as { id: number }
    ).id;
    const handleId = (
      h.fixture.db
        .prepare('SELECT ROWID AS id FROM handle WHERE id = ?')
        .get(HANDLE) as { id: number }
    ).id;
    for (let i = 0; i < n; i += 1) {
      h.fixture.addMessage({
        chatId,
        handleId,
        text: i % 2 === 0 ? `them ${BEL}${String(i)}` : `me ${String(i)}`,
        isFromMe: i % 2 === 1,
        at: new Date(Date.parse(T0) - (n - i) * 60_000).toISOString(),
      });
    }
  }

  it('sends the last 12 turns, oldest-first, control-stripped, both sides', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    seed(h, 40);
    await deliverer(h)(inbound());
    await sock.waitFor(1);
    const context = (requests(sock)[0] as RequestFrame).payload.context;

    expect(context).toHaveLength(12);
    expect(context.map((t) => t.from)).toContain('me');
    expect(context.map((t) => t.from)).toContain('them');
    // Oldest-first: an agent reading its own history backwards answers the
    // wrong question.
    const times = context.map((t) => Date.parse(t.at));
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(JSON.stringify(context)).not.toContain('\\u0007');
    expect(context[11]?.text).toBe('me 39');
  });

  it('sends 3 turns for a 3-turn chat (limit is a ceiling, not a quota)', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    seed(h, 3);
    await deliverer(h)(inbound());
    await sock.waitFor(1);
    expect((requests(sock)[0] as RequestFrame).payload.context).toHaveLength(3);
  });
});

describe('inbound dispatch: fail-closed on the adapter row', () => {
  /**
   * Each row breaks the adapter a different way and asserts the same three
   * things: no frame, no draft, and the ingestion record intact.
   */
  const rows: Array<[string, (h: AgentHarness) => Promise<string>]> = [
    [
      'unknown adapter',
      async (h) => {
        await addAdapter(h, 'echo-1');
        // The rule points somewhere no adapter row exists — deleting the one
        // the rule references is refused by the store (adapter-referenced),
        // which is a different (S4) guarantee than this row's.
        h.store.insertRule(makeRule({ id: ruleId('R1'), adapterId: 'ghost' }));
        return 'echo-1';
      },
    ],
    [
      'disabled adapter',
      async (h) => {
        await addAdapter(h, 'echo-1');
        h.store.insertRule(makeRule({ id: ruleId('R1') }));
        const row = h.store.getAdapter('echo-1');
        if (row === null) throw new Error('fixture: adapter missing');
        h.store.updateAdapter({ ...row, enabled: false });
        return 'echo-1';
      },
    ],
    [
      'token-less adapter',
      async (h) => {
        await addAdapter(h, 'echo-1');
        h.store.insertRule(makeRule({ id: ruleId('R1') }));
        h.store.clearAdapterTokens();
        return 'echo-1';
      },
    ],
  ];

  for (const [label, setup] of rows) {
    it(`${label}: gate.denied, no frame, no draft, still ingested`, async () => {
      const h = await bootAgent();
      const cred = await addAdapter(h, 'listener');
      const sock = await connectAuthed(h, cred);
      await setup(h);
      await deliverer(h)(inbound());
      await settle();

      expect(requests(sock)).toHaveLength(0);
      expect(h.store.listDrafts()).toHaveLength(0);
      const denied = auditOf(h, 'gate.denied');
      expect(denied).toHaveLength(1);
      expect((denied[0] as { reason: string }).reason).toBe('adapter-disabled');
      // Ingestion is never gated (§2.4.3): the record survives the refusal.
      expect(auditTypes(h.store)).toContain('rule.matched');
      expect(h.store.hasInboundMessage('GUID-INBOUND-1')).toBe(true);
    });
  }
});

describe('inbound dispatch: unreachable adapter (F-45, no queue)', () => {
  it('audits adapter.unreachable and delivers nothing on reconnect', async () => {
    const h = await bootAgent();
    const cred = await addAdapter(h, 'echo-1');
    h.store.insertRule(makeRule({ id: ruleId('R1') }));
    await deliverer(h)(inbound());

    expect(h.store.listDrafts()).toHaveLength(0);
    expect(auditOf(h, 'adapter.unreachable')).toEqual([
      {
        type: 'adapter.unreachable',
        adapterId: 'echo-1',
        guid: 'GUID-INBOUND-1',
      },
    ]);

    // The pin: a queue would make this socket receive yesterday's text.
    const sock = await connectAuthed(h, cred);
    await waitUntil(() => h.store.getAdapter('echo-1')?.health === 'connected');
    await settle();
    expect(requests(sock)).toHaveLength(0);
  });
});

describe('inbound dispatch: single winner (F-31)', () => {
  it('sends one frame, to the priority winner, never both adapters', async () => {
    const h = await bootAgent();
    const winner = await addAdapter(h, 'echo-win');
    const loser = await addAdapter(h, 'echo-lose');
    h.store.insertRule(
      makeRule({ id: ruleId('R1'), adapterId: 'echo-win', priority: 1 }),
    );
    h.store.insertRule(
      makeRule({ id: ruleId('R2'), adapterId: 'echo-lose', priority: 2 }),
    );
    const winSock = await connectAuthed(h, winner);
    const loseSock = await connectAuthed(h, loser);

    await deliverer(h)(inbound());
    await winSock.waitFor(1);
    await settle();
    expect(requests(winSock)).toHaveLength(1);
    expect(requests(loseSock)).toHaveLength(0);
    expect(auditOf(h, 'rule.matched')).toHaveLength(1);
  });
});

describe('inbound dispatch: edit re-match (F-47)', () => {
  /** The draft's FKs are real: the message it answers has to be mirrored. */
  function draftFor(h: AgentHarness, guid: string): void {
    const now = h.clockCtl.clock.now();
    h.store.insertInboundMessage(inbound({ guid }));
    h.store.insertDraft({
      id: ruleId('D1'),
      inboundGuid: guid,
      chatGuid: CHAT,
      ruleId: ruleId('R1'),
      adapterId: 'echo-1',
      idempotencyKey: 'k-1',
      body: 'on it',
      originalBody: 'on it',
      state: 'pending',
      stateChangedAt: now,
      createdAt: now,
      expiresAt: new Date(Date.parse(now) + 45 * 60_000).toISOString(),
    });
  }

  it('skips an edit that already has a live pending draft', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    draftFor(h, 'GUID-INBOUND-1');
    await deliverer(h)(inbound({ kind: 'edit', text: 'tacos, actually' }));
    await settle();
    expect(requests(sock)).toHaveLength(0);
    expect(auditOf(h, 'rule.matched')).toHaveLength(0);
  });

  it('re-matches an edit whose draft was rejected', async () => {
    const h = await bootAgent();
    const sock = await ready(h);
    draftFor(h, 'GUID-INBOUND-1');
    h.store.applyDraftTransition({
      id: ruleId('D1'),
      from: 'pending',
      to: 'rejected',
      at: h.clockCtl.clock.now(),
    });
    await deliverer(h)(inbound({ kind: 'edit', text: 'tacos, actually' }));
    await sock.waitFor(1);
    expect(requests(sock)).toHaveLength(1);
  });
});
