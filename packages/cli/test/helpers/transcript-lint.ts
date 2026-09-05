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
// colour literals (s8 Sc1, F-104)
// ---------------------------------------------------------------------------

/**
 * ONE tokenizer for "is there a colour written down here", and one predicate
 * for "is that colour green".
 *
 * These live here rather than in the desktop app's test tree for the reason
 * s7 twice acted on: `publicStringOffenders` moved here in Sc 11 because a
 * second copy of "what must a public repo never say" is the copy that goes
 * stale, and Sc 12 reused `lintTranscript` on the shipped documents for the
 * same reason. S8 needs the identical question asked in three places — a
 * transcript line, every file under `apps/desktop/src`, and `tokens.css` —
 * and a fourth copy of a hue predicate is exactly the shape of duplication
 * that ends with three of them disagreeing about `#3C5`.
 *
 * What is deliberately NOT shared is the POLICY. `lintTranscript` refuses
 * every colour but the product blue, because a terminal transcript is
 * monochrome by construction. The desktop lint permits every colour that is
 * not green, in one file. Same tokens, different verdicts, one parser.
 */
export type ColourForm = 'hex' | 'functional' | 'named';

export interface ColourLiteral {
  readonly text: string;
  /** 0-indexed offset into the text that was scanned. */
  readonly index: number;
  readonly form: ColourForm;
}

export interface ColourScanOptions {
  /**
   * Also match the three- and four-digit hex forms. Off by default: a
   * markdown anchor (`#abc`) and an issue reference (`#123`) are three hex
   * digits and are not colours, so only a scan that already knows it is
   * looking at stylesheet-shaped text should turn this on.
   */
  readonly shortHex?: boolean;
  /**
   * Also match a CSS named colour sitting in a colour-valued position
   * (`fill="lime"`, `color: white`). Off by default for the same reason:
   * the CSS Color 4 list is 148 ordinary English words and most of a
   * README would light up.
   */
  readonly namedInContext?: boolean;
}

/** Longest-first so `#0A84FF` is one six-digit hex, never a three plus junk. */
const HEX_LONG_RE = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/g;
const HEX_ANY_RE =
  /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{4}|[0-9a-fA-F]{3})\b/g;
/**
 * A functional colour notation with a plausible body. The digit/percent
 * requirement is not decoration: without it `the color(s) below` in a README
 * is a colour literal, and a guard that cries wolf on prose is a guard
 * somebody turns off.
 */
const FUNCTIONAL_COLOUR_RE =
  /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(\s*[^()]*[\d%][^()]*\)/gi;
/**
 * The property names whose value is a colour. An SVG presentation attribute
 * (`fill="lime"`) and a CSS declaration (`color: white`) are both covered by
 * allowing `=` or `:` as the separator.
 */
const COLOUR_CONTEXT_RE =
  /\b(?:fill|stroke|stop-color|flood-color|lighting-color|color|background|background-color|border(?:-(?:top|right|bottom|left))?-color|outline-color|text-decoration-color|caret-color|accent-color|column-rule-color|box-shadow|text-shadow)\s*[:=]\s*["']?([A-Za-z]+)\b/gi;

/**
 * The CSS Color 4 named colours. Data, not logic: the point of the list is
 * that it is complete, because the one somebody reaches for is always the
 * one a hand-picked subset omitted.
 *
 * `transparent`, `currentcolor`, `none`, `inherit`, `initial`, `unset`,
 * `revert` and `var` are deliberately absent — none of them names a hue, and
 * three of them are how a correct file spells "take the colour from a token".
 */
const CSS_NAMED_COLOURS = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black ' +
    'blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse ' +
    'chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan ' +
    'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta ' +
    'darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet ' +
    'deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite ' +
    'forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green ' +
    'greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender ' +
    'lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink ' +
    'lightsalmon lightseagreen lightskyblue lightslategray lightslategrey ' +
    'lightsteelblue lightyellow lime limegreen linen magenta maroon ' +
    'mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred ' +
    'midnightblue mintcream mistyrose moccasin navajowhite navy oldlace ' +
    'olive olivedrab orange orangered orchid palegoldenrod palegreen ' +
    'paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown ' +
    'salmon sandybrown seagreen seashell sienna silver skyblue slateblue ' +
    'slategray slategrey snow springgreen steelblue tan teal thistle tomato ' +
    'turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** Every colour literal in `text`, in source order. */
export function colourLiterals(
  text: string,
  options: ColourScanOptions = {},
): ColourLiteral[] {
  const out: ColourLiteral[] = [];
  const hexRe = options.shortHex === true ? HEX_ANY_RE : HEX_LONG_RE;
  for (const m of text.matchAll(hexRe))
    out.push({ text: m[0], index: m.index, form: 'hex' });
  for (const m of text.matchAll(FUNCTIONAL_COLOUR_RE))
    out.push({ text: m[0], index: m.index, form: 'functional' });
  if (options.namedInContext === true) {
    for (const m of text.matchAll(COLOUR_CONTEXT_RE)) {
      const word = (m[1] ?? '').toLowerCase();
      if (!CSS_NAMED_COLOURS.has(word)) continue;
      out.push({ text: m[1] ?? '', index: m.index, form: 'named' });
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

function hueSat(rgb: Rgb): { hue: number; sat: number } {
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return { hue: 0, sat: 0 };
  const l = (max + min) / 2;
  const sat = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let hue: number;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return { hue, sat };
}

/**
 * A colour literal as sRGB, or `null` when the literal is a form this parser
 * does not resolve.
 *
 * Named colours return `null` ON PURPOSE. Resolving them would mean carrying
 * 148 triples, and the desktop lint does not need them: a named colour is
 * refused by FORM there (colour lives in `tokens.css` and `tokens.css` is
 * written in hex and `rgba()`), so a hue verdict on `lime` would never be
 * asked for. Modern spaces (`oklch`, `lab`) are also `null`: nothing in the
 * tree uses one, and a wrong conversion that reports "not green" is worse
 * than an honest "cannot parse" the caller can treat as an offender.
 */
export function parseColour(literal: string): Rgb | null {
  const text = literal.trim();
  const hex = /^#([0-9a-fA-F]{3,8})$/.exec(text);
  if (hex !== null) {
    const digits = hex[1] ?? '';
    const expand = (s: string): string => s + s;
    if (digits.length === 3 || digits.length === 4) {
      const [a, b, c] = [digits[0] ?? '0', digits[1] ?? '0', digits[2] ?? '0'];
      return {
        r: parseInt(expand(a), 16),
        g: parseInt(expand(b), 16),
        b: parseInt(expand(c), 16),
      };
    }
    if (digits.length === 6 || digits.length === 8) {
      return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
      };
    }
    return null;
  }
  const fn = /^([a-z]+)\(([^()]*)\)$/i.exec(text);
  if (fn === null) return null;
  const name = (fn[1] ?? '').toLowerCase();
  const parts = (fn[2] ?? '')
    .split(/[\s,/]+/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
  const num = (p: string | undefined, scale: number): number => {
    const raw = p ?? '';
    if (raw.endsWith('%')) return (Number(raw.slice(0, -1)) / 100) * scale;
    return Number(raw);
  };
  if (name === 'rgb' || name === 'rgba') {
    const r = num(parts[0], 255);
    const g = num(parts[1], 255);
    const b = num(parts[2], 255);
    if ([r, g, b].some((v) => Number.isNaN(v))) return null;
    return { r, g, b };
  }
  if (name === 'hsl' || name === 'hsla') {
    const h = ((num(parts[0], 360) % 360) + 360) % 360;
    const s = num(parts[1], 100) / 100;
    const l = num(parts[2], 100) / 100;
    if ([h, s, l].some((v) => Number.isNaN(v))) return null;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;
    const seg = Math.floor(h / 60) % 6;
    const table: [number, number, number][] = [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ];
    const [r1, g1, b1] = table[seg] ?? [0, 0, 0];
    return {
      r: Math.round((r1 + m) * 255),
      g: Math.round((g1 + m) * 255),
      b: Math.round((b1 + m) * 255),
    };
  }
  return null;
}

/** The three hexes ui-design-integration §2 bans by name. Lower case. */
export const BANNED_GREEN_HEXES: readonly string[] = [
  '#34c759',
  '#248a3d',
  '#30d158',
];

/** The message F-104 requires the by-name arm to fail with. */
export const GREEN_BAN_MESSAGE = 'green is banned (ui-design-integration §2)';

/**
 * Is this colour literal green? F-104's predicate, verbatim.
 *
 * Three arms, and the order is the order of decreasing confidence:
 *
 *  1. one of the three hexes the UI doc bans BY NAME, so the failure message
 *     is the sentence the doc wrote rather than a hue reading;
 *  2. dominant-G: `g > max(r, b) + 16`, which is what "reads as green"
 *     reduces to for a saturated colour and which no blue, red or amber in
 *     the token sheet comes near;
 *  3. hue in [75°, 165°] at more than 10% saturation, which catches the
 *     desaturated and the dark greens that arm 2 misses.
 *
 * Arm 3 has a SHARP EDGE worth knowing about before somebody trips it: HSL
 * saturation is a bad measure near white, where a two-count channel
 * difference reads as 11%. `#F5F7F5` is therefore "green" to this function
 * and `#F5F5F7` is not. That is the plan's predicate as written and it is
 * kept as written: an almost-imperceptibly green off-white is still a
 * decision somebody made, and the fix is to pick the neutral, not to widen
 * the guard.
 *
 * Returns `null` for a literal it cannot parse, which callers treat as an
 * offender in its own right rather than as a pass.
 */
export function greenVerdict(
  literal: string,
): { green: boolean; why: string } | null {
  const lower = literal.trim().toLowerCase();
  if (BANNED_GREEN_HEXES.includes(lower))
    return { green: true, why: `${GREEN_BAN_MESSAGE}: ${lower}` };
  // `#34C759FF` and `#34c759` are the same decision wearing an alpha.
  if (
    /^#[0-9a-f]{8}$/.test(lower) &&
    BANNED_GREEN_HEXES.includes(lower.slice(0, 7))
  )
    return { green: true, why: `${GREEN_BAN_MESSAGE}: ${lower}` };
  const rgb = parseColour(literal);
  if (rgb === null) return null;
  if (rgb.g > Math.max(rgb.r, rgb.b) + 16)
    return {
      green: true,
      why: `dominant-G (g ${String(rgb.g)} > max(r ${String(rgb.r)}, b ${String(rgb.b)}) + 16)`,
    };
  const { hue, sat } = hueSat(rgb);
  if (hue >= 75 && hue <= 165 && sat > 0.1)
    return {
      green: true,
      why: `hue ${hue.toFixed(1)}deg at ${(sat * 100).toFixed(1)}% saturation is in [75, 165]`,
    };
  return { green: false, why: '' };
}

// ---------------------------------------------------------------------------
// transcript rules
// ---------------------------------------------------------------------------

/** Any ANSI CSI introducer. The no-colour rule, strict (C-9). */
const ANSI_RE = /\x1b\[/;

/**
 * Every line of `text` that carries an ANSI CSI introducer.
 *
 * Extracted by s8 Sc1 so that the desktop suite can run THE ansi sweep
 * rather than a fourth regex that means to say the same thing. `apps/desktop`
 * has no transcripts today; the row that consumes this exists so that the
 * first builder to paste a coloured log line into a desktop spec trips a
 * guard instead of establishing a precedent. Same escape, same rule name,
 * same detail string as `lintTranscript`, because it IS `lintTranscript`'s.
 */
export function ansiOffenders(text: string): Finding[] {
  const out: Finding[] = [];
  text.split('\n').forEach((line, index) => {
    if (ANSI_RE.test(line))
      out.push({
        rule: 'ansi-escape',
        line: index + 1,
        detail: 'ANSI CSI introducer',
      });
  });
  return out;
}
/**
 * A hue used as a value. `#0A84FF` is the product's one colour and is
 * allowed anywhere; every other hex triplet and every bare colour word in a
 * value position is state carried by hue, which the house pattern forbids.
 */
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
    // s8 Sc1: the hex arm is now `colourLiterals` (below), which is the same
    // tokenizer the desktop app's static no-green lint uses. Two POLICIES
    // over one tokenizer: a transcript is monochrome so anything that is not
    // the product blue is a finding, while `tokens.css` is allowed every
    // colour that is not green. The default option set keeps this call's
    // behaviour byte-for-byte what it was — six- and eight-digit hex only,
    // no three-digit form (a markdown `#abc` anchor or a `#123` issue
    // reference is not a colour) and no bare named colours (`red` is already
    // COLOUR_WORD_RE's, and the CSS named list is full of English words).
    for (const o of ansiOffenders(line)) add(o.rule, o.detail);
    for (const lit of colourLiterals(line))
      if (lit.text.toLowerCase() !== PRODUCT_BLUE)
        add('colour-carries-state', lit.text);
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
