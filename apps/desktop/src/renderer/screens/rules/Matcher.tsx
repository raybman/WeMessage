/**
 * The matcher editor: four kinds, one at a time, and one of them refuses.
 *
 * §2.3's `RuleMatcher` is a discriminated union and this is the control that
 * picks the discriminant. Three decisions worth stating:
 *
 *  - **The kinds are a segmented control, not a `<select>`.** A select shows
 *    one option and hides the rest, and THEME has to be visible-and-refused
 *    rather than absent: an operator who cannot see it will look for it, and
 *    an operator who can see it greyed out with a sentence beside it has
 *    been told the truth about v1. `disabled` is the attribute, not a class.
 *  - **Fields for the inactive kinds are not destroyed, only hidden.** The
 *    form value is flat (`derive/ruleForm.ts`), so switching to REGEX and
 *    back does not eat a keyword list. Only the fields belonging to the
 *    ACTIVE kind reach the wire.
 *  - **Validity is computed on every keystroke and costs nothing.** A regex
 *    compiles in microseconds; there is no debounce, no throttle and no
 *    timer, and an arch row bans all three by name across the desktop app.
 *    The DAEMON's opinion is asked on `blur` — an event the operator
 *    generates — and its answer is labelled for exactly what it is: the
 *    stored rule's verdict on this string, which is the only question v1's
 *    routes can answer about a pattern that has not been saved yet.
 *
 * The keyword and handle inputs are UNCONTROLLED. They hold a word on its
 * way to becoming a pill, which is not part of the rule and has no business
 * in the form value or in the dirty calculation; ↩ commits it and clears the
 * box. Every other field here is controlled, because REVERT has to be able
 * to put the stored value back on screen.
 */
import type { VNode } from 'preact';
import type { MatcherKind, RuleFormValue } from '../../derive/ruleForm.js';

/** The daemon's own answer about the saved rule, once it has given one. */
export interface ServerVerdict {
  readonly state: string;
  readonly text: string;
}

export interface MatcherProps {
  readonly value: RuleFormValue;
  /** The local compiler's message, or `null` when the pattern compiles. */
  readonly patternProblem: string | null;
  readonly serverVerdict: ServerVerdict | null;
  readonly onKind: (kind: MatcherKind) => void;
  readonly onKeywords: (next: readonly string[]) => void;
  readonly onMode: (mode: 'any' | 'all') => void;
  readonly onFlag: (flag: 'case' | 'word', next: boolean) => void;
  readonly onPattern: (next: string) => void;
  readonly onPatternBlur: () => void;
  readonly onHandles: (next: readonly string[]) => void;
}

const KINDS: readonly { kind: MatcherKind; label: string }[] = [
  { kind: 'keyword', label: 'KEYWORD' },
  { kind: 'regex', label: 'REGEX' },
  { kind: 'contact', label: 'CONTACT' },
  { kind: 'theme', label: 'THEME' },
];

/** ↩ in a pill box: commit the word, clear the box, add nothing twice. */
function commitOn(
  event: KeyboardEvent,
  current: readonly string[],
  commit: (next: readonly string[]) => void,
): void {
  if (event.key !== 'Enter') return;
  const input = event.currentTarget;
  if (!(input instanceof HTMLInputElement)) return;
  event.preventDefault();
  const word = input.value.trim();
  input.value = '';
  if (word.length === 0 || current.includes(word)) return;
  commit([...current, word]);
}

export function Matcher(props: MatcherProps): VNode {
  const value = props.value;
  return (
    <section class="rule-block" aria-label="MATCHER">
      <h3 class="rule-block-title">MATCHER</h3>
      <div class="rule-segment" role="group" aria-label="MATCHER KIND">
        {KINDS.map((entry) => (
          <button
            key={entry.kind}
            type="button"
            class="rule-seg"
            data-kind={entry.kind}
            data-state={value.kind === entry.kind ? 'ON' : 'OFF'}
            aria-pressed={value.kind === entry.kind ? 'true' : 'false'}
            // THEME is on the screen and cannot be chosen. §1.4.1 defines it
            // and v1 ships no endpoint for it, so the daemon answers 400;
            // offering it as though it worked would be teaching an operator
            // that saves sometimes fail for no reason.
            disabled={entry.kind === 'theme'}
            onClick={() => {
              props.onKind(entry.kind);
            }}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <p id="rule-theme-note" class="rule-hint">
        THEME MATCHING HAS NO ENDPOINT IN V1 · THE DAEMON REFUSES IT
      </p>

      {value.kind === 'keyword' ? (
        <div class="rule-field">
          <div class="rule-pills">
            {value.keywords.map((word) => (
              <button
                key={word}
                type="button"
                class="rule-pill"
                data-keyword={word}
                aria-label={`REMOVE KEYWORD ${word}`}
                onClick={() => {
                  props.onKeywords(value.keywords.filter((k) => k !== word));
                }}
              >
                {word} ✕
              </button>
            ))}
          </div>
          <input
            id="rule-keyword-input"
            class="rule-input"
            type="text"
            aria-label="ADD A KEYWORD, THEN RETURN"
            placeholder="KEYWORD, THEN ↩"
            onKeyDown={(event) => {
              commitOn(event, value.keywords, props.onKeywords);
            }}
          />
          <div class="rule-segment" role="group" aria-label="KEYWORD MODE">
            {(['any', 'all'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                class="rule-seg"
                data-kwmode={mode}
                data-state={value.mode === mode ? 'ON' : 'OFF'}
                aria-pressed={value.mode === mode ? 'true' : 'false'}
                onClick={() => {
                  props.onMode(mode);
                }}
              >
                {mode === 'any' ? 'ANY OF THEM' : 'ALL OF THEM'}
              </button>
            ))}
          </div>
          <div class="rule-segment" role="group" aria-label="KEYWORD FLAGS">
            <button
              type="button"
              class="rule-seg"
              data-flag="case"
              data-state={value.caseSensitive ? 'ON' : 'OFF'}
              aria-pressed={value.caseSensitive ? 'true' : 'false'}
              onClick={() => {
                props.onFlag('case', !value.caseSensitive);
              }}
            >
              CASE SENSITIVE {value.caseSensitive ? 'ON' : 'OFF'}
            </button>
            <button
              type="button"
              class="rule-seg"
              data-flag="word"
              data-state={value.wholeWord ? 'ON' : 'OFF'}
              aria-pressed={value.wholeWord ? 'true' : 'false'}
              onClick={() => {
                props.onFlag('word', !value.wholeWord);
              }}
            >
              WHOLE WORD {value.wholeWord ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>
      ) : null}

      {value.kind === 'regex' ? (
        <div class="rule-field">
          <input
            id="rule-pattern"
            class="rule-input rule-mono"
            type="text"
            aria-label="REGULAR EXPRESSION"
            value={value.pattern}
            onInput={(event) => {
              props.onPattern(event.currentTarget.value);
            }}
            onBlur={props.onPatternBlur}
          />
          <p
            id="rule-pattern-verdict"
            class="rule-hint"
            data-state={props.patternProblem === null ? 'VALID' : 'INVALID'}
          >
            {props.patternProblem === null
              ? 'VALID · COMPILED WITH THE UNICODE FLAG, AS THE DAEMON DOES'
              : `INVALID · ${props.patternProblem}`}
          </p>
          {props.serverVerdict === null ? null : (
            <p
              id="rule-pattern-server"
              class="rule-hint"
              data-state={props.serverVerdict.state}
            >
              {props.serverVerdict.text}
            </p>
          )}
        </div>
      ) : null}

      {value.kind === 'contact' ? (
        <div class="rule-field">
          <div class="rule-pills">
            {value.handles.map((handle) => (
              <button
                key={handle}
                type="button"
                class="rule-pill"
                data-handle-pill={handle}
                aria-label={`REMOVE HANDLE ${handle}`}
                onClick={() => {
                  props.onHandles(value.handles.filter((h) => h !== handle));
                }}
              >
                {handle} ✕
              </button>
            ))}
          </div>
          <input
            id="rule-handle-input"
            class="rule-input rule-mono"
            type="text"
            aria-label="ADD A HANDLE, THEN RETURN"
            placeholder="HANDLE, THEN ↩"
            onKeyDown={(event) => {
              commitOn(event, value.handles, props.onHandles);
            }}
          />
        </div>
      ) : null}
    </section>
  );
}
