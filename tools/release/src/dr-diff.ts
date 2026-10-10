/**
 * v2 S5b: the designated requirement, diffed per tag.
 *
 * WHY. macOS keys every privacy grant WeMessage needs (Full Disk Access,
 * Automation, Contacts) on the app's designated requirement, and for a
 * self-signed build that requirement names the certificate leaf. A release
 * signed with a different leaf than the release before it resets every
 * user's grants without a word. That can be the right call (a compromised or
 * expiring key), but it must never be an accident, so the release lane
 * refuses it unless CHANGELOG.md says so, under THIS version's heading, in
 * exactly one line naming both leaves:
 *
 *   - Signing identity rotated: <previous leaf> -> <this leaf>
 *
 * Both hashes must be the real ones. A line under an older heading, under
 * [Unreleased], or naming any other leaf justifies nothing.
 *
 * Results and exit codes (the bin, `../bin/dr-diff.mjs`, maps them):
 *
 *   first-release      no earlier published release carries a requirement   0
 *   same               the previous requirement is byte-for-byte this one   0
 *   rotated, justified the line above, under this version                   0
 *   rotated, unjus.    anything else                                         6
 *
 * Pure: no I/O here, so every result is tested without a network in
 * `test/release/dr-diff.spec.ts`. The bin does the GitHub reads.
 *
 * THE FENCE (`tools-import-runtime-nothing`): imports nothing.
 */

export interface PreviousRequirement {
  readonly tag: string;
  readonly requirement: string;
}

export type DrDiffResult =
  | { readonly kind: 'first-release' }
  | { readonly kind: 'same'; readonly previousTag: string }
  | {
      readonly kind: 'rotated';
      readonly previousTag: string;
      readonly justified: true;
      readonly changelogLine: string;
    }
  | {
      readonly kind: 'rotated';
      readonly previousTag: string;
      readonly justified: false;
      readonly previousLeaf: string;
      readonly currentLeaf: string;
    };

/** The exit code for an unjustified change: the job fails before upload. */
export const UNJUSTIFIED_EXIT = 6;

const LEAF = /certificate (?:leaf|root) = H"([0-9a-fA-F]{40})"/;
const JUSTIFICATION =
  /^- Signing identity rotated: ([0-9a-f]{40}) -> ([0-9a-f]{40})$/;

/** The 40-hex certificate SHA-1 a designated requirement pins, lowercased. */
export function leafOf(requirement: string): string {
  const m = LEAF.exec(requirement);
  if (m === null || m[1] === undefined)
    throw new Error(
      `no certificate leaf in the designated requirement: ${requirement.trim()}`,
    );
  return m[1].toLowerCase();
}

const norm = (requirement: string): string => requirement.trim();

export function compareDesignatedRequirement(input: {
  readonly previous: PreviousRequirement | null;
  readonly current: string;
  readonly changelogSection: string;
}): DrDiffResult {
  const currentLeaf = leafOf(input.current);
  if (input.previous === null) return { kind: 'first-release' };
  const previousTag = input.previous.tag;
  if (norm(input.previous.requirement) === norm(input.current))
    return { kind: 'same', previousTag };
  const previousLeaf = leafOf(input.previous.requirement);
  // A requirement that changed while the leaf did not (an identifier, say)
  // is still a reset, and a rotation line cannot describe it.
  if (previousLeaf !== currentLeaf)
    for (const line of input.changelogSection.split('\n')) {
      const m = JUSTIFICATION.exec(line);
      if (m !== null && m[1] === previousLeaf && m[2] === currentLeaf)
        return {
          kind: 'rotated',
          previousTag,
          justified: true,
          changelogLine: line,
        };
    }
  return {
    kind: 'rotated',
    previousTag,
    justified: false,
    previousLeaf,
    currentLeaf,
  };
}

export function exitCodeFor(result: DrDiffResult): number {
  return result.kind === 'rotated' && !result.justified ? UNJUSTIFIED_EXIT : 0;
}

const escapeRe = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The body of the CHANGELOG section for `tag` (a leading `v` is optional on
 * both sides): every line after its `## ` heading up to the next `## `
 * heading. Empty when there is no such heading.
 */
export function changelogSection(changelog: string, tag: string): string {
  const version = tag.replace(/^v/, '');
  const heading = new RegExp(`^## \\[?v?${escapeRe(version)}\\]?(?:\\s|$)`);
  const lines = changelog.split('\n');
  const start = lines.findIndex((l) => heading.test(l));
  if (start < 0) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => /^## /.test(l));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n');
}

export interface ReleaseListing {
  readonly tagName: string;
  readonly isDraft: boolean;
}

/**
 * The candidates to compare against, newest first: every published release
 * other than `tag`. Drafts are excluded (nobody installed one); prereleases
 * are included, because a user on an rc holds grants keyed on its leaf.
 */
export function pickPreviousRelease(
  releases: readonly ReleaseListing[],
  tag: string,
): string[] {
  return releases
    .filter((r) => !r.isDraft && r.tagName !== tag)
    .map((r) => r.tagName);
}

/** One line for the job log. */
export function describeResult(result: DrDiffResult): string {
  switch (result.kind) {
    case 'first-release':
      return 'dr-diff: first-release (no earlier release carries a designated requirement)';
    case 'same':
      return `dr-diff: same as ${result.previousTag}`;
    case 'rotated':
      if (result.justified)
        return `dr-diff: rotated, justified since ${result.previousTag} by "${result.changelogLine}"`;
      return result.previousLeaf === result.currentLeaf
        ? `dr-diff: the designated requirement changed since ${result.previousTag} with the same leaf. That resets every user's privacy grants and no CHANGELOG line can justify it: find what changed.`
        : [
            `dr-diff: the designated requirement changed since ${result.previousTag} and CHANGELOG.md does not justify it.`,
            "Every user would lose their privacy grants. If the rotation is intended, add exactly this line under this version's heading:",
            `- Signing identity rotated: ${result.previousLeaf} -> ${result.currentLeaf}`,
          ].join('\n');
  }
}
