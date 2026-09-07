/**
 * The release lane's shared surface. Empty at s9 Sc 1, on purpose.
 *
 * Scenario 1 lays the guards for the ship era before any of the ship era
 * exists, and this package is one of the things those guards are about:
 * `tools-import-runtime-nothing` needs a `tools/` root to be a rule about,
 * `tsconfig.json` needs a project to reference, and `pnpm-workspace.yaml`
 * needs a member to resolve. The scenarios that follow fill it in —
 * notarisation (Sc 8), the cask renderer (Sc 11), version checking and tag
 * cutting (Sc 14) — and each of them arrives as a diff against a package
 * that is already wired, already typechecked, and already fenced.
 *
 * THE FENCE, restated here because this is the file a future scenario opens
 * first: nothing in `tools/` may import a workspace package. Not `core`, not
 * `protocol`, not even for a type. The release lane has to work on the day
 * the daemon does not compile, because that is the day somebody is shipping
 * a fix. `node:*`, `yaml`, and relative paths are the whole permitted set.
 */

/** The workspace-relative root every release tool resolves paths against. */
export const RELEASE_TOOLS_PACKAGE = 'tools/release';
