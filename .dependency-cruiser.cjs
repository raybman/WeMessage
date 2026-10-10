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

    // §3.1: nobody imports daemon.
    //
    // Two `to` shapes (s9 Sc 1 row 8), for the reason `adapters-thin-clients`
    // carries two: pnpm does not hoist, so an undeclared `import
    // '@wemessage/daemon'` does not RESOLVE, it comes back `couldNotResolve`
    // with no resolved path to match. The bare specifier catches the
    // sloppiest possible reach, which a resolved-path rule alone would miss.
    {
      severity: 'error',
      name: 'nobody-imports-daemon',
      from: {
        path: '^(packages/(?!daemon)|apps|fixtures)',
      },
      to: { path: ['^packages/daemon', '^@wemessage/daemon$'] },
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

    // s9 Sc 1 row 7. The release tools import NOTHING from this monorepo.
    //
    // Not a style rule. The release lane's job is to render a cask, check
    // versions, cut a tag and drive notarisation, and every one of those has
    // to work on the day the daemon does not compile — which is precisely
    // the day somebody is trying to ship a fix. A `tools/release` that
    // imported `@wemessage/core` would put the entire package graph on the
    // critical path of `pnpm release:cask`, so that a broken daemon build
    // could block a cask render for no reason connected to casks.
    //
    // The permitted set is therefore tiny and stated positively in the
    // prose: `node:*` builtins, `yaml`, and relative paths (the tools may
    // import each other). Everything else — workspace packages by path,
    // workspace packages by bare unresolvable specifier, and any other
    // third-party runtime dependency — is an error. Both specifier shapes
    // are matched for the same reason `adapters-thin-clients` matches both:
    // a tool that never declared the dependency still imports it in source,
    // and matching only the resolved path would let the sloppiest possible
    // reach through.
    {
      severity: 'error',
      name: 'tools-import-runtime-nothing',
      from: {
        path: '^tools/',
        pathNot: '^tools/release/bin/bundle-daemon\\.mjs$',
      },
      to: {
        pathNot: ['^tools/', '^node_modules/yaml/'],
        path: ['^(packages|apps|fixtures)/', '^@wemessage/', '^node_modules/'],
      },
    },

    // v2 S6a. The ONE file the rule above exempts, and the one thing it may
    // import that the rule above forbids: `esbuild`, a devDependency of
    // `@wemessage/release` and of nothing else in `tools/`. The daemon
    // bundler lives here so the Swift pack lane owns it outright, and
    // bundling is its whole job. It is a build step that READS `dist/` output as data, never a
    // workspace import, so every other reach stays an error exactly as it is
    // for every other tool.
    {
      severity: 'error',
      name: 'bundle-daemon-esbuild-only',
      from: { path: '^tools/release/bin/bundle-daemon\\.mjs$' },
      to: {
        pathNot: [
          '^tools/',
          '^node_modules/\\.pnpm/esbuild@[^/]+/node_modules/esbuild/',
        ],
        path: ['^(packages|apps|fixtures)/', '^@wemessage/', '^node_modules/'],
      },
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
