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

    // §3.1: cli and apps/desktop import client+protocol only. Self-imports
    // within packages/cli/src (e.g. bin.ts -> ./probe.js, ./purge.js — S3
    // Scenario 10) are not a cross-package dependency and must stay legal;
    // the `cli/` exclusion mirrors ingest-sendkit-store-core-only's `$1/`
    // self-exclusion above. apps/desktop needs no equivalent clause: its own
    // files never match `^packages/`, so this rule never fires on them.
    {
      severity: 'error',
      name: 'cli-desktop-thin-clients',
      from: { path: '^(packages/cli|apps/desktop)/src' },
      to: { path: '^packages/(?!client|protocol|cli)' },
    },

    // §3.1: nobody imports daemon
    {
      severity: 'error',
      name: 'nobody-imports-daemon',
      from: { path: '^(packages/(?!daemon)|apps|fixtures)' },
      to: { path: '^packages/daemon' },
    },

    // §3.1: daemon imports all packages but no app
    {
      severity: 'error',
      name: 'daemon-no-apps',
      from: { path: '^packages/daemon' },
      to: { path: '^apps' },
    },

    // §3.3: protocol has zero runtime deps; core reachable via import type only
    {
      severity: 'error',
      name: 'protocol-zero-runtime-deps',
      from: { path: '^packages/protocol/src' },
      to: {
        path: '^(node_modules|packages/(?!core))',
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
