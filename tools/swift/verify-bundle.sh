#!/usr/bin/env bash
# Check an assembled WeMessage.app before it is zipped (structure half).
#
#   verify-bundle.sh --app <WeMessage.app> [--expect-leaf <sha1>]
#
# What a user's Mac would trip over first, checked on the real tree:
#   - every path of the layout is present, with the right exec bits;
#   - daemon/ABI.json says runtime "node" at the version node.lock.json pins
#     (the number itself is read, never typed: plain Node and Electron
#     disagree on it, and both change with every major);
#   - Info.plist names sh.wemessage.gateway and WeMessage, at the
#     package.json version;
#   - nothing named dist-bundle* was carried along;
#   - no text file names this machine: the builder's home directory, the
#     directory above it, /opt/ or /usr/local. A bundle that only works where
#     it was built is the failure this check exists for.
#
# The identity half (codesign --verify, one leaf across the three Mach-Os,
# --expect-leaf) arrives with tools/swift/sign.sh in S2e; until then
# --expect-leaf is refused rather than silently ignored. Read-only: this
# script executes nothing inside the app. Any failure exits 2.
set -euo pipefail

die() {
  printf 'verify-bundle.sh: %s\n' "$*" >&2
  exit 2
}

app=""
expect_leaf=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --expect-leaf) expect_leaf="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[ -n "$app" ] || die "--app is required"
[ -z "$expect_leaf" ] || die "--expect-leaf is the identity half, which arrives with sign.sh in S2e"
[ -d "$app" ] || die "--app is not a directory: $app"
app="$(cd "$app" && pwd -P)"

case "${HOME:-}" in
  /?*) ;;
  *) die "HOME must be an absolute path other than /" ;;
esac

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
lock="$repo/tools/swift/node.lock.json"

failures=0
fail() {
  printf 'verify-bundle.sh: FAIL %s\n' "$*" >&2
  failures=$((failures + 1))
}

# --- the layout -------------------------------------------------------------

required=(
  Contents/Info.plist
  Contents/PkgInfo
  Contents/MacOS/WeMessage
  Contents/Resources/AppIcon.icns
  Contents/Resources/daemon/node
  Contents/Resources/daemon/main.mjs
  Contents/Resources/daemon/wemessaged.mjs
  Contents/Resources/daemon/ABI.json
  Contents/Resources/daemon/node_modules/better-sqlite3/package.json
  Contents/Resources/daemon/node_modules/better-sqlite3/lib/index.js
  Contents/Resources/daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node
  Contents/Resources/migrations/0001_init.sql
  Contents/Resources/bin/wemessage
  Contents/Resources/bin/wemessage.mjs
  Contents/Resources/bin/wemessaged
  Contents/Resources/licenses/LICENSE.node.txt
)
for rel in "${required[@]}"; do
  [ -f "$app/$rel" ] || fail "missing $rel"
done

for rel in Contents/MacOS/WeMessage Contents/Resources/daemon/node \
  Contents/Resources/bin/wemessage Contents/Resources/bin/wemessaged; do
  [ ! -f "$app/$rel" ] || [ -x "$app/$rel" ] || fail "$rel is not executable"
done
[ ! -x "$app/Contents/Resources/bin/wemessage.mjs" ] ||
  fail "Contents/Resources/bin/wemessage.mjs is executable; only the shims are"

if [ -f "$app/Contents/PkgInfo" ]; then
  [ "$(cat "$app/Contents/PkgInfo")" = "APPL????" ] || fail "PkgInfo is not APPL????"
fi

# --- ABI.json against the lock ---------------------------------------------

abi_json="$app/Contents/Resources/daemon/ABI.json"
if [ -f "$abi_json" ]; then
  pinned="$(plutil -extract version raw -o - "$lock" 2>/dev/null)" || die "node.lock.json has no version"
  runtime="$(plutil -extract runtime raw -o - "$abi_json" 2>/dev/null || true)"
  abi_version="$(plutil -extract version raw -o - "$abi_json" 2>/dev/null || true)"
  abi="$(plutil -extract abi raw -o - "$abi_json" 2>/dev/null || true)"
  [ "$runtime" = "node" ] || fail "ABI.json runtime is '$runtime', want node"
  [ "$abi_version" = "$pinned" ] || fail "ABI.json version is '$abi_version', node.lock.json pins $pinned"
  printf '%s\n' "$abi" | awk '!/^[1-9][0-9]*$/ {exit 1}' || fail "ABI.json abi is not a positive integer: '$abi'"
fi

# --- Info.plist ---------------------------------------------------------------

info="$app/Contents/Info.plist"
if [ -f "$info" ]; then
  key() { /usr/libexec/PlistBuddy -c "Print :$1" "$info" 2>/dev/null || true; }
  version="$(plutil -extract version raw -o - "$repo/package.json" 2>/dev/null)" || die "package.json has no version"
  [ "$(key CFBundleIdentifier)" = "sh.wemessage.gateway" ] || fail "CFBundleIdentifier is not sh.wemessage.gateway"
  [ "$(key CFBundleExecutable)" = "WeMessage" ] || fail "CFBundleExecutable is not WeMessage"
  [ "$(key CFBundleShortVersionString)" = "$version" ] || fail "CFBundleShortVersionString is not $version"
  [ "$(key CFBundleVersion)" = "$version" ] || fail "CFBundleVersion is not $version"
fi

# --- leftovers --------------------------------------------------------------

leftovers="$(find "$app" -name 'dist-bundle*' | awk 'NR <= 5')"
[ -z "$leftovers" ] || fail "dist-bundle leftovers inside the app: $leftovers"

# --- machine paths in text files ---------------------------------------------
# Mach-O and icon files are skipped: they are not text, and the two Mach-Os
# that matter are checked by their signatures in the identity half.

parent="$(dirname "$HOME")"
needles=("$HOME/" "/opt/" "/usr/local")
[ "$parent" = "/" ] || needles+=("$parent/")

hits="$(
  find "$app" -type f \
    ! -path "$app/Contents/MacOS/WeMessage" \
    ! -path "$app/Contents/Resources/daemon/node" \
    ! -name '*.node' ! -name '*.icns' \
    -exec awk -v list="$(IFS='|'; printf '%s' "${needles[*]}")" '
      BEGIN { n = split(list, needle, "|") }
      { for (i = 1; i <= n; i++) if (needle[i] != "" && index($0, needle[i])) print FILENAME ": " needle[i] }
    ' {} + | awk '!seen[$0]++'
)"
if [ -n "$hits" ]; then
  while IFS= read -r hit; do
    fail "machine path in ${hit#"$app/"}"
  done <<<"$hits"
fi

if [ "$failures" -gt 0 ]; then
  printf 'verify-bundle.sh: %s failure(s) in %s\n' "$failures" "$app" >&2
  exit 2
fi
printf 'verify-bundle.sh: structure ok: %s\n' "$app"
