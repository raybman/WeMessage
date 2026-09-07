/**
 * The LaunchAgent property list: built as a value, rendered as XML, and
 * refused when it is not the one thing this project installs (s9 Sc3 rows
 * 1-4, plan §1.7).
 *
 * WHY A RENDERER RATHER THAN A TEMPLATE. The plist is the file launchd obeys.
 * Four keys turn the agent this project installs into something else:
 * `UserName` runs it as another account, `SessionCreate` gives it its own
 * security session, `LaunchOnlyOnce` cancels the keep-alive contract, and
 * `Sockets` makes it socket-activated — at which point launchd, not this
 * daemon's instance lock, decides who owns the directory. Each of those is
 * one line in a template string somebody edits in a hurry. So the plist is
 * not a template: it is a function that will not build those.
 *
 * WHY THERE IS A PARSER HERE TOO, in a file whose job is to write. Two
 * callers need to read one back. The installer compares the file it is about
 * to write with the file already on disk, so a re-install that changes
 * nothing changes nothing (Sc3 row 7). And the runner, before it hands a path
 * to `bootstrap`, checks that the `Label` INSIDE the file is the label it was
 * asked to act on (Sc3 G1) — because launchd obeys the file, not the
 * argument. A parser for the subset we emit is thirty lines; a dependency
 * that parses all of plist is a dependency in the path of `bootstrap`.
 *
 * THIS FILE IS PURE. It has no `node:fs` import and no spawn. The refusals
 * are decided from values, before anything reaches a disk, which is what lets
 * the installer put its audit row down first (§1.8) and lets the arch sweep
 * say that the only thing which can start a process is one file away.
 *
 * INV-1: no `@wemessage/core` import. The renderer is adapter-blind and
 * store-blind; it turns a spec into a string.
 */
import {
  isLaunchAgentLabel,
  LaunchdLabelRefused,
  type LaunchAgentLabel,
} from './contract.js';

/** The subset of the property-list type system this project emits. */
export type PlistValue =
  | string
  | number
  | boolean
  | readonly PlistValue[]
  | { readonly [key: string]: PlistValue };
export type PlistDict = { readonly [key: string]: PlistValue };

/** Thrown for a plist this project will not build or will not read. */
export class LaunchdPlistRefused extends Error {
  readonly code = 'LAUNCHD_PLIST_REFUSED' as const;
  readonly detail: string;
  constructor(detail: string) {
    super(`refusing this LaunchAgent plist: ${detail}`);
    this.name = 'LaunchdPlistRefused';
    this.detail = detail;
  }
}

/**
 * Every key §1.7 names, sorted.
 *
 * Sorted because the renderer emits them in this order and a diff of two
 * plists that differ only in key order is a diff nobody reads. Exported so
 * the spec asserts a closed set rather than a spot check.
 */
export const LAUNCH_AGENT_PLIST_KEYS = [
  'EnvironmentVariables',
  'KeepAlive',
  'Label',
  'LimitLoadToSessionType',
  'ProcessType',
  'ProgramArguments',
  'RunAtLoad',
  'StandardErrorPath',
  'StandardOutPath',
  'ThrottleInterval',
] as const;

/**
 * The four keys that would make this a different kind of service.
 *
 * Not "no extra keys": Sc 4 and Sc 7 have legitimate reasons to add
 * `ExitTimeOut` or `WatchPaths`, and a guard a legitimate caller has to be
 * exempted from is the wrong guard. These four are named, and only these.
 */
export const FORBIDDEN_PLIST_KEYS = [
  'LaunchOnlyOnce',
  'SessionCreate',
  'Sockets',
  'UserName',
] as const;

/** The packaged layout (F-121). */
export const BUNDLE_EXECUTABLE_SUFFIX = '/Contents/MacOS/WeMessage';
export const BUNDLE_DAEMON_MAIN_SUFFIX = '/Contents/Resources/daemon/main.mjs';
/** The development layout: the repository's own node against the built entry. */
export const DEV_DAEMON_MAIN_SUFFIX = '/packages/daemon/dist/main.js';

/**
 * The two argument vectors this project will supervise, and no third.
 *
 * `bundle` is what ships. `dev` exists because the packaged app does not
 * exist until Sc 6 and the lifecycle rows have to point launchd at something
 * real before then; making it a NAMED shape rather than "anything goes when
 * testing" is the difference between two supported layouts and a plist that
 * can run an arbitrary program under the operator's account at every login.
 */
export type ProgramArgumentsShape = 'bundle' | 'dev';

export function programArgumentsShape(
  args: readonly string[],
): ProgramArgumentsShape {
  if (args.length !== 2)
    throw new LaunchdPlistRefused(
      `ProgramArguments must be exactly two entries, got ${String(args.length)}`,
    );
  const [exe, script] = args as [string, string];
  if (
    exe.endsWith(BUNDLE_EXECUTABLE_SUFFIX) &&
    script.endsWith(BUNDLE_DAEMON_MAIN_SUFFIX)
  )
    return 'bundle';
  if (exe.startsWith('/') && script.endsWith(DEV_DAEMON_MAIN_SUFFIX))
    return 'dev';
  throw new LaunchdPlistRefused(
    `ProgramArguments ${JSON.stringify(args)} is neither the bundle shape ` +
      `(…${BUNDLE_EXECUTABLE_SUFFIX}, …${BUNDLE_DAEMON_MAIN_SUFFIX}) nor the ` +
      `dev shape (<node>, …${DEV_DAEMON_MAIN_SUFFIX})`,
  );
}

export interface LaunchAgentSpec {
  readonly label: LaunchAgentLabel;
  readonly programArguments: readonly string[];
  readonly stdoutPath: string;
  readonly stderrPath: string;
  /** Only emitted when set: an absent override is an ABSENT key (F-80). */
  readonly dir?: string;
  readonly port?: number;
  /**
   * The chat database the supervised daemon tails. Only emitted when set,
   * exactly like `dir` and `port`.
   *
   * A launchd job has no shell, no profile and no inherited environment —
   * this dict IS its environment. Absent, the daemon falls back to
   * `~/Library/Messages/chat.db`, the operator's real one, with nothing in
   * the plist saying so. That is why it is a first-class spec field rather
   * than something a caller is trusted to remember.
   */
  readonly chatDb?: string;
  /** §1.7 default 10; tests use 1 so a restart is observable in a deadline. */
  readonly throttleInterval?: number;
  readonly extraKeys?: PlistDict;
}

/**
 * The plist as a VALUE — the thing that is serialized, and the thing a parse
 * recovers.
 *
 * Every refusal lives here, so `renderLaunchAgentPlist` cannot be reached
 * with a spec this function would have rejected.
 */
export function launchAgentPlistObject(spec: LaunchAgentSpec): PlistDict {
  // The brand is a compile-time fiction and this is a place labels arrive
  // from config files and argv, so it is asked again.
  if (!isLaunchAgentLabel(spec.label))
    throw new LaunchdLabelRefused(spec.label);

  const shape = programArgumentsShape(spec.programArguments);

  const env: Record<string, string> = {
    WEMESSAGE_SUPERVISOR: 'launchd',
    WEMESSAGE_LAUNCHD_LABEL: spec.label,
  };
  // Only under the packaged app: the variable tells Electron's binary to
  // behave as node. Set for a plain `node` it means nothing, and a variable
  // that means nothing in a plist is a variable somebody copies into one
  // where it does.
  if (shape === 'bundle') env['ELECTRON_RUN_AS_NODE'] = '1';
  if (spec.dir !== undefined) env['WEMESSAGE_DIR'] = spec.dir;
  if (spec.port !== undefined) env['WEMESSAGE_PORT'] = String(spec.port);
  if (spec.chatDb !== undefined) env['WEMESSAGE_CHATDB'] = spec.chatDb;

  const core: Record<string, PlistValue> = {
    EnvironmentVariables: env,
    KeepAlive: true,
    Label: spec.label,
    LimitLoadToSessionType: 'Aqua',
    ProcessType: 'Background',
    ProgramArguments: [...spec.programArguments],
    RunAtLoad: true,
    StandardErrorPath: spec.stderrPath,
    StandardOutPath: spec.stdoutPath,
    ThrottleInterval: spec.throttleInterval ?? 10,
  };

  const out: Record<string, PlistValue> = { ...core };
  for (const [key, value] of Object.entries(spec.extraKeys ?? {})) {
    if ((FORBIDDEN_PLIST_KEYS as readonly string[]).includes(key))
      throw new LaunchdPlistRefused(
        `${key} is not a key this project's agent may carry: it would change ` +
          `what kind of service launchd runs`,
      );
    if (key in core)
      throw new LaunchdPlistRefused(
        `${key} is one of the §1.7 keys and cannot be overridden through extraKeys`,
      );
    out[key] = value;
  }
  return out;
}

/* ── rendering ────────────────────────────────────────────────────────── */

/**
 * `&` first.
 *
 * An escaper that replaces `<` before `&` turns a literal `<` into
 * `&amp;lt;`, and the bug survives every test that only checks one character
 * at a time. Hence the order, and hence row 4 asserting all three together.
 */
function xmlEscape(raw: string): string {
  return raw
    .split('&')
    .join('&amp;')
    .split('<')
    .join('&lt;')
    .split('>')
    .join('&gt;');
}

/**
 * `Array.isArray` is typed `arg is any[]`, which does not narrow a
 * `readonly PlistValue[]` member of a union — it hands back `any`, and an
 * `any` inside the renderer is exactly the hole the closed `PlistValue`
 * union exists to prevent. A named predicate keeps the narrowing honest
 * without a cast and without widening the union.
 */
function isPlistArray(v: PlistValue): v is readonly PlistValue[] {
  return Array.isArray(v);
}

function renderValue(value: PlistValue, indent: string): string {
  if (typeof value === 'boolean') return `${indent}<${String(value)}/>\n`;
  if (typeof value === 'number') {
    if (!Number.isInteger(value))
      return `${indent}<real>${String(value)}</real>\n`;
    return `${indent}<integer>${String(value)}</integer>\n`;
  }
  if (typeof value === 'string')
    return `${indent}<string>${xmlEscape(value)}</string>\n`;
  if (isPlistArray(value)) {
    if (value.length === 0) return `${indent}<array/>\n`;
    let out = `${indent}<array>\n`;
    for (const item of value) out += renderValue(item, `${indent}\t`);
    return `${out}${indent}</array>\n`;
  }
  const entries = Object.entries(value).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  if (entries.length === 0) return `${indent}<dict/>\n`;
  let out = `${indent}<dict>\n`;
  for (const [key, item] of entries) {
    out += `${indent}\t<key>${xmlEscape(key)}</key>\n`;
    out += renderValue(item, `${indent}\t`);
  }
  return `${out}${indent}</dict>\n`;
}

/** The plist, as the bytes that go on disk. Pure: nothing is written here. */
export function renderLaunchAgentPlist(spec: LaunchAgentSpec): string {
  const obj = launchAgentPlistObject(spec);
  return (
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" ' +
    '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
    '<plist version="1.0">\n' +
    renderValue(obj, '') +
    '</plist>\n'
  );
}

/* ── parsing ──────────────────────────────────────────────────────────── */

function xmlUnescape(raw: string): string {
  return raw
    .split('&lt;')
    .join('<')
    .split('&gt;')
    .join('>')
    .split('&amp;')
    .join('&');
}

interface Cursor {
  readonly xml: string;
  i: number;
}

function skipTrivia(c: Cursor): void {
  for (;;) {
    while (c.i < c.xml.length && /\s/.test(c.xml[c.i] ?? '')) c.i += 1;
    if (c.xml.startsWith('<?', c.i) || c.xml.startsWith('<!', c.i)) {
      const end = c.xml.indexOf('>', c.i);
      if (end < 0) throw new LaunchdPlistRefused('unterminated declaration');
      c.i = end + 1;
      continue;
    }
    return;
  }
}

function readTag(c: Cursor): {
  name: string;
  selfClosing: boolean;
  closing: boolean;
} {
  skipTrivia(c);
  if (c.xml[c.i] !== '<')
    throw new LaunchdPlistRefused(`expected a tag at offset ${String(c.i)}`);
  const end = c.xml.indexOf('>', c.i);
  if (end < 0) throw new LaunchdPlistRefused('unterminated tag');
  const body = c.xml.slice(c.i + 1, end);
  c.i = end + 1;
  const closing = body.startsWith('/');
  const selfClosing = body.endsWith('/');
  const name = body.replace(/^\//, '').replace(/\/$/, '').split(/\s/)[0] ?? '';
  return { name, selfClosing, closing };
}

function readTextUntilClose(c: Cursor, tag: string): string {
  const close = `</${tag}>`;
  const end = c.xml.indexOf(close, c.i);
  if (end < 0) throw new LaunchdPlistRefused(`unterminated <${tag}>`);
  const text = c.xml.slice(c.i, end);
  c.i = end + close.length;
  return text;
}

function parseValueAt(c: Cursor): PlistValue {
  const tag = readTag(c);
  if (tag.closing) throw new LaunchdPlistRefused(`unexpected </${tag.name}>`);
  switch (tag.name) {
    case 'true':
      return true;
    case 'false':
      return false;
    case 'string':
      return tag.selfClosing
        ? ''
        : xmlUnescape(readTextUntilClose(c, 'string'));
    case 'integer':
      return Number.parseInt(readTextUntilClose(c, 'integer').trim(), 10);
    case 'real':
      return Number.parseFloat(readTextUntilClose(c, 'real').trim());
    case 'array': {
      if (tag.selfClosing) return [];
      const items: PlistValue[] = [];
      for (;;) {
        const save = c.i;
        const next = readTag(c);
        if (next.closing && next.name === 'array') return items;
        c.i = save;
        items.push(parseValueAt(c));
      }
    }
    case 'dict': {
      if (tag.selfClosing) return {};
      const out: Record<string, PlistValue> = {};
      for (;;) {
        const next = readTag(c);
        if (next.closing && next.name === 'dict') return out;
        if (next.name !== 'key')
          throw new LaunchdPlistRefused(`expected <key>, saw <${next.name}>`);
        const key = xmlUnescape(readTextUntilClose(c, 'key'));
        out[key] = parseValueAt(c);
      }
    }
    default:
      throw new LaunchdPlistRefused(`unsupported plist element <${tag.name}>`);
  }
}

/**
 * Read back a plist this module wrote.
 *
 * Deliberately narrow: it understands the elements this project emits and
 * refuses everything else, including `<data>` and `<date>`. A parser that
 * shrugged at an element it did not recognise would be a parser that reads a
 * foreign plist as an empty one, and the caller downstream of that is
 * `bootstrap`.
 */
export function parseLaunchAgentPlist(xml: string): PlistDict {
  const c: Cursor = { xml, i: 0 };
  skipTrivia(c);
  const root = readTag(c);
  if (root.name !== 'plist')
    throw new LaunchdPlistRefused(`expected <plist>, saw <${root.name}>`);
  const value = parseValueAt(c);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new LaunchdPlistRefused('the plist root is not a dictionary');
  return value as PlistDict;
}

/**
 * The `Label` a plist file DECLARES, or null if it declares none.
 *
 * The one question `bootstrap` has to ask about a file before it loads it,
 * exposed as its own function so the runner does not have to know the shape
 * of a parsed plist.
 */
export function plistDeclaredLabel(xml: string): string | null {
  const label = parseLaunchAgentPlist(xml)['Label'];
  return typeof label === 'string' ? label : null;
}
