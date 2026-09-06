/**
 * How much autonomy a handle has actually spent, and whether it is at its cap.
 *
 * The awkward fact this file exists for: `auto.approved` carries no handle.
 * Its payload is `{ draftId, approvalId, ruleId, adapterId, scopes,
 * scheduleId }` (`packages/core/src/audit/events.ts`), because the approval
 * is about a DRAFT and the draft is what knows who it is for. So a per-person
 * count is only obtainable as a JOIN through `draft.created`, whose payload
 * carries the draft snapshot and therefore the `chatGuid`.
 *
 * The alternative, counting `auto.approved` rows and putting the total in
 * every row of the grid, would be a single machine-wide number wearing a
 * per-person label, next to a per-person cap. An operator would read it as
 * "this person is near their limit" and it would mean nothing of the kind.
 * Unjoinable approvals are DROPPED rather than attributed to a guess.
 *
 * The windows are the gate's own, from `overRateCap`: two minutes against
 * `send.capContactPer2Min` and an hour against `send.capContactPerHour`,
 * each compared to its own number with `>=`, which is the comparison the
 * gate uses. The plan compares a two-hour count against a two-minute cap.
 *
 * No clock here: `nowIso` is an argument, as it is everywhere in `derive/`.
 */
import type {
  AuditRowPayload,
  GateDenyReason,
  SettingsPayload,
} from '@wemessage/client';

/** `send.capContactPer2Min`'s window, in minutes. */
export const AUTO_CAP_WINDOW_MIN = 2;
/** `send.capContactPerHour`'s window, in minutes. */
export const AUTO_HOUR_WINDOW_MIN = 60;

/** A room is never auto-answered (INV-5), so it never appears in a tally. */
const GROUP_INFIX = ';+;';
const DIRECT_INFIX = ';-;';

export interface AutoTally {
  readonly last2Min: number;
  readonly lastHour: number;
}

export interface AutoCaps {
  readonly per2Min: number;
  readonly perHour: number;
}

/**
 * The two clamps this screen can attribute to one row.
 *
 * A clamp, not a deny: both of these live inside `dispatchApproved`'s
 * `if (isAutoApproval)` branch, so they stop the machine and leave a human
 * free to approve the same draft by hand. The screen says so in the footer;
 * this type is the reason it can.
 */
export type AutoHold = Extract<
  GateDenyReason,
  'rate-limited' | 'sms-auto-forbidden'
>;

interface Parsed {
  readonly type: string;
  readonly draftId: string;
  readonly chatGuid: string | null;
}

/**
 * One audit row, or nothing.
 *
 * `eventJson` is a string off the wire and a malformed one must not blank a
 * screen whose whole job is to say what the gate will do. An unparseable row
 * is one row this screen cannot explain; the rest still count.
 */
function parseRow(row: AuditRowPayload): Parsed | null {
  let event: unknown;
  try {
    event = JSON.parse(row.eventJson);
  } catch {
    return null;
  }
  if (typeof event !== 'object' || event === null) return null;
  const bag = event as Record<string, unknown>;
  const type = bag['type'];
  const draftId = bag['draftId'];
  if (typeof type !== 'string' || typeof draftId !== 'string') return null;
  const draft = bag['draft'];
  const guid =
    typeof draft === 'object' && draft !== null
      ? (draft as Record<string, unknown>)['chatGuid']
      : undefined;
  return {
    type,
    draftId,
    chatGuid: typeof guid === 'string' ? guid : null,
  };
}

function handleOf(guid: string): string | null {
  if (guid.includes(GROUP_INFIX)) return null;
  const at = guid.indexOf(DIRECT_INFIX);
  if (at === -1) return null;
  const handle = guid.slice(at + DIRECT_INFIX.length);
  return handle.length > 0 ? handle : null;
}

/**
 * Auto-approvals per handle, in the gate's two windows.
 *
 * Windowed on the APPROVAL's instant, not the draft's. A draft minted last
 * week and auto-approved a minute ago spent autonomy a minute ago, and the
 * cap the daemon will enforce on the next one is computed from the approval.
 */
export function autoSendsPerHour(
  approvals: readonly AuditRowPayload[],
  creations: readonly AuditRowPayload[],
  nowIso: string,
): ReadonlyMap<string, AutoTally> {
  const now = Date.parse(nowIso);
  const handleForDraft = new Map<string, string>();
  for (const row of creations) {
    const parsed = parseRow(row);
    if (parsed === null || parsed.type !== 'draft.created') continue;
    if (parsed.chatGuid === null) continue;
    const handle = handleOf(parsed.chatGuid);
    if (handle === null) continue;
    handleForDraft.set(parsed.draftId, handle);
  }
  const tally = new Map<string, { last2Min: number; lastHour: number }>();
  for (const row of approvals) {
    const parsed = parseRow(row);
    if (parsed === null || parsed.type !== 'auto.approved') continue;
    const handle = handleForDraft.get(parsed.draftId);
    if (handle === undefined) continue;
    const at = Date.parse(row.at);
    if (Number.isNaN(at)) continue;
    const ageMin = (now - at) / 60_000;
    if (ageMin > AUTO_HOUR_WINDOW_MIN) continue;
    const entry = tally.get(handle) ?? { last2Min: 0, lastHour: 0 };
    entry.lastHour += 1;
    if (ageMin <= AUTO_CAP_WINDOW_MIN) entry.last2Min += 1;
    tally.set(handle, entry);
  }
  return tally;
}

/**
 * Whether the rate cap is already holding this handle.
 *
 * `>=`, matching `overRateCap`: a handle that has spent its whole allowance
 * is held, it is not "at zero remaining and still permitted". Each window is
 * compared to its OWN cap and to nothing else.
 */
export function heldBy(tally: AutoTally, caps: AutoCaps): AutoHold | null {
  if (tally.last2Min >= caps.per2Min) return 'rate-limited';
  if (tally.lastHour >= caps.perHour) return 'rate-limited';
  return null;
}

/* ── the caps, from the daemon rather than from memory ────────────────── */

/**
 * The two keys `overRateCap` reads, spelled here and nowhere else.
 *
 * They live in a derive module rather than in the binding for the same
 * reason `send.globalMode` does: the store root's arch guard bans that
 * substring in identifiers AND in string literals, so that no file sitting
 * next to the approval verbs can name the port. A pure function is not
 * sitting next to them.
 */
const KEY_PER_2MIN = 'send.capContactPer2Min';
const KEY_PER_HOUR = 'send.capContactPerHour';

/**
 * `DEFAULT_RATE_CAPS`, as the daemon ships them.
 *
 * Only a fallback for a settings payload that did not carry the key at all.
 * Every ordinary path reads the STORED value, because a screen that showed
 * a cap the operator had already raised would be reporting a hold that is
 * not there.
 */
const SHIPPED: AutoCaps = { per2Min: 1, perHour: 10 };

function numberAt(settings: SettingsPayload, key: string): number | null {
  const entry = settings[key];
  if (entry === undefined) return null;
  const value = typeof entry.value === 'number' ? entry.value : entry.default;
  return typeof value === 'number' ? value : null;
}

/** The caps in force, from `GET /v1/settings`. */
export function capsOf(settings: SettingsPayload): AutoCaps {
  return {
    per2Min: numberAt(settings, KEY_PER_2MIN) ?? SHIPPED.per2Min,
    perHour: numberAt(settings, KEY_PER_HOUR) ?? SHIPPED.perHour,
  };
}
