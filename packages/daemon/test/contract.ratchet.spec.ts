/**
 * v2 S0: the contract freeze (docs/plans/v2-swift-S0S1.md section 2).
 *
 * The Swift client (S1) is written against bytes, not against this
 * TypeScript. This ratchet pins those bytes under fixtures/contract/:
 *
 *   requests/<slug>.schema.json   every zod body/query schema as JSON Schema
 *   responses/<name>.json         {route, status, body} per success response
 *   errors/<name>.json            {route, status, body} per error envelope
 *   sse/*.txt, sse/headers.json   the SSE wire, byte for byte
 *   wire.json                     the constants a client must agree on
 *   manifest.json                 the file list and how to regenerate it
 *
 * Every row compares a committed file to what the recorder produces from a
 * fixture daemon right now. Drift fails. Regenerating is deliberate:
 *
 *   WEMESSAGE_WRITE_CONTRACT=1 npx vitest run --project daemon contract.ratchet
 *   git diff --stat fixtures/contract   # review every hunk before committing
 *
 * The recorder (helpers/contract-recorder.ts) stabilises what is random by
 * construction (ulids, tokens, the temp config dir) so that a re-record of
 * an unchanged daemon is byte-identical.
 */
import { execFileSync } from 'node:child_process';
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  GATEWAY_EVENT_NAMES,
  WIRE_VERSION,
  type GatewayEventName,
} from '@wemessage/protocol';
import {
  contractSlug,
  PARAM_SCHEMAS,
  paramJsonSchemas,
  REQUEST_SCHEMAS,
  requestJsonSchemas,
} from '../src/contract.js';
import { SSE_KEEPALIVE_MS, SSE_PATH } from '../src/routes/events-sse.js';
import { TOKEN_FILENAME, TOKEN_PREFIX } from '../src/auth.js';
import { adapterSchemas } from '../src/routes/adapters.js';
import { auditSchemas } from '../src/routes/audit.js';
import { connectionSchemas } from '../src/routes/connection.js';
import { contactSchemas } from '../src/routes/contacts.js';
import { draftSchemas } from '../src/routes/drafts.js';
import { ruleSchemas } from '../src/routes/rules.js';
import { scheduleSchemas } from '../src/routes/schedules.js';
import { sendSchemas } from '../src/routes/send.js';
import { settingsSchemas } from '../src/routes/settings.js';
import { threadSchemas } from '../src/routes/threads.js';
import { toggleSchemas } from '../src/routes/toggles.js';
import {
  CONTRACT_NOTES,
  ERROR_NAMES,
  NULL_DIGEST,
  recordContract,
  REGENERATE,
  renderJson,
  RESPONSE_NAMES,
  type ContractBundle,
} from './helpers/contract-recorder.js';
import { cleanupHarness } from './helpers/draft-harness.js';
import { NO_BODY_ROUTES, ROUTE_TABLE } from './transport-surface.snapshot.js';

const WRITE = process.env['WEMESSAGE_WRITE_CONTRACT'] === '1';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const CONTRACT_DIR = join(repoRoot, 'fixtures', 'contract');
const EVENTS_DIR = join(repoRoot, 'fixtures', 'events');

/** Every file this ratchet owns, relative to fixtures/contract, POSIX. */
const planned = new Map<string, string>();

/**
 * The ratchet itself. Under WRITE the rendered bytes land first; either way
 * the committed file must then equal them exactly.
 */
function ratchet(rel: string, rendered: string): void {
  planned.set(rel, rendered);
  const path = join(CONTRACT_DIR, ...rel.split('/'));
  if (WRITE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, rendered);
  }
  expect(readFileSync(path, 'utf8')).toBe(rendered);
}

function walk(dir: string): string[] {
  let out: string[] = [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(relative(CONTRACT_DIR, full).split(sep).join('/'));
  }
  return out;
}

function trackedContractFiles(): string[] {
  return execFileSync('git', ['ls-files', '--', 'fixtures/contract'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.length > 0)
    .map((f) => f.slice('fixtures/contract/'.length));
}

const JSON_SCHEMA_OPTS = {
  target: 'draft-2020-12',
  unrepresentable: 'throw',
  io: 'input',
} as const;

const requestFile = (key: string): string =>
  `requests/${contractSlug(key)}.schema.json`;
const paramFile = (key: string): string =>
  `requests/${contractSlug(key)}.params.schema.json`;

let bundle: ContractBundle;

beforeAll(async () => {
  bundle = await recordContract();
}, 60_000);

afterAll(async () => {
  await cleanupHarness();
});

/* ------------------------------------------------------------------------ */

describe('S0 requests: every schema is public', () => {
  const nonHead = ROUTE_TABLE.filter((r) => !r.startsWith('HEAD '));
  const requestKeys = Object.keys(REQUEST_SCHEMAS);
  const paramKeys = Object.keys(PARAM_SCHEMAS);

  it('every body or query route has a REQUEST_SCHEMAS entry or is in NO_BODY_ROUTES', () => {
    // A partition: each non-HEAD route is in exactly one of the two.
    const both = nonHead.filter(
      (r) => requestKeys.includes(r) && NO_BODY_ROUTES.includes(r),
    );
    const neither = nonHead.filter(
      (r) => !requestKeys.includes(r) && !NO_BODY_ROUTES.includes(r),
    );
    expect(both).toEqual([]);
    expect(neither).toEqual([]);
    expect(requestKeys.length + NO_BODY_ROUTES.length).toBe(nonHead.length);
    // NO_BODY_ROUTES names only real, non-HEAD routes, once each.
    expect(NO_BODY_ROUTES.filter((r) => !nonHead.includes(r))).toEqual([]);
    expect(new Set(NO_BODY_ROUTES).size).toBe(NO_BODY_ROUTES.length);
    // Every HEAD route is a twin of a GET, so it is covered by the GET.
    for (const head of ROUTE_TABLE.filter((r) => r.startsWith('HEAD '))) {
      expect(ROUTE_TABLE, head).toContain(head.replace(/^HEAD /, 'GET '));
    }

    // The source agrees: one zod body/query parse site per key, and one
    // params parse site per params key. A route that starts parsing a body
    // without a REQUEST_SCHEMAS entry moves the first count and not the second.
    const routesDir = fileURLToPath(new URL('../src/routes/', import.meta.url));
    let bodyOrQuery = 0;
    let params = 0;
    for (const name of readdirSync(routesDir)) {
      const text = readFileSync(join(routesDir, name), 'utf8');
      bodyOrQuery += [...text.matchAll(/\.safeParse\(req\.(body|query)\b/g)]
        .length;
      params += [...text.matchAll(/\.safeParse\(req\.params\b/g)].length;
    }
    expect(bodyOrQuery).toBe(requestKeys.length);
    expect(params).toBe(paramKeys.length);

    // And each entry IS the route module's own schema, by identity: the
    // per-route `<noun>Schemas` exports are the only source REQUEST_SCHEMAS
    // may draw from, and every member of them is used exactly once.
    const exported: z.ZodType[] = [
      adapterSchemas,
      auditSchemas,
      connectionSchemas,
      contactSchemas,
      draftSchemas,
      ruleSchemas,
      scheduleSchemas,
      sendSchemas,
      settingsSchemas,
      threadSchemas,
      toggleSchemas,
    ].flatMap((group) => Object.values(group) as z.ZodType[]);
    const used = [
      ...Object.values(REQUEST_SCHEMAS),
      ...Object.values(PARAM_SCHEMAS),
    ];
    expect(used.length).toBe(exported.length);
    for (const schema of used) expect(exported).toContain(schema);
    expect(new Set(used).size).toBe(used.length);
  });

  it('no REQUEST_SCHEMAS key is absent from ROUTE_TABLE', () => {
    expect(requestKeys.filter((k) => !ROUTE_TABLE.includes(k))).toEqual([]);
    expect(paramKeys.filter((k) => !ROUTE_TABLE.includes(k))).toEqual([]);
    expect(requestKeys.length).toBeGreaterThan(0);
  });

  it('every schema is representable as JSON Schema', () => {
    // Two maps, not one spread: GET /v1/threads/:guid/messages is a key in
    // both (its query and its params), and a spread would keep only one.
    expect(Object.keys(requestJsonSchemas()).sort()).toEqual(
      [...requestKeys].sort(),
    );
    expect(Object.keys(paramJsonSchemas()).sort()).toEqual(
      [...paramKeys].sort(),
    );
    for (const [key, schema] of [
      ...Object.entries(REQUEST_SCHEMAS),
      ...Object.entries(PARAM_SCHEMAS),
    ]) {
      // unrepresentable:'throw' is the assertion: a transform, a bigint or a
      // custom type in any request schema would throw here.
      const json = z.toJSONSchema(schema, JSON_SCHEMA_OPTS) as {
        type?: unknown;
      };
      expect(json.type, key).toBe('object');
    }
  });

  it('PATCH /v1/settings is the one open object; every other schema has additionalProperties:false at its root', () => {
    type Root = { additionalProperties?: unknown };
    const all: Array<[string, Root]> = [
      ...Object.entries(requestJsonSchemas()).map(([k, v]): [string, Root] => [
        k,
        v as Root,
      ]),
      ...Object.entries(paramJsonSchemas()).map(([k, v]): [string, Root] => [
        `${k} params`,
        v as Root,
      ]),
    ];
    expect(all).toHaveLength(requestKeys.length + paramKeys.length);
    const open = all
      .filter(([, s]) => s.additionalProperties !== false)
      .map(([k]) => k);
    expect(open).toEqual(['PATCH /v1/settings']);
    // Open means "any key, any value": the closed list is enforced by
    // planPatch with a typed refusal, not by the shape.
    expect(
      all.find(([k]) => k === 'PATCH /v1/settings')?.[1].additionalProperties,
    ).toEqual({});
  });

  it.each(Object.keys(REQUEST_SCHEMAS))(
    'requests/%s matches toJSONSchema output',
    (key) => {
      const schema = requestJsonSchemas()[key as keyof typeof REQUEST_SCHEMAS];
      expect(schema).toEqual(
        z.toJSONSchema(
          REQUEST_SCHEMAS[key as keyof typeof REQUEST_SCHEMAS],
          JSON_SCHEMA_OPTS,
        ),
      );
      expect(bundle.requests[requestFile(key)]).toEqual(schema);
      ratchet(requestFile(key), renderJson(schema));
    },
  );

  it.each(Object.keys(PARAM_SCHEMAS))(
    'requests/%s params match toJSONSchema output',
    (key) => {
      const schema = paramJsonSchemas()[key as keyof typeof PARAM_SCHEMAS];
      expect(bundle.requests[paramFile(key)]).toEqual(schema);
      ratchet(paramFile(key), renderJson(schema));
    },
  );

  it('one slug function names the files both ways', () => {
    expect(contractSlug('POST /v1/drafts/:id/approve')).toBe(
      'post.v1.drafts.id.approve',
    );
    expect(contractSlug('GET /v1/rules/:id/dry-run')).toBe(
      'get.v1.rules.id.dry-run',
    );
    const slugs = [...Object.keys(REQUEST_SCHEMAS)].map(contractSlug);
    expect(new Set(slugs).size).toBe(slugs.length);
    expect(Object.keys(bundle.requests).sort()).toEqual(
      [
        ...Object.keys(REQUEST_SCHEMAS).map(requestFile),
        ...Object.keys(PARAM_SCHEMAS).map(paramFile),
      ].sort(),
    );
  });
});

/* ------------------------------------------------------------------------ */

describe('S0 responses: golden bodies', () => {
  it('every recorded call answered the status the recorder expected', () => {
    expect(bundle.surprises).toEqual([]);
  });

  it('the recorder produced exactly the named responses', () => {
    expect(Object.keys(bundle.responses).sort()).toEqual(
      [...RESPONSE_NAMES].sort(),
    );
    for (const r of Object.values(bundle.responses)) {
      expect(ROUTE_TABLE).toContain(r.route);
      expect(r.status).toBeLessThan(300);
    }
  });

  it.each([...RESPONSE_NAMES])(
    'responses/%s is byte-identical to the recorder',
    (name) => {
      ratchet(`responses/${name}.json`, renderJson(bundle.responses[name]));
    },
  );
});

describe('S0 errors: golden envelopes', () => {
  it('the recorder produced exactly the named errors', () => {
    expect(Object.keys(bundle.errors).sort()).toEqual([...ERROR_NAMES].sort());
    for (const [name, r] of Object.entries(bundle.errors)) {
      expect(ROUTE_TABLE).toContain(r.route);
      // The file stem leads with the status it records.
      expect(name.startsWith(`${String(r.status)}.`), name).toBe(true);
      expect(typeof (r.body as { error?: unknown }).error, name).toBe('string');
    }
  });

  it.each([...ERROR_NAMES])('errors/%s', (name) => {
    ratchet(`errors/${name}.json`, renderJson(bundle.errors[name]));
  });
});

/* ------------------------------------------------------------------------ */

describe('S0 sse: wire bytes', () => {
  it('headers.json is exactly SSE_HEADERS', () => {
    // SSE_HEADERS is module-private (advisor 11): its literal is read from
    // the route's own text, so the fixture and the source cannot disagree.
    const src = readFileSync(
      fileURLToPath(new URL('../src/routes/events-sse.ts', import.meta.url)),
      'utf8',
    );
    const block = /const SSE_HEADERS[^=]*=\s*\{([\s\S]*?)\};/.exec(src)?.[1];
    expect(block).toBeDefined();
    const fromSource: Record<string, string> = {};
    for (const m of (block ?? '').matchAll(
      /['"]?([\w-]+)['"]?\s*:\s*'([^']*)'/g,
    )) {
      fromSource[(m[1] ?? '').toLowerCase()] = m[2] ?? '';
    }
    expect(Object.keys(fromSource)).toHaveLength(4);
    expect(bundle.sse.headers).toEqual(fromSource);
    ratchet('sse/headers.json', renderJson(bundle.sse.headers));
  });

  it('greeting.txt is the connection.state frame with id 1', () => {
    expect(bundle.sse.greeting).toMatch(
      /^id: 1\nevent: connection\.state\ndata: \{[^\n]*\}\n\n$/,
    );
    ratchet('sse/greeting.txt', bundle.sse.greeting);
  });

  it.each([...GATEWAY_EVENT_NAMES])(
    'sse/%s.txt is id/event/data in that order and data parses to fixtures/events/<event>.json',
    (name: GatewayEventName) => {
      const frame = bundle.sse.frames[name];
      ratchet(`sse/${name}.txt`, frame);
      expect(frame.endsWith('\n\n')).toBe(true);
      const lines = frame.slice(0, -2).split('\n');
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^id: \d+$/);
      expect(lines[1]).toBe(`event: ${name}`);
      expect(lines[2]?.startsWith('data: ')).toBe(true);
      expect(JSON.parse((lines[2] ?? '').slice('data: '.length))).toEqual(
        JSON.parse(readFileSync(join(EVENTS_DIR, `${name}.json`), 'utf8')),
      );
    },
  );

  it('keepalive.txt is ": keepalive\\n\\n"', () => {
    expect(bundle.sse.keepalive).toBe(': keepalive\n\n');
    ratchet('sse/keepalive.txt', bundle.sse.keepalive);
  });

  it('a bad filter is 400 unknown-event, recorded under errors', () => {
    const rec = bundle.errors['400.unknown-event'];
    expect(rec).toEqual({
      route: 'GET /v1/events/sse',
      status: 400,
      body: { error: 'unknown-event', name: 'nope' },
    });
    expect(planned.get('errors/400.unknown-event.json')).toBe(renderJson(rec));
  });
});

/* ------------------------------------------------------------------------ */

describe('S0 manifest', () => {
  it('wire.json pins WIRE_VERSION 1, the 21 names, the 9 draft states, BACKOFF_MS/JITTER/AUDIT_GAP_LIMIT, keepalive 15000, port 47100, token file daemon.token', () => {
    const w = bundle.wire;
    expect(w.wireVersion).toBe(WIRE_VERSION);
    expect(w.wireVersion).toBe(1);
    expect(w.eventNames).toEqual([...GATEWAY_EVENT_NAMES]);
    expect(w.eventNames).toHaveLength(21);
    expect(w.draftStates).toHaveLength(9);
    expect(new Set(w.draftStates).size).toBe(9);
    expect(w.backoff.steps).toHaveLength(5);
    expect(w.backoff.steps).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(w.backoff.jitter).toBe(0.2);
    expect(w.backoff.auditGapLimit).toBe(1000);
    expect(w.sse).toEqual({ path: SSE_PATH, keepaliveMs: SSE_KEEPALIVE_MS });
    expect(w.sse.keepaliveMs).toBe(15000);
    expect(w.defaults).toEqual({ port: 47100, tokenFile: TOKEN_FILENAME });
    expect(w.defaults.tokenFile).toBe('daemon.token');
    ratchet('wire.json', renderJson(w));
  });

  it('manifest.json lists exactly git ls-files fixtures/contract minus itself, sorted', () => {
    const files = [...planned.keys()].sort();
    // Non-vacuity: every block above ran and registered its files.
    expect(files.length).toBeGreaterThanOrEqual(60);
    const manifest = renderJson({
      regenerate: REGENERATE,
      notes: CONTRACT_NOTES,
      files,
    });
    if (WRITE) {
      // A regenerate removes what it no longer produces.
      for (const stale of walk(CONTRACT_DIR)) {
        if (stale !== 'manifest.json' && !planned.has(stale))
          rmSync(join(CONTRACT_DIR, ...stale.split('/')));
      }
    }
    ratchet('manifest.json', manifest);
    // The disk holds nothing else, and git tracks exactly the same set.
    expect(
      walk(CONTRACT_DIR)
        .filter((f) => f !== 'manifest.json')
        .sort(),
    ).toEqual(files);
    expect(
      trackedContractFiles()
        .filter((f) => f !== 'manifest.json')
        .sort(),
    ).toEqual(files);
  });
});

/* ------------------------------------------------------------------------ */

describe('S0 hygiene', () => {
  // The lookarounds are the point (advisor 5): `\b` treats `_` as a word
  // character, so `wm_<64 hex>` has no boundary before the hex and a `\b`
  // regex walks straight past a live token.
  const HEX64_ANYWHERE = /(?<![0-9a-f])[0-9a-f]{64}(?![0-9a-f])/g;

  const texts = (): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    for (const [k, v] of Object.entries(bundle.requests))
      out.push([k, renderJson(v)]);
    for (const [k, v] of Object.entries(bundle.responses))
      out.push([`responses/${k}`, renderJson(v)]);
    for (const [k, v] of Object.entries(bundle.errors))
      out.push([`errors/${k}`, renderJson(v)]);
    out.push(['sse/headers.json', renderJson(bundle.sse.headers)]);
    out.push(['sse/greeting.txt', bundle.sse.greeting]);
    out.push(['sse/keepalive.txt', bundle.sse.keepalive]);
    for (const [k, v] of Object.entries(bundle.sse.frames))
      out.push([`sse/${k}`, v]);
    out.push(['wire.json', renderJson(bundle.wire)]);
    return out;
  };

  it('no fixture contains a 64-hex run other than NULL_DIGEST', () => {
    const offenders = texts().flatMap(([name, text]) =>
      [...text.matchAll(HEX64_ANYWHERE)]
        .filter((m) => m[0] !== NULL_DIGEST)
        .map(() => name),
    );
    expect(offenders).toEqual([]);
    // Non-vacuity: the stabiliser did meet digests (the audit chain) and the
    // regex sees through an underscore.
    expect(texts().some(([, t]) => t.includes(NULL_DIGEST))).toBe(true);
    expect(`wm_${'a'.repeat(64)}`.match(HEX64_ANYWHERE)).toHaveLength(1);
  });

  // Assembled, not spelled: the S8 home-path rows sweep tracked sources for
  // the literal, and this file is one of them.
  const HOME_ROOT = `/${'Users'}/`;

  it(`no fixture contains ${HOME_ROOT}, a non-+1555 phone, a non-example.com host, or the token prefix followed by hex`, () => {
    const offenders: string[] = [];
    // The token prefix followed by anything but the null digest.
    const token = new RegExp(`${TOKEN_PREFIX}(?!${NULL_DIGEST}(?![0-9a-f]))`);
    for (const [name, text] of texts()) {
      if (text.includes(HOME_ROOT)) offenders.push(`${name}: ${HOME_ROOT}`);
      for (const m of text.matchAll(/\+\d{7,}/g))
        if (!m[0].startsWith('+1555')) offenders.push(`${name}: ${m[0]}`);
      for (const m of text.matchAll(
        /\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|ai|dev|app)\b/gi,
      ))
        // json-schema.org is the `$schema` meta-schema URI every request
        // schema declares, a standard, not a host anything talks to.
        if (!/(^|\.)example\.com$/i.test(m[0]) && m[0] !== 'json-schema.org')
          offenders.push(`${name}: ${m[0]}`);
      if (token.test(text)) offenders.push(`${name}: token`);
    }
    expect(offenders).toEqual([]);
    // Non-vacuity: the rule refuses a live-shaped token and allows the null.
    expect(token.test(`wm_${'f'.repeat(64)}`)).toBe(true);
    expect(token.test(`wm_${NULL_DIGEST}`)).toBe(false);
  });

  it('no fixture contains an em dash', () => {
    expect(
      texts()
        .filter(([, t]) => t.includes('—'))
        .map(([n]) => n),
    ).toEqual([]);
  });

  it('every ISO instant in a fixture is on the fake clock day, 2026-09-01', () => {
    // The 21 event frames are exempt: their data is fixtures/events verbatim
    // (dated 2026-01-01), and the sse rows above already pin it to those
    // files. Everything the recorder ASKED a daemon for is on the fake day.
    const frames = new Set(
      Object.keys(bundle.sse.frames).map((k) => `sse/${k}`),
    );
    expect(frames.size).toBe(GATEWAY_EVENT_NAMES.length);
    const off = texts()
      .filter(([name]) => !frames.has(name))
      .flatMap(([name, text]) =>
        [...text.matchAll(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)]
          .filter((m) => !m[0].startsWith('2026-09-01T'))
          .map((m) => `${name}: ${m[0]}`),
      );
    expect(off).toEqual([]);
  });
});
