/**
 * One rule, as a form — and, above the form, the truth about what it can do.
 *
 * The ordering on screen is deliberate and it is not the order of §2.3's
 * columns. The LADDER comes first, because "what will this rule actually
 * do" is the question the operator came here with and `respondMode` is not
 * the answer to it: under a global `draft-only` a rule whose own column says
 * `auto` will draft, and a field that reads AUTO with nothing beside it is a
 * promise the machine will not keep. §2.4.3's ladder narrows only, so the
 * pane renders every rung, its own value, which rung took the decision, and
 * the deny-all default underneath the lot.
 *
 * The second thing above the form is the IN-FLIGHT count. A draft minted
 * under the old version of this rule is already in the queue with its own
 * body and its own expiry, and saving does not re-decide it — `dispatch
 * Approved` is the only path to the port and it wants an `Approval` row that
 * a rule edit cannot mint (INV-2). An editor that let an operator believe
 * otherwise would eventually be believed.
 *
 * Refusals are rendered in the DAEMON's words. `[data-issue]` is keyed by
 * the zod `path` the validator itself produced, joined with dots, and the
 * text is its own `message`. There is deliberately no parallel client-side
 * vocabulary for the bounds the daemon owns: `draftTtlMinutes` has a
 * server-side bound and NO local check, so the path from a real 400 to a
 * real field label is exercised by a real refusal rather than by a fixture.
 * What the form does check locally is the set of things the daemon cannot
 * phrase usefully — an empty keyword list is `invalid-matcher-shape`, which
 * names no field at all.
 */
import type { VNode } from 'preact';
import type { ScopeLadder } from '../../derive/scopeLadder.js';
import {
  OUTSIDE_WINDOW_CHOICES,
  type MatcherKind,
  type OutsideWindowChoice,
  type RespondChoice,
  type RuleFormValue,
} from '../../derive/ruleForm.js';
import { Matcher, type ServerVerdict } from './Matcher.js';

export interface NamedOption {
  readonly id: string;
  readonly label: string;
}

export interface RuleDetailProps {
  /** The stored row's id, or `''` while a new rule is being written. */
  readonly ruleId: string;
  readonly value: RuleFormValue;
  readonly dirty: boolean;
  readonly saveDisabled: boolean;
  readonly busy: boolean;
  /** Field path → the message to show, daemon's first. */
  readonly issues: ReadonlyMap<string, string>;
  readonly adapters: readonly NamedOption[];
  readonly schedules: readonly NamedOption[];
  readonly ladder: ScopeLadder;
  /** Drafts already in the queue that this rule minted. */
  readonly inflight: number;
  readonly patternProblem: string | null;
  readonly serverVerdict: ServerVerdict | null;
  readonly onName: (next: string) => void;
  readonly onKind: (kind: MatcherKind) => void;
  readonly onKeywords: (next: readonly string[]) => void;
  readonly onMode: (mode: 'any' | 'all') => void;
  readonly onFlag: (flag: 'case' | 'word' | 'group', next: boolean) => void;
  readonly onPattern: (next: string) => void;
  readonly onPatternBlur: () => void;
  readonly onHandles: (next: readonly string[]) => void;
  readonly onAdapter: (id: string) => void;
  readonly onRespond: (choice: RespondChoice) => void;
  readonly onSchedule: (id: string | null) => void;
  readonly onOutside: (choice: OutsideWindowChoice) => void;
  readonly onTtl: (minutes: number) => void;
  readonly onSave: () => void;
  readonly onRevert: () => void;
  readonly onDryRun: () => void;
}

const RESPOND: readonly RespondChoice[] = ['DRAFT-ONLY', 'AUTO', 'OFF'];

const OUTSIDE_LABEL: Readonly<Record<OutsideWindowChoice, string>> = {
  'draft-only': 'DRAFT ANYWAY',
  ignore: 'IGNORE IT',
};

/** One complaint, addressed by the path whoever produced it named. */
function Issue(props: {
  path: string;
  issues: ReadonlyMap<string, string>;
}): VNode | null {
  const message = props.issues.get(props.path);
  if (message === undefined) return null;
  return (
    <p class="rule-issue" data-issue={props.path}>
      {message}
    </p>
  );
}

export function RuleDetail(props: RuleDetailProps): VNode {
  const value = props.value;
  const ladder = props.ladder;
  return (
    <div
      id="rule-detail"
      class="rule-detail"
      data-rule-id={props.ruleId}
      data-dirty={props.dirty ? 'yes' : 'no'}
    >
      <section class="rule-block" aria-label="WHAT THIS RULE CAN DO">
        <h3 class="rule-block-title">WHAT THIS RULE CAN DO</h3>
        <div class="rule-ladder">
          {ladder.rungs.map((rung) => (
            <div
              key={rung.label}
              class="rule-rung"
              data-rung={rung.label}
              data-value={rung.value}
            >
              <span class="rule-rung-label">{rung.label}</span>
              <span class="rule-rung-value">{rung.value}</span>
            </div>
          ))}
        </div>
        <p
          id="rule-effective"
          class="rule-effective"
          data-value={ladder.effective === 'auto' ? 'AUTO' : 'DRAFT-ONLY'}
          // Every rung that narrowed, in order, or the empty string. A
          // `data-narrowed` that named only the LAST one would hide the fact
          // that flipping the global alone changes nothing here.
          data-narrowed={ladder.narrowedBy.join(',')}
        >
          EFFECTIVE · {ladder.effective === 'auto' ? 'AUTO' : 'DRAFT-ONLY'}
          {ladder.narrowedBy.length === 0
            ? ''
            : ` · NARROWED BY ${ladder.narrowedBy.join(' AND ')}`}
        </p>
        <p class="rule-hint">{ladder.note}</p>
        <p
          id="rule-deny"
          class="rule-deny"
          data-drafts={ladder.drafts ? 'yes' : 'no'}
        >
          {ladder.deny}
        </p>
        <p
          id="rule-inflight"
          class="rule-hint"
          data-count={String(props.inflight)}
        >
          {props.inflight === 0
            ? 'NO DRAFTS FROM THIS RULE ARE WAITING IN THE QUEUE'
            : `${String(props.inflight)} DRAFT${
                props.inflight === 1 ? '' : 'S'
              } ALREADY IN THE QUEUE FROM THIS RULE · SAVING CHANGES NOTHING ABOUT ${
                props.inflight === 1 ? 'IT' : 'THEM'
              }`}
        </p>
      </section>

      <section class="rule-block" aria-label="NAME AND AGENT">
        <h3 class="rule-block-title">NAME AND AGENT</h3>
        <input
          id="rule-name"
          class="rule-input"
          type="text"
          aria-label="RULE NAME"
          value={value.name}
          onInput={(event) => {
            props.onName(event.currentTarget.value);
          }}
        />
        <Issue path="name" issues={props.issues} />
        <select
          id="rule-adapter"
          class="rule-select"
          aria-label="AGENT"
          value={value.adapterId}
          onChange={(event) => {
            props.onAdapter(event.currentTarget.value);
          }}
        >
          {props.adapters.map((adapter) => (
            <option key={adapter.id} value={adapter.id}>
              {adapter.label}
            </option>
          ))}
        </select>
        <Issue path="adapterId" issues={props.issues} />
      </section>

      <Matcher
        value={value}
        patternProblem={props.patternProblem}
        serverVerdict={props.serverVerdict}
        onKind={props.onKind}
        onKeywords={props.onKeywords}
        onMode={props.onMode}
        onFlag={(flag, next) => {
          props.onFlag(flag, next);
        }}
        onPattern={props.onPattern}
        onPatternBlur={props.onPatternBlur}
        onHandles={props.onHandles}
      />
      <Issue path="matcher" issues={props.issues} />
      <Issue path="matcher.keywords" issues={props.issues} />
      <Issue path="matcher.handles" issues={props.issues} />
      <Issue path="matcher.pattern" issues={props.issues} />

      <section class="rule-block" aria-label="WHEN IT ANSWERS">
        <h3 class="rule-block-title">WHEN IT ANSWERS</h3>
        <div class="rule-segment" role="group" aria-label="RESPOND MODE">
          {RESPOND.map((choice) => (
            <button
              key={choice}
              type="button"
              class="rule-seg"
              data-respond={choice}
              data-state={value.respond === choice ? 'ON' : 'OFF'}
              aria-pressed={value.respond === choice ? 'true' : 'false'}
              onClick={() => {
                props.onRespond(choice);
              }}
            >
              {choice}
            </button>
          ))}
        </div>
        <select
          id="rule-schedule"
          class="rule-select"
          aria-label="SCHEDULE"
          value={value.scheduleId ?? ''}
          onChange={(event) => {
            const next = event.currentTarget.value;
            props.onSchedule(next === '' ? null : next);
          }}
        >
          <option value="">NO SCHEDULE · ALWAYS IN WINDOW</option>
          {props.schedules.map((schedule) => (
            <option key={schedule.id} value={schedule.id}>
              {schedule.label}
            </option>
          ))}
        </select>
        <div class="rule-segment" role="group" aria-label="OUTSIDE THE WINDOW">
          {OUTSIDE_WINDOW_CHOICES.map((choice) => (
            <button
              key={choice}
              type="button"
              class="rule-seg"
              data-outside={choice}
              data-state={value.outsideWindow === choice ? 'ON' : 'OFF'}
              aria-pressed={value.outsideWindow === choice ? 'true' : 'false'}
              onClick={() => {
                props.onOutside(choice);
              }}
            >
              {OUTSIDE_LABEL[choice]}
            </button>
          ))}
        </div>
        <p id="rule-outside-note" class="rule-hint">
          HOLDING A REPLY IN A QUEUE UNTIL THE WINDOW OPENS IS NOT IN V1 · THE
          DAEMON REFUSES THAT MODE, SO IT IS NOT OFFERED HERE
        </p>
      </section>

      <section class="rule-block" aria-label="DRAFTS">
        <h3 class="rule-block-title">DRAFTS</h3>
        <button
          type="button"
          class="rule-seg"
          data-flag="group"
          data-state={value.allowGroupDrafts ? 'ON' : 'OFF'}
          aria-pressed={value.allowGroupDrafts ? 'true' : 'false'}
          onClick={() => {
            props.onFlag('group', !value.allowGroupDrafts);
          }}
        >
          GROUP CHATS {value.allowGroupDrafts ? 'ON' : 'OFF'}
        </button>
        <label class="rule-label" for="rule-ttl">
          DRAFT EXPIRES AFTER (MINUTES)
        </label>
        <input
          id="rule-ttl"
          class="rule-input rule-mono"
          type="text"
          inputMode="numeric"
          aria-label="DRAFT EXPIRES AFTER, IN MINUTES"
          value={String(value.draftTtlMinutes)}
          onInput={(event) => {
            const parsed = Number.parseInt(event.currentTarget.value, 10);
            props.onTtl(Number.isNaN(parsed) ? 0 : parsed);
          }}
        />
        <Issue path="draftTtlMinutes" issues={props.issues} />
      </section>

      {/* A refusal the daemon phrased without naming a field: rendered in
          its own words rather than paraphrased, because the vocabulary
          belongs to the validator and a second copy of it would drift. */}
      <Issue path="rule" issues={props.issues} />

      <div class="rule-actions">
        <button
          id="rule-save"
          class="rule-action"
          type="button"
          disabled={props.saveDisabled}
          onClick={props.onSave}
        >
          SAVE
        </button>
        <button
          id="rule-revert"
          class="rule-action"
          type="button"
          disabled={!props.dirty || props.busy}
          onClick={props.onRevert}
        >
          REVERT
        </button>
        <button
          id="rule-dryrun"
          class="rule-action"
          type="button"
          // A replay is a read of the stored rule, so there is nothing to
          // replay until the rule exists.
          disabled={props.ruleId === '' || props.busy}
          onClick={props.onDryRun}
        >
          DRY RUN
        </button>
      </div>
    </div>
  );
}
