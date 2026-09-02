/**
 * Automation + running-state probes (s3-execution §1.8 doctor table,
 * Scenario 2). Both are osascript-backed (the "osascript home" — sendkit
 * owns every osascript string in the repo, per Scenario 1's arch gate) but
 * side-effect-free: neither script sends, creates, or mutates anything.
 */
import type { ExecFn } from './applescript.js';

/**
 * Benign automation-permission probe. Deliberately contains no send/make/
 * tell-to-send token — probing must never risk a real action (§1.8).
 */
export const AUTOMATION_PROBE_SCRIPT =
  'tell application "Messages" to get version';

export const MESSAGES_RUNNING_SCRIPT = 'application "Messages" is running';

export type AutomationProbeResult = 'ok' | 'denied' | 'not-determined';

/** -1743 = "not authorized to send Apple events" (denied); 0 = ok; else = not-determined. */
export async function probeAutomation(
  exec: ExecFn,
): Promise<AutomationProbeResult> {
  const result = await exec('osascript', ['-e', AUTOMATION_PROBE_SCRIPT]);
  if (result.code === 0) return 'ok';
  if (result.stderr.includes('-1743')) return 'denied';
  return 'not-determined';
}

/** pgrep-free: `application "Messages" is running` is a builtin AppleScript boolean. */
export async function isMessagesRunning(exec: ExecFn): Promise<boolean> {
  const result = await exec('osascript', ['-e', MESSAGES_RUNNING_SCRIPT]);
  return result.code === 0 && result.stdout.trim() === 'true';
}
