#!/usr/bin/env node
/**
 * wemessage CLI (§3.8): status / watch / auth print-token / auth rotate
 * (S1) plus rules and audit command groups (S2 Scenario 11). Thin wrapper
 * over the daemon API via @wemessage/client (§2.5 "zero business logic
 * duplicated") — every validation not expressible as a daemon 400 (e.g.
 * "exactly one matcher source") lives here, client-side, so a usage error
 * never reaches the wire.
 *
 * Exit codes (§3.8): 0 success, 1 operation failed, 2 usage error,
 * 3 daemon unreachable, 4 auth failure. `audit verify` is the one verb
 * that turns a *successful* read into a non-zero exit: a broken chain is
 * reported (on stdout) AND exits 1 (§2.3 — the finding is the failure).
 *
 * Auth bootstrap (§2.6): --token/-T flag, else WEMESSAGE_TOKEN env
 * (remote/CI), else the token file in WEMESSAGE_DIR read directly
 * (same-user filesystem trust).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, CommanderError } from 'commander';
import {
  createClient,
  readTokenFile,
  rotateTokenFile,
  DaemonAuthError,
  DaemonConflictError,
  DaemonEventFilterError,
  DaemonGateDeniedError,
  DaemonRequestError,
  DaemonSettingsError,
  DaemonUnreachableError,
  type AuditRowPayload,
  type AuditVerifyResult,
  type DisconnectReportPayload,
  type DoctorCheckPayload,
  type DoctorReportPayload,
  type DryRunResult,
  type RuleInput,
  type RuleMatcher,
  type RulePayload,
  type RuleTestResult,
  type RuleWriteResult,
  type BatchReport,
  type ContactMode,
  type ContactPolicyPayload,
  type DraftPayload,
  type DraftState,
  type SendResult,
  type AdapterKind,
  type AdapterPatch,
  type RespondMode,
  type SchedulePatch,
  type ScheduleWindowPayload,
  type SettingsPayload,
} from '@wemessage/client';
import {
  renderAdapter,
  renderAdapterTable,
  renderMintedCredential,
} from './adapters.js';
import {
  confirmTyped,
  contactAutoPhrase,
  contactAutoPrompt,
  isRespondMode,
  parseWindowSpec,
  renderMode,
  renderPause,
  renderResume,
  renderSchedule,
  renderScheduleTable,
  renderStatus,
  resolveGlobalMode,
  resumeHolds,
  GLOBAL_AUTO_PHRASE,
  GLOBAL_AUTO_PROMPT,
} from './arming.js';
import { probeChatDbReadable } from './probe.js';
import { confirmPurge } from './purge.js';
import {
  parseSettingLiteral,
  renderSettingsSet,
  renderSettingsTable,
  settingsRefusal,
} from './settings.js';
import { createWatchRenderer, parseEventsFlag } from './watch.js';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHABLE = 3;
const EXIT_AUTH = 4;
const EXIT_GATE_DENIED = 5;
/** `drafts approve --all --wait` poll interval (F-37). */
const WAIT_POLL_MS = 100;

function configDir(): string {
  return (
    process.env['WEMESSAGE_DIR'] ??
    join(homedir(), 'Library', 'Application Support', 'WeMessage')
  );
}

function baseUrl(): string {
  const port = process.env['WEMESSAGE_PORT'] ?? '47100';
  return `http://127.0.0.1:${port}`;
}

function resolveToken(flag?: string): string | null {
  return flag ?? process.env['WEMESSAGE_TOKEN'] ?? readTokenFile(configDir());
}

function fail(message: string, code: number): never {
  console.error(`wemessage: ${message}`);
  process.exit(code);
}

function exitFor(error: unknown): never {
  if (error instanceof DaemonConflictError) {
    // Exit 1, the operation-failed code: an illegal transition is a real
    // refusal, not a usage error. The message names the state it actually
    // was, because "you cannot approve that" without saying why is the
    // least useful thing a CLI can print.
    const {
      error: kind,
      from,
      requested,
      attempts,
      ruleIds,
      id,
    } = error.detail;
    fail(
      kind === 'retry-limit'
        ? `retry limit reached after ${String(attempts ?? 0)} attempt(s)`
        : // s5 Sc11: the adapter registry's two 409s. Naming the rules that
          // block a delete is the entire actionable content of that refusal.
          // s6 Sc12. `not-armed` is not a draft transition and must not be
          // rendered as one: `rest-of-window` asked for a horizon this
          // daemon's schedule does not have, so the message points at the
          // schedule rather than at the word the operator typed.
          kind === 'not-armed'
          ? 'not-armed: nothing to rest out — no enabled rule has a window open right now (see `wemessage windows list`)'
          : kind === 'schedule-in-use'
            ? 'schedule-in-use: a rule still points at this window — repoint or delete the rule first (see `wemessage rules list`)'
            : kind === 'adapter-referenced'
              ? `adapter-referenced: still used by rule(s) ${(ruleIds ?? []).join(', ')} — delete or repoint them first`
              : kind === 'adapter-exists'
                ? `adapter-exists: an adapter with id "${String(id)}" already exists`
                : `${kind}: draft is ${String(from)}, cannot ${String(requested)}`,
      EXIT_FAILED,
    );
  }
  if (error instanceof DaemonEventFilterError) {
    // s7 Sc5. A close frame before `open` is what an unreachable daemon looks
    // like too, and the ONLY thing separating them is the 4400 code the WS
    // route spends saying "your --events list named something I do not have."
    // Exit 2, not 3: nothing is wrong with the daemon, the request could not
    // have been served as typed. The daemon's own words, verbatim.
    fail(error.reason, EXIT_USAGE);
  }
  if (error instanceof DaemonSettingsError) {
    // s7 Sc5. Checked BEFORE DaemonRequestError, which it extends: the five
    // reasons `PATCH /v1/settings` distinguishes are the entire actionable
    // content of that 400, and the generic branch below would print
    // "daemon request failed (HTTP 400)" over the top of all of them.
    const { message, code } = settingsRefusal(error.detail);
    fail(message, code);
  }
  if (error instanceof DaemonUnreachableError) {
    fail(error.message, EXIT_UNREACHABLE);
  }
  if (error instanceof DaemonAuthError) {
    fail(error.message, EXIT_AUTH);
  }
  if (error instanceof DaemonGateDeniedError) {
    fail(`gate denied: ${error.reason}`, EXIT_GATE_DENIED);
  }
  fail(error instanceof Error ? error.message : String(error), EXIT_FAILED);
}

/**
 * Read one line from the operator, prompting on STDERR so that a `--json`
 * pipeline never sees the prompt text mixed into its payload.
 */
async function askLine(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

function clientOrExit(tokenFlag?: string): ReturnType<typeof createClient> {
  const token = resolveToken(tokenFlag);
  if (token === null) {
    fail(
      `no token: pass --token, set WEMESSAGE_TOKEN, or run the daemon once to create ${join(configDir(), 'daemon.token')}`,
      EXIT_AUTH,
    );
  }
  return createClient({ baseUrl: baseUrl(), token });
}

function checkGlyph(status: DoctorCheckPayload['status']): string {
  return status === 'ok' ? '✓' : status === 'warn' ? '!' : '✗';
}

/**
 * Plaintext checks table (C-8: zero ANSI anywhere, glyphs only). Remediation
 * is printed verbatim from the daemon's own string, never reworded — the
 * daemon owns that copy (doctor.ts), the CLI is just a thin renderer.
 */
function renderDoctor(report: DoctorReportPayload): string {
  const idWidth = Math.max(...report.checks.map((c) => c.id.length));
  const lines = [`state: ${report.state}`, `probed: ${report.probedAt}`, ''];
  for (const check of report.checks) {
    const detail = check.detail !== undefined ? ` ${check.detail}` : '';
    lines.push(
      `${checkGlyph(check.status)} ${check.id.padEnd(idWidth)}${detail}`,
    );
    if (check.remediation !== undefined) {
      lines.push(`  remediation: ${check.remediation}`);
    }
  }
  return lines.join('\n');
}

/**
 * §1.3.1 GUI-vs-daemon divergence, CLI edition: on macOS 26, FDA does not
 * propagate to background items, so an operator's own shell can read
 * chat.db while wemessaged still cannot. Printed only when that exact
 * mismatch is observed (local probe 'ok' + daemon fda check 'fail') — never
 * when the local probe fails too (then it's just "no FDA anywhere", the
 * daemon's own remediation line already says everything needed).
 */
async function renderDivergence(
  report: DoctorReportPayload,
): Promise<string | null> {
  const fdaCheck = report.checks.find((c) => c.id === 'fda');
  if (fdaCheck?.status !== 'fail') return null;
  const local = await probeChatDbReadable();
  if (local !== 'ok') return null;
  return [
    '',
    'divergence: this shell can read chat.db but the daemon cannot',
    'This is the macOS 26 FDA propagation landmine: Full Disk Access',
    'granted to your terminal/shell does not propagate to the background',
    'wemessaged process. Grant Full Disk Access to wemessaged itself.',
  ].join('\n');
}

function renderSend(result: SendResult): string {
  const lines = [`draft: ${result.draftId}`];
  lines.push(
    result.outcome === 'sent'
      ? `sent: ${result.sentMessageGuid}`
      : `failed: ${result.error.code} (${result.error.message})`,
  );
  return lines.join('\n');
}

function disconnectStepGlyph(status: 'done' | 'skipped' | 'failed'): string {
  return status === 'done' ? '✓' : status === 'skipped' ? '-' : '✗';
}

function renderDisconnect(report: DisconnectReportPayload): string {
  const lines = [`state: ${report.state}`, ''];
  for (const step of report.steps) {
    const detail = step.detail !== undefined ? ` ${step.detail}` : '';
    lines.push(`${disconnectStepGlyph(step.status)} ${step.id}${detail}`);
  }
  if (report.manualRevocation.length > 0) {
    lines.push(
      '',
      'manual revocation required (OS-level, cannot be automated):',
    );
    for (const line of report.manualRevocation) {
      lines.push(`  ${line}`);
    }
  }
  return lines.join('\n');
}

const program = new Command();
program
  .name('wemessage')
  .description('WeMessage gateway CLI — thin client over the local daemon API')
  .exitOverride();

program
  .command('status')
  .description('connection state, cursor, counts (§3.8)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const status = await clientOrExit(opts.token).status();
      console.log(
        opts.json === true
          ? JSON.stringify(status)
          : // s6 Sc12 row 5: the armed line needs a `now` to count down to,
            // and the CLI is the only party that knows the operator's.
            renderStatus(status, Date.now()),
      );
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('watch')
  .description('live event stream (WS under the hood, §3.8)')
  .option('--json', 'NDJSON: one JSON object per event')
  .option(
    '--events <list>',
    'comma-separated event names; the daemon filters, not this CLI (s7)',
  )
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; events?: string; token?: string }) => {
    // s5 Sc11: `--json` is still NDJSON, every event, unchanged (§3.8
    // "--json … NDJSON for streams"). Human mode renders the two S5 events
    // that are unreadable as raw JSON at a terminal — a streaming preview
    // and an adapter's health — and leaves every other event as NDJSON,
    // which is what it has always been.
    const render = createWatchRenderer();
    try {
      // s7 Sc5: the filter is applied SERVER-side (`?events=`), which is the
      // whole point of Sc 3 — an event the operator did not ask for never
      // crosses the socket, rather than crossing it and being dropped here.
      // The names travel verbatim; an unknown one closes 4400 and lands in
      // `exitFor` as a DaemonEventFilterError.
      const subscription = await clientOrExit(opts.token).events(
        (event) => {
          const line = opts.json === true ? null : render(event);
          if (line === null) {
            console.log(JSON.stringify(event));
            return;
          }
          if (line.inPlace && process.stdout.isTTY === true) {
            // One line, overwritten, at a terminal only: a pipe or a log file
            // gets whole lines, because \r in a captured log is noise. A
            // carriage return and nothing else — no erase-line escape, because
            // C-9 is "no ANSI", not "no color" (a preview only ever grows, so
            // there is nothing left behind to erase).
            process.stdout.write(`\r${line.text}`);
            return;
          }
          console.log(line.text);
        },
        // exactOptionalPropertyTypes: an omitted `--events` means the KEY is
        // absent, not present-and-undefined, which is what makes the client
        // open `/v1/events` with no query string at all.
        opts.events !== undefined
          ? { events: parseEventsFlag(opts.events) }
          : {},
      );
      // The stream stays open until Ctrl-C / kill — or until the daemon ends
      // it. A refused `--events` list is the one ending that is not an
      // ordinary end of stream: it rejects here and exits 2 rather than
      // letting the process fall off the end at 0, which is what "not a
      // stack" has to mean if it is to mean anything.
      await subscription.closed;
    } catch (error) {
      exitFor(error);
    }
  });

const auth = program
  .command('auth')
  .description('daemon token management (§2.6)');

auth
  .command('print-token')
  .description('print the daemon token from the config dir')
  .action(() => {
    const token = readTokenFile(configDir());
    if (token === null) {
      fail(
        `no token file at ${join(configDir(), 'daemon.token')}`,
        EXIT_FAILED,
      );
    }
    console.log(token);
  });

auth
  .command('rotate')
  .description('rotate the daemon token; old bearers get 401 immediately')
  .action(() => {
    try {
      console.log(rotateTokenFile(configDir()));
    } catch (error) {
      exitFor(error);
    }
  });

// ---------------------------------------------------------------------------
// rules + audit command groups (S2 Scenario 11)
// ---------------------------------------------------------------------------

function parseOptionalInt(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) {
    fail(`--${label} must be an integer, got: ${value}`, EXIT_USAGE);
  }
  return n;
}

interface MatcherOpts {
  keyword?: string;
  mode?: string;
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: string;
  contact?: string;
  matcherJson?: string;
}

/**
 * Exactly-one-of validation commander can't express declaratively (§1.4.1
 * matcher tree): --keyword/--regex/--contact/--matcher-json. `required`
 * distinguishes `add` (a matcher is mandatory) from `edit` (a patch may
 * leave the matcher untouched). Keyword sub-flags (--mode/--case-sensitive/
 * --whole-word) are rejected unless --keyword is the active source.
 */
function resolveMatcher(opts: MatcherOpts, required: true): RuleMatcher;
function resolveMatcher(
  opts: MatcherOpts,
  required: boolean,
): RuleMatcher | undefined;
function resolveMatcher(
  opts: MatcherOpts,
  required: boolean,
): RuleMatcher | undefined {
  const sources: Record<string, boolean> = {
    keyword: opts.keyword !== undefined,
    regex: opts.regex !== undefined,
    contact: opts.contact !== undefined,
    'matcher-json': opts.matcherJson !== undefined,
  };
  const active = Object.keys(sources).filter((key) => sources[key]);
  if (active.length > 1) {
    fail(
      `exactly one matcher source allowed (--keyword, --regex, --contact, --matcher-json), got: ${active.join(', ')}`,
      EXIT_USAGE,
    );
  }
  const keywordSubFlagsUsed =
    opts.mode !== undefined ||
    opts.caseSensitive === true ||
    opts.wholeWord === true;
  const source = active[0];
  if (source === undefined) {
    if (keywordSubFlagsUsed) {
      fail(
        '--mode/--case-sensitive/--whole-word require --keyword',
        EXIT_USAGE,
      );
    }
    if (required) {
      fail(
        'exactly one matcher source required: --keyword, --regex, --contact, or --matcher-json',
        EXIT_USAGE,
      );
    }
    return undefined;
  }
  if (source !== 'keyword' && keywordSubFlagsUsed) {
    fail('--mode/--case-sensitive/--whole-word require --keyword', EXIT_USAGE);
  }
  if (source === 'keyword') {
    const keywords = String(opts.keyword)
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const modeRaw = opts.mode ?? 'any';
    if (modeRaw !== 'any' && modeRaw !== 'all') {
      fail(`--mode must be "any" or "all", got: ${modeRaw}`, EXIT_USAGE);
    }
    return {
      kind: 'keyword',
      keywords,
      mode: modeRaw,
      ...(opts.caseSensitive === true ? { caseSensitive: true } : {}),
      ...(opts.wholeWord === true ? { wholeWord: true } : {}),
    };
  }
  if (source === 'regex') {
    return { kind: 'regex', pattern: String(opts.regex) };
  }
  if (source === 'contact') {
    return {
      kind: 'contact',
      handles: String(opts.contact)
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    };
  }
  // source === 'matcher-json': the escape hatch for combinators (§1.4.1).
  try {
    return JSON.parse(String(opts.matcherJson)) as RuleMatcher;
  } catch {
    fail('--matcher-json is not valid JSON', EXIT_USAGE);
  }
}

/** `add` and `edit` expose identical matcher flags (spec: "edit mirrors add's flags"). */
function addMatcherOptions(cmd: Command): Command {
  return cmd
    .option('--keyword <csv>', 'comma-separated keywords (one matcher source)')
    .option(
      '--mode <any|all>',
      'keyword match mode; requires --keyword (default any)',
    )
    .option(
      '--case-sensitive',
      'keyword match is case-sensitive; requires --keyword',
    )
    .option(
      '--whole-word',
      'keyword match requires word boundaries; requires --keyword',
    )
    .option('--regex <pattern>', 'regex matcher pattern (one matcher source)')
    .option(
      '--contact <csv>',
      'comma-separated contact handles (one matcher source)',
    )
    .option(
      '--matcher-json <json>',
      'raw RuleMatcher JSON — escape hatch for combinators (one matcher source)',
    );
}

function renderRule(rule: RulePayload): string {
  return [
    `id:       ${rule.id}`,
    `name:     ${rule.name}`,
    `enabled:  ${String(rule.enabled)}`,
    `adapter:  ${rule.adapterId}`,
    `matcher:  ${JSON.stringify(rule.matcher)}`,
    `respond:  ${rule.respondMode}`,
    `priority: ${String(rule.priority)}`,
    `ttl:      ${String(rule.draftTtlMinutes)}m`,
    `updated:  ${rule.updatedAt}`,
  ].join('\n');
}

function renderRuleWrite(result: RuleWriteResult): string {
  const note = result.adapterKnown
    ? ''
    : '\n(note: adapterId not recognized by this daemon yet — F-14)';
  return renderRule(result.rule) + note;
}

function renderTestResult(result: RuleTestResult): string {
  return result.matched
    ? `matched (rule: ${result.detail.matchedRuleIds.join(', ')})`
    : 'no match';
}

function renderDryRun(result: DryRunResult): string {
  const lines = [`${String(result.matched)}/${String(result.total)} matched`];
  for (const row of result.rows) {
    lines.push(
      `${row.matched ? 'x' : ' '} ${row.guid} ${row.handle} ${row.textPreview ?? '(no text)'}`,
    );
  }
  return lines.join('\n');
}

function renderAuditRow(row: AuditRowPayload): string {
  return `#${String(row.seq)} ${row.at} ${row.eventJson}`;
}

function renderAuditVerify(result: AuditVerifyResult): string {
  if (result.ok) {
    return `ok: chain verified, length ${String(result.length)}`;
  }
  return [
    `BROKEN at seq ${String(result.brokenAtSeq)}: ${result.reason}`,
    `chain length: ${String(result.length)}`,
    ...(result.expectedHash !== undefined
      ? [`expected: ${result.expectedHash}`]
      : []),
    ...(result.actualHash !== undefined
      ? [`actual:   ${result.actualHash}`]
      : []),
  ].join('\n');
}

interface AddRuleOpts extends MatcherOpts {
  name: string;
  adapter: string;
  priority?: string;
  ttl?: string;
  json?: boolean;
  token?: string;
}

interface EditRuleOpts extends MatcherOpts {
  name?: string;
  adapter?: string;
  priority?: string;
  ttl?: string;
  json?: boolean;
  token?: string;
}

interface TestRuleOpts {
  rule: string;
  message?: string;
  handle?: string;
  json?: boolean;
  token?: string;
}

interface AuditListOpts {
  since?: string;
  event?: string;
  limit?: string;
  json?: boolean;
  token?: string;
}

const rules = program
  .command('rules')
  .description('rule CRUD, test, and dry-run (§1.6 routes 1-7, S2)');

rules
  .command('list')
  .description('list all rules (§1.6 route 1)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const items = await clientOrExit(opts.token).listRules();
      console.log(
        opts.json === true
          ? JSON.stringify(items)
          : items.length > 0
            ? items.map(renderRule).join('\n\n')
            : '(no rules)',
      );
    } catch (error) {
      exitFor(error);
    }
  });

rules
  .command('show <id>')
  .description('fetch one rule by id (§1.6 route 3)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const rule = await clientOrExit(opts.token).getRule(id);
      console.log(opts.json === true ? JSON.stringify(rule) : renderRule(rule));
    } catch (error) {
      exitFor(error);
    }
  });

addMatcherOptions(
  rules
    .command('add')
    .description('create a rule (§1.6 route 2)')
    .requiredOption('--name <name>', 'rule name')
    .requiredOption('--adapter <id>', 'adapter id'),
)
  .option('--priority <n>', 'match priority, lower runs first (default 100)')
  .option('--ttl <minutes>', 'draft TTL in minutes (default 240)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: AddRuleOpts) => {
    const matcher = resolveMatcher(opts, true);
    const priority = parseOptionalInt(opts.priority, 'priority');
    const draftTtlMinutes = parseOptionalInt(opts.ttl, 'ttl');
    const input: RuleInput = {
      name: opts.name,
      adapterId: opts.adapter,
      matcher,
      ...(priority !== undefined ? { priority } : {}),
      ...(draftTtlMinutes !== undefined ? { draftTtlMinutes } : {}),
    };
    try {
      const result = await clientOrExit(opts.token).createRule(input);
      console.log(
        opts.json === true ? JSON.stringify(result) : renderRuleWrite(result),
      );
    } catch (error) {
      exitFor(error);
    }
  });

addMatcherOptions(
  rules
    .command('edit <id>')
    .description("patch a rule (§1.6 route 4); mirrors add's flags")
    .option('--name <name>', 'rule name')
    .option('--adapter <id>', 'adapter id'),
)
  .option('--priority <n>', 'match priority, lower runs first')
  .option('--ttl <minutes>', 'draft TTL in minutes')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: EditRuleOpts) => {
    const matcher = resolveMatcher(opts, false);
    const priority = parseOptionalInt(opts.priority, 'priority');
    const draftTtlMinutes = parseOptionalInt(opts.ttl, 'ttl');
    const patch: Partial<RuleInput> = {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.adapter !== undefined ? { adapterId: opts.adapter } : {}),
      ...(matcher !== undefined ? { matcher } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(draftTtlMinutes !== undefined ? { draftTtlMinutes } : {}),
    };
    if (Object.keys(patch).length === 0) {
      fail('edit requires at least one field to change', EXIT_USAGE);
    }
    try {
      const result = await clientOrExit(opts.token).updateRule(id, patch);
      console.log(
        opts.json === true ? JSON.stringify(result) : renderRuleWrite(result),
      );
    } catch (error) {
      exitFor(error);
    }
  });

rules
  .command('rm <id>')
  .description('delete a rule (§1.6 route 5)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).deleteRule(id);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `deleted ${result.deleted}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

function registerEnableVerb(
  name: 'enable' | 'disable',
  enabled: boolean,
): void {
  rules
    .command(`${name} <id>`)
    .description(`${enabled ? 'enable' : 'disable'} a rule (§1.6 route 4)`)
    .option('--json', 'stable machine-readable output')
    .option('-T, --token <token>', 'bearer token override')
    .action(async (id: string, opts: { json?: boolean; token?: string }) => {
      try {
        const result = await clientOrExit(opts.token).updateRule(id, {
          enabled,
        });
        console.log(
          opts.json === true ? JSON.stringify(result) : renderRuleWrite(result),
        );
      } catch (error) {
        exitFor(error);
      }
    });
}
registerEnableVerb('enable', true);
registerEnableVerb('disable', false);

rules
  .command('test')
  .description('dry-match a message against a rule (§1.3.2)')
  .requiredOption('--rule <id>', 'rule id to test against')
  .option(
    '--message <text>',
    'message text (omit to test a null/attachment-only message)',
  )
  .option('--handle <handle>', 'sender handle — drives contact matchers')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: TestRuleOpts) => {
    try {
      const result = await clientOrExit(opts.token).testRule(opts.rule, {
        text: opts.message ?? null,
        ...(opts.handle !== undefined ? { handle: opts.handle } : {}),
      });
      console.log(
        opts.json === true ? JSON.stringify(result) : renderTestResult(result),
      );
    } catch (error) {
      exitFor(error);
    }
  });

rules
  .command('dryrun <id>')
  .description(
    'replay the mirrored inbound window against a rule (§1.6 route 7, F-18)',
  )
  .option('--limit <n>', 'max rows to replay')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      id: string,
      opts: { limit?: string; json?: boolean; token?: string },
    ) => {
      const limit = parseOptionalInt(opts.limit, 'limit');
      try {
        const result = await clientOrExit(opts.token).dryRunRule(id, limit);
        console.log(
          opts.json === true ? JSON.stringify(result) : renderDryRun(result),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

const audit = program
  .command('audit')
  .description(
    'append-only audit trail: list + hash-chain verify (§1.6 routes 8-9, S2)',
  );

audit
  .command('list')
  .description('list audit rows, reverse-chronological (§1.6 route 8)')
  .option('--since <iso>', 'ISO-8601 inclusive lower bound')
  .option('--event <type>', 'exact audit-event type filter')
  .option('--limit <n>', 'max rows (default 100, max 1000)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: AuditListOpts) => {
    const limit = parseOptionalInt(opts.limit, 'limit');
    try {
      const rows = await clientOrExit(opts.token).listAudit({
        ...(opts.since !== undefined ? { since: opts.since } : {}),
        ...(opts.event !== undefined ? { event: opts.event } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      console.log(
        opts.json === true
          ? JSON.stringify(rows)
          : rows.length > 0
            ? rows.map(renderAuditRow).join('\n')
            : '(no audit rows)',
      );
    } catch (error) {
      exitFor(error);
    }
  });

audit
  .command('verify')
  .description(
    'walk the full audit hash chain, every call (§1.6 route 9, §2.3)',
  )
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).verifyAudit();
      console.log(
        opts.json === true ? JSON.stringify(result) : renderAuditVerify(result),
      );
      // §2.3 "the finding is the failure": a broken chain is reported on
      // stdout AND exits 1 — print above happens before this exit.
      if (!result.ok) {
        process.exit(EXIT_FAILED);
      }
    } catch (error) {
      exitFor(error);
    }
  });

// ---------------------------------------------------------------------------
// doctor / send / connect / disconnect (S3 Scenario 10, §1.3.7/§3.8, F-29)
// ---------------------------------------------------------------------------

program
  .command('doctor')
  .description('connection health checks; exit 1 unless fully-connected (F-29)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const report = await clientOrExit(opts.token).doctor();
      if (opts.json === true) {
        console.log(JSON.stringify(report));
      } else {
        const divergence = await renderDivergence(report);
        console.log(renderDoctor(report) + (divergence ?? ''));
      }
      if (report.state !== 'fully-connected') {
        process.exit(EXIT_FAILED);
      }
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('send')
  .description('send a message through the sending pipeline (§3.8)')
  .requiredOption('--to <handle>', 'destination handle')
  .requiredOption('--body <text>', 'message body')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (opts: {
      to: string;
      body: string;
      json?: boolean;
      token?: string;
    }) => {
      try {
        const result = await clientOrExit(opts.token).send({
          to: opts.to,
          body: opts.body,
        });
        console.log(
          opts.json === true ? JSON.stringify(result) : renderSend(result),
        );
        if (result.outcome === 'failed') {
          process.exit(EXIT_FAILED);
        }
      } catch (error) {
        exitFor(error);
      }
    },
  );

program
  .command('connect')
  .description('re-arm the daemon after a prior disconnect (§1.3.7)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const report = await clientOrExit(opts.token).connect();
      console.log(
        opts.json === true ? JSON.stringify(report) : renderDoctor(report),
      );
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('disconnect')
  .description('disarm the daemon; optionally purge stored data (§1.3.7)')
  .option('--purge', 'also delete the daemon config dir and all stored data')
  .option(
    '--yes-really-purge',
    'skip the interactive confirmation for --purge (scripts/CI)',
  )
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (opts: {
      purge?: boolean;
      yesReallyPurge?: boolean;
      json?: boolean;
      token?: string;
    }) => {
      const purge = opts.purge === true;
      if (purge && opts.yesReallyPurge !== true) {
        const confirmed = await confirmPurge({
          isTTY: process.stdin.isTTY === true,
          ask: async () => {
            const rl = createInterface({
              input: process.stdin,
              output: process.stderr,
            });
            try {
              return await rl.question(
                'Type "delete my data" to confirm --purge: ',
              );
            } finally {
              rl.close();
            }
          },
        });
        if (!confirmed) {
          fail(
            '--purge requires confirmation (refused or non-interactive)',
            EXIT_USAGE,
          );
        }
      }
      try {
        const report = await clientOrExit(opts.token).disconnect({ purge });
        console.log(
          opts.json === true
            ? JSON.stringify(report)
            : renderDisconnect(report),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

// ---- s4 Scenario 11: drafts / contacts / kill / resume (§3.8) ----------

/** Fixed-width monochrome table (C-8: no color anywhere in the CLI). */
function renderDraftTable(drafts: DraftPayload[]): string {
  if (drafts.length === 0) return '(no drafts)';
  const rows = drafts.map((d) => [
    d.id,
    d.state,
    d.chatGuid.split(';').at(-1) ?? d.chatGuid,
    d.body.length > 40 ? `${d.body.slice(0, 39)}…` : d.body,
  ]);
  const head = ['ID', 'STATE', 'CHAT', 'BODY'];
  const widths = head.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(head), ...rows.map(line)].join('\n');
}

function renderDraft(d: DraftPayload): string {
  return [
    `id:        ${d.id}`,
    `state:     ${d.state}`,
    `chat:      ${d.chatGuid}`,
    `rule:      ${d.ruleId ?? '(none)'}`,
    `adapter:   ${d.adapterId}`,
    `body:      ${d.body}`,
    ...(d.body !== d.originalBody ? [`original:  ${d.originalBody}`] : []),
    ...(d.sendNotBefore !== undefined ? [`sends at:  ${d.sendNotBefore}`] : []),
    `expires:   ${d.expiresAt}`,
    ...(d.error !== undefined
      ? [`error:     ${d.error.code}: ${d.error.message}`]
      : []),
  ].join('\n');
}

function renderBatchReport(report: BatchReport): string {
  return [
    `batch:     ${report.batchId}`,
    `sent:      ${String(report.sent)}`,
    `failed:    ${String(report.failed)}`,
    `recalled:  ${String(report.recalled)}`,
  ].join('\n');
}

function renderContacts(contacts: ContactPolicyPayload[]): string {
  if (contacts.length === 0) return '(no contact policies)';
  return contacts.map((c) => `${c.mode.padEnd(10)} ${c.handle}`).join('\n');
}

const drafts = program
  .command('drafts')
  .description('review, approve and recall drafts (§3.8)');

drafts
  .command('list')
  .description('list drafts; the queue by default (§1.6)')
  .option('--state <state>', 'filter by draft state, e.g. expired')
  .option('--rule <id>', 'filter by rule id')
  .option('--contact <handle>', 'filter by contact handle')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (opts: {
      state?: string;
      rule?: string;
      contact?: string;
      json?: boolean;
      token?: string;
    }) => {
      try {
        const items = await clientOrExit(opts.token).listDrafts({
          ...(opts.state !== undefined
            ? { state: opts.state as DraftState }
            : {}),
          ...(opts.rule !== undefined ? { ruleId: opts.rule } : {}),
          ...(opts.contact !== undefined ? { contact: opts.contact } : {}),
        });
        console.log(
          opts.json === true ? JSON.stringify(items) : renderDraftTable(items),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

drafts
  .command('show <id>')
  .description('show one draft with its approval history')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const detail = await clientOrExit(opts.token).getDraft(id);
      console.log(
        opts.json === true
          ? JSON.stringify(detail)
          : `${renderDraft(detail.draft)}\napprovals: ${String(detail.approvals.length)}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

drafts
  .command('create')
  .description('(dev) compose a draft by hand, bypassing the rule pipeline')
  .requiredOption('--chat <guid>', 'chat guid, e.g. "iMessage;-;+15551234567"')
  .requiredOption('--body <text>', 'draft body')
  .option('--ttl <minutes>', 'draft TTL in minutes (default 240)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (opts: {
      chat: string;
      body: string;
      ttl?: string;
      json?: boolean;
      token?: string;
    }) => {
      let ttlMinutes: number | undefined;
      if (opts.ttl !== undefined) {
        ttlMinutes = Number(opts.ttl);
        if (!Number.isInteger(ttlMinutes) || ttlMinutes <= 0) {
          fail(
            '--ttl must be a positive integer number of minutes',
            EXIT_USAGE,
          );
        }
      }
      try {
        const draft = await clientOrExit(opts.token).createDraft({
          chatGuid: opts.chat,
          body: opts.body,
          ...(ttlMinutes !== undefined ? { ttlMinutes } : {}),
        });
        console.log(
          opts.json === true ? JSON.stringify(draft) : renderDraft(draft),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

drafts
  .command('approve [id]')
  .description('approve a draft, or --all to approve a whole selection')
  .option('--edit <text>', 'replace the body before sending')
  .option('--all', 'approve every pending draft in the selection')
  .option('--rule <id>', 'with --all: limit to one rule')
  .option('--contact <handle>', 'with --all: limit to one contact')
  .option('--wait', 'with --all: poll until the batch settles, then report')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      id: string | undefined,
      opts: {
        edit?: string;
        all?: boolean;
        rule?: string;
        contact?: string;
        wait?: boolean;
        json?: boolean;
        token?: string;
      },
    ) => {
      const bulk = opts.all === true;
      // An id AND --all is ambiguous in a way that matters: one of the two
      // interpretations sends messages the user did not name.
      if (bulk === (id !== undefined)) {
        fail('give exactly one of <id> or --all', EXIT_USAGE);
      }
      const client = clientOrExit(opts.token);
      try {
        if (!bulk) {
          const result = await client.approveDraft(String(id), {
            ...(opts.edit !== undefined ? { editedBody: opts.edit } : {}),
          });
          console.log(
            opts.json === true
              ? JSON.stringify(result)
              : renderDraft(result.draft),
          );
          return;
        }
        const batch = await client.bulkDrafts('approve', {
          filter: {
            ...(opts.rule !== undefined ? { rule: opts.rule } : {}),
            ...(opts.contact !== undefined ? { contact: opts.contact } : {}),
            ...(opts.rule === undefined && opts.contact === undefined
              ? { all: true as const }
              : {}),
          },
        });
        if (opts.wait !== true) {
          // Undo grace makes a synchronous report impossible without holding
          // the request open through the window (F-37), so the default is
          // honest: here is the batch id, ask for the report when you want it.
          console.log(
            opts.json === true
              ? JSON.stringify(batch)
              : `batch:     ${batch.batchId}\napproved:  ${String(batch.applied)} of ${String(batch.matched)}${
                  batch.refused.length > 0
                    ? `\nrefused:   ${String(batch.refused.length)}`
                    : ''
                }`,
          );
          return;
        }
        let report = await client.batchReport(batch.batchId);
        while (report.approved + report.sending > 0) {
          await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
          report = await client.batchReport(batch.batchId);
        }
        console.log(
          opts.json === true
            ? JSON.stringify(report)
            : renderBatchReport(report),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

drafts
  .command('recall [id]')
  .description('recall an approved draft during its undo window')
  .option('--all', 'recall every approved draft in the selection')
  .option('--rule <id>', 'with --all: limit to one rule')
  .option('--contact <handle>', 'with --all: limit to one contact')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      id: string | undefined,
      opts: {
        all?: boolean;
        rule?: string;
        contact?: string;
        json?: boolean;
        token?: string;
      },
    ) => {
      const bulk = opts.all === true;
      if (bulk === (id !== undefined)) {
        fail('give exactly one of <id> or --all', EXIT_USAGE);
      }
      try {
        const client = clientOrExit(opts.token);
        if (!bulk) {
          const result = await client.recallDraft(String(id));
          console.log(
            opts.json === true
              ? JSON.stringify(result)
              : renderDraft(result.draft),
          );
          return;
        }
        const batch = await client.bulkDrafts('recall', {
          filter: {
            ...(opts.rule !== undefined ? { rule: opts.rule } : {}),
            ...(opts.contact !== undefined ? { contact: opts.contact } : {}),
            ...(opts.rule === undefined && opts.contact === undefined
              ? { all: true as const }
              : {}),
          },
        });
        console.log(
          opts.json === true
            ? JSON.stringify(batch)
            : `batch:     ${batch.batchId}\nrecalled:  ${String(batch.applied)} of ${String(batch.matched)}`,
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

drafts
  .command('reject <id>')
  .description('reject a pending draft')
  .option('--reason <text>', 'why (recorded in the audit log)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      id: string,
      opts: { reason?: string; json?: boolean; token?: string },
    ) => {
      try {
        const result = await clientOrExit(opts.token).rejectDraft(id, {
          ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
        });
        console.log(
          opts.json === true
            ? JSON.stringify(result)
            : renderDraft(result.draft),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

drafts
  .command('retry <id>')
  .description('retry a failed draft with a fresh undo window')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).retryDraft(id);
      console.log(
        opts.json === true ? JSON.stringify(result) : renderDraft(result.draft),
      );
    } catch (error) {
      exitFor(error);
    }
  });

drafts
  .command('redraft <id>')
  .description('compose a fresh draft from an expired or rejected one')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).redraftDraft(id);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `from:      ${result.fromDraftId}\n${renderDraft(result.draft)}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

const contacts = program
  .command('contacts')
  .description('contact policies: deny / draft-only / auto (§2.4.3)');

contacts
  .command('list')
  .description('list every contact policy')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const items = await clientOrExit(opts.token).listContacts();
      console.log(
        opts.json === true ? JSON.stringify(items) : renderContacts(items),
      );
    } catch (error) {
      exitFor(error);
    }
  });

contacts
  .command('set <handle> <mode>')
  .description('set a contact policy: deny | draft-only | auto')
  .option('--yes', 'skip the typed confirmation on `auto` (scripts, CI)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      handle: string,
      mode: string,
      opts: { yes?: boolean; json?: boolean; token?: string },
    ) => {
      if (!['deny', 'draft-only', 'auto'].includes(mode)) {
        fail(
          `mode must be deny, draft-only or auto (got "${mode}")`,
          EXIT_USAGE,
        );
      }
      // s6 Sc12 row 6. `auto` is the only one of the three that GRANTS
      // autonomy (§2.4.3), so it is the only one that costs a ceremony, and
      // the phrase is the handle itself: typing "yes" proves a keypress,
      // typing the handle proves the operator read which conversation they
      // were about to hand over. `deny` and `draft-only` withdraw autonomy
      // and prompt for nothing — a rule that made safety expensive would be
      // a rule people route around.
      if (mode === 'auto' && opts.yes !== true) {
        const confirmed = await confirmTyped(
          {
            isTTY: process.stdin.isTTY === true,
            ask: () => askLine(contactAutoPrompt(handle)),
          },
          contactAutoPhrase(handle),
        );
        if (!confirmed) {
          fail(
            `contacts set ${handle} auto requires confirmation (refused or non-interactive); pass --yes to script it`,
            EXIT_USAGE,
          );
        }
      }
      try {
        const contact = await clientOrExit(opts.token).setContactPolicy(
          handle,
          mode as ContactMode,
        );
        console.log(
          opts.json === true
            ? JSON.stringify(contact)
            : `${contact.mode.padEnd(10)} ${contact.handle}`,
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

contacts
  .command('rm <handle>')
  .description('remove a contact policy, returning it to unknown')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (handle: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).deleteContactPolicy(handle);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `removed ${result.deleted}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

// ---- s5 Scenario 11: the adapter registry (§1.6 adapter routes, §3.8) ----

/**
 * The kinds `routes/adapters.ts` accepts. Duplicated here on purpose: an
 * unknown kind is a USAGE error (exit 2), refused before the wire, not a
 * daemon 400 rendered as a generic failure.
 */
const ADAPTER_KINDS: readonly AdapterKind[] = [
  'sol',
  'hermes',
  'luna',
  'openclaw',
  'echo',
  'generic',
];

function resolveKind(raw: string): AdapterKind {
  if (!(ADAPTER_KINDS as readonly string[]).includes(raw)) {
    fail(
      `--kind must be one of ${ADAPTER_KINDS.join(', ')} (got "${raw}")`,
      EXIT_USAGE,
    );
  }
  return raw as AdapterKind;
}

const adapters = program
  .command('adapters')
  .description('agent registry: who may draft into your conversations (§1.6)');

adapters
  .command('list')
  .description('list registered adapters; never prints token material')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const items = await clientOrExit(opts.token).listAdapters();
      console.log(
        opts.json === true ? JSON.stringify(items) : renderAdapterTable(items),
      );
    } catch (error) {
      exitFor(error);
    }
  });

adapters
  .command('show <id>')
  .description('show one adapter; `token: set` is all it will ever say')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const adapter = await clientOrExit(opts.token).getAdapter(id);
      console.log(
        opts.json === true ? JSON.stringify(adapter) : renderAdapter(adapter),
      );
    } catch (error) {
      exitFor(error);
    }
  });

adapters
  .command('add <id>')
  .description('register an adapter and mint its token (shown once)')
  .requiredOption('--kind <kind>', `adapter kind: ${ADAPTER_KINDS.join(' | ')}`)
  .option('--name <name>', 'display name (defaults to the id)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      id: string,
      opts: { kind: string; name?: string; json?: boolean; token?: string },
    ) => {
      const kind = resolveKind(opts.kind);
      try {
        const credential = await clientOrExit(opts.token).createAdapter({
          id,
          kind,
          displayName: opts.name ?? id,
        });
        console.log(
          opts.json === true
            ? JSON.stringify(credential)
            : renderMintedCredential(credential, { rotated: false }),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

adapters
  .command('rm <id>')
  .description('delete an adapter; refused while a rule still points at it')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).deleteAdapter(id);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `deleted ${result.deleted}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

function registerAdapterEnableVerb(
  name: 'enable' | 'disable',
  enabled: boolean,
): void {
  adapters
    .command(`${name} <id>`)
    .description(
      `${enabled ? 'enable' : 'disable'} an adapter (a disabled adapter cannot connect)`,
    )
    .option('--json', 'stable machine-readable output')
    .option('-T, --token <token>', 'bearer token override')
    .action(async (id: string, opts: { json?: boolean; token?: string }) => {
      const patch: AdapterPatch = { enabled };
      try {
        const adapter = await clientOrExit(opts.token).updateAdapter(id, patch);
        console.log(
          opts.json === true ? JSON.stringify(adapter) : renderAdapter(adapter),
        );
      } catch (error) {
        exitFor(error);
      }
    });
}
registerAdapterEnableVerb('enable', true);
registerAdapterEnableVerb('disable', false);

adapters
  .command('token-rotate <id>')
  .description('mint a fresh token; the old one keeps working 60s (F-42)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const credential = await clientOrExit(opts.token).rotateAdapterToken(id);
      console.log(
        opts.json === true
          ? JSON.stringify(credential)
          : renderMintedCredential(credential, { rotated: true }),
      );
    } catch (error) {
      exitFor(error);
    }
  });

adapters
  .command('test <id>')
  .description('run the adapter conformance kit against a live adapter')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(() => {
    // Same posture as `resume --circuit`: an honest refusal beats a verb that
    // prints something reassuring without having tested anything.
    //
    // s5 Scenario 13 built the kit (`@wemessage/adapter-testkit`) and dogfooded
    // it on echo and sol, but it does NOT reach this verb, for one structural
    // reason and one scope reason:
    //
    //  - `cli-thin-client` (.dependency-cruiser.cjs) allows
    //    packages/cli/src to import client and protocol and nothing else. The
    //    CLI cannot import the kit, or the adapters the kit runs, without
    //    widening that rule — and the CLI's narrow reach is the point of it.
    //  - F-52 ships the kit workspace-internal in S5 and defers its public
    //    surface (`npx`, the `--transport ws --cmd "..."` subprocess runner
    //    that this verb would drive) to S7. Wiring the verb before that runner
    //    exists would mean the CLI spawning adapter processes, which F-55
    //    refuses on a localhost daemon.
    //
    // s7 Sc5 revises the COPY, not the posture. F-86: the kit has its own
    // invocation now, so the refusal hands over that command line instead of
    // a `pnpm --filter` nobody outside this workspace can run. What it still
    // will not do is run it — a CLI that spawns an arbitrary command is a
    // generic escape hatch wearing a verb's name (F-55), and the operator is
    // better served by a line they can read before they run it.
    fail(
      'adapters test does not run the kit from here: this CLI imports client ' +
        'and protocol only (cli-thin-client), and spawning an adapter ' +
        'process on its behalf is what F-55 refuses. The kit runs itself — ' +
        'run: npx @wemessage/adapter-testkit --cmd "<your adapter>" ' +
        '(F-52 for its packaging, F-86 for why this stays a pointer)',
      EXIT_USAGE,
    );
  });

// ---- s6 Scenario 12: windows / pause / mode (§3.8, F-76, F-77) --------

/** `--window` is repeatable: one flag per window, in the order given. */
function collectWindow(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * Every `--window` spec, or exit 2 naming the first bad one.
 *
 * Refused HERE, ahead of the wire, for the reason §2.5 gives for every other
 * client-side check in this file: the daemon's `invalid-window` 400 answers a
 * different question (is this a legal window?) and cannot see the string the
 * operator actually typed.
 */
function parseWindows(specs: readonly string[]): ScheduleWindowPayload[] {
  if (specs.length === 0) {
    fail(
      'at least one --window is required, e.g. --window "mon,tue 09:00-17:00"',
      EXIT_USAGE,
    );
  }
  return specs.map((spec) => {
    const parsed = parseWindowSpec(spec);
    if (!parsed.ok) fail(parsed.message, EXIT_USAGE);
    return parsed.window;
  });
}

interface ScheduleErrorBody {
  error?: unknown;
  detail?: { index?: unknown; field?: unknown };
}

/**
 * The two typed 400s from `/v1/schedules`, rendered with the input that
 * caused them. Both bodies name the FAULT and not the VALUE — the route sees
 * `{error:'invalid-timezone'}` and an index, never `--tz Mars/Olympus_Mons` —
 * so the CLI, which still has the argv, is the only layer that can put the
 * operator's own string back into the sentence.
 */
function scheduleExit(
  error: unknown,
  ctx: { timezone?: string; specs?: readonly string[] },
): never {
  if (
    error instanceof DaemonRequestError &&
    !(error instanceof DaemonConflictError) &&
    error.statusCode === 400
  ) {
    let body: ScheduleErrorBody = {};
    try {
      body = JSON.parse(error.body) as ScheduleErrorBody;
    } catch {
      body = {};
    }
    if (body.error === 'invalid-timezone') {
      fail(
        `invalid-timezone: this machine cannot project into "${ctx.timezone ?? '(unset)'}" — --tz takes an IANA name, e.g. America/Los_Angeles`,
        EXIT_FAILED,
      );
    }
    if (body.error === 'invalid-window') {
      const index =
        typeof body.detail?.index === 'number' ? body.detail.index : -1;
      const field =
        typeof body.detail?.field === 'string' ? body.detail.field : 'field';
      const spec = ctx.specs?.[index];
      fail(
        `invalid-window: the daemon refused ${
          spec === undefined ? `window ${String(index)}` : `--window "${spec}"`
        } (bad ${field})`,
        EXIT_FAILED,
      );
    }
  }
  exitFor(error);
}

interface AddWindowOpts {
  name: string;
  tz: string;
  window: string[];
  disabled?: boolean;
  json?: boolean;
  token?: string;
}

interface EditWindowOpts {
  name?: string;
  tz?: string;
  window: string[];
  enable?: boolean;
  disable?: boolean;
  json?: boolean;
  token?: string;
}

/**
 * F-76's deliberate asymmetry, stated in the one place an operator will look
 * for it. The CLI noun is `windows` because that is the word §1.4.1 and the
 * wireframe use for the thing ("respond between these hours"); the HTTP
 * resource stayed `/v1/schedules` because that is the table name in §2.3 and
 * renaming a shipped route to match a CLI noun is a migration, not a fix. An
 * asymmetry nobody documents is a bug report waiting to be filed, so the
 * group description names both spellings.
 */
const windows = program
  .command('windows')
  .description(
    'respond windows: when a rule may fire (F-76 — the CLI noun is `windows`, the HTTP resource is /v1/schedules)',
  );

windows
  .command('list')
  .description('list every window (GET /v1/schedules)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const items = await clientOrExit(opts.token).listSchedules();
      console.log(
        opts.json === true ? JSON.stringify(items) : renderScheduleTable(items),
      );
    } catch (error) {
      exitFor(error);
    }
  });

windows
  .command('show <id>')
  .description('fetch one window by id (GET /v1/schedules/:id)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const schedule = await clientOrExit(opts.token).getSchedule(id);
      console.log(
        opts.json === true
          ? JSON.stringify(schedule)
          : renderSchedule(schedule),
      );
    } catch (error) {
      exitFor(error);
    }
  });

windows
  .command('add')
  .description('create a window (POST /v1/schedules)')
  .requiredOption('--name <name>', 'what this window is for')
  // Required, and required LOUDLY: a window with no zone is not a window, it
  // is a guess about which 09:00 the operator meant, and §1.4.1 makes the
  // zone the thing the whole comparison hangs on.
  .requiredOption('--tz <zone>', 'IANA timezone the hours are expressed in')
  .option(
    '--window <spec>',
    'repeatable: "<days> HH:MM-HH:MM", e.g. "mon,tue 09:00-17:00"',
    collectWindow,
    [] as string[],
  )
  .option('--disabled', 'create it switched off')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: AddWindowOpts) => {
    const parsed = parseWindows(opts.window);
    try {
      const schedule = await clientOrExit(opts.token).createSchedule({
        name: opts.name,
        timezone: opts.tz,
        windows: parsed,
        ...(opts.disabled === true ? { enabled: false } : {}),
      });
      console.log(
        opts.json === true
          ? JSON.stringify(schedule)
          : renderSchedule(schedule),
      );
    } catch (error) {
      scheduleExit(error, { timezone: opts.tz, specs: opts.window });
    }
  });

windows
  .command('edit <id>')
  .description("patch a window (PATCH /v1/schedules/:id); mirrors add's flags")
  .option('--name <name>', 'what this window is for')
  .option('--tz <zone>', 'IANA timezone the hours are expressed in')
  .option(
    '--window <spec>',
    'repeatable; REPLACES the whole window list',
    collectWindow,
    [] as string[],
  )
  .option('--enable', 'switch this window on')
  .option('--disable', 'switch this window off')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: EditWindowOpts) => {
    if (opts.enable === true && opts.disable === true) {
      fail('--enable and --disable are mutually exclusive', EXIT_USAGE);
    }
    // exactOptionalPropertyTypes discipline, same as the rules patch above:
    // absent keys are ABSENT, never present-and-undefined, so a PATCH cannot
    // accidentally spell "leave this alone" as "set this to nothing".
    const patch: SchedulePatch = {
      ...(opts.name !== undefined ? { name: opts.name } : {}),
      ...(opts.tz !== undefined ? { timezone: opts.tz } : {}),
      ...(opts.window.length > 0 ? { windows: parseWindows(opts.window) } : {}),
      ...(opts.enable === true ? { enabled: true } : {}),
      ...(opts.disable === true ? { enabled: false } : {}),
    };
    try {
      const schedule = await clientOrExit(opts.token).updateSchedule(id, patch);
      console.log(
        opts.json === true
          ? JSON.stringify(schedule)
          : renderSchedule(schedule),
      );
    } catch (error) {
      scheduleExit(error, {
        ...(opts.tz !== undefined ? { timezone: opts.tz } : {}),
        specs: opts.window,
      });
    }
  });

windows
  .command('rm <id>')
  .description('delete a window; refused while a rule still points at it')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (id: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).deleteSchedule(id);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `removed ${result.deleted}`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

/**
 * `pause` is TOP-LEVEL, beside `kill` and `resume`, and there is no `toggles`
 * noun anywhere in this CLI.
 *
 * The daemon groups these three under `/v1/toggles/*` because they are one
 * family of settings writes. An operator reaching for the pause verb is not
 * thinking about a settings namespace; they are thinking "stop, for a bit",
 * which is the same shelf `kill` and `resume` live on. Route shape is the
 * daemon's business (§2.5), and mirroring it into the verb list would make
 * the operator learn it.
 *
 * None of the four deadline forms is parsed here. `until-tomorrow` is the
 * next 08:00 in the DAEMON HOST's zone and `rest-of-window` reads the
 * schedule dimension: both are answers only the daemon has, and a CLI that
 * computed its own would drift the moment the two clocks disagreed (F-68).
 */
program
  .command('pause <until>')
  .description(
    'hold autonomous sends until a deadline: 1h | until-tomorrow | rest-of-window | <iso>',
  )
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (until: string, opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).pause(until);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : renderPause(result, Date.now()),
      );
    } catch (error) {
      if (
        error instanceof DaemonRequestError &&
        !(error instanceof DaemonConflictError) &&
        error.statusCode === 400 &&
        error.body.includes('invalid-until')
      ) {
        fail(
          `invalid-until: could not read "${until}" as a deadline — use 1h, until-tomorrow, rest-of-window, or an ISO-8601 instant in the future`,
          EXIT_FAILED,
        );
      }
      exitFor(error);
    }
  });

/**
 * `mode` reads by DERIVING and writes by POSTing (F-77).
 *
 * F-77 ratified exactly one route for `send.globalMode` — the POST — and
 * deferred a general settings API to S7, so there is no GET to call and this
 * scenario must not mint one (the transport-surface ratchet does not move for
 * a client scenario). The read comes from the audit log instead, which is not
 * a workaround but the complete record: the setting has exactly one writer,
 * that writer appends `arming.mode-changed` before it answers, and no row at
 * all means the shipped default. One call either way.
 */
program
  .command('mode [value]')
  .description('read or set the global respond mode: draft-only | auto (F-77)')
  .option('--yes', 'skip the typed confirmation on `auto` (scripts, CI)')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      value: string | undefined,
      opts: { yes?: boolean; json?: boolean; token?: string },
    ) => {
      if (value === undefined) {
        try {
          const rows = await clientOrExit(opts.token).listAudit({
            event: 'arming.mode-changed',
            limit: 1,
          });
          const mode = resolveGlobalMode(rows);
          console.log(
            opts.json === true ? JSON.stringify({ mode }) : renderMode(mode),
          );
        } catch (error) {
          exitFor(error);
        }
        return;
      }
      if (!isRespondMode(value)) {
        fail(`mode must be draft-only or auto (got "${value}")`, EXIT_USAGE);
      }
      const mode: RespondMode = value;
      // Granting autonomy costs a typed phrase; withdrawing it costs nothing.
      // §2.4.3's ladder only ever gets climbed on purpose.
      if (mode === 'auto' && opts.yes !== true) {
        const confirmed = await confirmTyped(
          {
            isTTY: process.stdin.isTTY === true,
            ask: () => askLine(GLOBAL_AUTO_PROMPT),
          },
          GLOBAL_AUTO_PHRASE,
        );
        if (!confirmed) {
          fail(
            'mode auto requires confirmation (refused or non-interactive); pass --yes to script it',
            EXIT_USAGE,
          );
        }
      }
      try {
        const result = await clientOrExit(opts.token).setGlobalMode(mode);
        console.log(
          opts.json === true ? JSON.stringify(result) : renderMode(result.mode),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

program
  .command('kill')
  .description('emergency stop: cancel in-grace drafts and refuse new sends')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      const result = await clientOrExit(opts.token).setKillSwitch(true);
      console.log(
        opts.json === true
          ? JSON.stringify(result)
          : `kill switch: on\ncancelled:   ${String(result.cancelled.length)} draft(s)`,
      );
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('resume')
  .description('lift the holds you are holding: the kill switch and a pause')
  .option('--circuit', 'also reset the circuit breaker')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (opts: { circuit?: boolean; json?: boolean; token?: string }) => {
      // s6 Scenario 7, widened by Scenario 12 to cover the pause deadline
      // F-68 added. `--circuit` stays OPT-IN both here and on the wire: the
      // breaker is a decision the MACHINE made about a broken send path, and
      // lifting a switch a human threw says nothing about it.
      //
      // This is the one composed verb in the CLI (§2.5 row 8). The
      // composition lives in `resumeHolds`, in the open, with its cost
      // asserted at both ends: one read plus at most two writes, and with
      // nothing held one read and no writes at all.
      const circuit = opts.circuit === true;
      try {
        const report = await resumeHolds(clientOrExit(opts.token), { circuit });
        console.log(
          opts.json === true ? JSON.stringify(report) : renderResume(report),
        );
      } catch (error) {
        exitFor(error);
      }
    },
  );

// ---- s7 Scenario 5: settings get / set (§1.6, Sc 4's two routes) ------

const settings = program
  .command('settings')
  .description("read and write the daemon settings (s7 Sc 4's closed list)");

settings
  .command('get')
  .description('every setting with its default, bounds and owning route')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      // The WHOLE list, read-only keys included. A settings screen that
      // showed only what it could write would be lying about the
      // configuration — and the four read-only keys are precisely the ones
      // carrying arming state, which is the state an operator most needs to
      // see and least may edit here.
      const payload = await clientOrExit(opts.token).settings();
      console.log(
        opts.json === true
          ? JSON.stringify(payload)
          : renderSettingsTable(payload),
      );
    } catch (error) {
      exitFor(error);
    }
  });

settings
  .command('set <key> <value>')
  .description('write one setting; the daemon owns every refusal')
  .option('--json', 'stable machine-readable output')
  .option('-T, --token <token>', 'bearer token override')
  .action(
    async (
      key: string,
      value: string,
      opts: { json?: boolean; token?: string },
    ) => {
      try {
        // No client-side validation of the key or the value, deliberately.
        // The closed list, the types, the floors and the ceilings all live in
        // one place (packages/daemon/src/settings/schema.ts) and a copy here
        // would drift the first time a key was added — silently, in the
        // direction of refusing writes the daemon would have accepted. The
        // literal parse is the ONE thing the CLI must do, because a shell
        // hands it a string and JSON needs a type.
        const result = await clientOrExit(opts.token).setSettings({
          [key]: parseSettingLiteral(value),
        });
        if (opts.json === true) {
          console.log(JSON.stringify(result));
          return;
        }
        // The route answers with the whole list; the operator asked about one
        // key, so narrow to it rather than printing fifteen rows they did not
        // request.
        const entry = result.settings[key];
        if (entry === undefined) {
          fail(`daemon accepted "${key}" but did not return it`, EXIT_FAILED);
        }
        const shown: SettingsPayload = { [key]: entry };
        console.log(renderSettingsSet(shown, result.changed));
      } catch (error) {
        exitFor(error);
      }
    },
  );

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // help/version exit 0; anything else commander-side is a usage error (§3.8)
    process.exit(error.exitCode === 0 ? 0 : EXIT_USAGE);
  }
  exitFor(error);
}
