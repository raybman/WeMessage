/**
 * s5-execution Scenario 11 (CLI half, pure-function rows) — the `adapters`
 * renderers and the `watch` delta/health renderers.
 *
 * Split, same as S3 Scenario 10 split `purge.spec.ts` from
 * `send-connect-cli.spec.ts`: the rows that are pure functions of a payload
 * live here, in the package that owns them; the rows that need a REAL daemon
 * answering real HTTP (exit codes, the shown-once token, the no-green sweep
 * over live transcripts) live in packages/daemon/test/adapters-cli.spec.ts,
 * because `.dependency-cruiser.cjs`'s `nobody-imports-daemon` /
 * `cli-desktop-thin-clients` rules forbid packages/cli from importing the
 * daemon.
 *
 * The load-bearing row here is "list never prints token material". The
 * adapter list renderer must render a WHITELIST of fields, never "whatever
 * the daemon happened to send": a registry read that starts carrying token
 * material — a future daemon regression, a hand-built payload, a replayed
 * create response — must not turn `wemessage adapters list` into a
 * credential dump. The TOKEN column is a boolean rendered as `set`/`none`,
 * by construction, and that is the whole design.
 */
import { describe, expect, it } from 'vitest';
import type { AdapterPayload } from '@wemessage/client';
import {
  renderAdapter,
  renderAdapterTable,
  renderMintedCredential,
} from '../src/adapters.js';
import { createWatchRenderer } from '../src/watch.js';

/** Any ANSI escape (covers color incl. green): the no-green rule (C-9). */
const ANSI_RE = /\x1b\[/;

/**
 * s7 Sc1: `over` widens `lastSeenAt` to admit an explicit `undefined`.
 * Under `exactOptionalPropertyTypes` an adapter that has never been seen
 * carries NO `lastSeenAt` key rather than the key set to `undefined`, so a
 * caller cannot write `lastSeenAt: undefined` against
 * `Partial<AdapterPayload>` at all — yet "never seen" is precisely the row
 * the table has to render. The conditional spread turns the caller's
 * `undefined` into an omitted key, which is what the daemon's NULL column
 * actually produces on the wire.
 */
function adapter(
  over: Omit<Partial<AdapterPayload>, 'lastSeenAt'> & {
    lastSeenAt?: string | undefined;
  } = {},
): AdapterPayload {
  // `in`, not a destructuring default: a default fires on `undefined`, which
  // would silently turn "never seen" back into the default timestamp. The
  // question is whether the caller SUPPLIED the key, which is the same
  // question `exactOptionalPropertyTypes` makes the compiler ask.
  const { lastSeenAt, ...rest } = over;
  const seen = 'lastSeenAt' in over ? lastSeenAt : '2026-09-03T00:00:00.000Z';
  return {
    id: 'echo-1',
    kind: 'echo',
    displayName: 'Echo',
    enabled: true,
    hasToken: true,
    health: 'connected',
    config: {},
    ...(seen === undefined ? {} : { lastSeenAt: seen }),
    ...rest,
  };
}

describe('adapters list rendering', () => {
  it('renders a monochrome fixed-width table: id, kind, health, token, last seen', () => {
    const out = renderAdapterTable([
      adapter(),
      adapter({
        id: 'sol',
        kind: 'sol',
        displayName: 'Sol',
        hasToken: false,
        health: 'unknown',
        enabled: false,
        lastSeenAt: undefined,
      }),
    ]);
    const lines = out.split('\n');
    // Fixed-width, two-space gutters, same shape as `drafts list` (S4).
    expect(lines[0]).toBe('ID      KIND  HEALTH     TOKEN  LAST SEEN');
    expect(lines[1]).toBe(
      'echo-1  echo  connected  set    2026-09-03T00:00:00.000Z',
    );
    // A disabled adapter says so; an absent lastSeenAt renders as `never`,
    // not as the string "undefined".
    expect(lines[2]).toContain('sol');
    expect(lines[2]).toContain('none');
    expect(lines[2]).toContain('never');
    expect(lines[2]).not.toContain('undefined');
    expect(out).not.toMatch(ANSI_RE);
  });

  it('says so out loud when there are no adapters', () => {
    expect(renderAdapterTable([])).toBe('(no adapters)');
  });

  it('list never prints token material', () => {
    // Defence in depth: even handed a payload that carries stray token
    // material, the renderer prints its own whitelist. `set` is derived from
    // the `hasToken` boolean and nothing else.
    const leaky = {
      ...adapter(),
      token: 'wm_0123456789abcdef',
      connectCmd: 'wemessage-adapter-echo --token wm_0123456789abcdef',
    } as unknown as AdapterPayload;
    const out = renderAdapterTable([
      leaky,
      adapter({ id: 'sol', kind: 'sol' }),
    ]);
    expect(out).not.toContain('wm_');
    expect(out).not.toContain('0123456789abcdef');
    expect(out).toContain('set');
  });

  it('renderAdapter shows one adapter in detail, and still no token material', () => {
    const out = renderAdapter({
      ...adapter(),
      token: 'wm_secret',
    } as unknown as AdapterPayload);
    expect(out).toContain('id:');
    expect(out).toContain('echo-1');
    expect(out).toContain('token:');
    expect(out).toContain('set');
    expect(out).not.toContain('wm_');
    expect(out).not.toMatch(ANSI_RE);
  });
});

describe('minted-credential rendering (shown once, never again)', () => {
  const credential = {
    adapter: adapter(),
    token: 'wm_abc123',
    connectCmd:
      'wemessage-adapter-echo --url ws://127.0.0.1:47100/v1/agent --token wm_abc123',
  };

  it('prints the token exactly once, with an explicit only-time-you-see-it line', () => {
    const out = renderMintedCredential(credential, { rotated: false });
    const occurrences = out.split('wm_abc123').length - 1;
    // Once as the token line. The connect command is printed with the token
    // ELIDED: an operator who pastes it substitutes the token they just
    // stored, and a scrollback/screenshot of this block carries one copy of
    // the secret, not two.
    expect(occurrences).toBe(1);
    expect(out.toLowerCase()).toContain(
      'this is the only time you will see this token',
    );
    expect(out).toContain('connect:');
    expect(out).not.toMatch(ANSI_RE);
  });

  it('a rotation additionally states the 60-second carry-over (F-42)', () => {
    const out = renderMintedCredential(credential, { rotated: true });
    expect(out).toContain('old token valid 60 seconds');
    expect(out).toContain('wm_abc123');
  });

  it('a first mint does NOT claim an old token is still valid', () => {
    expect(
      renderMintedCredential(credential, { rotated: false }),
    ).not.toContain('old token');
  });
});

describe('watch renderers (draft.delta preview, adapter.health state line)', () => {
  it('renders draft.delta as an in-place preview that accumulates the text', () => {
    const render = createWatchRenderer();
    const correlation = {
      requestId: 'req-1',
      chatGuid: 'iMessage;-;+15551234567',
    };
    const first = render({
      event: 'draft.delta',
      correlation,
      seq: 1,
      textDelta: 'Hello',
    });
    expect(first).not.toBeNull();
    expect(first?.inPlace).toBe(true);
    expect(first?.text).toContain('Hello');

    const second = render({
      event: 'draft.delta',
      correlation,
      seq: 2,
      textDelta: ' there',
    });
    // Accumulated, not replaced: a preview line that showed only the newest
    // chunk would be unreadable.
    expect(second?.text).toContain('Hello there');
    expect(second?.text).toContain('+15551234567');
    expect(second?.text).not.toMatch(ANSI_RE);
  });

  it('keeps concurrent requests on separate preview lines', () => {
    const render = createWatchRenderer();
    render({
      event: 'draft.delta',
      correlation: { requestId: 'a', chatGuid: 'iMessage;-;+1555000001' },
      seq: 1,
      textDelta: 'AAA',
    });
    const other = render({
      event: 'draft.delta',
      correlation: { requestId: 'b', chatGuid: 'iMessage;-;+1555000002' },
      seq: 1,
      textDelta: 'BBB',
    });
    expect(other?.text).toContain('BBB');
    expect(other?.text).not.toContain('AAA');
  });

  it('renders adapter.health as a plain state line, not in place', () => {
    const line = createWatchRenderer()({
      event: 'adapter.health',
      adapterId: 'echo-1',
      status: 'disconnected',
    });
    expect(line?.inPlace).toBe(false);
    expect(line?.text).toContain('echo-1');
    expect(line?.text).toContain('disconnected');
    expect(line?.text).not.toMatch(ANSI_RE);
  });

  it('returns null for every other event — those stay NDJSON (§3.8)', () => {
    const render = createWatchRenderer();
    expect(render({ event: 'message.unsent', guid: 'p:0/abc' })).toBeNull();
    expect(
      render({ event: 'connection.state', state: 'fully-connected' }),
    ).toBeNull();
  });
});
