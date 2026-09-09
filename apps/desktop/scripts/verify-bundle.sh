#!/bin/bash
# s9 Sc 6 — verify-bundle.sh: what a signed WeMessage.app has to be true of.
#
#   verify-bundle.sh <app-path> <adhoc|release> [--json]
#
# Exits 0 when every assertion in F-124 holds, and non-zero naming the
# offending path when one does not. `--json` additionally prints a machine
# summary on stdout; without it the output is a human-readable checklist and
# stdout stays quiet on success except for the final line.
#
# WHY THIS IS A SHELL SCRIPT AND NOT A TEST. Everything it asks is a question
# only `codesign`, `dyld_info` and `plutil` can answer, and it has to be runnable
# by a human holding a `.dmg` they downloaded, on a machine with no checkout,
# no pnpm and no node. A release lane whose only verifier is a test file is a
# release lane nobody can check after the fact.
#
# THE LANE ARGUMENT IS NOT A FORMALITY. The ad-hoc lane MUST carry
# `com.apple.security.cs.disable-library-validation` (an ad-hoc signature has
# no Team ID, so library validation would refuse to load `better-sqlite3`) and
# the release lane MUST NOT (it is the property that stops a dropped dylib
# from being loaded into a process holding Full Disk Access). One entitlement,
# required in one lane and forbidden in the other, is exactly the kind of
# difference that a script silently gets wrong forever, so it is the first
# thing checked and Sc 6 row 7 proves the failure by running the release lane
# against the ad-hoc bundle.
set -o errexit
set -o nounset
set -o pipefail

APP="${1:-}"
LANE="${2:-}"
JSON=0
[ "${3:-}" = "--json" ] && JSON=1

if [ -z "$APP" ] || [ -z "$LANE" ]; then
  echo "usage: verify-bundle.sh <app-path> <adhoc|release> [--json]" >&2
  exit 2
fi
if [ "$LANE" != "adhoc" ] && [ "$LANE" != "release" ]; then
  echo "verify-bundle: unknown lane '$LANE' (want adhoc or release)" >&2
  exit 2
fi
if [ ! -d "$APP" ]; then
  echo "verify-bundle: no such app bundle: $APP" >&2
  exit 2
fi

# EVERY failure, not the first one.
#
# The first draft exited on the first bad assertion, and Sc 6 row 7 caught the
# problem immediately: running the RELEASE lane against an ad-hoc bundle
# reported "no TeamIdentifier" and stopped, so the entitlement check that the
# row exists to prove was never reached. A verifier that stops at the first
# problem also makes a human run it once per defect, which on a signing
# problem is the difference between one pass and six. `fail` records; `die`
# is for the preconditions that make the rest meaningless.
FAILURES=""
fail() { FAILURES="${FAILURES}verify-bundle: $*"$'\n'; }
die() { echo "verify-bundle: $*" >&2; exit 2; }

# ── every Mach-O under the bundle, found by magic and not by extension ──
# `.node`, `.dylib`, the framework binaries and the four helpers have four
# different naming conventions between them, and the next Electron will bring
# a fifth. `file` reads the header, which is the only thing that cannot drift.
MACH_O=$(find "$APP" -type f -exec file --mime-type {} + \
  | grep -E ':[[:space:]]*application/x-mach-binary$' \
  | sed -e 's/:[[:space:]]*application\/x-mach-binary$//' \
  | sort)

[ -n "$MACH_O" ] || die "found no Mach-O files at all under $APP (did the pack run?)"

COUNT=0
TEAMS=""
JSON_ROWS=""
while IFS= read -r bin; do
  [ -n "$bin" ] || continue
  COUNT=$((COUNT + 1))

  # (1) signed at all. If this fails nothing below it can be asked, so the
  # file is recorded as unsigned and the loop moves on rather than aborting.
  if ! INFO=$(codesign -dvvv "$bin" 2>&1); then
    fail "not signed: $bin"
    JSON_ROWS="${JSON_ROWS}{\"path\":\"${bin#"$APP"/}\",\"signed\":false,\"runtime\":false,\"team\":\"not set\"},"
    continue
  fi

  # (2) the hardened runtime flag is actually set on THIS file, not just on
  # the app that contains it. Helpers inherit entitlements, not flags.
  RUNTIME=true
  echo "$INFO" | grep -qE '^CodeDirectory .*flags=0x[0-9a-f]*\(.*runtime.*\)' || {
    fail "hardened runtime not set on: $bin"
    RUNTIME=false
  }

  # (3) team identity. In the release lane every file must carry the same
  # one; in the ad-hoc lane every file must carry NONE, and asserting the
  # degraded shape is what keeps the row from being a no-op in that lane.
  TEAM=$(echo "$INFO" | sed -n 's/^TeamIdentifier=//p' | head -1)
  [ -n "$TEAM" ] || TEAM="not set"
  TEAMS="${TEAMS}${TEAM}"$'\n'

  # (6) nothing links against a path that exists only on the build machine.
  # Homebrew, /usr/local and any home directory are all absent from a user's
  # Mac, and a bundle that needs one of them fails at dlopen with a message
  # about a library, not about the build.
  #
  # `dyld_info` AND NOT `otool -L`, and the reason is not a preference.
  # `otool` still honours the `archive(member.o)` notation from the days when
  # it read static libraries, so it splits ANY argument containing a `(` at
  # the parenthesis and tries to open the part before it. Electron ships four
  # helper apps named `WeMessage Helper (GPU)`, `(Renderer)`, `(Plugin)` and
  # the plain one, so `otool -L` on this bundle reported
  #
  #     can't open file: .../MacOS/WeMessage Helper  (No such file or directory)
  #
  # for four of the thirteen Mach-O files here. The previous version of this
  # check sent that error to /dev/null, which turned it into an empty pipeline,
  # which `grep -q` reports as "no match", which this `if` reads as "clean".
  # The four binaries most likely to carry a stray link were the four this
  # check could not see, and it said "ok" about them for as long as it existed.
  #
  # So: a tool that can open the path, and a failure when it cannot. The shape
  # of a successful read is the `-linked_dylibs:` header, and its absence is
  # now an error rather than a pass. `dyld_info` exits 0 even on a file it
  # could not read, so the exit status is not usable and is not used.
  #
  # The first line of the output is `<path> [arch]:`, which contains the
  # bundle's own absolute path and would match every pattern below, so lines
  # ending in `]:` are dropped before the scan. `-rpaths` are scanned too,
  # which `otool -L` never showed: an rpath into a home directory is the same
  # bug one indirection later.
  DEPS=$(dyld_info -dependents "$bin" 2>&1)
  printf '%s\n' "$DEPS" | grep -q -- '-linked_dylibs:' \
    || fail "cannot read load commands ($(printf '%s' "$DEPS" | head -1)): $bin"
  if printf '%s\n' "$DEPS" | grep -v ']:$' \
    | grep -qE '(^|[[:space:]])(/opt/homebrew|/usr/local|/Users/)'; then
    fail "links against a build-machine path: $bin"
  fi

  JSON_ROWS="${JSON_ROWS}{\"path\":\"${bin#"$APP"/}\",\"signed\":true,\"runtime\":${RUNTIME},\"team\":\"${TEAM}\"},"
done <<< "$MACH_O"

# (3) continued: one distinct value, whichever lane.
DISTINCT=$(printf '%s' "$TEAMS" | sort -u | grep -c '^' || true)
[ "$DISTINCT" = "1" ] || fail "mixed TeamIdentifier values across the bundle: $(printf '%s' "$TEAMS" | sort -u | tr '\n' ' ')"
TEAM_ID=$(printf '%s' "$TEAMS" | sort -u | head -1)
if [ "$LANE" = "release" ] && [ "$TEAM_ID" = "not set" ]; then
  fail "release lane but the bundle is ad-hoc signed (no TeamIdentifier)"
fi
if [ "$LANE" = "release" ] && [ -n "${APPLE_TEAM_ID:-}" ] && [ "$TEAM_ID" != "$APPLE_TEAM_ID" ]; then
  fail "TeamIdentifier $TEAM_ID is not APPLE_TEAM_ID $APPLE_TEAM_ID"
fi

# (4) the whole bundle, strictly, including nested code.
codesign --verify --strict --deep --verbose=2 "$APP" 2>/dev/null \
  || fail "codesign --verify --strict --deep failed on $APP"

# (5) the entitlement that differs by lane, and the one that never does.
EXE="$APP/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP/Contents/Info.plist")"
ENTS=$(codesign -d --entitlements :- --xml "$EXE" 2>/dev/null | plutil -convert json -o - - || echo '{}')
echo "$ENTS" | grep -q 'com.apple.security.automation.apple-events' \
  || fail "main executable does not declare automation.apple-events"
if [ "$LANE" = "release" ]; then
  if echo "$ENTS" | grep -q 'disable-library-validation'; then
    fail "disable-library-validation present in release lane"
  fi
else
  echo "$ENTS" | grep -q 'disable-library-validation' \
    || fail "ad-hoc lane needs disable-library-validation or better-sqlite3 will not load"
fi

# (7) the Info.plist facts a user-visible install depends on.
plist() { /usr/libexec/PlistBuddy -c "Print $1" "$APP/Contents/Info.plist" 2>/dev/null || true; }
[ "$(plist ':CFBundleIdentifier')" = "sh.wemessage.gateway" ] \
  || fail "CFBundleIdentifier is '$(plist ':CFBundleIdentifier')', want sh.wemessage.gateway"
[ "$(plist ':LSMinimumSystemVersion')" = "15.0" ] \
  || fail "LSMinimumSystemVersion is '$(plist ':LSMinimumSystemVersion')', want 15.0"
[ -n "$(plist ':NSAppleEventsUsageDescription')" ] \
  || fail "NSAppleEventsUsageDescription is missing"
[ "$(plist ':CFBundleURLTypes:0:CFBundleURLSchemes:0')" = "wemessage" ] \
  || fail "CFBundleURLSchemes[0] is not 'wemessage'"

if [ "$JSON" = "1" ]; then
  printf '{"app":"%s","lane":"%s","team":"%s","files":[%s]}\n' \
    "$APP" "$LANE" "$TEAM_ID" "${JSON_ROWS%,}"
fi

if [ -n "$FAILURES" ]; then
  printf '%s' "$FAILURES" >&2
  echo "verify-bundle: FAILED — $(printf '%s' "$FAILURES" | grep -c '^') problem(s), lane=$LANE" >&2
  exit 1
fi

[ "$JSON" = "1" ] || echo "verify-bundle: ok — $COUNT Mach-O files, lane=$LANE, team=$TEAM_ID"
