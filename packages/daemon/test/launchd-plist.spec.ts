/**
 * s9 Sc3 stage 1, rows 1-4 and 15 — the LaunchAgent plist, rendered from a
 * typed spec, and the four things it must never be turnable into.
 *
 * WHY A RENDERER AND NOT A TEMPLATE STRING. A plist is the file launchd
 * reads to decide what to run, as whom, and how often to run it again. The
 * difference between the agent this project installs and a background daemon
 * with the operator's session privileges is four keys. `UserName` runs it as
 * somebody else. `SessionCreate` gives it its own security session.
 * `LaunchOnlyOnce` turns the keep-alive contract off. `Sockets` makes it
 * socket-activated, which means launchd opens a listener on its behalf and
 * this project's single-instance lock stops being the thing that decides who
 * owns the directory. None of those four is exotic; all four are one line in
 * a template a maintainer edits at 1am. So the plist is not a template. It is
 * a value, built by a function that refuses to build the other kinds.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT DO. It never invokes the service
 * manager, not even to read. Every row here is a pure function over a spec
 * and a string; the closest it comes to the operating system is `plutil`,
 * which lints and converts property lists and cannot load, unload, start or
 * stop anything. Stage 1 of this scenario spawns no service-manager process
 * at all, and this file is the largest part of stage 1.
 *
 * PLAN DIVERGENCES, argued at the rows:
 *  - row 1's "round-trips to a deep-equal spec" is implemented as a
 *    round-trip to a deep-equal PLIST OBJECT (`launchAgentPlistObject`),
 *    because a parser cannot recover a spec: the spec's `dir` and `port` are
 *    environment entries by the time they are on disk, and its optional
 *    `throttleInterval` has been defaulted. The object is what the renderer
 *    serializes and what the parser recovers, so the round trip is over the
 *    thing that actually round-trips, and the spec-level facts are asserted
 *    separately in row 2.
 *  - the plan's §1.7 table gives ten keys; it does not say they are sorted.
 *    They are rendered sorted, because a diff of two plists that differ only
 *    in key order is a diff nobody reads.
 */
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { asLaunchAgentLabel } from '../src/launchd/contract.js';
import {
  FORBIDDEN_PLIST_KEYS,
  LAUNCH_AGENT_PLIST_KEYS,
  LaunchdPlistRefused,
  launchAgentPlistObject,
  parseLaunchAgentPlist,
  programArgumentsShape,
  renderLaunchAgentPlist,
  type LaunchAgentSpec,
} from '../src/launchd/plist.js';
import { LaunchdLabelRefused } from '../src/launchd/contract.js';
import { resolveBundlePaths } from '../src/launchd/paths.js';

const DARWIN = process.platform === 'darwin';

/** The packaged shape (F-121): the app executable, then the daemon bundle. */
const APP = '/Applications/WeMessage.app';
const BUNDLE_ARGS = [
  `${APP}/Contents/MacOS/WeMessage`,
  `${APP}/Contents/Resources/daemon/main.mjs`,
] as const;

/**
 * The dev shape. Stage 2 needs it because the packaged app does not exist
 * until Sc 6, and a renderer that only knew the bundle shape would force the
 * lifecycle rows to hand-write a plist — which is the one thing this module
 * exists to stop anybody doing.
 */
const DEV_ARGS = [
  process.execPath,
  '/repo/packages/daemon/dist/main.js',
] as const;

function spec(over: Partial<LaunchAgentSpec> = {}): LaunchAgentSpec {
  return {
    label: asLaunchAgentLabel('sh.wemessage.gateway'),
    programArguments: BUNDLE_ARGS,
    stdoutPath: '/tmp/wemessage/daemon.out.log',
    stderrPath: '/tmp/wemessage/daemon.err.log',
    ...over,
  };
}

/* ── row 1: render, parse, and let macOS check our work ───────────────── */

describe('s9 Sc3 row 1: the plist round-trips, and plutil agrees', () => {
  it('parse(render(spec)) deep-equals the object the renderer serialized', () => {
    const s = spec({ dir: '/tmp/wm', port: 47_123, throttleInterval: 1 });
    expect(parseLaunchAgentPlist(renderLaunchAgentPlist(s))).toEqual(
      launchAgentPlistObject(s),
    );
  });

  it('the round trip survives every optional being absent', () => {
    // `exactOptionalPropertyTypes`: an omitted `dir` is an ABSENT key in the
    // rendered EnvironmentVariables dict, never a key whose value is the
    // string "undefined". That mistake renders, lints, and puts the four
    // characters u-n-d-e-f into a path launchd will chdir a daemon into.
    const s = spec();
    const obj = launchAgentPlistObject(s);
    const env = obj['EnvironmentVariables'] as Record<string, string>;
    expect(Object.keys(env).sort()).toEqual([
      'ELECTRON_RUN_AS_NODE',
      'WEMESSAGE_LAUNCHD_LABEL',
      'WEMESSAGE_SUPERVISOR',
    ]);
    expect(parseLaunchAgentPlist(renderLaunchAgentPlist(s))).toEqual(obj);
  });

  it('the parser is not a stub: it reads types, not just text', () => {
    // Non-vacuity for the round trip. If `parseLaunchAgentPlist` returned
    // every value as a string, the two rows above would still pass against a
    // renderer that emitted every value as a string, and the plist would be
    // wrong in the one way launchd notices (`<string>true</string>` is not
    // `<true/>`, and `ThrottleInterval` as a string is ignored).
    const parsed = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ throttleInterval: 1 })),
    );
    expect(parsed['KeepAlive']).toBe(true);
    expect(parsed['RunAtLoad']).toBe(true);
    expect(parsed['ThrottleInterval']).toBe(1);
    expect(parsed['Label']).toBe('sh.wemessage.gateway');
    expect(parsed['ProgramArguments']).toEqual([...BUNDLE_ARGS]);
  });

  describe.skipIf(!DARWIN)(
    'and macOS agrees (plutil, which cannot load)',
    () => {
      it('plutil -lint exits 0 and -convert json agrees key for key', () => {
        const s = spec({ dir: '/tmp/wm', port: 47_123 });
        const xml = renderLaunchAgentPlist(s);
        // `plutil` reads and converts property lists. It has no verb that can
        // start, stop or load anything, which is why it is the one macOS tool
        // this stage is allowed to run.
        const lint = execFileSync('plutil', ['-lint', '-'], {
          input: xml,
          encoding: 'utf8',
        });
        expect(lint).toContain('OK');
        const json = execFileSync(
          'plutil',
          ['-convert', 'json', '-o', '-', '-'],
          { input: xml, encoding: 'utf8' },
        );
        expect(JSON.parse(json)).toEqual(launchAgentPlistObject(s));
      });
    },
  );
});

/* ── row 2: exactly the §1.7 keys, and exactly the §1.7 values ────────── */

describe('s9 Sc3 row 2: the key set is closed and the values are §1.7', () => {
  it('the rendered key list is exactly the ten keys, sorted', () => {
    const parsed = parseLaunchAgentPlist(renderLaunchAgentPlist(spec()));
    expect(Object.keys(parsed).sort()).toEqual([...LAUNCH_AGENT_PLIST_KEYS]);
    // Equality against a pinned tuple AND against a second, independently
    // written list: the tuple is what the renderer iterates, so a key
    // deleted from it would silently satisfy a row that only compared the
    // renderer to itself.
    expect([...LAUNCH_AGENT_PLIST_KEYS]).toEqual([
      'EnvironmentVariables',
      'KeepAlive',
      'Label',
      'LimitLoadToSessionType',
      'ProcessType',
      'ProgramArguments',
      'RunAtLoad',
      'StandardErrorPath',
      'StandardOutPath',
      'ThrottleInterval',
    ]);
  });

  it('every §1.7 value is what the plan says it is', () => {
    const s = spec({ dir: '/tmp/wm', port: 47_123 });
    const p = parseLaunchAgentPlist(renderLaunchAgentPlist(s));
    expect(p['Label']).toBe(s.label);
    const args = p['ProgramArguments'] as string[];
    expect(args[0]?.endsWith('/Contents/MacOS/WeMessage')).toBe(true);
    expect(args[1]?.endsWith('/Contents/Resources/daemon/main.mjs')).toBe(true);
    const env = p['EnvironmentVariables'] as Record<string, string>;
    expect(env['ELECTRON_RUN_AS_NODE']).toBe('1');
    expect(env['WEMESSAGE_SUPERVISOR']).toBe('launchd');
    expect(env['WEMESSAGE_LAUNCHD_LABEL']).toBe(s.label);
    expect(env['WEMESSAGE_DIR']).toBe('/tmp/wm');
    expect(env['WEMESSAGE_PORT']).toBe('47123');
    expect(p['KeepAlive']).toBe(true);
    expect(p['RunAtLoad']).toBe(true);
    expect(p['LimitLoadToSessionType']).toBe('Aqua');
    expect(p['ProcessType']).toBe('Background');
    expect(p['ThrottleInterval']).toBe(10);
    expect(p['StandardOutPath']).toBe(s.stdoutPath);
    expect(p['StandardErrorPath']).toBe(s.stderrPath);
  });

  it('chatDb is emitted exactly like dir and port, and is ABSENT by default', () => {
    /*
     * s9 Sc3 stage 2. WHY THIS KEY EXISTS AT ALL.
     *
     * A launchd job's environment is the plist's `EnvironmentVariables` and
     * nothing else — there is no shell, no profile, no inherited PATH. So a
     * supervised daemon with no `WEMESSAGE_CHATDB` does not fall back to a
     * test fixture. It falls back to the default in `main.ts`, which is the
     * operator's real message database. That is a latent hazard in the
     * product, not merely an inconvenience in a test: `service install` on
     * a developer machine would point a background agent at real messages
     * with nothing in the plist saying so.
     *
     * THAT DEFAULT PATH IS DESCRIBED HERE, NEVER SPELLED. Arch gate (b)
     * forbids any test file from naming it, and this comment is the third
     * time in this scenario that a file has convicted itself by writing out
     * the literal it was explaining that it must not write out. The fix is
     * always to reword or to assemble, and never to add a carrier to the
     * guard: a guard with an exemption for the file most likely to leak is
     * not a guard. Read `main.ts` if you need the value.
     *
     * Emitted EXACTLY like `dir` and `port`: an absent override is an
     * absent key (F-80), which is why the ten-key rows above still hold.
     */
    const bare = parseLaunchAgentPlist(renderLaunchAgentPlist(spec()));
    const bareEnv = bare['EnvironmentVariables'] as Record<string, string>;
    expect('WEMESSAGE_CHATDB' in bareEnv).toBe(false);
    expect(Object.keys(bare).sort()).toEqual([...LAUNCH_AGENT_PLIST_KEYS]);

    const set = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ chatDb: '/tmp/wm/chat.db' })),
    );
    const setEnv = set['EnvironmentVariables'] as Record<string, string>;
    expect(setEnv['WEMESSAGE_CHATDB']).toBe('/tmp/wm/chat.db');
    // Non-vacuity: adding it changed the env dict and NOTHING else.
    expect(Object.keys(set).sort()).toEqual([...LAUNCH_AGENT_PLIST_KEYS]);
    expect(Object.keys(setEnv).sort()).toEqual(
      [...Object.keys(bareEnv), 'WEMESSAGE_CHATDB'].sort(),
    );
  });

  it('ThrottleInterval defaults to 10 and is overridable to 1 for tests', () => {
    const d = parseLaunchAgentPlist(renderLaunchAgentPlist(spec()));
    expect(d['ThrottleInterval']).toBe(10);
    const t = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ throttleInterval: 1 })),
    );
    expect(t['ThrottleInterval']).toBe(1);
  });

  it('the dev shape is the SECOND legal shape, and it drops the electron flag', () => {
    // Stage 2 needs this: there is no packaged app until Sc 6, so the
    // lifecycle rows point the agent at the built entrypoint under the
    // repository's own node. `ELECTRON_RUN_AS_NODE` is tied to the shape
    // rather than passed in, because that variable set for a plain `node`
    // is a variable that means nothing, and a variable that means nothing
    // in a plist is a variable somebody copies into one where it does.
    expect(programArgumentsShape([...BUNDLE_ARGS])).toBe('bundle');
    expect(programArgumentsShape([...DEV_ARGS])).toBe('dev');
    const p = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ programArguments: DEV_ARGS })),
    );
    const env = p['EnvironmentVariables'] as Record<string, string>;
    expect(env['ELECTRON_RUN_AS_NODE']).toBeUndefined();
    expect(env['WEMESSAGE_SUPERVISOR']).toBe('launchd');
    // The key SET does not change with the shape: ten keys either way.
    expect(Object.keys(p).sort()).toEqual([...LAUNCH_AGENT_PLIST_KEYS]);
  });
});

/* ── row 3: the four refusals ─────────────────────────────────────────── */

describe('s9 Sc3 row 3: what the renderer refuses to build', () => {
  it('a label outside this project namespace (via a cast) is refused', () => {
    // The brand is a compile-time fiction and the renderer is a place a
    // label arrives from a config file. So it asks again.
    const foreign = ['com.', 'user.', 'sol', '-agent'].join('');
    expect(() =>
      renderLaunchAgentPlist(
        spec({ label: foreign as unknown as LaunchAgentSpec['label'] }),
      ),
    ).toThrow(LaunchdLabelRefused);
  });

  it('NEAR-MISS: our own test-scoped label renders fine', () => {
    const ours = asLaunchAgentLabel('sh.wemessage.test.01j0abc');
    expect(
      parseLaunchAgentPlist(renderLaunchAgentPlist(spec({ label: ours })))[
        'Label'
      ],
    ).toBe(ours);
  });

  it('programArguments[0] that is not the app executable is refused', () => {
    expect(() =>
      renderLaunchAgentPlist(
        spec({
          programArguments: [
            '/bin/sh',
            `${APP}/Contents/Resources/daemon/main.mjs`,
          ],
        }),
      ),
    ).toThrow(LaunchdPlistRefused);
    // …and the near miss that matters most: the RIGHT executable with the
    // wrong second argument is not a shape either. A plist that runs the
    // signed app binary against an arbitrary script is the same hole.
    expect(() =>
      renderLaunchAgentPlist(
        spec({
          programArguments: [
            `${APP}/Contents/MacOS/WeMessage`,
            '/tmp/anything.mjs',
          ],
        }),
      ),
    ).toThrow(LaunchdPlistRefused);
    expect(() =>
      renderLaunchAgentPlist(spec({ programArguments: [] })),
    ).toThrow(LaunchdPlistRefused);
    expect(() =>
      renderLaunchAgentPlist(
        spec({ programArguments: [...BUNDLE_ARGS, '--verbose'] }),
      ),
    ).toThrow(LaunchdPlistRefused);
  });

  it('the four convertibility keys are refused, by name, one at a time', () => {
    // Each one on its own, so a guard that only checked the first would
    // fail four rows rather than pass three.
    expect([...FORBIDDEN_PLIST_KEYS]).toEqual([
      'LaunchOnlyOnce',
      'SessionCreate',
      'Sockets',
      'UserName',
    ]);
    for (const key of FORBIDDEN_PLIST_KEYS) {
      expect(
        () => renderLaunchAgentPlist(spec({ extraKeys: { [key]: 'x' } })),
        key,
      ).toThrow(LaunchdPlistRefused);
      try {
        renderLaunchAgentPlist(spec({ extraKeys: { [key]: 'x' } }));
        expect.unreachable(`${key} was accepted`);
      } catch (err) {
        // The refusal names the key: a plist refusal that does not say
        // which key is a refusal somebody works around by bisection.
        expect((err as Error).message, key).toContain(key);
        expect((err as { code?: string }).code).toBe('LAUNCHD_PLIST_REFUSED');
      }
    }
  });

  it('NEAR-MISS: an ordinary extra key is allowed, and lands in the plist', () => {
    // A guard a legitimate caller must be exempted from is the wrong guard.
    // Sc 4 and Sc 7 will want `WatchPaths` or `ExitTimeOut`; the ban is four
    // named keys, not "no extra keys".
    const p = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ extraKeys: { ExitTimeOut: 30 } })),
    );
    expect(p['ExitTimeOut']).toBe(30);
    expect(Object.keys(p).sort()).toEqual(
      [...LAUNCH_AGENT_PLIST_KEYS, 'ExitTimeOut'].sort(),
    );
  });

  it('the refusals happen before anything is written anywhere', () => {
    // `renderLaunchAgentPlist` is pure. It returns a string; it does not
    // know what a filesystem is. Stated as a row because the natural next
    // edit is "and write it while we are here", and the install path's
    // ordering (§1.8: the audit row first) depends on the write being
    // somewhere the audit sink can be sequenced against.
    const src = renderLaunchAgentPlist.toString();
    for (const forbidden of ['writeFile', 'mkdir', 'spawn', 'execFile'])
      expect(src.includes(forbidden), forbidden).toBe(false);
  });
});

/* ── row 4: XML safety ────────────────────────────────────────────────── */

describe('s9 Sc3 row 4: a directory name cannot become markup', () => {
  // `&` first: an escaper that replaces `<` before `&` turns `<` into
  // `&amp;lt;`. The three characters are asserted together for that reason.
  const NASTY = '/tmp/a&b/c<d>/café-日本語';

  it('&, < and > are escaped in the rendered XML', () => {
    const xml = renderLaunchAgentPlist(spec({ dir: NASTY }));
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    // The raw characters never reach the file as markup.
    expect(xml.includes('<string>/tmp/a&b')).toBe(false);
  });

  it('and the value round-trips byte-exact through the parser', () => {
    const p = parseLaunchAgentPlist(
      renderLaunchAgentPlist(spec({ dir: NASTY })),
    );
    const env = p['EnvironmentVariables'] as Record<string, string>;
    expect(env['WEMESSAGE_DIR']).toBe(NASTY);
    expect(Buffer.from(env['WEMESSAGE_DIR'] ?? '', 'utf8')).toEqual(
      Buffer.from(NASTY, 'utf8'),
    );
  });

  it('the non-ASCII characters are UTF-8 in the file, not entities', () => {
    // Deliberate: `plutil` and launchd both read UTF-8, and numeric
    // entities for every accented character would make a plist unreadable
    // for a human debugging one at 2am.
    const xml = renderLaunchAgentPlist(spec({ dir: NASTY }));
    expect(xml).toContain('café');
    expect(xml.includes('&#')).toBe(false);
  });

  describe.skipIf(!DARWIN)('and plutil accepts the escaped file', () => {
    it('lints and converts back to the same bytes', () => {
      const xml = renderLaunchAgentPlist(spec({ dir: NASTY }));
      expect(
        execFileSync('plutil', ['-lint', '-'], {
          input: xml,
          encoding: 'utf8',
        }),
      ).toContain('OK');
      const json = JSON.parse(
        execFileSync('plutil', ['-convert', 'json', '-o', '-', '-'], {
          input: xml,
          encoding: 'utf8',
        }),
      ) as { EnvironmentVariables: Record<string, string> };
      expect(json.EnvironmentVariables['WEMESSAGE_DIR']).toBe(NASTY);
    });
  });
});

/* ── row 15: the default paths, asserted as STRINGS ───────────────────── */

describe('s9 Sc3 row 15: the defaults are strings, and nothing reads them', () => {
  /*
   * The whole row is "what would the installer choose if nobody overrode
   * anything", and the answer must be obtained WITHOUT touching the answer.
   * No test in this scenario writes to the real LaunchAgents directory, and
   * no test in stage 1 reads it either — not `existsSync`, not `readdir`.
   * A row that stat'd the real directory would pass on this machine and
   * would be the row that taught the next builder that reading it is fine.
   */
  it('resolveBundlePaths() names the user LaunchAgents dir and the gateway', () => {
    const paths = resolveBundlePaths({});
    expect(paths.launchAgentsDir).toBe(
      join(homedir(), 'Library', 'LaunchAgents'),
    );
    expect(paths.label).toBe('sh.wemessage.gateway');
    expect(paths.labelPrefix).toBe('sh.wemessage.');
    expect(paths.logsDir).toBe(join(homedir(), 'Library', 'Logs', 'WeMessage'));
    expect(paths.stdoutPath).toBe(join(paths.logsDir, 'daemon.out.log'));
    expect(paths.stderrPath).toBe(join(paths.logsDir, 'daemon.err.log'));
  });

  it('never /Library/LaunchAgents, and never a system domain', () => {
    // The user agent lives under the operator's home. The root-owned
    // directory of the same name is a different thing entirely and this
    // project never enters it (F-123).
    const paths = resolveBundlePaths({});
    expect(paths.launchAgentsDir.startsWith(homedir())).toBe(true);
    expect(paths.launchAgentsDir.startsWith('/Library/')).toBe(false);
  });

  it('the environment can move all three, which is how every test runs', () => {
    const paths = resolveBundlePaths({
      WEMESSAGE_LAUNCH_AGENTS_DIR: '/tmp/la',
      WEMESSAGE_LOGS_DIR: '/tmp/logs',
      WEMESSAGE_LAUNCHD_LABEL_PREFIX: 'sh.wemessage.test.',
    });
    expect(paths.launchAgentsDir).toBe('/tmp/la');
    expect(paths.logsDir).toBe('/tmp/logs');
    expect(paths.labelPrefix).toBe('sh.wemessage.test.');
    // Under the test prefix there is no single well-known label: each
    // install mints its own, so the field reports the prefix's own agent
    // name rather than pretending `sh.wemessage.gateway` is in scope.
    expect(paths.label.startsWith('sh.wemessage.test.')).toBe(true);
  });

  it('a label prefix outside this project is refused, not defaulted', () => {
    const foreign = ['com.', 'user.'].join('');
    expect(() =>
      resolveBundlePaths({ WEMESSAGE_LAUNCHD_LABEL_PREFIX: foreign }),
    ).toThrow(LaunchdLabelRefused);
  });
});
