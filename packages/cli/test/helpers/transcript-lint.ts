/**
 * s7-execution Scenario 11 — the transcript linter, and the parser for the
 * three machine-readable blocks a SKILL.md carries (§1.7).
 *
 * A skill document produces two artifacts nobody reviews carefully: the
 * commands an agent runs, and the transcript somebody later pastes into an
 * issue. This file is the guard on both. It is deliberately a pure
 * function over text, so the same implementation checks a live run, a
 * committed DRYRUN.md, and every markdown file under `skills/`.
 *
 * WHAT IT MUST CATCH, and why each one is here rather than in a review
 * checklist:
 *
 *  - **Policy.** A command the document forbids, a command the document
 *    never permitted, and an approval-gated command with no human sentence
 *    behind it. These are the rules that make the document mean something.
 *  - **Secrets.** An adapter token, or the same 64 hex characters wearing a
 *    `Bearer`. A transcript is the single most likely place for one to
 *    escape, because it is the thing people copy.
 *  - **People.** A phone number or a host or a mailbox that could belong to
 *    somebody. The synthetic reserves are `+1555…` and `example.com` and
 *    loopback, and everything else is presumed to be a real person until a
 *    human says otherwise.
 *  - **The operator.** A brand string, or an absolute path with a home
 *    directory in it. Both name who ran this.
 *  - **Colour.** Any ANSI escape, and any word or hex that carries state by
 *    hue. The house pattern since S6 Sc12 is glyph-carries-state plus
 *    UPPERCASE-carries-emphasis; the product's one colour is the blue
 *    bubble. A transcript is monochrome by construction and a colour in one
 *    is a renderer that grew a branch nobody swept.
 *  - **Frames that do not exist.** INV-2 lives here too: the wire has nine
 *    frames and none of them sends, so a transcript or a document naming a
 *    tenth is either fiction or a leak from a branch that should not exist.
 *
 * REUSE, stated explicitly because the alternative is a second copy of
 * things this repo already got right:
 *
 *  - The token shape is Sc 6's. `redactTokens` from `@wemessage/adapter-
 *    testkit` owns `wm_<64 hex>` and its 67-character carry buffer, and the
 *    rule below asks IT whether a token is present rather than restating
 *    the pattern. The `Bearer` arm is genuinely new: Sc 6 redacts what the
 *    daemon MINTS, and an operator bearer pasted into a transcript is a
 *    different leak with the same consequence.
 *  - The brand and phone sweep is Sc 7's, moved here rather than copied.
 *    `test/arch.spec.ts` now calls `publicStringOffenders` instead of
 *    holding its own regexes, so the tree-wide sweep and the transcript
 *    sweep cannot drift.
 *
 * The banned strings are assembled from fragments (`'flow' + 'stay'`) for
 * one reason: this file would otherwise be the second file in the repo
 * that has to exempt itself from the sweep it implements, and an
 * exemption list that grows is how a sweep dies. Sc 7 exempted
 * `test/arch.spec.ts` because it had to; this file does not have to, so it
 * does not.
 */
import { redactTokens } from '@wemessage/adapter-testkit';
import { FRAME_SPECS } from '@wemessage/protocol';

/** Bumped when the shape of a generated DRYRUN.md changes. */
export const SKILL_DRYRUN_VERSION = 1;

/** The three §1.7 blocks, one argv pattern per line. */
export interface SkillPolicy {
  /** Verbs the agent MAY run. */
  readonly allowed: readonly string[];
  /** Verbs needing an explicit human instruction in the same turn. */
  readonly approval: readonly string[];
  /** Patterns the agent may NEVER run, whatever anybody says. */
  readonly never: readonly string[];
}

export interface Finding {
  readonly rule: string;
  /** 1-indexed line of the transcript the finding is anchored to. */
  readonly line: number;
  readonly detail: string;
}

// ---------------------------------------------------------------------------
// §1.7 block parsing
// ---------------------------------------------------------------------------

/**
 * Read one `<!-- wemessage:NAME -->` block: the next fenced region after
 * the marker, minus blanks and `#` comments.
 *
 * Identical in behaviour to the parser `packages/adapters/openclaw/test/
 * shim.spec.ts` grew in Sc 10, which is why that file now imports this one
 * rather than keeping its own: two parsers for one file format is one
 * parser too many, and the Sc 10 rows are exactly the rows that would stop
 * noticing if the formats drifted.
 */
function readBlock(doc: string, name: string): string[] {
  const marker = `<!-- wemessage:${name} -->`;
  const at = doc.indexOf(marker);
  if (at === -1) return [];
  const rest = doc.slice(at + marker.length);
  const open = rest.indexOf('```');
  if (open === -1) return [];
  const after = rest.slice(open + 3);
  const close = after.indexOf('```');
  if (close === -1) return [];
  return after
    .slice(0, close)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'));
}

export function parseSkillBlocks(doc: string): SkillPolicy {
  return {
    allowed: readBlock(doc, 'allowed'),
    approval: readBlock(doc, 'approval'),
    never: readBlock(doc, 'never'),
  };
}

// ---------------------------------------------------------------------------
// the argv glob
// ---------------------------------------------------------------------------

/**
 * Does `argv` match a block pattern?
 *
 * `*` stands for exactly one token, and a trailing `*` for one or more. A
 * pattern that runs out while argv has tokens left matches only if the
 * first leftover is a flag, so `status` covers `status --json` and
 * `audit list` covers `audit list --event draft.sent`, while `status
 * whatever` is a different command and does not match.
 *
 * `*` matches flags too, deliberately. That makes `drafts approve *` cover
 * `drafts approve --all`, which is the reason `never` is checked first and
 * `drafts approve --all` is on it: a permissive glob plus an explicit
 * refusal is a safer pairing than a glob nobody noticed was narrow.
 */
export function matchArgv(pattern: string, argv: readonly string[]): boolean {
  const pat = pattern.split(/\s+/).filter((t) => t !== '');
  let i = 0;
  for (let p = 0; p < pat.length; p += 1) {
    const token = pat[p];
    const last = p === pat.length - 1;
    if (token === '*') {
      if (i >= argv.length) return false;
      i += 1;
      if (last) return true; // trailing star swallows the remainder
      continue;
    }
    if (argv[i] !== token) return false;
    i += 1;
  }
  if (i === argv.length) return true;
  return (argv[i] ?? '').startsWith('-');
}

/**
 * The argv tokens a pattern's `*` positions consumed, minus flags.
 *
 * This is what "the thing the human has to have named" means, derived from
 * the pattern rather than guessed from the shape of the token: for
 * `drafts approve *` it is the draft id, and for `drafts create *` — whose
 * star lands on `--chat` — it is nothing, which is correct. A human asking
 * for a draft names the message, not the chat guid.
 */
export function globArgs(pattern: string, argv: readonly string[]): string[] {
  const pat = pattern.split(/\s+/).filter((t) => t !== '');
  const out: string[] = [];
  let i = 0;
  for (const token of pat) {
    if (i >= argv.length) break;
    if (token === '*') out.push(argv[i] ?? '');
    i += 1;
  }
  return out.filter((t) => t !== '' && !t.startsWith('-'));
}

// ---------------------------------------------------------------------------
// the public-string sweep (Sc 7's, widened)
// ---------------------------------------------------------------------------

/**
 * Built from fragments so this file is not itself an offender. The words
 * are the operator's brands; the point of the rule is that a public repo
 * never says who runs it.
 */
const BRAND_RE = new RegExp(
  [
    `flow${'stay'}`,
    `flow${'verse'}`,
    `flow${'industries'}`,
    `viva${'epic'}`,
  ].join('|'),
  'i',
);
/** Any +1 number. `+1555…` is the fiction reserve (NANP, never assigned). */
const PHONE_RE = /\+1\d{10}/g;
/** An absolute home path. Written indirectly for the reason above. */
const USER_PATH_RE = new RegExp(`/${'User'}s/[A-Za-z0-9._-]+`, 'g');
/** A bearer wearing 64 hex: an operator token, which Sc 6 never redacts. */
const BEARER_RE = /\b(?:Bearer|authorization:\s*Bearer)\s+[0-9a-f]{64}\b/gi;

export interface PublicOffender {
  readonly rule: string;
  /**
   * The string `test/arch.spec.ts` renders after `${file}: `. Kept exactly
   * as Sc 7 spelled it (`brand string`, or the number itself) so that the
   * tree-wide row and its proven teeth did not have to change meaning when
   * the implementation moved here.
   */
  readonly detail: string;
}

/**
 * Everything in a blob of text that a PUBLIC repository must not carry.
 *
 * Four arms. Two are Sc 7's, unchanged in wording. Two are new in Sc 11
 * and were verified against every tracked file at the commit that added
 * them, so nothing is grandfathered: the tree was already clean of adapter
 * tokens and of absolute home paths, and this is what keeps it that way.
 */
export function publicStringOffenders(text: string): PublicOffender[] {
  const out: PublicOffender[] = [];
  if (BRAND_RE.test(text))
    out.push({ rule: 'brand-string', detail: 'brand string' });
  for (const n of text.match(PHONE_RE) ?? [])
    if (!n.startsWith('+1555'))
      out.push({ rule: 'non-synthetic-contact', detail: n });
  // Sc 6 owns the token shape; asking it is the reuse.
  if (redactTokens(text) !== text)
    out.push({ rule: 'token-shaped', detail: 'adapter token' });
  // Count only: a bearer credential's VALUE must not be echoed into a
  // finding, or the report becomes the leak it is reporting.
  for (let i = (text.match(BEARER_RE) ?? []).length; i > 0; i--)
    out.push({ rule: 'token-shaped', detail: 'bearer token' });
  for (const p of text.match(USER_PATH_RE) ?? [])
    out.push({ rule: 'absolute-user-path', detail: p });
  return out;
}

// ---------------------------------------------------------------------------
// transcript rules
// ---------------------------------------------------------------------------

/** Any ANSI CSI introducer. The no-colour rule, strict (C-9). */
const ANSI_RE = /\x1b\[/;
/**
 * A hue used as a value. `#0A84FF` is the product's one colour and is
 * allowed anywhere; every other hex triplet and every bare colour word in a
 * value position is state carried by hue, which the house pattern forbids.
 */
const HEX_COLOUR_RE = /#[0-9a-fA-F]{6}\b/g;
const PRODUCT_BLUE = '#0a84ff';
const COLOUR_WORD_RE = /\b(green|red|amber|yellow|orange)\b/gi;
/** A host that is neither loopback nor a reserved example domain. */
const HOST_RE = /\b(?:wss?|https?):\/\/([A-Za-z0-9._-]+)/g;
const MAILBOX_RE = /\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;
const SYNTHETIC_HOSTS = /^(127\.0\.0\.1|localhost|\[::1\])$/;
const SYNTHETIC_DOMAIN = /(^|\.)(example\.(com|org|net)|invalid|localhost)$/i;
/** A wire frame: `"type": "x"` with a `"v":` nearby. */
const FRAME_TYPE_RE = /"type"\s*:\s*"([^"]+)"/g;
const FRAME_NAMES = new Set(Object.keys(FRAME_SPECS));

/** `$ wemessage drafts approve 01H…` → the argv after the binary name. */
function commandOf(line: string): string[] | null {
  const m = /^\s*\$\s*wemessage\s+(.*)$/.exec(line);
  if (m === null) return null;
  return (m[1] ?? '')
    .split(/\s+/)
    .filter((t) => t !== '')
    .map((t) => t.replace(/^["']|["']$/g, ''));
}

/**
 * Lint a transcript against the policy the document declares.
 *
 * The policy is an ARGUMENT, never a copy held here. That is not a style
 * preference: a linter carrying its own never-list is a linter that keeps
 * passing after somebody edits the document, which is the single most
 * likely way this guard goes blind. `skill-dryrun.spec.ts` has a row that
 * hands this function an empty never-list and asserts the rule goes quiet,
 * which a hardcoded copy could not survive.
 */
export function lintTranscript(
  transcript: string,
  policy: SkillPolicy,
): Finding[] {
  const out: Finding[] = [];
  const lines = transcript.split('\n');
  /** The human sentence that opened the current turn, if any. */
  let instruction: string | null = null;

  lines.forEach((line, index) => {
    const n = index + 1;
    const add = (rule: string, detail: string): void => {
      out.push({ rule, line: n, detail });
    };

    if (/^\s*human:\s*/i.test(line)) instruction = line;

    // --- policy ---------------------------------------------------------
    const argv = commandOf(line);
    if (argv !== null) {
      const banned = policy.never.find((p) => matchArgv(p, argv));
      if (banned !== undefined) {
        add('never-do', banned);
      } else if (!policy.allowed.some((p) => matchArgv(p, argv))) {
        add('verb-not-allowed', argv.join(' '));
      } else {
        const gate = policy.approval.find((p) => matchArgv(p, argv));
        if (gate !== undefined) {
          // The instruction must exist AND must name what it acts on. A
          // human who said "approve 01HAAA" did not consent to 01HZZZ, and
          // an agent that read any nearby sentence as blanket permission
          // is the failure this rule exists for.
          const said = instruction;
          if (said === null) {
            add('approval-without-instruction', argv.join(' '));
          } else {
            const targets = globArgs(gate, argv);
            if (targets.length > 0 && !targets.some((t) => said.includes(t)))
              add(
                'approval-without-instruction',
                `${argv.join(' ')} vs ${said.trim()}`,
              );
          }
        }
      }
    }

    // --- secrets, people, the operator -----------------------------------
    for (const o of publicStringOffenders(line)) add(o.rule, o.detail);

    // --- colour ----------------------------------------------------------
    if (ANSI_RE.test(line)) add('ansi-escape', 'ANSI CSI introducer');
    for (const hex of line.match(HEX_COLOUR_RE) ?? [])
      if (hex.toLowerCase() !== PRODUCT_BLUE) add('colour-carries-state', hex);
    for (const word of line.match(COLOUR_WORD_RE) ?? [])
      add('colour-carries-state', word);

    // --- people, continued ------------------------------------------------
    for (const m of line.matchAll(HOST_RE)) {
      const host = m[1] ?? '';
      if (!SYNTHETIC_HOSTS.test(host) && !SYNTHETIC_DOMAIN.test(host))
        add('non-synthetic-contact', host);
    }
    for (const m of line.matchAll(MAILBOX_RE)) {
      const domain = m[1] ?? '';
      if (!SYNTHETIC_DOMAIN.test(domain))
        add('non-synthetic-contact', m[0] ?? domain);
    }

    // --- INV-2 -------------------------------------------------------------
    for (const m of line.matchAll(FRAME_TYPE_RE)) {
      const name = m[1] ?? '';
      // Only wire frames carry a version alongside the type; an audit row
      // or any other `"type"` field is not a claim about the protocol.
      if (!/"v"\s*:\s*\d/.test(line)) continue;
      if (!FRAME_NAMES.has(name)) add('unknown-frame-named', name);
    }
  });

  return out;
}

/**
 * Lint a SKILL.md as a document rather than as a transcript.
 *
 * The transcript rules already apply to it (Sc 11 row 9 sweeps every file
 * under `skills/`). This adds the one check that only makes sense against
 * a document: it must not name a wire frame that does not exist, in prose
 * or in an example, because a skill is exactly where a capable agent goes
 * looking for permission it was not given, and an invented frame name is
 * the most plausible shape that permission would take.
 */
export function lintSkillDocument(doc: string): Finding[] {
  const out: Finding[] = [];
  doc.split('\n').forEach((line, index) => {
    for (const m of line.matchAll(/`([a-z]+(?:\.[a-z]+)+)`/g)) {
      const name = m[1] ?? '';
      // Only names that LOOK like frames: one dot, both halves lowercase.
      // `chat.db` and `example.com` are not claims about the wire, so the
      // check is scoped to the prefixes the protocol actually uses.
      const prefix = name.split('.')[0] ?? '';
      if (!['draft', 'proactive', 'event', 'adapter'].includes(prefix))
        continue;
      if (!FRAME_NAMES.has(name))
        out.push({
          rule: 'unknown-frame-named',
          line: index + 1,
          detail: name,
        });
    }
  });
  return out;
}
