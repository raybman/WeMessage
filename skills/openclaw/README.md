# skills/openclaw

`SKILL.md` is the skill document an OpenClaw host loads. The stdio shim it
describes lives in `packages/adapters/openclaw`; the child-process contract is in
that package's README.

Every verb this document allows, `skills/claude/SKILL.md` allows too. That is not
a convention, it is a row: `packages/adapters/openclaw/test/shim.spec.ts` parses
both files and fails if this one grows a capability the flagship does not have.

Verification tier is `conformance-only`. The shim's child contract is fully
exercised; no byte has ever been exchanged with a real OpenClaw.
