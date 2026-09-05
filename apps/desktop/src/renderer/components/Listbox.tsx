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
 *    changed under them;
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
  /** `data-*` and `aria-expanded`, decided by the screen that owns the row. */
  readonly attrs: Readonly<Record<string, string>>;
  readonly body: VNode;
}

export interface ListboxProps {
  readonly id: string;
  readonly label: string;
  /** Already windowed by the caller: this component renders what it is given. */
  readonly options: readonly ListboxOption[];
  readonly activeId: string | null;
  readonly onKeyDown: (event: KeyboardEvent) => void;
}

export function Listbox(props: ListboxProps): VNode {
  return (
    <ul
      id={props.id}
      role="listbox"
      aria-label={props.label}
      aria-multiselectable="true"
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
          data-active={option.active ? 'true' : 'false'}
          {...option.attrs}
        >
          {option.body}
        </li>
      ))}
    </ul>
  );
}
