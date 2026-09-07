/**
 * Minting a test-scoped label.
 *
 * Its own module for one reason: `cli.ts` is where the id generator would
 * otherwise be imported, and the fold to lowercase is the kind of detail that
 * gets lost in a bigger file. The generator emits uppercase Crockford base32;
 * the label grammar is lowercase alphanumerics and hyphens. Without the fold
 * every test-scoped install throws, which is a trap worth isolating.
 */
import { ulid } from 'ulid';

export function mintServiceLabel(prefix: string): string {
  return `${prefix}${ulid().toLowerCase()}`;
}
