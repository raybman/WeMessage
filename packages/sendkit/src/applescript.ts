/**
 * AppleScript send backend (s3-execution §1.3, §2.2.2, Scenario 2).
 *
 * Injection safety is the whole point of this file: the AppleScript source
 * (`SEND_SCRIPT`) is a FROZEN CONSTANT, never built from message content.
 * `chatGuid`/`body` travel exclusively as `osascript`'s own argv mechanism
 * (`-e <script> -- <chatGuid> <body>`, read inside the script via
 * `on run argv`). A hostile body can contain anything — quotes, backslashes,
 * `") do shell script ("` — and it never touches the script text, so there
 * is nothing for it to break out of.
 *
 * `exec` is injected (§ same seam convention as Clock/FsWatcher elsewhere in
 * this repo): tests never spawn a real osascript (s3 Scenario 1's arch gate
 * makes that structural); production wiring (Scenario 6+) supplies a real
 * `execFile`-backed implementation.
 */
import { homedir } from 'node:os';
import type {
  SendBackend,
  SendFileInput,
  SendInput,
  SendOutcome,
} from '@wemessage/core';
import { isMessagesRunning, probeAutomation } from './probes.js';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Injection seam: production supplies execFile('osascript'|'open', args). */
export type ExecFn = (cmd: string, args: string[]) => Promise<ExecResult>;

export interface AppleScriptSendBackendOptions {
  exec: ExecFn;
  /** Injected so tests run in fake time (same convention as sendkit/verify.ts, Sc 4). */
  delay?: (ms: number) => Promise<void>;
  /**
   * settings['send.autoLaunchMessages'] (design note, §2.2.2 exit-code
   * mapping) — no toggle API exists in S3; callers read the setting and
   * pass it through. Defaults true.
   */
  autoLaunch?: boolean;
}

/**
 * Frozen script text — never interpolated. `chat id (item 1 of argv)`
 * targets an EXISTING conversation only; there is no `make new text chat`
 * anywhere in this file, by design (new-recipient sends fail fast upstream
 * as `no-conversation`, §2.2.2 — AppleScript cannot start one).
 */
export const SEND_SCRIPT = [
  'on run argv',
  '  tell application "Messages"',
  '    send (item 2 of argv) to chat id (item 1 of argv)',
  '  end tell',
  'end run',
].join('\n');

/**
 * v2 F6e: the file twin of SEND_SCRIPT, frozen the same way. The outbox
 * path is item 2 of argv and becomes a file reference only inside the
 * script (`POSIX file`), so a path containing quotes or AppleScript is
 * inert text. Same existing-chat-only target as SEND_SCRIPT.
 */
export const SEND_FILE_SCRIPT = [
  'on run argv',
  '  tell application "Messages"',
  '    send (POSIX file (item 2 of argv)) to chat id (item 1 of argv)',
  '  end tell',
  'end run',
].join('\n');

const LAUNCH_WAIT_MS = 1500;
const DETAIL_MAX_LEN = 500;

function isMessagesNotRunningError(result: ExecResult): boolean {
  return result.code !== 0 && result.stderr.includes('-600');
}

/** Strip the operator's home dir and cap length — §2.2.2 "sanitized stderr tail". */
function sanitizeDetail(stderr: string): string {
  const home = homedir();
  const stripped = home.length > 0 ? stderr.split(home).join('~') : stderr;
  const tail =
    stripped.length > DETAIL_MAX_LEN
      ? stripped.slice(-DETAIL_MAX_LEN)
      : stripped;
  return tail.trim();
}

export class AppleScriptSendBackend implements SendBackend {
  private readonly exec: ExecFn;
  private readonly delayFn: (ms: number) => Promise<void>;
  private readonly autoLaunch: boolean;

  constructor(opts: AppleScriptSendBackendOptions) {
    this.exec = opts.exec;
    this.delayFn =
      opts.delay ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.autoLaunch = opts.autoLaunch ?? true;
  }

  async isAvailable(): Promise<boolean> {
    const automation = await probeAutomation(this.exec);
    if (automation !== 'ok') return false;
    return isMessagesRunning(this.exec);
  }

  private runScript(
    script: string,
    chatGuid: string,
    payload: string,
  ): Promise<ExecResult> {
    // argv AFTER `--`: osascript stops flag parsing there, so a body (or a
    // file path) that happens to start with `-` is never mistaken for an
    // osascript flag.
    return this.exec('osascript', ['-e', script, '--', chatGuid, payload]);
  }

  async send(input: SendInput): Promise<SendOutcome> {
    return this.deliver(() =>
      this.runScript(SEND_SCRIPT, input.chatGuid, input.body),
    );
  }

  /**
   * v2 F6e: send one outbox file. Only the path reaches osascript; the
   * name is for the dispatcher's verify. The same -600 handling as text.
   */
  async sendFile(input: SendFileInput): Promise<SendOutcome> {
    return this.deliver(() =>
      this.runScript(SEND_FILE_SCRIPT, input.chatGuid, input.file.path),
    );
  }

  private async deliver(run: () => Promise<ExecResult>): Promise<SendOutcome> {
    const first = await run();
    if (first.code === 0) return { accepted: true };

    if (!isMessagesNotRunningError(first)) {
      return {
        accepted: false,
        errorCode: 'backend-error',
        detail: sanitizeDetail(first.stderr),
      };
    }

    if (!this.autoLaunch) {
      return {
        accepted: false,
        errorCode: 'messages-not-running',
        detail: sanitizeDetail(first.stderr),
      };
    }

    // auto-launch flow: launch Messages, wait, retry exactly once.
    await this.exec('open', ['-a', 'Messages']);
    await this.delayFn(LAUNCH_WAIT_MS);
    const retry = await run();
    if (retry.code === 0) return { accepted: true };
    return {
      accepted: false,
      errorCode: 'messages-not-running',
      detail: sanitizeDetail(retry.stderr),
    };
  }
}
