/**
 * dependency-cruiser config — INV-1 (§2.7) + §3.1 import arrows.
 * Package paths are brand-neutral; the WeMessage rename does not touch these regexes.
 * Rule names are binding (s1-execution §1.6); regexes are the enforcement.
 */
module.exports = {
  forbidden: [
    // INV-1 (§2.7): core is pure — no internal packages, no I/O deps, no node I/O builtins
    {
      severity: 'error',
      name: 'core-no-internal-deps',
      from: { path: '^packages/core/src' },
      to: { path: '^packages/(?!core)' },
    },
    {
      severity: 'error',
      name: 'core-no-io',
      from: { path: '^packages/core/src' },
      to: { path: '^node_modules' }, // core has zero runtime deps at all
    },
    {
      severity: 'error',
      name: 'core-no-node-io-builtins',
      // `crypto` is deliberately absent: sha256 is a pure deterministic
      // function and core/audit chain math needs it (s2-execution §1.2).
      // `randomBytes`-style entropy use in core is a review-level catch
      // (INV-1 "ulid at the I/O edge" precedent), not a cruiser rule.
      from: { path: '^packages/core/src' },
      to: {
        path: '^(node:)?(fs|net|http|https|child_process|worker_threads|dgram|tls|os)$',
      },
    },
    {
      severity: 'error',
      name: 'core-no-unresolvable-imports',
      comment:
        'S2 §1.2 closed dependency list: an import of a package that is not ' +
        'installed for core (e.g. re2, ulid — pnpm isolation means nothing ' +
        'external resolves from core) never reaches core-no-io, because ' +
        'that rule matches resolved ^node_modules paths only. Any ' +
        'unresolvable import from core is therefore an attempted external ' +
        'dependency and an INV-1 violation.',
      from: { path: '^packages/core/src' },
      to: { couldNotResolve: true },
    },

    // INV-1 electron clause (§2.7): no electron in core|store|ingest|sendkit|...
    {
      severity: 'error',
      name: 'no-electron-outside-desktop',
      from: {
        path: '^packages/(core|store|ingest|sendkit|daemon|client|cli|protocol)',
      },
      to: { path: 'electron' },
    },

    // §3.1 arrows: ingest|sendkit|store import core only
    {
      severity: 'error',
      name: 'ingest-sendkit-store-core-only',
      from: { path: '^packages/(ingest|sendkit|store)/src' },
      to: { path: '^packages/(?!core/|$1/)' },
    },

    // §3.1: the CLI is a thin client. Self-imports within packages/cli/src
    // (e.g. bin.ts -> ./probe.js, ./purge.js — S3 Scenario 10) are not a
    // cross-package dependency and must stay legal; the `cli` exclusion
    // mirrors ingest-sendkit-store-core-only's `$1/` self-exclusion above.
    {
      severity: 'error',
      name: 'cli-thin-client',
      from: { path: '^packages/cli/src' },
      to: { path: '^packages/(?!client|protocol|cli)' },
    },

    // §3.1: the desktop app is a thin client too, and it is now its OWN rule
    // (s8 Sc1, F-103). Until S8 both lived in one rule, `cli-desktop-thin-
    // clients`, whose `to` had to exclude `cli` so that the CLI's internal
    // file layout stayed legal — and that exclusion applied to apps/desktop
    // as well, which silently permitted `apps/desktop/src -> packages/cli`
    // for six slices. Nothing exploited it because apps/desktop had two
    // lines in it; S8 is the slice that fills the directory, and a hole is
    // only theoretical until somebody needs a status table.
    //
    // Two `to` shapes, mirroring adapters-thin-clients: pnpm isolation means
    // an undeclared `@wemessage/cli` import does not RESOLVE from
    // apps/desktop, so a resolved-path rule alone would miss the sloppiest
    // possible reach — an import that is a violation twice over. The bare
    // specifier catches it before the package.json does.
    {
      severity: 'error',
      name: 'desktop-thin-client',
      from: { path: '^apps/desktop/src' },
      to: {
        path: [
          '^packages/(?!client|protocol)',
          '^@wemessage/(?!client$|protocol$)',
        ],
      },
    },

    // §3.1: nobody imports daemon.
    //
    // s8 Sc1 carves out `apps/desktop/test/` and nothing else. The desktop
    // e2e harness boots a REAL daemon in-process against a temp store
    // (F-102) — the house has no other place to do that, and a fake daemon
    // would make the checkpoint scenarios assert against a fiction. The
    // exception is deliberately narrow (test/, not the package), and it is
    // paired with `desktop-thin-client` above, which asserts positively that
    // the SHIPPED app reaches neither the daemon nor anything else. A rule
    // with one reviewed exception plus a positive assertion is stronger than
    // the rule it replaces, which had no exception because nothing had tried.
    {
      severity: 'error',
      name: 'nobody-imports-daemon',
      from: {
        path: '^(packages/(?!daemon)|apps|fixtures)',
        pathNot: '^apps/desktop/test/',
      },
      to: { path: '^packages/daemon' },
    },

    // s5 §3.1: an adapter is a thin client. It speaks the wire protocol and
    // uses the client, and it reaches nothing else in the monorepo: no store,
    // no core, no ingest, no sendkit, and above all no daemon. A third
    // party's adapter code is the first foreign code near our send path, so
    // the reach is fenced at the import graph, not at review time.
    {
      severity: 'error',
      name: 'adapters-thin-clients',
      from: { path: '^packages/adapters/[^/]+/src' },
      // Two shapes, because an adapter that does not declare the dependency
      // in its package.json still imports it in source: a resolved workspace
      // path, and the bare unresolvable specifier. Matching only the former
      // would let the sloppiest possible reach through.
      to: {
        path: [
          '^packages/(?!protocol/|client/|adapters/|adapter-testkit/)',
          '^@wemessage/(?!protocol$|client$)',
        ],
      },
    },

    // §3.1: daemon imports all packages but no app
    {
      severity: 'error',
      name: 'daemon-no-apps',
      from: { path: '^packages/daemon' },
      to: { path: '^apps' },
    },

    // §3.3: protocol has zero runtime deps; core reachable via import type only.
    // "Zero runtime deps" means zero EXTERNAL runtime deps: a module inside
    // packages/protocol/src importing a sibling module in the same package
    // (s7 Scenario 2: index.ts -> events.ts, a value import of the derived
    // EVENT_PAYLOAD_KEYS) is not a dependency the package ships, it is the
    // package's own file layout. The `protocol/` exclusion mirrors
    // ingest-sendkit-store-core-only's `$1/` and cli-thin-client'
    // `cli` self-exclusions above; without it every intra-package split in
    // protocol would read as a §3.3 violation and the rule would push the
    // vocabulary back into one unsplittable file.
    {
      severity: 'error',
      name: 'protocol-zero-runtime-deps',
      from: { path: '^packages/protocol/src' },
      to: {
        path: '^(node_modules|packages/(?!core/|protocol/))',
        dependencyTypesNot: ['type-only'],
      },
    },
    {
      severity: 'error',
      name: 'protocol-core-type-only',
      from: { path: '^packages/protocol/src' },
      to: { path: '^packages/core', dependencyTypesNot: ['type-only'] },
    },

    // fixtures never ship (§2.1): no src/ of any package may import fixtures
    {
      severity: 'error',
      name: 'no-fixtures-in-prod-path',
      from: { path: '^(packages|apps)/[^/]+/src' },
      to: { path: '^fixtures' },
    },
  ],
  options: {
    tsConfig: { fileName: 'tsconfig.json' },
    tsPreCompilationDeps: true,
    doNotFollow: { path: 'node_modules' },
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'types', 'default'],
    },
  },
};
