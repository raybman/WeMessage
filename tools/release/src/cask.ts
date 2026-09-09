/**
 * s9 Sc10: the Homebrew cask renderer.
 *
 * `renderCask` turns {version, sha256, repo} into the full Ruby body of a
 * Homebrew cask for WeMessage. It is a PURE function: no filesystem access,
 * no network, no child process. That separation is deliberate and mirrors
 * `tools/release/src/notarize.ts`'s pure state machine (see that file's own
 * doc comment for the fuller argument): everything impure, reading a DMG's
 * bytes, hashing them, writing `homebrew/Casks/wemessage.rb` and
 * `homebrew/cask.lock.json` to disk, lives in `tools/release/bin/cask.mjs`
 * instead. A renderer that cannot touch disk cannot have a bug that only
 * reproduces on a real machine's filesystem; every input this function can
 * see is right there in its argument, which is what makes `test/release/
 * cask.spec.ts` able to call it directly, in-process, dozens of times with
 * different fixtures, with no temp directory in sight except for the one
 * on-disk drift check (row 5) that reads the COMMITTED files by design.
 *
 * WHY A STRING TEMPLATE, NOT A RUBY AST BUILDER: a cask is fifteen stanzas
 * of largely fixed shape (see CASK_STANZA_ORDER below), not a language
 * needing general code generation. A template keeps the indentation
 * contract that `test/release/cask.spec.ts` depends on (two spaces for
 * every top-level stanza, four-plus for anything nested) visible and
 * literal in one place, instead of implicit in whatever an AST printer
 * decides to do with whitespace.
 *
 * THE FENCE (s9 Sc1, tools-import-runtime-nothing): this file imports
 * nothing but the language itself. No workspace package, not even a type
 * import, the same restriction `notarize.ts` operates under and explains
 * in its own header. There is nothing here that needs one: three regexes
 * and a string template.
 *
 * FACTS this renderer bakes in, none of them inputs, because none of them
 * change release to release the way {version, sha256, repo} do:
 *   - the cask token is "wemessage" (lowercase; must equal the basename of
 *     `homebrew/Casks/wemessage.rb` for `brew style`'s token/filename cop)
 *   - the app bundle is "WeMessage.app", exposing two on-PATH binaries:
 *     the "wemessaged" gateway daemon and the "wemessage" control CLI
 *   - the daemon runs as a launchd agent labelled "sh.wemessage.gateway",
 *     installed at ~/Library/LaunchAgents/sh.wemessage.gateway.plist
 *   - "wemessage service install" is the operator's on-ramp to that agent
 *     (referenced in `caveats`; the caveats block is the only place a
 *     first-time installer reliably reads before anything else runs)
 */

export interface RenderCaskInput {
  readonly version: string;
  readonly sha256: string;
  /** "owner/name", e.g. "raybman/WeMessage". Not read from the lock file:
   * see `test/release/cask.spec.ts` row 5's comment on why. */
  readonly repo: string;
}

// The canonical Homebrew stanza order this renderer emits, and the order
// `test/release/cask.spec.ts` row 1 checks the rendered output against by
// an INDEPENDENT transcription (not by reading this constant back), so a
// bug that changes the template without updating this constant, or vice
// versa, is still caught. `depends_on` and `binary` each appear twice, by
// design (macos + arch; the daemon + the CLI), which is why this is a list
// of stanza NAMES with repeats, not a Set.
export const CASK_STANZA_ORDER = [
  'version',
  'sha256',
  'url',
  'name',
  'desc',
  'homepage',
  'livecheck',
  'depends_on',
  'depends_on',
  'app',
  'binary',
  'binary',
  'uninstall',
  'zap',
  'caveats',
] as const;

export type CaskStanzaName = (typeof CASK_STANZA_ORDER)[number];

export class CaskVersionInvalid extends Error {
  override readonly name = 'CaskVersionInvalid';
  constructor(readonly given: string) {
    super(
      `version must be a valid semver (see semver.org), e.g. "1.0.0" or ` +
        `"1.0.0-rc.1"; got ${JSON.stringify(given)}`,
    );
  }
}

export class CaskSha256Invalid extends Error {
  override readonly name = 'CaskSha256Invalid';
  constructor(readonly given: string) {
    super(
      `sha256 must be exactly 64 lowercase hex characters; got ${JSON.stringify(given)}`,
    );
  }
}

export class CaskRepoInvalid extends Error {
  override readonly name = 'CaskRepoInvalid';
  constructor(readonly given: string) {
    super(
      `repo must be exactly "owner/name" (one slash, no spaces); got ${JSON.stringify(given)}`,
    );
  }
}

// The canonical semver.org regex, unmodified:
// https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
// Verified against this suite's own fixtures to accept "1.0.0-rc.1" and
// reject both "1.0" (not three components) and "v1.0.0" (no leading "v"
// in semver proper; GitHub's tag has one, this field does not, see the
// `url` stanza below for where the "v" actually gets added back).
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

const SHA256_RE = /^[0-9a-f]{64}$/;

// owner/name: GitHub owner segments are alphanumerics and single internal
// hyphens (no leading/trailing hyphen); repo names allow alphanumerics,
// dots, underscores and hyphens. One slash, never zero, never two.
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/;

export function renderCask(input: RenderCaskInput): string {
  if (!SEMVER_RE.test(input.version)) {
    throw new CaskVersionInvalid(input.version);
  }
  if (!SHA256_RE.test(input.sha256)) {
    throw new CaskSha256Invalid(input.sha256);
  }
  if (!REPO_RE.test(input.repo)) {
    throw new CaskRepoInvalid(input.repo);
  }

  const { version, sha256, repo } = input;

  // Every top-level stanza below sits at exactly two leading spaces;
  // everything nested (the `url :url`/`strategy :github_latest` lines
  // inside `livecheck`, the `uninstall` continuation lines, the `zap`
  // array body, the caveats heredoc) sits at four or more. That contract
  // is what `test/release/cask.spec.ts` row 1's line regex depends on, and
  // it is why the lines below are left-aligned to their OUTPUT column
  // rather than to this function's own source indentation: a template
  // literal reproduces exactly the whitespace between its backticks, and
  // the whitespace that matters here is the Ruby file's, not this file's.
  //
  // `#{version}` in the `url` stanza is a LITERAL Ruby interpolation
  // placeholder, not this function's `version` argument substituted in:
  // a template literal only interpolates `${...}`, never `#{...}`, so it
  // passes straight through untouched. That is the whole point of row 2:
  // a point release is a one-line diff to the `version` stanza, and every
  // other stanza that needs the version re-reads it through Ruby's own
  // interpolation at cask-eval time instead of this renderer baking a
  // value in that would go stale the moment `version` next changes.
  return `cask "wemessage" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/${repo}/releases/download/v#{version}/WeMessage-#{version}-arm64-UNSIGNED.dmg"
  name "WeMessage"
  desc "Local gateway service that bridges iMessage to WeMessage clients"
  homepage "https://github.com/${repo}"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :sequoia
  depends_on arch: :arm64

  app "WeMessage.app"
  binary "#{appdir}/WeMessage.app/Contents/MacOS/wemessaged", target: "wemessaged"
  binary "#{appdir}/WeMessage.app/Contents/MacOS/wemessage", target: "wemessage"

  uninstall launchctl: "sh.wemessage.gateway",
            quit:      "sh.wemessage.gateway",
            delete:    "~/Library/LaunchAgents/sh.wemessage.gateway.plist"

  zap trash: [
    "~/Library/Application Support/WeMessage",
    "~/Library/Logs/WeMessage",
    "~/Library/Preferences/sh.wemessage.gateway.plist",
    "~/Library/Saved Application State/sh.wemessage.gateway.savedState",
  ]

  caveats do
    <<~EOS
      WeMessage needs Full Disk Access and Automation permission for Messages
      to read and send messages. Grant both in System Settings > Privacy &
      Security before starting the service.

      Start the gateway service with:
        wemessage service install
    EOS
  end
end
`;
}
