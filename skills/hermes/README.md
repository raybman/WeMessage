# skills/hermes

`SKILL.md` is the skill document a Hermes host loads. It is a strict subset of
`skills/claude/SKILL.md`: read-only verbs, an empty approval block, and a never
list that is Claude's plus everything that can produce a draft.

That asymmetry is deliberate and is asserted rather than described. Hermes reaches
this daemon over the HTTP adapter built in s7 Scenario 8 against a fake, and no
real Hermes has ever been driven through this document, so its verification tier
is `conformance-only` and the banner says so.

The subset relationship, the empty approval block and the never list are checked
by `packages/cli/test/skill-dryrun.spec.ts`.
