# Contributing to WeMessage

## Setup (pnpm monorepo)

```bash
corepack enable           # pins pnpm@10.34.5 via packageManager
pnpm install
pnpm build                # tsc -b across the workspace (this is also the typecheck)
pnpm test                 # vitest, all packages
pnpm lint                 # eslint + prettier --check
pnpm dep:check            # dependency-cruiser (INV-1 + §3.1 import arrows)
pnpm licenses:check       # fail on GPL/AGPL transitive deps (§3.11.1)
```

Node `>=22.12` is required (N-API compatibility for the v1.1 Beeper backend).

## The fixture-DB test loop (no Mac needed for most work)

Every unit and integration test runs on Linux against **fixtures**, never a live
`~/Library/Messages/chat.db`:

- `fixtures/chatdb-builder.ts` constructs a real SQLite file that replicates the
  chat.db schema (message/chat/handle/attachment join tables, Apple-epoch dates).
- `fixtures/typedstream/*.bin` is a checked-in, **synthetic-content** typedstream
  corpus with `manifest.json` golden expectations.

You only need a Mac for the live demo (`s1-execution` §4.2) and for the `ci-macos`
smoke work (S3+). All CI gating happens on Linux.

## Conventions

- **Conventional commits** for every change.
- **DCO sign-off**: commit with `git commit -s` (adds `Signed-off-by:`).
- Prettier defaults; no style bikeshedding in PRs.
- **PRs that touch the transport surface must update the ratchet snapshot and say
  why.** (INV-3, `transport-surface.ratchet.spec.ts`.)

## Third-party adapters live out-of-tree

The wire protocol (`@wemessage/protocol`) plus the adapter testkit are the
contract. Adapters are published independently; do not fork the monorepo to add
an agent.

The kit ships a bin, so proving conformance needs no checkout of this repo:

```bash
npx @wemessage/adapter-testkit --cmd "node my-adapter.mjs"
```

Exit 0 conformant, 1 not conformant, 2 usage. `wemessage adapters test` in the
CLI deliberately refuses and prints that command instead: conformance is the
adapter author's business, and a daemon subcommand that spawned third-party
code would be a worse seam than a pointer.

The full wire reference is `packages/protocol/PROTOCOL.md`, generated from the
protocol package's own tables. Do not hand-edit it; change the table and
regenerate.
