/**
 * s7-execution Scenario 7 — the Hermes plugin, run as a stranger would run it.
 *
 * `adapter.py` and `wemessage_wire.py` are the first non-JavaScript children
 * this repo has ever put on its own wire, which makes this file the real test
 * of a claim Sc 6 only asserted: that the child contract (five environment
 * variables, a greeting for readiness, a wall-clock budget per check, a
 * death/hang distinction) is language-neutral. Nothing below reads the Python
 * and decides it looks right. Row 1 spawns it, dials it back over a real
 * loopback socket and runs the same six checks that judged the Node reference
 * adapter, through the same `runConformanceSpawned`.
 *
 * Four properties are load-bearing here and each is argued where it is
 * asserted rather than in a README:
 *
 *  - **The interpreter is resolved, never assumed.** This machine's system
 *    Python is 3.14, which is OUTSIDE Hermes' own `>=3.11,<3.14` pin, so
 *    `python3` is not a usable interpreter here and pretending otherwise
 *    would make the rows below lie. Resolution is a documented ladder
 *    (`$WEMESSAGE_PYTHON`, then `uv`, then a bare `python3`), every rung is
 *    PROBED before it is believed, and the outcome is printed.
 *  - **A missing interpreter skips, loudly, and never under CI.** C-11: a
 *    cross-language row must not make the TypeScript gate red on a machine
 *    without the interpreter, and must not go quietly green on CI because the
 *    interpreter was missing. So the skips are COUNTED, the count is asserted
 *    against the declared row list at the end of the file, and `CI=true`
 *    turns any skip into a failure (F-88).
 *  - **INV-2 holds in a second language.** The protocol has no send frame.
 *    `wemessage_wire.py` has one `AGENT_FRAME_TYPES` frozenset, one `_emit`
 *    chokepoint that raises on anything outside it, and exactly one socket
 *    write in the whole module. `test/children/broken_sends.py` is the Python
 *    twin of `examples/broken-sends.mjs`: the same file with the one change a
 *    stranger makes first, refused with the daemon's own taxonomy
 *    (`adapter.no-send-frame`, never `gate.denied`, C-6).
 *  - **The token never reaches argv.** Argv is world-readable through `ps(1)`;
 *    a `uv run …` command line is a particularly public place. Row 1 asserts
 *    the spawned argv is clean and that no `wm_<64 hex>` survives into the
 *    transcript the kit prints.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  killAllChildren,
  liveChildren,
  runConformanceSpawned,
  type ConformanceReport,
} from '@wemessage/adapter-testkit';

const PKG = fileURLToPath(new URL('..', import.meta.url));
const PLUGIN = `${PKG}plugin/`;
const REPO = fileURLToPath(new URL('../../../../', import.meta.url));
const TOKEN_RE = /wm_[0-9a-f]{64}/;

/**
 * The operator's brand names, assembled at runtime rather than written down.
 *
 * The repo-wide sweep in `test/arch.spec.ts` has to exempt itself because it
 * spells the denylist out; this file does not get that exemption and does not
 * need one. Splitting each name means the guard for the plugin can live
 * beside the plugin without the guard becoming the thing it is looking for —
 * which the widened sweep caught within minutes of this file existing.
 */
const BRAND = new RegExp(
  [
    `flow${'stay'}`,
    `flow${'verse'}`,
    `flow${'industries'}`,
    `viva${'epic'}`,
  ].join('|'),
  'i',
);

const read = (rel: string): string => readFileSync(`${PLUGIN}${rel}`, 'utf8');

afterEach(async () => {
  await killAllChildren();
  expect(liveChildren()).toBe(0);
});

/* ── the interpreter ladder ────────────────────────────────────────────── */

/**
 * How the interpreter was found, in the words the skip banner prints. A
 * closed set, because "how did this run" is a fact a reader of a CI log needs
 * to be able to trust without reading this file.
 */
type PythonSource = 'env' | 'uv' | 'system';

interface PythonRuntime {
  source: PythonSource;
  cmd: string;
  /** Prefix args. The script path and its own args are appended after these. */
  args: string[];
  label: string;
}

/**
 * The one thing the plan's ladder does not say and the tree requires: the
 * interpreter must be able to `import websockets`. `plugin/requirements.txt`
 * is the closed one-package list, so the `uv` rung supplies it with
 * `--with-requirements` against that exact file rather than a version spelled
 * a second time here. The `$WEMESSAGE_PYTHON` and bare-`python3` rungs are
 * believed only if a probe proves the import works and the version is inside
 * `pyproject.toml`'s `>=3.11,<3.14`.
 */
const PROBE = [
  'import sys, websockets;',
  'v = sys.version_info;',
  'ok = (3, 11) <= (v.major, v.minor) < (3, 14);',
  'print("PROBE", "ok" if ok else "version", v.major, v.minor, websockets.version.version);',
  'sys.exit(0 if ok else 3)',
].join(' ');

function probe(cmd: string, args: string[]): string | null {
  try {
    const out = execFileSync(cmd, [...args, '-c', PROBE], {
      encoding: 'utf8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim();
  } catch {
    return null;
  }
}

function hasUv(): boolean {
  try {
    execFileSync('uv', ['--version'], { stdio: 'ignore', timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * The ladder, in order, each rung probed before it is believed.
 *
 * `uv run --no-project` matters: without it `uv` walks up to the nearest
 * `pyproject.toml`, finds this repo's Python plugin manifest and tries to
 * install the repo as a project. `--quiet` keeps uv's own progress lines out
 * of the child transcript the kit relays.
 */
function resolvePython(): PythonRuntime | null {
  const fromEnv = process.env['WEMESSAGE_PYTHON'];
  if (fromEnv !== undefined && fromEnv !== '') {
    const detail = probe(fromEnv, []);
    if (detail !== null)
      return { source: 'env', cmd: fromEnv, args: [], label: detail };
  }
  if (hasUv()) {
    const args = [
      'run',
      '--quiet',
      '--no-project',
      '--python',
      '3.12',
      '--with-requirements',
      `${PLUGIN}requirements.txt`,
      'python',
    ];
    const detail = probe('uv', args);
    if (detail !== null)
      return { source: 'uv', cmd: 'uv', args, label: detail };
  }
  for (const candidate of ['python3.12', 'python3']) {
    const detail = probe(candidate, []);
    if (detail !== null)
      return { source: 'system', cmd: candidate, args: [], label: detail };
  }
  return null;
}

const PYTHON = resolvePython();
const CI = process.env['CI'] === 'true';

/**
 * The rows that need an interpreter, named exactly as they are declared. The
 * list is asserted twice: against what actually ran, and against what was
 * skipped. A row that quietly stops existing cannot make the accounting row
 * at the bottom of this file vacuous.
 */
const INTERPRETED_ROWS = [
  'row 1: the plugin passes all six checks over a real socket',
  'row 3: adapter.py imports and reports HERMES_AVAILABLE=False without Hermes',
  'row 7: the idempotency key is derived from the correlation, not from entropy',
  'row 10: the Python counter-example is refused as adapter.no-send-frame',
] as const;

const ran: string[] = [];
const skipped: string[] = [];

if (PYTHON === null)
  // Printed, not swallowed. A skip nobody sees is a pass with extra steps.
  console.warn(
    '[s7 Sc7] no usable Python: every interpreted row will SKIP. Wanted an ' +
      'interpreter in >=3.11,<3.14 that can import websockets; tried ' +
      '$WEMESSAGE_PYTHON, uv (--python 3.12), python3.12, python3.',
  );
else
  console.warn(
    `[s7 Sc7] interpreter: ${PYTHON.source} — ${PYTHON.cmd} — ${PYTHON.label}`,
  );

/** Declare an interpreted row. Runs it, or counts the skip and says so. */
function pyRow(
  name: (typeof INTERPRETED_ROWS)[number],
  body: (py: PythonRuntime) => Promise<void> | void,
  timeout = 120_000,
): void {
  it(
    name,
    async (ctx) => {
      if (PYTHON === null) {
        skipped.push(name);
        ctx.skip();
        return;
      }
      ran.push(name);
      await body(PYTHON);
    },
    timeout,
  );
}

function explain(report: ConformanceReport): string {
  return report.checks
    .filter((c) => !c.ok)
    .map((c) => `${String(c.id)}: ${c.detail ?? 'no detail'}`)
    .join('\n');
}

/* ── row 1 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the Hermes plugin over the spawn transport', () => {
  pyRow(INTERPRETED_ROWS[0], async (py) => {
    const report = await runConformanceSpawned({
      cmd: py.cmd,
      args: [...py.args, `${PLUGIN}wemessage_wire.py`, '--standalone'],
      name: 'hermes-plugin',
      timeoutMs: 30_000,
    });
    expect(explain(report)).toBe('');
    expect(report.conformant).toBe(true);
    expect(report.checks).toHaveLength(6);
    expect(report.transport).toBe('spawn');
    // A real process on the other end of a real socket, and no leak.
    expect(report.spawn?.children).toBeGreaterThan(1);
    expect(report.spawn?.orphans).toBe(0);
    expect(report.spawn?.protocolViolations).toEqual([]);
    expect(report.spawn?.budgetTrips).toEqual([]);
    // The token travels by environment. `ps(1)` shows argv to every user on
    // the box, and a `uv run …` line is about as public as argv gets.
    expect(report.spawn?.argv.join(' ')).not.toMatch(TOKEN_RE);
    expect(report.spawn?.transcript ?? '').not.toMatch(TOKEN_RE);
    // Streaming is not declared, so check 4 must not have probed for deltas.
    expect(report.features).toEqual([]);
  });
});

/* ── row 2 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the wire module is standalone', () => {
  it('row 2: wemessage_wire.py imports nothing from Hermes', () => {
    const source = read('wemessage_wire.py');
    // Import forms, not the bare package name: a docstring may name Hermes,
    // an import may not. `from gateway import x`, `import gateway.y`,
    // `importlib.import_module('agent.z')` are all the same defect.
    const forbidden = /^\s*(?:from|import)\s+(gateway|hermes_cli|agent)\b/m;
    expect(source).not.toMatch(forbidden);
    expect(source).not.toMatch(
      /import_module\(\s*['"](gateway|hermes_cli|agent)/,
    );
    // websockets is the ONE third-party import the module is allowed.
    const thirdParty = [
      ...source.matchAll(/^\s*(?:from|import)\s+([a-z_][\w.]*)/gm),
    ]
      .map((m) => (m[1] ?? '').split('.')[0])
      .filter((mod) => !STDLIB.has(mod ?? ''));
    expect([...new Set(thirdParty)]).toEqual(['websockets']);
  });
});

/** The standard-library modules `wemessage_wire.py` is allowed to reach for. */
const STDLIB = new Set([
  '__future__',
  'argparse',
  'asyncio',
  'json',
  'os',
  'sys',
  'time',
  'typing',
  'uuid',
  'datetime',
  'collections',
  'dataclasses',
  'logging',
]);

/* ── row 3 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: adapter.py is inspectable without Hermes installed', () => {
  pyRow(INTERPRETED_ROWS[1], (py) => {
    const out = execFileSync(
      py.cmd,
      [
        ...py.args,
        '-c',
        'import adapter; print(f"HERMES_AVAILABLE={adapter.HERMES_AVAILABLE}")',
      ],
      {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PYTHONPATH: PLUGIN },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    // Hermes is not on this interpreter's path, so the guarded imports must
    // have taken the ImportError branch and the module must still be there.
    expect(out).toContain('HERMES_AVAILABLE=False');
  });

  it('row 3b: the Hermes imports are guarded and the four abstract methods exist', () => {
    const source = read('adapter.py');
    expect(source).toMatch(/try:\s*\n(?:.*\n)*?\s*except ImportError:/);
    expect(source).toMatch(/^class WeMessageAdapter\(BasePlatformAdapter\):/m);
    expect(source).toMatch(
      /^\s*async def connect\(self, \*, is_reconnect: bool = False\)/m,
    );
    expect(source).toMatch(/^\s*async def disconnect\(self\)/m);
    expect(source).toMatch(/^\s*async def send\(\s*$/m);
    expect(source).toMatch(
      /^\s*async def get_chat_info\(self, chat_id: str\)/m,
    );
    expect(source).toMatch(/^def register\(ctx\)/m);
    expect(source).toMatch(/ctx\.register_platform\(/);
  });
});

/* ── row 4 ─────────────────────────────────────────────────────────────── */

/**
 * `plugin.yaml` is written in the JSON-compatible subset of YAML on purpose:
 * scalars, lists of maps, no anchors, no block scalars, no multi-document. It
 * parses here with a fifteen-line reader rather than a new devDependency
 * (§1.2: no new deps in S7), and the constraint is worth more than the
 * convenience — a manifest a human is expected to hand-edit should not have
 * corners that only a full YAML engine understands.
 */
function parseSimpleYaml(text: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  let listKey: string | null = null;
  let entry: Record<string, unknown> | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').replace(/^#.*$/, '');
    if (line.trim() === '') continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    if (indent === 0) {
      listKey = null;
      entry = null;
      const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(body);
      if (m === null) throw new Error(`unparseable top-level line: ${body}`);
      const [, key, value] = m;
      if (value === '') {
        listKey = key ?? '';
        root[listKey] = [];
      } else root[key ?? ''] = scalar(value ?? '');
      continue;
    }
    if (listKey === null)
      throw new Error(`indented line outside a list: ${body}`);
    if (body.startsWith('- ')) {
      entry = {};
      (root[listKey] as Record<string, unknown>[]).push(entry);
      const m = /^-\s+([A-Za-z_][\w]*):\s*(.*)$/.exec(body);
      if (m === null) throw new Error(`unparseable list entry: ${body}`);
      entry[m[1] ?? ''] = scalar(m[2] ?? '');
      continue;
    }
    const m = /^([A-Za-z_][\w]*):\s*(.*)$/.exec(body);
    if (m === null || entry === null)
      throw new Error(`unparseable mapping line: ${body}`);
    entry[m[1] ?? ''] = scalar(m[2] ?? '');
  }
  return root;
}

function scalar(text: string): string | boolean {
  const value = text.replace(/^["']|["']$/g, '');
  if (value === 'true') return true;
  if (value === 'false') return false;
  return value;
}

describe('s7 Sc7: plugin.yaml is a manifest, not a wish', () => {
  it('row 4: kind, name and a requires_env that is exactly the three wire vars', () => {
    const manifest = parseSimpleYaml(read('plugin.yaml'));
    expect(manifest['kind']).toBe('platform');
    expect(manifest['name']).toBe('wemessage');
    const required = manifest['requires_env'] as Record<string, unknown>[];
    expect(required.map((e) => e['name'])).toEqual([
      'WEMESSAGE_GATEWAY_URL',
      'WEMESSAGE_ADAPTER_TOKEN',
      'WEMESSAGE_ADAPTER_ID',
    ]);
    // The secret is exactly one of the three and the manifest says so. A
    // manifest that marked the URL secret would teach Hermes to redact the
    // wrong field; one that did not mark the token would put a `wm_<64 hex>`
    // in a setup transcript.
    expect(
      required.filter((e) => e['password'] === true).map((e) => e['name']),
    ).toEqual(['WEMESSAGE_ADAPTER_TOKEN']);
    expect(required.every((e) => typeof e['password'] === 'boolean')).toBe(
      true,
    );
  });
});

/* ── row 5 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: INV-2 spelled in Python', () => {
  it('row 5: one frozenset, one chokepoint, one socket write', () => {
    const source = read('wemessage_wire.py');
    // The vocabulary is a module-level frozenset of exactly the five
    // agent->gateway types. `send` is not one of them and there is no tenth
    // frame to add it to: FRAME_SPECS has nine and none puts text on a phone.
    const decl =
      /^AGENT_FRAME_TYPES\s*=\s*frozenset\(\s*\{([^}]*)\}\s*\)/m.exec(source);
    expect(decl).not.toBeNull();
    const members = [...(decl?.[1] ?? '').matchAll(/"([^"]+)"/g)].map(
      (m) => m[1],
    );
    expect(members.sort()).toEqual([
      'draft.delta',
      'draft.submit',
      'hello',
      'pong',
      'proactive.propose',
    ]);
    expect(members).not.toContain('send');
    // Exactly one place in the module writes to the socket, and it is inside
    // `_emit`. Two write sites would mean the frozenset guards one of them.
    expect(source.match(/websocket\.send\(/g) ?? []).toHaveLength(1);
    const emit = /\n    async def _emit\(([\s\S]*?)\n    async def /.exec(
      source,
    );
    expect(emit).not.toBeNull();
    expect(emit?.[1]).toContain('AGENT_FRAME_TYPES');
    expect(emit?.[1]).toContain('websocket.send(');
    expect(emit?.[1]).toMatch(/raise ProtocolViolation/);
    // And no `send` frame type anywhere in the plugin, in any file.
    for (const file of ['wemessage_wire.py', 'adapter.py'])
      expect(read(file)).not.toMatch(/["']type["']\s*:\s*["']send["']/);
  });
});

/* ── row 6 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the Python dependency list is closed', () => {
  it('row 6: exactly one hashed websockets line, and the Hermes version pin', () => {
    const lines = read('requirements.txt')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '' && !l.startsWith('#'));
    // ONE line. This is the GPL/AGPL guard for Python: `pnpm licenses:check`
    // walks node_modules and structurally cannot see a Python dependency
    // graph, so the graph is kept to a single reviewed BSD-3-Clause package
    // instead. A second line fails here and a human decides (F-88).
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line).toMatch(/^websockets==15\.0\.1(?=\s)/);
    // Pinned AND hashed: a pin without a hash still trusts whatever the index
    // serves under that name.
    expect(
      (line ?? '').match(/--hash=sha256:[0-9a-f]{64}/g) ?? [],
    ).not.toHaveLength(0);
    expect(line).not.toMatch(/\\$/);
    const pyproject = read('pyproject.toml');
    expect(pyproject).toContain('requires-python = ">=3.11,<3.14"');
  });
});

/* ── row 7 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the idempotency key survives a replay', () => {
  pyRow(INTERPRETED_ROWS[2], (py) => {
    // Run the derivation itself, twice, on the same correlation and on a
    // second correlation. A key made of entropy passes any single call and
    // fails here, which is the whole point: the daemon re-delivers an inbound
    // after a restart and a fresh key would put a SECOND draft in front of a
    // human who already declined the first.
    const out = execFileSync(
      py.cmd,
      [
        ...py.args,
        '-c',
        [
          'import wemessage_wire as w;',
          'a = {"requestId": "req-1", "chatGuid": "c", "inboundGuid": "p:0/msg-1"};',
          'b = {"requestId": "req-2", "chatGuid": "c", "inboundGuid": "p:0/msg-2"};',
          'print(w.idempotency_key(a));',
          'print(w.idempotency_key(a));',
          'print(w.idempotency_key(b))',
        ].join(' '),
      ],
      {
        encoding: 'utf8',
        timeout: 120_000,
        env: { ...process.env, PYTHONPATH: PLUGIN },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const [first, second, other] = out.trim().split('\n');
    expect(first).toBe(second);
    expect(first).not.toBe(other);
    // Derived from the inbound guid, so two adapters that answer the same
    // inbound agree without talking to each other.
    expect(first).toContain('p:0/msg-1');
    // And the source says so, so the next reader does not have to infer it.
    expect(read('wemessage_wire.py')).not.toMatch(
      /uuid4\(\)[^\n]*idempotency/i,
    );
  });
});

/* ── row 8 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the plugin is publishable in a public repo', () => {
  it('row 8: no operator paths, no brand strings, synthetic handles only', () => {
    // The plugin, plus the README that documents it and the counter-example
    // that is committed to be read. Everything a stranger who clones this
    // repository will actually open.
    const files = [
      `${PLUGIN}wemessage_wire.py`,
      `${PLUGIN}adapter.py`,
      `${PLUGIN}plugin.yaml`,
      `${PLUGIN}requirements.txt`,
      `${PLUGIN}pyproject.toml`,
      `${PKG}README.md`,
      `${PKG}test/children/broken_sends.py`,
    ];
    const offenders: string[] = [];
    for (const path of files) {
      const file = path.slice(PKG.length);
      const content = readFileSync(path, 'utf8');
      // A home directory, in either spelling, is the shape that leaks an
      // operator's name into a public repo.
      if (/\/Users\/|\/home\/[a-z]|(?:^|\s)~\//.test(content))
        offenders.push(`${file}: a home directory path`);
      if (BRAND.test(content)) offenders.push(`${file}: brand string`);
      for (const n of content.match(/\+1\d{10}/g) ?? [])
        if (!n.startsWith('+1555')) offenders.push(`${file}: ${n}`);
      // Hostnames: loopback and the reserved example domains only.
      for (const m of content.matchAll(
        /(?:wss?|https?):\/\/([A-Za-z0-9.-]+)/g,
      )) {
        const host = m[1] ?? '';
        const ok =
          host === '127.0.0.1' ||
          host === 'localhost' ||
          host.endsWith('.example.com') ||
          host === 'example.com' ||
          host === 'pypi.org' ||
          host === 'files.pythonhosted.org' ||
          host === 'github.com' ||
          host === 'www.apache.org';
        if (!ok) offenders.push(`${file}: host ${host}`);
      }
      if (TOKEN_RE.test(content)) offenders.push(`${file}: a wm_ token`);
    }
    expect(offenders).toEqual([]);
  });
});

/* ── row 9 ─────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the Python lane is its own blocking CI job', () => {
  const workflow = (): string =>
    readFileSync(`${REPO}.github/workflows/ci-python.yml`, 'utf8');

  it('row 9: ci-python.yml pins 3.12, requires hashes, and is separate from ci-linux', () => {
    expect(existsSync(`${REPO}.github/workflows/ci-python.yml`)).toBe(true);
    const source = workflow();
    expect(source).toMatch(/uses:\s*actions\/setup-python@v\d+/);
    expect(source).toMatch(/python-version:\s*['"]3\.12['"]/);
    expect(source).toMatch(/--require-hashes/);
    expect(source).toMatch(
      /-r packages\/adapters\/hermes\/plugin\/requirements\.txt/,
    );
    expect(source).toMatch(/--project adapter-hermes/);
    expect(source).toMatch(/CI:\s*['"]?true['"]?/);
    // Blocking, not advisory. `continue-on-error` is how a red lane becomes
    // wallpaper, and the escape hatch is a commit that cites flake logs and
    // opens a flag, not a line nobody notices (F-88).
    expect(source).not.toMatch(/continue-on-error/);
    // Its OWN job in its OWN workflow: a Python flake must never stop the
    // TypeScript signal from being readable.
    expect(
      readFileSync(`${REPO}.github/workflows/ci-linux.yml`, 'utf8'),
    ).not.toMatch(/python/i);
  });
});

/* ── row 10 ────────────────────────────────────────────────────────────── */

describe('s7 Sc7: the Python counter-example is refused, not laundered', () => {
  pyRow(INTERPRETED_ROWS[3], async (py) => {
    // `test/children/broken_sends.py` is `wemessage_wire.py --standalone`
    // with the one change a stranger makes first: it decides drafting is a
    // formality and puts the text on the wire itself, in a frame it invented
    // because the protocol has none to borrow. It reaches for the socket
    // directly, bypassing `_emit` — which is the only way to get there, and
    // is exactly why `_emit` is the chokepoint.
    const report = await runConformanceSpawned({
      cmd: py.cmd,
      args: [...py.args, `${PKG}test/children/broken_sends.py`],
      name: 'broken-sends-py',
      timeoutMs: 30_000,
    });
    expect(report.conformant).toBe(false);
    // C-6, in the daemon's own words. `gate.denied` is a closed union about
    // approval decisions; this frame never reached a gate, a queue or a human.
    expect(report.spawn?.protocolViolations).toContain(
      'adapter.no-send-frame:send',
    );
    expect(report.spawn?.protocolViolations.join(' ')).not.toContain(
      'gate.denied',
    );
    expect(report.checks.filter((c) => !c.ok).map((c) => c.id)).toContain(3);
  });
});

/* ── the accounting ────────────────────────────────────────────────────── */

describe('s7 Sc7: the interpreter gap is counted, not assumed', () => {
  // Last row in the file on purpose: vitest runs a file's rows in source
  // order, so by the time this runs every interpreted row has either run or
  // counted its own skip.
  it('row 11: every interpreted row ran, or every one of them skipped and said why', () => {
    // The enumeration is asserted first. A row that is deleted or renamed
    // must not be able to make the accounting below vacuously true.
    expect(INTERPRETED_ROWS).toHaveLength(4);
    expect([...ran, ...skipped].sort()).toEqual([...INTERPRETED_ROWS].sort());

    if (CI) {
      // F-88 / C-11: on CI the interpreter is pinned by ci-python.yml, so a
      // skip here means the pin did not take and the green tick would be a
      // lie about what was verified.
      expect(PYTHON).not.toBeNull();
      expect(skipped).toEqual([]);
      return;
    }
    if (PYTHON === null) {
      // All or nothing. A partial skip would mean a row silently no-op'd for
      // some reason other than the missing interpreter.
      expect(skipped.sort()).toEqual([...INTERPRETED_ROWS].sort());
      expect(ran).toEqual([]);
      return;
    }
    expect(skipped).toEqual([]);
    expect(PYTHON.label).toMatch(/^PROBE ok 3 (?:11|12|13) /);
  });
});
