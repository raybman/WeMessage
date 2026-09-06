import { describe, expect, it } from 'vitest';

import {
  DEEP_LINK_HOSTS,
  DEEP_LINK_PREFIX,
  DEEP_LINK_REFUSALS,
  DEEP_LINK_SCHEME,
  MAX_DEEP_LINK_LENGTH,
  deepLinkFromArgv,
  parseDeepLink,
} from '../../src/main/deep-link.js';
import { DEFAULT_SCREEN, SCREENS } from '../../src/renderer/router.js';

/**
 * Scenario 16 — the deep-link grammar.
 *
 * A `wemessage://` URL is untrusted input. It can be produced by any page the
 * operator merely visits, by any app on the machine, by `open` from a shell
 * script they were talked into running. The parser is therefore the security
 * boundary of this scenario, and it is pure so that the boundary can be
 * tested exhaustively in a plain Node worker instead of inferred from an
 * Electron launch.
 *
 * Two properties are asserted here and nowhere else:
 *
 *  1. TOTALITY. `parseDeepLink` returns a value for every string. It never
 *     throws. A throw inside an `open-url` handler on the main process is an
 *     unhandled failure at best and a crash loop at worst, and the input is
 *     supplied by the attacker.
 *
 *  2. NO ACTION IS EXPRESSIBLE. The return type has three optional fields —
 *     `draftId`, `notFound`, `refused` — and none of them is a verb. There
 *     is no shape of URL that parses into "approve", "send", "pause", or a
 *     settings write, because the grammar has no production for one. That is
 *     stronger than a handler that declines to act: a handler can be edited
 *     by someone who did not read this comment, whereas a type with no verb
 *     in it fails to compile.
 *
 * The wire-level proof that no request is issued lives in the e2e (row 6).
 */

const ULID = '01HQ00000000000000000SC16A';

describe('s8 Sc16 — parseDeepLink is a closed allowlist expressed as data', () => {
  it('accepts a bare host for every screen, and only for a screen', () => {
    for (const screen of DEEP_LINK_HOSTS) {
      expect(parseDeepLink(`${DEEP_LINK_PREFIX}${screen}`)).toEqual({ screen });
      // A trailing slash is what `open` and most browsers actually produce.
      expect(parseDeepLink(`${DEEP_LINK_PREFIX}${screen}/`)).toEqual({
        screen,
      });
    }
  });

  it('is the same closed set as the renderer router, spelled independently', () => {
    // INV-1's shape applied to main: main does not import the renderer's
    // registry (that would make a main-process bug a renderer edit away), it
    // keeps a second projection and ties it back here AND in an arch row.
    expect([...DEEP_LINK_HOSTS].sort()).toEqual([...SCREENS].sort());
    expect(DEFAULT_SCREEN).toBe('queue');
  });

  it('accepts exactly one path form: a draft on the queue', () => {
    expect(parseDeepLink(`${DEEP_LINK_PREFIX}queue/draft/${ULID}`)).toEqual({
      screen: 'queue',
      draftId: ULID,
    });
  });

  it('refuses a draft path on any host but the queue', () => {
    for (const screen of DEEP_LINK_HOSTS) {
      if (screen === 'queue') continue;
      expect(
        parseDeepLink(`${DEEP_LINK_PREFIX}${screen}/draft/${ULID}`),
      ).toEqual({
        screen: DEFAULT_SCREEN,
        refused: 'unknown-path',
      });
    }
  });

  it('lands on the queue with a not-found chip when the id is not a ULID', () => {
    expect(parseDeepLink(`${DEEP_LINK_PREFIX}queue/draft/not-a-ulid`)).toEqual({
      screen: 'queue',
      notFound: 'not-a-ulid',
    });
  });

  it('never carries a draftId it did not validate', () => {
    // The chip is the ONLY place a URL component is echoed, so it is the only
    // place that has to be bounded. Anything that is not a ULID and is not a
    // short, alphanumeric-ish token is refused outright rather than shown.
    const hostile = [
      '<script>alert(1)</script>',
      '../../etc/passwd',
      "' OR 1=1 --",
      'a'.repeat(200),
      '%00',
    ];
    for (const id of hostile) {
      const link = parseDeepLink(`${DEEP_LINK_PREFIX}queue/draft/${id}`);
      expect(link.draftId).toBeUndefined();
      expect(link.screen).toBe(DEFAULT_SCREEN);
      if (link.notFound !== undefined) {
        expect(link.notFound.length).toBeLessThanOrEqual(32);
        expect(link.notFound).toMatch(/^[0-9A-Za-z_-]+$/);
      }
    }
  });

  it('rejects an unknown host explicitly instead of falling through', () => {
    // `wemessage://evil/../x` normalises to host `evil`, path `/x` under the
    // WHATWG parser for a non-special scheme. It must be named as an unknown
    // HOST, not silently treated as the default screen: the difference
    // between "you asked for the queue" and "we refused you and put you on
    // the queue" is the difference between a log line and a blind spot.
    expect(parseDeepLink(`${DEEP_LINK_PREFIX}evil/../x`)).toEqual({
      screen: DEFAULT_SCREEN,
      refused: 'unknown-host',
    });
    expect(parseDeepLink(`${DEEP_LINK_PREFIX}queue.evil.example.com`)).toEqual({
      screen: DEFAULT_SCREEN,
      refused: 'unknown-host',
    });
  });

  it('matches the host case-sensitively', () => {
    // Probed, not assumed: the WHATWG URL parser does NOT lowercase the host
    // of a non-special scheme, so `wemessage://QUEUE` arrives with host
    // `QUEUE`. Case-folding it would widen the allowlist by 63 spellings per
    // screen for no gain; refusing it keeps the set finite and literal.
    expect(parseDeepLink(`${DEEP_LINK_PREFIX}QUEUE`)).toEqual({
      screen: DEFAULT_SCREEN,
      refused: 'unknown-host',
    });
  });

  it('rejects a foreign scheme', () => {
    for (const url of [
      'https://queue.example.com/draft/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'app://-/index.html',
      'wemessages://queue',
    ]) {
      expect(parseDeepLink(url)).toEqual({
        screen: DEFAULT_SCREEN,
        refused: 'foreign-scheme',
      });
    }
  });

  it('rejects a scheme-relative or hostless spelling', () => {
    // `wemessage:queue` parses, with an EMPTY hostname and `queue` as the
    // path. It is not on the allowlist and it is not an accident worth
    // guessing at.
    expect(parseDeepLink(`${DEEP_LINK_SCHEME}:queue`)).toEqual({
      screen: DEFAULT_SCREEN,
      refused: 'unknown-host',
    });
  });

  it('caps the whole URL before it parses anything', () => {
    const huge = `${DEEP_LINK_PREFIX}queue/draft/${'0'.repeat(MAX_DEEP_LINK_LENGTH)}`;
    expect(huge.length).toBeGreaterThan(MAX_DEEP_LINK_LENGTH);
    expect(parseDeepLink(huge)).toEqual({
      screen: DEFAULT_SCREEN,
      refused: 'too-long',
    });
  });

  it('never throws, for any input at all', () => {
    const inputs = [
      '',
      ' ',
      'wemessage://',
      'wemessage:///',
      'wemessage://queue/draft',
      'wemessage://queue/draft/',
      'wemessage://queue/draft/a/b/c',
      `wemessage://queue?draft=${ULID}`,
      `wemessage://queue#${ULID}`,
      'wemessage://user:pw@queue/',
      'wemessage://queue:99999/',
      'wemessage://%2e%2e/queue',
      '://',
      'not a url at all',
      '%',
      `wemessage://queue/draft/${encodeURIComponent('../../settings')}`,
    ];
    for (const input of inputs) {
      const link = parseDeepLink(input);
      expect(DEEP_LINK_HOSTS as readonly string[]).toContain(link.screen);
      if (link.refused !== undefined) {
        expect(DEEP_LINK_REFUSALS as readonly string[]).toContain(link.refused);
      }
    }
  });

  it('has no verb in its result: nothing a URL says can be an action', () => {
    const keys = new Set<string>();
    for (const input of [
      `${DEEP_LINK_PREFIX}queue/draft/${ULID}`,
      `${DEEP_LINK_PREFIX}audit`,
      `${DEEP_LINK_PREFIX}queue/draft/not-a-ulid`,
      'https://example.com',
    ]) {
      for (const key of Object.keys(parseDeepLink(input))) keys.add(key);
    }
    expect([...keys].sort()).toEqual([
      'draftId',
      'notFound',
      'refused',
      'screen',
    ]);
  });
});

describe('s8 Sc16 — argv is the same input by another door', () => {
  it('finds the URL a second instance was launched with', () => {
    expect(
      deepLinkFromArgv(['/path/to/WeMessage', `${DEEP_LINK_PREFIX}audit`]),
    ).toBe(`${DEEP_LINK_PREFIX}audit`);
  });

  it('accepts the scheme case-insensitively in argv and nowhere else', () => {
    // The SCHEME is case-insensitive per RFC 3986 and the OS may hand it back
    // in any case; the HOST is not. Finding the token is not the same as
    // trusting it, and the token still goes through `parseDeepLink`.
    const raw = 'WeMessage://queue';
    expect(deepLinkFromArgv(['app', raw])).toBe(raw);
    expect(parseDeepLink(raw).screen).toBe(DEFAULT_SCREEN);
  });

  it('returns null when no argument names the scheme', () => {
    expect(deepLinkFromArgv([])).toBeNull();
    expect(deepLinkFromArgv(['/path/to/WeMessage', '--inspect', 'queue'])).toBe(
      null,
    );
    expect(deepLinkFromArgv(['https://example.com'])).toBeNull();
  });

  it('takes the first URL only, so a second argument cannot smuggle one past', () => {
    expect(
      deepLinkFromArgv([
        'app',
        `${DEEP_LINK_PREFIX}audit`,
        `${DEEP_LINK_PREFIX}settings`,
      ]),
    ).toBe(`${DEEP_LINK_PREFIX}audit`);
  });

  it('refuses an oversized argv token without measuring it twice', () => {
    expect(
      deepLinkFromArgv([
        'app',
        `${DEEP_LINK_PREFIX}${'q'.repeat(MAX_DEEP_LINK_LENGTH)}`,
      ]),
    ).toBeNull();
  });
});
