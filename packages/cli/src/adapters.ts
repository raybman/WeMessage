/**
 * s5-execution Scenario 11 — `wemessage adapters` renderers.
 *
 * A separate module rather than more inline helpers in bin.ts, for the same
 * reason `purge.ts` is one: these are the rows a test must be able to hold
 * still. The load-bearing rule lives here — the adapter table renders a
 * WHITELIST of fields, so a registry read that ever starts carrying token
 * material cannot turn `adapters list` into a credential dump.
 *
 * Monochrome throughout (C-9, the no-green rule): no ANSI, anywhere.
 */
import type { AdapterCredential, AdapterPayload } from '@wemessage/client';

/** The only three things the TOKEN column can ever say. */
function tokenCell(adapter: AdapterPayload): string {
  return adapter.hasToken ? 'set' : 'none';
}

function healthCell(adapter: AdapterPayload): string {
  // A disabled adapter's health is stale by definition; say the disabling,
  // not the last health it happened to report.
  return adapter.enabled ? adapter.health : 'disabled';
}

/**
 * Fixed-width monochrome table, same shape as `drafts list` (S4): two-space
 * gutters, header row, trailing whitespace trimmed.
 */
export function renderAdapterTable(adapters: AdapterPayload[]): string {
  if (adapters.length === 0) return '(no adapters)';
  const head = ['ID', 'KIND', 'HEALTH', 'TOKEN', 'LAST SEEN'];
  const rows = adapters.map((a) => [
    a.id,
    a.kind,
    healthCell(a),
    tokenCell(a),
    a.lastSeenAt ?? 'never',
  ]);
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

/** One adapter in detail. Same whitelist discipline as the table. */
export function renderAdapter(adapter: AdapterPayload): string {
  return [
    `id:        ${adapter.id}`,
    `kind:      ${adapter.kind}`,
    `name:      ${adapter.displayName}`,
    `enabled:   ${String(adapter.enabled)}`,
    `health:    ${adapter.health}`,
    `token:     ${tokenCell(adapter)}`,
    `last seen: ${adapter.lastSeenAt ?? 'never'}`,
  ].join('\n');
}

/**
 * The mint block: the one moment a plaintext adapter token is ever shown.
 *
 * The token appears exactly ONCE in this block. The connect command is
 * printed with the token elided and a `<token>` placeholder in its place —
 * an operator substitutes the token they just stored, and a screenshot or a
 * scrollback of this block carries one copy of the secret rather than two.
 */
export function renderMintedCredential(
  credential: AdapterCredential,
  opts: { rotated: boolean },
): string {
  const elided = credential.connectCmd.split(credential.token).join('<token>');
  return [
    renderAdapter(credential.adapter),
    '',
    `token:     ${credential.token}`,
    'This is the only time you will see this token. Store it now: the daemon',
    'keeps only a hash, and there is no way to read it back — only to rotate.',
    ...(opts.rotated
      ? ['The old token valid 60 seconds more, then it stops working (F-42).']
      : []),
    '',
    `connect:   ${elided}`,
  ].join('\n');
}
