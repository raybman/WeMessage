/**
 * v2 A1: the line above the conversations list.
 *
 * Board 01.B heads the list with three things: what is being shown ("All
 * Messages"), how it is ordered (the lens, "Recent"), and a chip that counts
 * the conversations and dates the count. The chip is a string the
 * composition root built from the page the daemon answered, and this file
 * only draws it: the count is the daemon's `total`, the "as of" is the
 * page's own `asOf`, and neither is computed here.
 *
 * No chip until there is a page to date. A chip reading "0 conversations"
 * while the first page is still in flight would be a number nobody counted.
 *
 * A view, under the same ban as `components/` and `screens/`: no bridge, no
 * clock, no subscription.
 */
import type { VNode } from 'preact';

export interface HeaderProps {
  readonly title: string;
  readonly lens: string;
  /** The dated count, or `''` before a page has been answered. */
  readonly chip: string;
}

export function Header(props: HeaderProps): VNode {
  return (
    <div id="threads-head">
      <span id="threads-title">{props.title}</span>
      <span id="threads-lens">{props.lens}</span>
      {props.chip === '' ? null : <span id="threads-chip">{props.chip}</span>}
    </div>
  );
}
