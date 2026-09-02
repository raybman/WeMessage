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

The wire protocol (`@wemessage/protocol`) + the adapter testkit are the contract.
Adapters are published independently and listed in the README's
`awesome-wemessage-adapters` section — do not fork the monorepo to add an agent.
