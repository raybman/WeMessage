/**
 * s3-execution.md Part 2 Scenario 2 — AppleScript backend, injection-safe,
 * exec-injected.
 *
 * `AppleScriptSendBackend` never shells out for real in tests: every
 * invocation goes through an injected `exec(cmd, args) -> {code, stdout,
 * stderr}` fake, matching the injection-seam pattern the daemon/ingest
 * suites already use for Clock/FsWatcher (S1/S2 precedent).
 *
 * Central property this scenario proves (§ Non-negotiable #2's structural
 * cousin from Scenario 1's arch gate, now proven at the unit level): the
 * frozen AppleScript text NEVER contains message content. Hostile bodies
 * travel as argv (`on run argv`), after a `--` separator, never as
 * string-interpolated script source — an injection attempt that would
 * escape a naive `osascript -e "tell app Messages to send \"" + body + ...`
 * implementation is inert here because the body is never in the string.
 */
import { homedir } from 'node:os';
import { describe, expect, it } from 'vitest';
import type { ExecFn, ExecResult } from '../src/applescript.js';
import { AppleScriptSendBackend, SEND_SCRIPT } from '../src/applescript.js';
import {
  AUTOMATION_PROBE_SCRIPT,
  MESSAGES_RUNNING_SCRIPT,
  isMessagesRunning,
  probeAutomation,
} from '../src/probes.js';

interface Invocation {
  cmd: string;
  args: string[];
}

/** Records every exec() call; `script` decides the canned result per call. */
function fakeExec(
  script: (cmd: string, args: string[], call: number) => ExecResult,
): { exec: ExecFn; calls: Invocation[] } {
  const calls: Invocation[] = [];
  const exec: ExecFn = async (cmd, args) => {
    calls.push({ cmd, args });
    return script(cmd, args, calls.length);
  };
  return { exec, calls };
}

const ok = (): ExecResult => ({ code: 0, stdout: '', stderr: '' });
const notRunning = (): ExecResult => ({
  code: 1,
  stdout: '',
  stderr:
    'execution error: Messages got an error: Application isn’t running. (-600)',
});

describe('AppleScriptSendBackend (Scenario 2)', () => {
  it('the frozen SEND_SCRIPT is a constant with no send()-body interpolation and no new-chat capability', () => {
    // Script text itself, independent of any invocation: no template
    // interpolation markers, no way to start a NEW conversation.
    expect(SEND_SCRIPT).not.toMatch(/\$\{|`\s*\+|"\s*\+\s*\w/);
    expect(SEND_SCRIPT).not.toContain('make new text chat');
    expect(SEND_SCRIPT).toContain('chat id');
    expect(SEND_SCRIPT).toContain('on run argv');
  });

  it('passes a hostile body + chatGuid via argv only — never inside script text', async () => {
    const hostileBody =
      '") do shell script ("rm -rf ~" -- "\n\t"emoji🔥" quotes " and \\ backslashes';
    const chatGuid = 'iMessage;-;+15550001111';
    const { exec, calls } = fakeExec(ok);
    const backend = new AppleScriptSendBackend({ exec });

    const result = await backend.send({ chatGuid, body: hostileBody });

    expect(result).toEqual({ accepted: true });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.cmd).toBe('osascript');

    const sepIndex = call.args.indexOf('--');
    expect(sepIndex).toBeGreaterThan(0);
    const scriptArgs = call.args.slice(0, sepIndex).join('\n');
    const argv = call.args.slice(sepIndex + 1);

    // script text is byte-identical to the frozen constant — no interpolation.
    expect(scriptArgs).toContain(SEND_SCRIPT);
    expect(scriptArgs).not.toContain(hostileBody);
    expect(scriptArgs).not.toContain('rm -rf');
    expect(scriptArgs).not.toContain(chatGuid);

    // the hostile content appears byte-identical in argv, after `--`.
    expect(argv).toEqual([chatGuid, hostileBody]);
  });

  it('targets an existing chat by id; contains no make-new-chat capability (no-conversation is resolved upstream)', () => {
    expect(SEND_SCRIPT).not.toContain('make new text chat');
    expect(SEND_SCRIPT).toMatch(/chat id \(item 1 of argv\)/);
  });

  describe('exit-code mapping', () => {
    it('-600 (Messages not running) + autoLaunch:true launches, delays, retries once, then succeeds', async () => {
      const { exec, calls } = fakeExec((cmd, _args, call) => {
        if (cmd === 'open') return ok();
        // call 1: initial send fails not-running; call 2 (after launch): succeeds.
        return call === 1 ? notRunning() : ok();
      });
      const delays: number[] = [];
      const backend = new AppleScriptSendBackend({
        exec,
        autoLaunch: true,
        delay: async (ms) => {
          delays.push(ms);
        },
      });

      const result = await backend.send({ chatGuid: 'g1', body: 'hi' });

      expect(result).toEqual({ accepted: true });
      expect(calls.filter((c) => c.cmd === 'osascript')).toHaveLength(2);
      const launch = calls.find((c) => c.cmd === 'open');
      expect(launch?.args).toEqual(['-a', 'Messages']);
      expect(delays).toHaveLength(1);
      expect(delays[0]).toBeGreaterThan(0);
    });

    it('-600 + autoLaunch:true retries once, and still fails if Messages never comes up', async () => {
      const { exec, calls } = fakeExec((cmd) =>
        cmd === 'open' ? ok() : notRunning(),
      );
      const backend = new AppleScriptSendBackend({
        exec,
        autoLaunch: true,
        delay: async () => {},
      });

      const result = await backend.send({ chatGuid: 'g1', body: 'hi' });

      expect(result.accepted).toBe(false);
      expect(result.errorCode).toBe('messages-not-running');
      expect(result.detail).toContain('-600');
      // exactly one retry — not an unbounded loop.
      expect(calls.filter((c) => c.cmd === 'osascript')).toHaveLength(2);
      expect(calls.filter((c) => c.cmd === 'open')).toHaveLength(1);
    });

    it('-600 + autoLaunch:false surfaces messages-not-running immediately, no launch, no retry', async () => {
      const { exec, calls } = fakeExec(notRunning);
      const backend = new AppleScriptSendBackend({ exec, autoLaunch: false });

      const result = await backend.send({ chatGuid: 'g1', body: 'hi' });

      expect(result).toEqual({
        accepted: false,
        errorCode: 'messages-not-running',
        detail: expect.stringContaining('-600'),
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.cmd).toBe('osascript');
    });

    it('any other nonzero exit maps to backend-error with a sanitized, capped stderr tail', async () => {
      const home = homedir();
      const noisy = 'x'.repeat(2_000);
      const { exec } = fakeExec(() => ({
        code: 1,
        stdout: '',
        stderr: `${noisy} boom at ${home}/Desktop/private-notes.txt`,
      }));
      const backend = new AppleScriptSendBackend({ exec });

      const result = await backend.send({ chatGuid: 'g1', body: 'hi' });

      expect(result.accepted).toBe(false);
      expect(result.errorCode).toBe('backend-error');
      expect(result.detail).toBeDefined();
      expect(result.detail!.length).toBeLessThanOrEqual(500);
      expect(result.detail).not.toContain(home);
      expect(result.detail).toContain('boom');
    });
  });

  describe('isAvailable()', () => {
    it('true only when the automation probe is ok AND Messages is running', async () => {
      // call 1 = automation probe (exit 0 is sufficient); call 2 = the
      // running check, which additionally reads stdout for "true".
      const { exec: bothOk } = fakeExec((_cmd, _args, call) =>
        call === 2 ? { code: 0, stdout: 'true', stderr: '' } : ok(),
      );
      expect(
        await new AppleScriptSendBackend({ exec: bothOk }).isAvailable(),
      ).toBe(true);

      const { exec: notAuthorized } = fakeExec(() => ({
        code: 1,
        stdout: '',
        stderr: 'execution error (-1743)',
      }));
      expect(
        await new AppleScriptSendBackend({ exec: notAuthorized }).isAvailable(),
      ).toBe(false);
    });

    it('false when automation is ok but Messages is not running', async () => {
      let call = 0;
      const { exec } = fakeExec(() => {
        call += 1;
        // call 1: automation probe -> ok; call 2: running check -> "false"
        return call === 1 ? ok() : { code: 0, stdout: 'false', stderr: '' };
      });
      expect(await new AppleScriptSendBackend({ exec }).isAvailable()).toBe(
        false,
      );
    });
  });

  describe('probes.ts', () => {
    it('AUTOMATION_PROBE_SCRIPT is side-effect-free: no send/make/tell-to-send tokens', () => {
      expect(AUTOMATION_PROBE_SCRIPT).not.toMatch(/\bsend\b/i);
      expect(AUTOMATION_PROBE_SCRIPT).not.toMatch(/\bmake\b/i);
      expect(AUTOMATION_PROBE_SCRIPT).not.toMatch(/tell.*to\s+send/i);
    });

    it('probeAutomation: exit 0 -> ok, -1743 -> denied, anything else -> not-determined', async () => {
      const { exec: okExec } = fakeExec(ok);
      expect(await probeAutomation(okExec)).toBe('ok');

      const { exec: deniedExec } = fakeExec(() => ({
        code: 1,
        stdout: '',
        stderr: 'execution error: Not authorized (-1743)',
      }));
      expect(await probeAutomation(deniedExec)).toBe('denied');

      const { exec: weirdExec } = fakeExec(() => ({
        code: 1,
        stdout: '',
        stderr: 'some other error',
      }));
      expect(await probeAutomation(weirdExec)).toBe('not-determined');
    });

    it('isMessagesRunning: pgrep-free — reads the osascript boolean result', async () => {
      const { exec: running, calls } = fakeExec(() => ({
        code: 0,
        stdout: 'true',
        stderr: '',
      }));
      expect(await isMessagesRunning(running)).toBe(true);
      expect(calls[0]!.args).toContain(MESSAGES_RUNNING_SCRIPT);

      const { exec: notRunningExec } = fakeExec(() => ({
        code: 0,
        stdout: 'false',
        stderr: '',
      }));
      expect(await isMessagesRunning(notRunningExec)).toBe(false);
    });
  });
});
