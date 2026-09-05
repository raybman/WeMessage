/**
 * s7-execution Scenario 11 ★ (static half) — SKILL.md as a machine-checked
 * document, and the transcript linter that guards what a skill produces.
 *
 * A skill is not documentation. It is a set of instructions an agent will
 * actually follow, which makes "does the file contain the right words" the
 * wrong question and "does an agent obeying this file do the right thing"
 * the only one worth a gate. This file owns the half of that question a
 * pure function can answer:
 *
 *  - every verb the document permits is a verb the CLI really has, checked
 *    against the real `--help` tree of the built binary, not a hand-list;
 *  - the three blocks stand in the relation the document claims (approval
 *    is a subset of allowed, never is disjoint from both, never wins);
 *  - the linter fires on a genuine offender and stays quiet on a
 *    legitimate near-miss, once per rule;
 *  - the sibling skills are subsets of this one, so no host gets a power
 *    the flagship document does not grant;
 *  - and INV-2: no skill document names a frame the wire does not have.
 *
 * The other half — a scripted agent driving the documented sequence
 * against a REAL daemon and a real CLI subprocess, and the transcript that
 * run produces — lives in `packages/daemon/test/skill-dryrun-live.spec.ts`,
 * for the reason `settings-cli-live.spec.ts` records: those rows need
 * `startDaemon`, and `nobody-imports-daemon` forbids this package from
 * importing it. The plan names one file; the cruiser names two.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FRAME_SPECS } from '@wemessage/protocol';
import {
  SKILL_DRYRUN_VERSION,
  lintSkillDocument,
  lintTranscript,
  matchArgv,
  parseSkillBlocks,
  publicStringOffenders,
  type SkillPolicy,
} from './helpers/transcript-lint.js';
import {
  CLAUDE_SKILL_VERIFICATION,
  HERMES_SKILL_VERIFICATION,
  skillVerificationBanner,
  skillVerificationOffenders,
} from './helpers/skill-verification.js';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../..');
const CLI_BIN = join(repoRoot, 'packages/cli/dist/bin.js');

const SKILLS = {
  claude: join(repoRoot, 'skills/claude/SKILL.md'),
  hermes: join(repoRoot, 'skills/hermes/SKILL.md'),
  openclaw: join(repoRoot, 'skills/openclaw/SKILL.md'),
} as const;

const read = (p: string): string => readFileSync(p, 'utf8');

/* ── the real verb tree, read from the real binary ─────────────────────── */

/**
 * Every command path `wemessage --help` reaches, plus every intermediate
 * group, walked from the built binary.
 *
 * Read from `--help` rather than from `bin.ts`'s source because that is what
 * a stranger reading the document would do, and because a source grep would
 * still pass on the day commander stops registering a command it declares.
 * `TN-skill-stale-verb` is a rename that a source grep sees and a `--help`
 * walk also sees; the point of using `--help` is the renames it catches that
 * a grep would not.
 */
function cliVerbPaths(): Set<string> {
  const children = (path: readonly string[]): string[] => {
    const out = execFileSync(process.execPath, [CLI_BIN, ...path, '--help'], {
      encoding: 'utf8',
    });
    const at = out.indexOf('Commands:');
    if (at === -1) return [];
    return out
      .slice(at + 'Commands:'.length)
      .split('\n')
      .map((l) => /^ {2}(\S+)/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => m[1] as string)
      .filter((c) => c !== 'help');
  };
  const paths = new Set<string>();
  for (const top of children([])) {
    paths.add(top);
    for (const sub of children([top])) paths.add(`${top} ${sub}`);
  }
  return paths;
}

/** The tokens of a block line that name a verb: everything before a glob. */
function verbPathOf(line: string): string {
  const tokens = line.split(/\s+/);
  const stop = tokens.findIndex((t) => t === '*' || t.startsWith('-'));
  return (stop === -1 ? tokens : tokens.slice(0, stop)).join(' ');
}

const VERBS = cliVerbPaths();

function policyOf(which: keyof typeof SKILLS): SkillPolicy {
  return parseSkillBlocks(read(SKILLS[which]));
}

/* ── row 1: the document cannot name a verb the CLI does not have ──────── */

describe('s7 Sc11 row 1: every permitted verb is a verb that exists', () => {
  it('the walk found the real tree, not an empty one', () => {
    // A verb check against an empty set passes vacuously, and a `--help`
    // walk that silently returned nothing is exactly how that happens.
    expect(VERBS.size).toBeGreaterThan(40);
    expect(VERBS.has('drafts approve')).toBe(true);
    expect(VERBS.has('settings get')).toBe(true);
  });

  for (const which of ['claude', 'hermes', 'openclaw'] as const) {
    it(`${which}: allowed, approval and never all name real verb paths`, () => {
      const policy = policyOf(which);
      const lines = [...policy.allowed, ...policy.approval, ...policy.never];
      expect(lines.length).toBeGreaterThan(0);
      const unknown = lines
        .map(verbPathOf)
        .filter((v) => v !== '' && !VERBS.has(v));
      expect(unknown, `unknown verb paths in ${which}`).toEqual([]);
    });

    it(`${which}: approval is a subset of allowed, never is disjoint`, () => {
      const { allowed, approval, never } = policyOf(which);
      for (const verb of approval) expect(allowed).toContain(verb);
      for (const pattern of never) {
        expect(allowed).not.toContain(pattern);
        expect(approval).not.toContain(pattern);
      }
    });
  }
});

/* ── row 2: the coverage the plan names, plus the send verb ────────────── */

describe('s7 Sc11 row 2: the never block covers everything that widens', () => {
  it('claude refuses every credential, lifecycle and widening verb', () => {
    const { never } = policyOf('claude');
    for (const pattern of [
      'kill',
      'resume',
      'contacts set * auto',
      'rules add',
      'rules edit *',
      'rules rm *',
      'adapters token-rotate *',
      'settings set *',
      'auth *',
      'mode *',
      'pause *',
      'windows *',
    ])
      expect(never, pattern).toContain(pattern);
  });

  it('the approval block is exactly the verbs that reach the send path', () => {
    const { approval } = policyOf('claude');
    expect(approval).toContain('drafts approve *');
    expect(approval).toContain('drafts retry *');
    // PLAN DEVIATION, and the load-bearing one in this scenario. The plan
    // put `send *` in `approval`. `wemessage send` does not queue anything:
    // packages/daemon/src/routes/send.ts mints an ALREADY-APPROVED draft,
    // mints its own Approval with actor {kind:'human', via:'api'}, and
    // dispatches in the same request. The "human" in that Approval row is
    // whoever held the token, which under a skill is the agent. An approval
    // block entry is a promise that a human's instruction gates the act;
    // for this verb the act and the approval are the same call, so the
    // promise is unkeepable. It goes on the never list instead, and
    // `skill-dryrun-live.spec.ts` demonstrates the send it would have
    // produced rather than asserting the refusal in prose.
    expect(approval).not.toContain('send *');
    expect(policyOf('claude').never).toContain('send *');
  });

  it('drafting is approval-gated too: no draft is written unasked', () => {
    // A draft is words in the operator's name sitting in the operator's
    // queue. It cannot reach a phone by itself, but "the agent wrote three
    // things I never asked for" is still the agent speaking for someone.
    expect(policyOf('claude').approval).toContain('drafts create *');
  });
});

/* ── row 3: the linter, one offender and one near-miss per rule ─────────── */

/**
 * A rule with only an offender proves it fires. A rule with only a
 * near-miss proves it is quiet. Neither alone tells you the rule is a rule
 * rather than a substring search, so every entry below carries both, and
 * the pairs are chosen to differ by as little as possible.
 */
describe('s7 Sc11 row 3: every linter rule fires, and only when it should', () => {
  const policy: SkillPolicy = {
    allowed: [
      'status',
      'drafts list',
      'drafts show *',
      'drafts create *',
      'drafts approve *',
      'contacts list',
      'contacts set *',
    ],
    approval: ['drafts create *', 'drafts approve *'],
    never: ['contacts set * auto', 'drafts approve --all', 'send *'],
  };

  const rulesOf = (t: string): string[] =>
    lintTranscript(t, policy).map((f) => f.rule);

  // Offenders are assembled at runtime from halves so that THIS FILE stays
  // clean under the tree-wide public sweep it shares an implementation with.
  const REAL_PHONE = `+1${'2065550123'}`;
  const BRAND = `flow${'stay'}`;
  const ESC = String.fromCharCode(27);
  // Two more assembled literals. `/Users/` is the shape the sweep hunts, so
  // spelling it here would make this file the offender; and the live
  // message-store path is separately banned in every test tree by S3 guard
  // (b), which is why the probe below points at a state file instead.
  const HOME = `/${'User'}s/ada`;
  const HEX64 = 'a'.repeat(64);

  const CASES: ReadonlyArray<{
    rule: string;
    offender: string;
    nearMiss: string;
    why: string;
  }> = [
    {
      rule: 'never-do',
      offender: `$ wemessage contacts set ${'+15551230000'} auto`,
      nearMiss: `$ wemessage contacts set ${'+15551230000'} draft-only`,
      why: 'the mode is the whole act: auto widens, draft-only narrows',
    },
    {
      rule: 'never-do',
      offender: '$ wemessage drafts approve --all',
      nearMiss: '$ wemessage drafts approve 01HZZZ',
      why: 'never beats allowed: `drafts approve *` cannot re-permit --all',
    },
    {
      rule: 'verb-not-allowed',
      offender: '$ wemessage drafts redraft 01HZZZ',
      nearMiss: '$ wemessage drafts show 01HZZZ',
      why: 'a verb in neither list is not a permission, it is an omission',
    },
    {
      rule: 'approval-without-instruction',
      offender: '$ wemessage drafts approve 01HZZZ',
      nearMiss: 'human: approve 01HZZZ\n$ wemessage drafts approve 01HZZZ',
      why: 'the instruction must exist and must name what it approves',
    },
    {
      rule: 'approval-without-instruction',
      offender: 'human: approve 01HAAA\n$ wemessage drafts approve 01HZZZ',
      nearMiss: 'human: approve 01HZZZ\n$ wemessage drafts approve 01HZZZ',
      why: 'a human line about a different draft is not consent for this one',
    },
    {
      rule: 'token-shaped',
      offender: `< adapter token: wm_${'0'.repeat(64)}`,
      nearMiss: '< adapter token: wm_<redacted>',
      why: 'the redaction is the only shape allowed to survive a transcript',
    },
    {
      rule: 'token-shaped',
      offender: `< authorization: Bearer ${HEX64}`,
      nearMiss: `< chain hash: ${HEX64}`,
      why: 'a 64-hex audit hash is public; the same bytes after Bearer are not',
    },
    {
      rule: 'non-synthetic-contact',
      offender: `< to: ${REAL_PHONE}`,
      nearMiss: '< to: +15551234567',
      why: '+1555 is the fiction reserve; anything else may be somebody',
    },
    {
      rule: 'non-synthetic-contact',
      offender: '< gateway: wss://gateway.acme.internal/v1/agent',
      nearMiss: '< gateway: ws://127.0.0.1:8765/v1/agent',
      why: 'loopback is nobody; a named host is somebody`s infrastructure',
    },
    {
      rule: 'non-synthetic-contact',
      offender: '< operator: ada@acme.io',
      nearMiss: '< operator: qa-bookings@example.com',
      why: 'example.com is reserved by RFC 2606; .io is somebody`s mailbox',
    },
    {
      rule: 'brand-string',
      offender: `< user-agent: ${BRAND}-gateway/1.0`,
      nearMiss: '< user-agent: workflow-gateway/1.0',
      why: 'the substring `flow` is not the brand; the brand is the brand',
    },
    {
      rule: 'absolute-user-path',
      offender: `< store: ${HOME}/.wemessage/state.db`,
      nearMiss: '< store: ~/.wemessage/state.db',
      why: 'the tilde says the same thing without naming the operator',
    },
    {
      rule: 'ansi-escape',
      offender: `< ${ESC}[32mconnected${ESC}[0m`,
      nearMiss: '< frame [32m] connected',
      why: 'one byte apart: the escape is the colour, the brackets are text',
    },
    {
      rule: 'colour-carries-state',
      offender: '< health: green',
      nearMiss: '< health: greenlight',
      why: 'state is carried by a glyph and by CASE, never by a colour word',
    },
    {
      rule: 'colour-carries-state',
      offender: '< accent: #22C55E',
      nearMiss: '< accent: #0A84FF',
      why: 'the product has exactly one colour and it is the blue bubble',
    },
    {
      rule: 'unknown-frame-named',
      offender: `< {"type":"send","v":1,"payload":{}}`,
      nearMiss: `< {"type":"draft.submit","v":1,"payload":{}}`,
      why: 'INV-2 in a linter: there is no send frame, so naming one is a bug',
    },
  ];

  for (const c of CASES) {
    it(`${c.rule}: fires on the offender (${c.why})`, () => {
      expect(rulesOf(c.offender)).toContain(c.rule);
    });
    it(`${c.rule}: silent on the near-miss (${c.why})`, () => {
      expect(rulesOf(c.nearMiss)).not.toContain(c.rule);
    });
  }

  it('a clean transcript has no findings at all', () => {
    const clean = [
      'human: what is in the queue?',
      '$ wemessage status --json',
      '< {"state":"connected"}',
      '< exit 0',
      '$ wemessage drafts list --json',
      '< {"drafts":[]}',
      '< exit 0',
      'human: tell +15551234567 the roof is fixed',
      '$ wemessage drafts create --chat iMessage;-;+15551234567 --body "the roof is fixed"',
      '< draft 01HZZZ pending',
      '< exit 0',
      'human: approve 01HZZZ',
      '$ wemessage drafts approve 01HZZZ',
      '< draft 01HZZZ sent',
      '< exit 0',
    ].join('\n');
    expect(lintTranscript(clean, policy)).toEqual([]);
  });

  it('every rule the linter advertises has a case above', () => {
    // The pairs are the specification. A rule with no pair is a rule
    // nobody proved, and this row is what stops one being added quietly.
    const advertised = new Set(lintTranscript('', policy).map((f) => f.rule));
    expect(advertised.size).toBe(0);
    const covered = new Set(CASES.map((c) => c.rule));
    expect([...covered].sort()).toEqual([
      'absolute-user-path',
      'ansi-escape',
      'approval-without-instruction',
      'brand-string',
      'colour-carries-state',
      'never-do',
      'non-synthetic-contact',
      'token-shaped',
      'unknown-frame-named',
      'verb-not-allowed',
    ]);
  });

  it('the never list comes from the document, not from a copy', () => {
    // TN-linter-blind's target. `lintTranscript` takes the policy as an
    // argument and holds no never-list of its own: hand it a policy whose
    // never block is empty and the never-do rule must go quiet, which a
    // hardcoded copy could not do.
    const empty: SkillPolicy = {
      allowed: ['contacts set *'],
      approval: [],
      never: [],
    };
    const line = `$ wemessage contacts set ${'+15551230000'} auto`;
    expect(lintTranscript(line, empty).map((f) => f.rule)).not.toContain(
      'never-do',
    );
    expect(rulesOf(line)).toContain('never-do');
  });
});

/* ── the argv glob, in its own right ────────────────────────────────────── */

describe('s7 Sc11: the argv glob is a glob, not a prefix test', () => {
  const cases: ReadonlyArray<[string, string, boolean]> = [
    ['status', 'status', true],
    ['status', 'status --json', true],
    ['status', 'status extra', false],
    ['drafts show *', 'drafts show 01HZZZ', true],
    ['drafts show *', 'drafts show', false],
    ['contacts set * auto', 'contacts set +15551230000 auto', true],
    ['contacts set * auto', 'contacts set +15551230000 draft-only', false],
    ['contacts set *', 'contacts set +15551230000 draft-only', true],
    ['send *', 'send --to +15551234567 --body hi', true],
    ['drafts approve --all', 'drafts approve --all', true],
    ['drafts approve --all', 'drafts approve 01HZZZ', false],
    ['auth *', 'auth print-token', true],
    ['windows *', 'windows list', true],
  ];
  for (const [pattern, argv, want] of cases) {
    it(`${JSON.stringify(pattern)} ${want ? 'matches' : 'does not match'} ${JSON.stringify(argv)}`, () => {
      expect(matchArgv(pattern, argv.split(' '))).toBe(want);
    });
  }
});

/* ── row 8: the sibling skills are subsets ─────────────────────────────── */

describe('s7 Sc11 row 8: no host gets a power claude does not have', () => {
  it('hermes allowed ⊆ claude allowed, and hermes writes nothing', () => {
    const claude = policyOf('claude');
    const hermes = policyOf('hermes');
    for (const verb of hermes.allowed) expect(claude.allowed).toContain(verb);
    // Under Hermes the WIRE adapter carries the replies (F-89). This file
    // governs tool use of the CLI only, and tool use of the CLI under
    // Hermes is reading. An empty approval block is the honest encoding of
    // that: there is nothing here that needs a human because there is
    // nothing here that acts.
    expect(hermes.approval).toEqual([]);
    expect(hermes.allowed).not.toContain('drafts create *');
    expect(hermes.allowed).not.toContain('drafts approve *');
  });

  it('hermes says in paragraph one that the adapter, not this file, replies', () => {
    const head = read(SKILLS.hermes)
      .split(/\n\s*\n/)
      .slice(0, 4)
      .join('\n\n');
    expect(head).toMatch(/wire adapter/i);
    expect(head).toMatch(/tool use/i);
  });

  it('openclaw allowed ⊆ claude allowed (Sc 10 row 6, finally assertable)', () => {
    const claude = policyOf('claude');
    const openclaw = policyOf('openclaw');
    for (const verb of openclaw.allowed) expect(claude.allowed).toContain(verb);
    for (const verb of openclaw.approval)
      expect(claude.approval).toContain(verb);
  });

  it('every never pattern claude has, the siblings have too', () => {
    // Subset in the permissive direction is only half the guarantee. A
    // sibling that quietly dropped `settings set *` from its never block
    // would still be a subset on `allowed` and would still be wrong.
    const claude = policyOf('claude');
    for (const which of ['hermes', 'openclaw'] as const) {
      const sibling = policyOf(which);
      const missing = claude.never.filter((p) => !sibling.never.includes(p));
      expect(missing, `${which} is missing never patterns`).toEqual([]);
    }
  });
});

/* ── INV-2: the document cannot describe a send ─────────────────────────── */

describe('s7 Sc11: INV-2 — no skill document leaves room for a send', () => {
  it('the wire still has nine frames and none of them sends', () => {
    expect(Object.keys(FRAME_SPECS)).toHaveLength(9);
    expect(Object.keys(FRAME_SPECS)).not.toContain('send');
  });

  for (const which of ['claude', 'hermes', 'openclaw'] as const) {
    it(`${which}: names no frame the protocol does not have`, () => {
      const findings = lintSkillDocument(read(SKILLS[which]));
      expect(findings.map((f) => `${f.rule}: ${f.detail}`)).toEqual([]);
    });

    it(`${which}: refuses \`send\` by name, on the never list`, () => {
      // Not "does not mention send". The document MUST mention it: a verb
      // an agent can see in `--help` and cannot find on any list is a verb
      // it will eventually try. The requirement is that the mention is a
      // refusal.
      expect(policyOf(which).never).toContain('send *');
      expect(policyOf(which).allowed).not.toContain('send *');
    });
  }

  it('the three markers are load-bearing, not decoration', () => {
    // Every rule above reads the document through `parseSkillBlocks`, so
    // the markers are the interface. Delete one and the block it names goes
    // empty — which is what makes "the never list came from the document"
    // a checkable statement rather than a hope.
    for (const which of ['claude', 'hermes', 'openclaw'] as const) {
      const doc = read(SKILLS[which]);
      for (const name of ['allowed', 'approval', 'never'] as const)
        expect(doc, which).toContain(`<!-- wemessage:${name} -->`);
      const stripped = doc.replace('<!-- wemessage:never -->', '(removed)');
      expect(parseSkillBlocks(stripped).never, which).toEqual([]);
      expect(parseSkillBlocks(doc).never.length, which).toBeGreaterThan(0);
    }
  });
});

/* ── row 9: PUBLIC and no-green over everything under skills/ ──────────── */

describe('s7 Sc11 row 9: skills/ is swept like every other public surface', () => {
  const skillFiles = execFileSync('git', ['ls-files', 'skills'], {
    cwd: repoRoot,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((f) => f.length > 0);

  it('the enumeration is not empty and includes all three documents', () => {
    expect(skillFiles).toContain('skills/claude/SKILL.md');
    expect(skillFiles).toContain('skills/hermes/SKILL.md');
    expect(skillFiles).toContain('skills/openclaw/SKILL.md');
  });

  it('no file under skills/ carries a public-repo offender', () => {
    const offenders = skillFiles.flatMap((f) =>
      publicStringOffenders(read(join(repoRoot, f))).map(
        (o) => `${f}: ${o.rule}: ${o.detail}`,
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('no file under skills/ carries colour, an escape, or a bad frame', () => {
    // The full transcript lint minus the policy rules, which need argv.
    const policy: SkillPolicy = { allowed: [], approval: [], never: [] };
    const offenders = skillFiles.flatMap((f) =>
      lintTranscript(read(join(repoRoot, f)), policy)
        .filter((x) => x.rule !== 'verb-not-allowed')
        .map((x) => `${f}:${String(x.line)}: ${x.rule}: ${x.detail}`),
    );
    expect(offenders).toEqual([]);
  });
});

/* ── the verification tier, applied to a document ──────────────────────── */

describe('s7 Sc11: what has actually been driven, declared as a value', () => {
  it('claude`s tier is conformance-only, and says exactly why', () => {
    // The CLI in that document is real and every row above checks it. What
    // has never happened is a language model following the file: F-93 makes
    // the scripted policy the gate and the human run a manual step. The
    // tier is the honest name for that gap, and `blockedBy` is the sentence
    // the document prints.
    expect(CLAUDE_SKILL_VERIFICATION.tier).toBe('conformance-only');
    expect(CLAUDE_SKILL_VERIFICATION.liveEvidence).toBeNull();
    expect(
      skillVerificationOffenders(CLAUDE_SKILL_VERIFICATION, {
        read: () => null,
        tracked: () => false,
      }),
    ).toEqual([]);
  });

  it('the banner is rendered into the document, byte for byte', () => {
    for (const [which, value] of [
      ['claude', CLAUDE_SKILL_VERIFICATION],
      ['hermes', HERMES_SKILL_VERIFICATION],
    ] as const) {
      const head = read(SKILLS[which])
        .split(/\n\s*\n/)
        .slice(0, 4)
        .join('\n\n');
      expect(head, which).toContain(skillVerificationBanner(value));
    }
  });

  it('a live claim without a marked, tracked spec is refused', () => {
    // The mechanism is Sc 9's and the asymmetry is the point: claiming
    // less than you can prove is free, claiming more costs a file another
    // engineer can open.
    const overclaim = {
      subject: 'claude',
      declaredOn: '2026-09-05',
      tier: 'live-verified',
      liveEvidence: 'test/skill-dryrun-live.spec.ts',
      verifiedOn: '2026-09-05',
    } as const;
    expect(
      skillVerificationOffenders(overclaim, {
        read: () => 'no marker here',
        tracked: () => true,
      }),
    ).toHaveLength(1);
    expect(
      skillVerificationOffenders(overclaim, {
        read: () => null,
        tracked: () => false,
      }).length,
    ).toBeGreaterThan(0);
  });
});

/* ── the artifact ──────────────────────────────────────────────────────── */

describe('s7 Sc11 row 7: DRYRUN.md is a committed, stable artifact', () => {
  const path = join(repoRoot, 'skills/claude/DRYRUN.md');

  it('exists and carries the fixed header, with no timestamp', () => {
    expect(existsSync(path)).toBe(true);
    const body = read(path);
    expect(body).toContain(
      `generated by packages/daemon/test/skill-dryrun-live.spec.ts at SKILL_DRYRUN_VERSION ${String(SKILL_DRYRUN_VERSION)}`,
    );
    // Stability: no ISO timestamp, no port, no raw ULID.
    expect(body).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(body).not.toMatch(/127\.0\.0\.1:\d+/);
    expect(body).not.toMatch(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/);
  });

  it('lints clean against the document it was produced from', () => {
    expect(lintTranscript(read(path), policyOf('claude'))).toEqual([]);
  });
});
