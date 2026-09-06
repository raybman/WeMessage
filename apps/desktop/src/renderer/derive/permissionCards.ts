/**
 * s8 Scenario 14 — the Permissions pane's four cards.
 *
 * **The pane reports; it cannot grant.** macOS TCC is not writable by an
 * application: Full Disk Access and Automation are granted by a human in
 * System Settings and by nothing else. So the remedy a card offers is a
 * NAME on `main/policy.ts`'s closed pane allowlist, which main resolves to a
 * URL and hands to the shell. A renderer that has been compromised can ask
 * for `fullDisk`; it cannot ask for anything not on that list, and it can
 * never ask for a grant.
 *
 * **A check that never ran is not a check that passed.** `evaluateDoctor`
 * SHORT-CIRCUITS: an FDA denial returns two checks and never probes
 * Automation or Messages at all. So `checks` is routinely incomplete, and
 * the fourth card state is not an invented vocabulary but the daemon's own
 * consequence. Three failure modes collapse into it, deliberately:
 *
 *  - the id is absent from `checks` (the short circuit above),
 *  - the id is present with a status this build does not recognise,
 *  - the report could not be read at all.
 *
 * All three mean the same thing to an operator — nobody has established
 * anything about this permission — and none of them may render as a grant.
 * A pane that showed a card as OK because the check threw would be the same
 * class of lie as a blank column that reads as "no policy".
 *
 * **Colour is never the carrier.** Every card carries a glyph from the
 * closed set `derive/state.ts` teaches, an uppercase word, and a
 * `data-state`. Blue is the only accent this product has, so a "green
 * light" is not merely discouraged here, it does not exist.
 */
import type { DoctorReportPayload } from '@wemessage/client';

/** The daemon's four ids, in the order `evaluateDoctor` reaches them. */
export const CHECK_IDS = ['os', 'fda', 'automation', 'messages'] as const;

export type CheckId = (typeof CHECK_IDS)[number];

/** Nobody has established anything about this permission. Not a pass. */
export const NOT_CHECKED = 'NOT CHECKED';

export const CARD_STATES = ['OK', 'WARN', 'FAIL', NOT_CHECKED] as const;

export type CardState = (typeof CARD_STATES)[number];

/** The closed glyph set, one shape per state, shared with the state strip. */
export const CARD_GLYPH: Readonly<Record<CardState, string>> = {
  OK: '●',
  WARN: '◐',
  FAIL: '⊘',
  'NOT CHECKED': '◌',
};

/**
 * A key of `main/policy.ts`'s `SYSTEM_SETTINGS_PANES`, spelled rather than
 * imported: a renderer module may not import from `main/`, and the two are
 * tied together at runtime by `test/unit/settings-derive.spec.ts` instead.
 */
export type PaneName = 'fullDisk' | 'automation';

/**
 * Where a failing check can be fixed, or `null` where macOS has no pane to
 * offer. `os` is a VERSION and `messages` is an application that is running
 * or is not: neither is a grant, and a button beside them would open a
 * window that says nothing about the thing that failed.
 */
export const CARD_PANE: Readonly<Record<CheckId, PaneName | null>> = {
  os: null,
  fda: 'fullDisk',
  automation: 'automation',
  messages: null,
};

/** What the operator reads when the daemon said nothing else. */
const DEFAULT_DETAIL: Readonly<Record<CardState, string>> = {
  OK: 'Reported healthy at the last probe.',
  WARN: 'Reported a warning with no further detail.',
  FAIL: 'Reported a failure with no further detail.',
  'NOT CHECKED':
    'The daemon stopped before it reached this check, so nothing is known about it. Fix the failure above and probe again.',
};

export interface PermissionCard {
  readonly id: CheckId;
  readonly state: CardState;
  readonly glyph: string;
  readonly detail: string;
  /** Offered only where there is something to fix AND a pane to fix it in. */
  readonly pane: PaneName | null;
}

function stateOf(status: string): CardState {
  if (status === 'ok') return 'OK';
  if (status === 'warn') return 'WARN';
  if (status === 'fail') return 'FAIL';
  return NOT_CHECKED;
}

/**
 * Total over {@link CHECK_IDS}, in probe order, for any report at all
 * including none.
 *
 * FIRST answer wins for a repeated id. Never the friendlier one: a daemon
 * that answered `fail` and then `ok` for the same check has a bug, and the
 * reading that keeps an operator safe is the first refusal.
 */
export function permissionCards(
  report: DoctorReportPayload | null,
): PermissionCard[] {
  const seen = new Map<string, DoctorReportPayload['checks'][number]>();
  for (const check of report?.checks ?? [])
    if (!seen.has(check.id)) seen.set(check.id, check);

  return CHECK_IDS.map((id) => {
    const check = seen.get(id);
    const state = check === undefined ? NOT_CHECKED : stateOf(check.status);
    const detail =
      state === NOT_CHECKED
        ? DEFAULT_DETAIL[NOT_CHECKED]
        : (check?.remediation ?? check?.detail ?? DEFAULT_DETAIL[state]);
    return {
      id,
      state,
      glyph: CARD_GLYPH[state],
      detail,
      pane: state === 'WARN' || state === 'FAIL' ? CARD_PANE[id] : null,
    };
  });
}

/**
 * When the daemon last looked, in its own words.
 *
 * `probedAt` is the daemon's instant, echoed; nothing here reads a clock to
 * turn it into an age, because an age is a value that changes while nobody
 * is acting, which is a timer.
 */
export function probedLine(report: DoctorReportPayload | null): string {
  if (report === null) return `LAST PROBE: ${NOT_CHECKED}`;
  return `LAST PROBE: ${report.probedAt}`;
}
