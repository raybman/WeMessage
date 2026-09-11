## What this changes

<!-- One or two sentences. What is different after this merges? -->

## Why

<!-- The problem, not the patch. Link the issue if there is one. -->

Closes #

## How it was verified

<!--
Tests close every task. Paste the command you ran and its result, or describe
the manual steps if the change is one a test cannot reach.
-->

- [ ] `pnpm build`
- [ ] `pnpm test`
- [ ] `pnpm lint`
- [ ] `pnpm dep:check`
- [ ] `pnpm licenses:check`

## Safety review

The one promise this project makes is that **nothing sends without a human
approval**. Answer these honestly even when the change looks unrelated.

- [ ] This change adds no new path from the GUI to a send (INV-2).
- [ ] This change mints no new `reason: 'auto-respond'` actor outside
      `packages/core/src/sending/auto-approve.ts`.
- [ ] If this touches the transport surface, the ratchet snapshot is updated
      and the PR body says why (INV-3).
- [ ] No new test is skipped, or the skip is declared in `DECLARED_SKIPS` in
      `test/release/s9-e2e.spec.ts` with its reason.
- [ ] No assertion was widened or deleted to make a red test green. Guards get
      narrower, never looser.

## Housekeeping

- [ ] Conventional commit messages.
- [ ] Signed off with `git commit -s` (DCO).
