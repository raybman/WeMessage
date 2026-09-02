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
      from: { path: '^packages/core/src' },
      to: {
        path: '^(node:)?(fs|net|http|https|child_process|worker_threads|dgram|tls|os)$',
      },
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

    // §3.1: cli and apps/desktop import client+protocol only
    {
      severity: 'error',
      name: 'cli-desktop-thin-clients',
      from: { path: '^(packages/cli|apps/desktop)/src' },
      to: { path: '^packages/(?!client|protocol)' },
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
