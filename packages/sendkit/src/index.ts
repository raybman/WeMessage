/**
 * @wemessage/sendkit — outbound send capability (s3-execution §1.1).
 * The S1 stub (`NotImplementedSendBackend`) is retired here: Scenario 2
 * lands the real AppleScript backend (C-3, s3-execution.md).
 */
import type { SendBackend } from '@wemessage/core';

export type { SendBackend };
export * from './applescript.js';
export * from './probes.js';
