/**
 * v2 F8b: a paged first run. The first scan reads chat.db one bounded page
 * at a time instead of one unbounded readSince(0). While a backlog remains,
 * the mutation sweep is skipped and the watermark is pinned to "now" at the
 * first full page, so edits made before WeMessage ever ran are history, not
 * mutations. Edits after catch-up still flow through onMutation.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createChatDb } from '@wemessage/fixtures';
import { openStore } from '@wemessage/store';
import { createScanLoop } from '@wemessage/ingest';
import type { Clock, Message } from '@wemessage/core';

const FIXED_NOW = '2026-01-05T12:00:00.000Z';
const clock: Clock = {
  now: () => FIXED_NOW,
  nowMs: () => Date.parse(FIXED_NOW),
};

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('v2 F8b paged first run', () => {
  it('catches up page by page with zero mutations for historical edits, then sees new edits', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-paged-first-run-'));
    const fixture = createChatDb(join(dir, 'chat.db'));
    const chatId = fixture.addChat({ identifier: '+15555550134' });
    const handleId = fixture.addHandle('+15555550134');
    const store = openStore({ dir: join(dir, 'store'), clock });
    cleanups.push(() => {
      store.close();
      fixture.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const refs = fixture.addMessageBurst(10, {
      chatId,
      handleId,
      text: 'hello',
      startAt: '2026-01-02T00:00:00Z',
    });
    // Edited before WeMessage ever ran: history, not a mutation.
    fixture.editMessage(refs[2]!.guid, 'old edit', {
      at: '2026-01-03T00:00:00Z',
    });

    const emitted: Message[] = [];
    const mutations: Message[] = [];
    const scanner = createScanLoop({
      chatDbPath: fixture.path,
      store,
      clock,
      pageSize: 4,
      onMessage: (m) => emitted.push(m),
      onMutation: (m) => mutations.push(m),
    });

    const pages: number[] = [];
    do {
      pages.push((await scanner.scanOnce()).length);
    } while (scanner.hasBacklog());

    expect(pages).toEqual([4, 4, 2]);
    expect(emitted).toHaveLength(10);
    expect(mutations).toHaveLength(0);

    fixture.editMessage(refs[5]!.guid, 'new edit', {
      at: '2026-01-06T00:00:00Z',
    });
    await scanner.scanOnce();
    expect(mutations.map((m) => m.guid)).toEqual([refs[5]!.guid]);
  });
});
