/**
 * The one listbox in this application, and the only file allowed to mint one.
 *
 * An arch row asserts that `role="listbox"` and `role="option"` appear in
 * this file and nowhere else under `src/renderer`. That is not tidiness: a
 * listbox has an ARIA contract that only holds if ONE thing owns it, and the
 * two ways it usually breaks are a second list appearing beside the first
 * (Sc7's empty states, Sc9's batch card) and an option growing a button
 * inside it. Both are decisions; neither should be reachable by editing a
 * screen file.
 *
 * The contract, in full:
 *
 *  - exactly one `role="listbox"`, with an `aria-label`;
 *  - `aria-multiselectable` declared NOW rather than when Sc9 needs it,
 *    because assistive technology describes a list once and an operator who
 *    has learned "this list is single-select" should not have that quietly
 *    changed under them. Always declared, never omitted: the queue marks
 *    (`true`, the default), and v2 A1's conversations list selects one
 *    conversation at a time (`false`);
 *  - `aria-setsize` and `aria-posinset` when the caller holds only part of
 *    the list (v2 A1 pages 4,000 conversations a hundred at a time, and
 *    mounts sixty of those). Without them a screen reader counts the
 *    mounted window and announces "1 of 60" over a list of thousands;
 *  - every child is a `role="option"`, which is why the virtualization
 *    window is a SLICE rather than a pair of spacer elements: a container
 *    whose children are not all options is not a listbox, whatever its role
 *    attribute says;
 *  - `aria-selected` on every option, always present and never inferred
 *    from a class;
 *  - ROVING FOCUS, not roving tabindex. The container is the single tab
 *    stop (`tabIndex={0}`) and `aria-activedescendant` names the active
 *    option. This is the decision Scenario 8's twenty-drafts-in-a-minute
 *    checkpoint rests on: with roving tabindex, DOM focus lives on an option,
 *    and a virtualized list UNMOUNTS the focused node the moment it leaves
 *    the window — focus drops to `<body>`, the next keystroke goes nowhere,
 *    and the run ends. With one focus holder, scrolling the window is a
 *    paint and nothing can lose focus.
 *
 * Nothing in here is interactive. No option contains a link, a button, an
 * input or a tabbable node, so an option is one announceable thing and there
 * is no affordance that could bypass the approval row (INV-2): every verb is
 * a keystroke the screen above interprets.
 */
import type { VNode } from 'preact';

export interface ListboxOption {
  /** The DOM id `aria-activedescendant` points at. Must be unique. */
  readonly id: string;
  readonly selected: boolean;
  readonly active: boolean;
  /** What assistive technology is handed, in words rather than glyphs. */
  readonly label: string;
  /** `data-*` attributes, decided by the screen that owns the row. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly body: VNode;
  /**
   * This option's 1-based place in the WHOLE list, when the caller passes
   * `setSize`. Ignored without it: a position in a set of unknown size is
   * a number with nothing to be a fraction of.
   */
  readonly position?: number;
}

export interface ListboxProps {
  readonly id: string;
  readonly label: string;
  /** Already windowed by the caller: this component renders what it is given. */
  readonly options: readonly ListboxOption[];
  readonly activeId: string | null;
  /**
   * Whether the list is inert because the app cannot vouch for it.
   *
   * `aria-disabled` rather than removing the tab stop: the list still holds
   * the window's only focusable node, and a disabled control that cannot be
   * focused is a control an operator cannot ask about. It announces as
   * unavailable, keeps focus, and the keys it would have claimed are
   * refused one layer up — where the refusal can be explained.
   */
  readonly disabled: boolean;
  readonly onKeyDown: (event: KeyboardEvent) => void;
  /** Whether options can be MARKED as well as selected. Default `true`. */
  readonly multiselectable?: boolean;
  /**
   * How many options the whole list has, when that is more than the caller
   * mounted. Set together with each option's `position`.
   */
  readonly setSize?: number;
}

export function Listbox(props: ListboxProps): VNode {
  const { setSize } = props;
  return (
    <ul
      id={props.id}
      role="listbox"
      aria-label={props.label}
      aria-multiselectable={props.multiselectable === false ? 'false' : 'true'}
      aria-disabled={props.disabled ? 'true' : 'false'}
      // Omitted rather than empty when there is no active row: an
      // `aria-activedescendant` pointing at nothing is a dangling reference,
      // and an empty one is a reference to an element whose id is ''.
      {...(props.activeId === null
        ? {}
        : { 'aria-activedescendant': props.activeId })}
      tabIndex={0}
      onKeyDown={props.onKeyDown}
    >
      {props.options.map((option) => (
        <li
          key={option.id}
          id={option.id}
          role="option"
          aria-selected={option.selected ? 'true' : 'false'}
          aria-label={option.label}
          {...(setSize === undefined || option.position === undefined
            ? {}
            : {
                // Numbers, as Preact types them; the DOM serialises both.
                'aria-setsize': setSize,
                'aria-posinset': option.position,
              })}
          data-active={option.active ? 'true' : 'false'}
          {...option.attrs}
        >
          {option.body}
        </li>
      ))}
    </ul>
  );
}
