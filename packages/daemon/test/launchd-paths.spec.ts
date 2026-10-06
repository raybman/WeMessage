/**
 * S2a rows 7-9: which argument vector `service install` derives, now that a
 * native app can be the thing launchd supervises.
 *
 * `resolveProgramArguments` had no spec of its own before S2a: the plist
 * rows fed it hand-written vectors and the service rows took its dev answer
 * on faith. S2a gives it a branch that matters (the Swift host), so it gets
 * a home, and the rows here pin both the new branch and the old ones it must
 * not disturb.
 *
 * THE RULE. Exactly one new branch, and it fires only when the process says
 * it runs under the Swift host (`WEMESSAGE_HOST=swift`, which only the host
 * sets on its node child) AND an app root is known: either named by
 * `WEMESSAGE_APP_PATH` or read off the daemon entry's own location inside a
 * bundle. A dev tree has no host, so with neither it falls through to the
 * existing derivation unchanged.
 *
 * Pure strings throughout: nothing here touches a filesystem or the service
 * manager, and no path below exists on any machine that runs this file.
 */
import { describe, expect, it } from 'vitest';
import { resolveProgramArguments } from '../src/launchd/paths.js';
import { programArgumentsShape } from '../src/launchd/plist.js';

const APP = '/Applications/WeMessage.app';
const EXE = `${APP}/Contents/MacOS/WeMessage`;
/** The daemon entry as `resolveDaemonMain` finds it inside the bundle. */
const BUNDLED_MAIN = `${APP}/Contents/Resources/daemon/main.mjs`;
/** The node binary the node-flavour bundle carries beside it. */
const BUNDLED_NODE = `${APP}/Contents/Resources/daemon/node`;
const DEV_MAIN = '/repo/packages/daemon/dist/main.js';
const DEV_NODE = '/usr/local/bin/node';

describe('S2a rows 7-9: resolveProgramArguments and the host branch', () => {
  it('row 7: WEMESSAGE_HOST=swift and a bundled daemonMain, no APP_PATH, yields the host pair', () => {
    // The path the bundled `wemessaged service install` takes: the shim
    // exports WEMESSAGE_HOST=swift, and the entry sits inside the app.
    const args = resolveProgramArguments(
      { WEMESSAGE_HOST: 'swift' },
      BUNDLED_MAIN,
      BUNDLED_NODE,
    );
    expect(args).toEqual([EXE, '--daemon']);
    // And the renderer agrees it is the host shape, so the derivation and
    // the refusal list cannot drift apart without a row noticing.
    expect(programArgumentsShape(args)).toBe('host');
  });

  it('row 7, empty APP_PATH: an empty override is no override, and the marker still decides', () => {
    expect(
      resolveProgramArguments(
        { WEMESSAGE_HOST: 'swift', WEMESSAGE_APP_PATH: '' },
        BUNDLED_MAIN,
        BUNDLED_NODE,
      ),
    ).toEqual([EXE, '--daemon']);
  });

  it('row 8: WEMESSAGE_HOST=swift with WEMESSAGE_APP_PATH yields the host pair for that app', () => {
    const other = '/tmp/wm-test/WeMessage.app';
    expect(
      resolveProgramArguments(
        { WEMESSAGE_HOST: 'swift', WEMESSAGE_APP_PATH: other },
        DEV_MAIN,
        DEV_NODE,
      ),
    ).toEqual([`${other}/Contents/MacOS/WeMessage`, '--daemon']);
    // Without the host variable the same env is the Electron bundle pair,
    // exactly as before S2a.
    expect(
      resolveProgramArguments(
        { WEMESSAGE_APP_PATH: other },
        DEV_MAIN,
        DEV_NODE,
      ),
    ).toEqual([
      `${other}/Contents/MacOS/WeMessage`,
      `${other}/Contents/Resources/daemon/main.mjs`,
    ]);
  });

  it('row 9: the Electron executable inside a bundle still yields the bundle pair', () => {
    // Regression guard: the new branch must not fire under Electron, which
    // runs the daemon with its own executable and never sets the variable.
    const bundle = [EXE, BUNDLED_MAIN];
    expect(resolveProgramArguments({}, BUNDLED_MAIN, EXE)).toEqual(bundle);
    expect(programArgumentsShape(bundle)).toBe('bundle');
  });

  it('row 9, near misses: only the exact string swift selects the host', () => {
    for (const value of [
      '',
      'Swift',
      'SWIFT',
      'swift ',
      ' swift',
      '1',
      'electron',
    ])
      expect(
        resolveProgramArguments({ WEMESSAGE_HOST: value }, BUNDLED_MAIN, EXE),
        JSON.stringify(value),
      ).toEqual([EXE, BUNDLED_MAIN]);
  });

  it('a dev tree has no host: WEMESSAGE_HOST=swift with no app root falls through to dev', () => {
    expect(
      resolveProgramArguments({ WEMESSAGE_HOST: 'swift' }, DEV_MAIN, DEV_NODE),
    ).toEqual([DEV_NODE, DEV_MAIN]);
    // And the explicit-entry override keeps working under it too.
    expect(
      resolveProgramArguments(
        {
          WEMESSAGE_HOST: 'swift',
          WEMESSAGE_DAEMON_MAIN: '/opt/wm/dist/main.js',
        },
        DEV_MAIN,
        DEV_NODE,
      ),
    ).toEqual([DEV_NODE, '/opt/wm/dist/main.js']);
  });
});
