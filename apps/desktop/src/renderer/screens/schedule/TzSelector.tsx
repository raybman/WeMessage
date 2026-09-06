/**
 * The zone picker, and the only file in this tree allowed to ask the runtime
 * for the list.
 *
 * `Intl.supportedValuesOf('timeZone')` rather than a constant, and an arch
 * row pins the call to this one file. A hand-written menu of four hundred
 * zone names is a tz database with no maintainer: it goes stale the first
 * time a government moves a boundary, and this repo is PUBLIC, so the S6
 * guard already pins every IANA literal in the tree to five zones chosen for
 * their DST SHAPES rather than for anybody's location. Shipping the menu as
 * source would either break that row or force it open.
 *
 * The banner underneath is the second half of the answer to "whose clock".
 * The windows are in the SCHEDULE's zone — not the operator's, not the
 * daemon's — and on a laptop that is somewhere else, every rectangle on the
 * grid is drawn at a wall time the person reading it is not living in. So
 * the screen says both zones, in words, whenever they differ, and says
 * nothing at all when they do not: a banner that is always up is a banner
 * nobody reads.
 */
import type { VNode } from 'preact';
import { canonicalZone } from '../../derive/projectWindow.js';

export interface TzSelectorProps {
  /** The schedule's zone, which is the one the grid is drawn in. */
  readonly value: string;
  /** The zone this DEVICE is in, read once by the composition root. */
  readonly hostZone: string;
  readonly disabled: boolean;
  readonly onChange: (zone: string) => void;
}

/**
 * Every zone this build's ICU can project into, plus the stored one.
 *
 * A schedule written on a machine with a newer tz database can name a zone
 * this one has never heard of. Dropping it from the menu would make the
 * select render EMPTY over a schedule that has a perfectly good zone, and
 * the first keystroke anywhere else in the form would save that emptiness.
 * So an unknown value is prepended and kept selectable.
 */
function zonesFor(current: string): readonly string[] {
  let all: readonly string[] = [];
  try {
    all = Intl.supportedValuesOf('timeZone');
  } catch {
    // An older runtime without the enumeration API. The stored zone is still
    // a zone, and one option is a working control.
    all = [];
  }
  if (current === '' || all.includes(current)) return all;
  return [current, ...all];
}

export function TzSelector(props: TzSelectorProps): VNode {
  const zones = zonesFor(props.value);
  return (
    <div class="sched-field">
      <label class="rule-label" for="sched-zone">
        TIME ZONE
      </label>
      <select
        id="sched-zone"
        class="rule-select"
        aria-label="THE ZONE THESE WINDOWS ARE IN"
        value={props.value}
        disabled={props.disabled}
        onChange={(event) => {
          props.onChange(event.currentTarget.value);
        }}
      >
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      {canonicalZone(props.value) === canonicalZone(props.hostZone) ? null : (
        <p
          id="sched-zone-mismatch"
          class="sched-mismatch"
          data-host-zone={props.hostZone}
        >
          WINDOWS ARE IN {props.value} · THIS DEVICE IS IN {props.hostZone} ·
          THE GATE READS THE SCHEDULE&apos;S ZONE
        </p>
      )}
    </div>
  );
}
