/**
 * s7-execution Scenario 12 — the PROTOCOL.md renderer.
 *
 * A pure function from the protocol's own tables to Markdown, plus the one
 * impure reader that collects those tables off disk. It lives under `test/`
 * rather than in a `scripts/` directory for two reasons, and the second is
 * the one that decided it:
 *
 *  1. `test/**` is already inside `tsconfig.vitest.json` and already linted,
 *     so the generator is typechecked and formatted by the gate that exists.
 *     A `scripts/` directory is in neither and would need both.
 *  2. Sc 11 established the house idiom for a generated committed artifact
 *     with `skills/claude/DRYRUN.md`: the SUITE compares, always, and an
 *     environment variable only decides whether a rewrite happens first.
 *     Under that idiom the generator's caller IS a spec, so putting the
 *     generator anywhere else would mean a spec importing across a boundary
 *     for no gain. `pnpm gen:docs` would be a second idiom for one problem,
 *     and a step somebody eventually forgets to run.
 *
 * WHAT IS AND IS NOT A SOURCE OF TRUTH HERE. The tables are: frame names,
 * their keys and direction, event names, their keys, the schema `$id`s on
 * disk, the close codes, the envelope keys and the wire version. Those are
 * read, never restated. The one-line NOTES below are prose and are the only
 * hand-written content in the document; they are a `Record` keyed by name,
 * and `noteFor` THROWS on a missing key rather than rendering an empty line.
 * That is deliberate: adding a tenth frame or an eighteenth event should
 * fail loudly with "nobody wrote a sentence explaining this to a stranger",
 * which is a better failure than a published document with a blank row.
 *
 * DETERMINISM is a requirement, not a nicety. No clock, no `Date`, no
 * filesystem iteration order (every list is sorted or comes from a sorted
 * table), and no absolute path. A generated file whose diff is noise is a
 * generated file whose diff nobody reads, and the entire value of this
 * scenario is that the diff means something.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLOSE_CODES,
  ENVELOPE_KEYS,
  EVENT_SPECS,
  FRAME_SPECS,
  GATEWAY_EVENT_NAMES,
  WIRE_VERSION,
} from '../../src/index.js';

export interface DocRow {
  readonly name: string;
  readonly required: readonly string[];
  readonly optional: readonly string[];
  /** Absent for events, which are always gateway->agent inside an `event`. */
  readonly direction?: string;
  /** The `$id` a JSON Schema validator resolves for this name. */
  readonly schemaId: string;
}

export interface CloseCodeRow {
  readonly name: string;
  readonly code: number;
  readonly meaning: string;
}

export interface ProtocolMdSources {
  readonly wireVersion: number;
  readonly envelopeKeys: readonly string[];
  readonly frames: readonly DocRow[];
  readonly events: readonly DocRow[];
  readonly closeCodes: readonly CloseCodeRow[];
}

/* ── the hand-written half: one sentence per name ───────────────────────── */

const FRAME_NOTES: Record<string, string> = {
  hello:
    'The first frame on the socket and the only one a gateway accepts before authentication. `wire` is the version the adapter speaks; a version this gateway cannot speak closes the socket with 4426.',
  'draft.submit':
    'The answer to a `draft.request`: a proposed reply, or a decline. Submitting sends nothing. It creates a pending draft that a person has to approve.',
  'draft.delta':
    'Optional streaming. Partial text for a reply still being composed, so an operator can watch it arrive. Deltas are display only, and the `draft.submit` that follows is what becomes a draft.',
  'proactive.propose':
    'A draft the adapter offers without having been asked. Same approval gate, plus an arming window an operator has to open first.',
  pong: 'The answer to a `ping`. Two consecutive misses close the socket with 4408.',
  'draft.request':
    'The gateway asking for a reply: the inbound message, the conversation context, the rule that matched, and the constraints the answer has to satisfy.',
  'draft.feedback':
    'What became of a draft this adapter submitted, and who decided. This is how an adapter learns it was rejected, and the only honest signal it gets.',
  event:
    'One member of the event vocabulary below, delivered to any adapter that asked for it. Informational: no event obliges an adapter to do anything.',
  ping: 'Liveness, sent by the gateway. Answer with `pong`.',
};

const EVENT_NOTES: Record<string, string> = {
  'adapter.health': "An adapter's connection status changed.",
  'arming.changed': 'The proactive arming window opened or closed.',
  'connection.state': "The gateway's own link to the message store changed.",
  'draft.approved': 'A person approved a draft. Dispatch follows.',
  'draft.created': 'A draft entered the pending queue.',
  'draft.delta': 'Streaming text for a draft still being composed.',
  'draft.expired':
    'A pending draft ran out its window and left the queue. Nobody acted on it and nothing was sent.',
  'draft.failed': 'Dispatch was attempted and did not succeed.',
  'draft.recalled':
    'An approved draft was pulled back inside its grace window.',
  'draft.redrafted':
    'A draft was rewritten. `draftId` is the draft that was replaced; `newDraftId` is the one now in the queue.',
  'draft.rejected': 'A person rejected a draft. Nothing was sent.',
  'draft.requeued':
    'An approved draft went back to pending because policy refused the send. The reason arrives on the `gate.denied` event that accompanies it, not on this one.',
  'draft.sent':
    'A draft reached the recipient, with the guid of the message that carried it.',
  'draft.superseded':
    'A newer draft took this one\u2019s place for the same conversation. `byDraftId` is the draft that replaced it.',
  'gate.denied': 'Policy refused something before it could become a draft.',
  'gateway.disconnected': 'The gateway is going away, with a reason.',
  'message.edited': 'An inbound message was edited at the source.',
  'message.received': 'An inbound message arrived, sanitized.',
  'message.unsent': 'An inbound message was unsent at the source.',
  'rule.matched':
    'An inbound message matched a rule and was routed to an adapter.',
  'toggle.changed': 'An operator setting changed.',
};

function noteFor(
  table: Record<string, string>,
  name: string,
  kind: string,
): string {
  const note = table[name];
  if (note === undefined)
    throw new Error(
      `gen-protocol-md: no note for ${kind} \`${name}\`. A new ${kind} needs one ` +
        `sentence explaining it to somebody outside this repo before it can be published.`,
    );
  return note;
}

/* ── the read half ──────────────────────────────────────────────────────── */

const SCHEMA_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/schemas',
);

function schemaId(rel: string): string {
  const parsed: unknown = JSON.parse(
    readFileSync(join(SCHEMA_DIR, rel), 'utf8'),
  );
  const id = (parsed as { $id?: unknown }).$id;
  if (typeof id !== 'string' || id === '')
    throw new Error(`gen-protocol-md: ${rel} has no $id`);
  return id;
}

/** Collect every source of truth this document is rendered from. */
export function readProtocolMdSources(): ProtocolMdSources {
  return {
    wireVersion: WIRE_VERSION,
    envelopeKeys: ENVELOPE_KEYS,
    frames: Object.entries(FRAME_SPECS).map(([name, spec]) => ({
      name,
      required: spec.required,
      optional: spec.optional,
      direction: spec.direction,
      schemaId: schemaId(`${name}.json`),
    })),
    events: GATEWAY_EVENT_NAMES.map((name) => ({
      name,
      required: EVENT_SPECS[name].required,
      optional: EVENT_SPECS[name].optional,
      schemaId: schemaId(`events/${name}.json`),
    })),
    closeCodes: Object.entries(CLOSE_CODES).map(([name, spec]) => ({
      name,
      code: spec.code,
      meaning: spec.meaning,
    })),
  };
}

/* ── the render half ────────────────────────────────────────────────────── */

/**
 * A fenced, monospaced key block. Fenced rather than a Markdown table on
 * purpose: the house style since the Hermes README is aligned text inside a
 * fence, which survives every renderer and every terminal, and a pipe table
 * of two columns is worse in all of them.
 */
function keyBlock(row: DocRow): string {
  const lines: string[] = [];
  const pad = (label: string): string => label.padEnd(9, ' ');
  lines.push(
    `${pad('required')}${row.required.length > 0 ? row.required.join(', ') : '(none)'}`,
  );
  lines.push(
    `${pad('optional')}${row.optional.length > 0 ? row.optional.join(', ') : '(none)'}`,
  );
  lines.push(`${pad('schema')}${row.schemaId}`);
  return ['```text', ...lines, '```'].join('\n');
}

function frameSection(row: DocRow): string {
  return [
    `### \`${row.name}\``,
    '',
    `Direction: \`${row.direction ?? ''}\`.`,
    '',
    noteFor(FRAME_NOTES, row.name, 'frame'),
    '',
    keyBlock(row),
  ].join('\n');
}

function eventSection(row: DocRow): string {
  return [
    `### \`${row.name}\``,
    '',
    noteFor(EVENT_NOTES, row.name, 'event'),
    '',
    keyBlock(row),
  ].join('\n');
}

/** Render the whole document. Pure: same sources in, same bytes out. */
export function renderProtocolMarkdown(s: ProtocolMdSources): string {
  const out: string[] = [];
  const push = (...parts: string[]): void => {
    out.push(parts.join('\n'));
  };

  push(
    '# The WeMessage adapter protocol',
    '',
    '<!-- GENERATED FILE. Do not edit by hand. -->',
    '',
    'This document describes wire version ' +
      String(s.wireVersion) +
      ' of the protocol an adapter speaks to a WeMessage gateway. It is generated from the same tables the gateway parses with, and a test regenerates it and fails the build if the two disagree, so it cannot quietly go stale. If you are reading a copy of this file, the code that produced it agreed with it.',
    '',
    'An adapter is a program that holds one WebSocket, answers requests for a reply, and can do nothing else. Everything it may say is on this page.',
  );

  push(
    '## What the protocol cannot do',
    '',
    'There is no send frame.',
    '',
    "That is the first thing to know about this protocol and the reason it has the shape it has. Not one of the frame types below puts text on anybody's phone, and no combination of them does either. An adapter that invents a tenth frame type gets its socket closed with 4400 and an audit row of type `adapter.no-send-frame` naming what it tried.",
    '',
    'Text reaches a recipient along exactly one path:',
    '',
    '1. the gateway asks, with `draft.request`, or the adapter offers, with `proactive.propose`;',
    '2. the adapter answers with `draft.submit`, which creates a PENDING draft and sends nothing;',
    '3. a person approves that draft, through `POST /v1/drafts/:id/approve` or the desktop app;',
    '4. the gateway, and only then, dispatches it.',
    '',
    'Step 3 is a human being. There is no token, no scope and no frame that skips it.',
    '',
    'One route deserves an honest paragraph, because it exists and it is not this path. `POST /v1/send` is the operator composing a message themselves in their own client: it mints an already-approved draft, writes an approval row attributed to whoever holds the operator credential, and dispatches, all in one call. It is the human typing, not the agent acting. An adapter cannot reach it. Adapter credentials authenticate a WebSocket and nothing else, and the HTTP surface is a separate credential an adapter is never given. If you are writing an agent that drives this gateway over HTTP rather than an adapter, treat approve-before-send as the model anyway: propose, then let a person approve.',
  );

  push(
    '## The envelope',
    '',
    'Every frame in either direction is a JSON object with exactly these keys, no more and no fewer:',
    '',
    ['```text', s.envelopeKeys.join('\n'), '```'].join('\n'),
    '',
    '`v` is the wire version and must equal ' +
      String(s.wireVersion) +
      ". `id` is a unique identifier for the frame. `type` is one of the names in the next section. `ts` is an ISO-8601 UTC timestamp. `payload` carries the keys that type allows, and an unknown key is a refusal rather than a warning: a v2 peer's new field is better rejected cleanly than guessed at.",
    '',
    'A minimal frame, whole:',
    '',
    [
      '```json',
      '{',
      '  "v": 1,',
      '  "id": "01J000000000000000000000",',
      '  "type": "pong",',
      '  "ts": "2026-01-01T00:00:00.000Z",',
      '  "payload": {}',
      '}',
      '```',
    ].join('\n'),
  );

  push(
    '## Frames',
    '',
    `There are ${String(s.frames.length)} frame types. Direction is stated for each and is enforced: a gateway-to-agent frame arriving from an adapter is a protocol violation, not a courtesy.`,
    '',
    s.frames.map(frameSection).join('\n\n'),
  );

  push(
    '## Events',
    '',
    `The \`event\` frame carries one of ${String(s.events.length)} named events. The name is the \`event\` key of the payload; the rest of the payload is listed per event below. An adapter subscribes to what it wants and ignores the rest.`,
    '',
    s.events.map(eventSection).join('\n\n'),
  );

  push(
    '## Close codes',
    '',
    'A gateway closes with one of these codes, all inside the RFC 6455 private range. Branch on the code rather than on the reason string:',
    '',
    s.closeCodes
      .map((c) => `- \`${String(c.code)}\` ${c.name}: ${c.meaning}.`)
      .join('\n'),
    '',
    'A close is not always fatal. 4408 says reconnect; 4401 and 4426 say stop and fix something.',
  );

  push(
    '## Writing an adapter',
    '',
    'Do not implement this document from scratch to find out whether you got it right. `@wemessage/adapter-testkit` runs a real gateway against your process and reports what it did:',
    '',
    [
      '```text',
      'npx @wemessage/adapter-testkit --cmd "node my-adapter.mjs"',
      '```',
    ].join('\n'),
    '',
    'Its README is the quickstart, and it ships a working reference adapter under `examples/`.',
  );

  push(
    '## Regenerating this document',
    '',
    'This file is rendered by `packages/protocol/test/helpers/gen-protocol-md.ts` from the tables in `packages/protocol/src`, the JSON Schemas in `packages/protocol/src/schemas`, and nothing else. `packages/protocol/test/protocol-md.spec.ts` compares the two on every run. After changing a frame, an event, a schema or a close code:',
    '',
    [
      '```text',
      'WEMESSAGE_WRITE_PROTOCOL_MD=1 pnpm vitest run --project protocol protocol-md',
      '```',
    ].join('\n'),
    '',
    'and commit the result with the change that caused it.',
  );

  return `${out.join('\n\n')}\n`;
}
