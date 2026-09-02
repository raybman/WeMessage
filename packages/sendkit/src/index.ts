import type { SendBackend, SendOutcome } from '@wemessage/core';

export type { SendBackend };

/**
 * Placeholder send backend. Real backends (applescript / shortcuts / beeper) land
 * in S3 (§2.2.2). Present in S1 only so the sendkit -> core arrow is locked and the
 * T-9.3 recovery path has a type to consume as a must-not-call fake (F-2).
 */
export class NotImplementedSendBackend implements SendBackend {
  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }
  send(): Promise<SendOutcome> {
    return Promise.reject(new Error('sendkit is not implemented until S3'));
  }
}
