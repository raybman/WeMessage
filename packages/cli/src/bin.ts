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
  DaemonGateDeniedError,
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
  type SendResult,
  type StatusPayload,
} from '@wemessage/client';
import { probeChatDbReadable } from './probe.js';
import { confirmPurge } from './purge.js';

const EXIT_FAILED = 1;
const EXIT_USAGE = 2;
const EXIT_UNREACHABLE = 3;
const EXIT_AUTH = 4;
const EXIT_GATE_DENIED = 5;

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

function renderStatus(status: StatusPayload): string {
  const cursor = status.cursor
    ? `rowid ${String(status.cursor.lastRowid)} @ ${status.cursor.lastScanAt}`
    : 'none';
  return [
    `connection: ${status.connectionState}`,
    `cursor:     ${cursor}`,
    `today:      ${String(status.counts.messagesToday)} message(s)`,
    `adapters:   ${String(status.adapters.length)}`,
  ].join('\n');
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
        opts.json === true ? JSON.stringify(status) : renderStatus(status),
      );
    } catch (error) {
      exitFor(error);
    }
  });

program
  .command('watch')
  .description('live event stream (WS under the hood, §3.8)')
  .option('--json', 'NDJSON: one JSON object per event')
  .option('-T, --token <token>', 'bearer token override')
  .action(async (opts: { json?: boolean; token?: string }) => {
    try {
      await clientOrExit(opts.token).events((event) => {
        // S1 emits NDJSON in both modes; --json is the stable contract
        // (§3.8 "--json … NDJSON for streams"). Pretty rendering is S3+.
        console.log(JSON.stringify(event));
      });
      // stream stays open until Ctrl-C / kill
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

try {
  await program.parseAsync(process.argv);
} catch (error) {
  if (error instanceof CommanderError) {
    // help/version exit 0; anything else commander-side is a usage error (§3.8)
    process.exit(error.exitCode === 0 ? 0 : EXIT_USAGE);
  }
  exitFor(error);
}
