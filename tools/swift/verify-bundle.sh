#!/usr/bin/env bash
# Check an assembled WeMessage.app before it is zipped.
#
#   verify-bundle.sh --app <WeMessage.app> [--expect-leaf <sha1>|any]
#
# What a user's Mac would trip over first, checked on the real tree:
#   - every path of the layout is present, with the right exec bits;
#   - daemon/ABI.json says runtime "node" at the version node.lock.json pins
#     (the number itself is read, never typed: plain Node and an embedding
#     disagree on it, and both change with every major);
#   - Info.plist names sh.wemessage.gateway and WeMessage, at the
#     package.json version;
#   - nothing named dist-bundle* was carried along;
#   - no text file names this machine: the builder's home directory, the
#     directory above it, /opt/ or /usr/local. A bundle that only works where
#     it was built is the failure this check exists for.
#
# THE IDENTITY HALF (v2 S5a), only with --expect-leaf, because only a signed
# app has an identity to check:
#   - codesign --verify --deep --strict accepts the app;
#   - the addon, node, the host and the app each carry a designated
#     requirement naming their own identifier (the ones tools/swift/sign.sh
#     signs with) and a certificate hash, and that hash is ONE leaf across
#     all four; --expect-leaf <sha1> also requires it to be that leaf
#     (compared case-blind), --expect-leaf any only that they agree;
#   - the entitlements each one carries equal apps/mac/Resources: node gets
#     node.entitlements, the host and the app WeMessage.entitlements;
#   - every one was signed with the hardened runtime flag;
#   - spctl's verdict is printed for the log and never fails the check: a
#     self-signed, unnotarized app is expected to be rejected by it, and the
#     line exists so the lane log shows the posture a user's Mac will see.
# Read-only: this script executes nothing inside the app (codesign and spctl
# read it). Any failure exits 2.
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
if [ -n "$expect_leaf" ] && [ "$expect_leaf" != "any" ]; then
  printf '%s\n' "$expect_leaf" | awk 'length($0) != 40 || $0 ~ /[^0-9A-Fa-f]/ {exit 1}' ||
    die "--expect-leaf is the 40-hex SHA-1 of the signing certificate, or any"
fi
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
  Contents/Resources/migrations/0002_thread_state.sql
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

# --- the identity half (only with --expect-leaf) ---------------------------------

if [ -n "$expect_leaf" ]; then
  res="$repo/apps/mac/Resources"
  r="$app/Contents/Resources"
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT

  if ! codesign --verify --deep --strict --verbose=2 "$app" >"$scratch/verify.txt" 2>&1; then
    cat "$scratch/verify.txt" >&2
    fail "codesign --verify --deep --strict rejects the app"
  fi

  # "<path> <identifier> <entitlements file or ->", the four signed objects.
  signed=(
    "$r/daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node|sh.wemessage.gateway.better-sqlite3|-"
    "$r/daemon/node|sh.wemessage.gateway.node|$res/node.entitlements"
    "$app/Contents/MacOS/WeMessage|sh.wemessage.gateway|$res/WeMessage.entitlements"
    "$app|sh.wemessage.gateway|$res/WeMessage.entitlements"
  )

  # The certificate hash out of `designated => identifier "<id>" and
  # certificate leaf|root = H"<hex>"`, lower case, or nothing when the line
  # names another identifier or has any other shape.
  leaf_of() {
    # `|| true`: an unsigned object makes codesign exit 1, and under pipefail
    # that would end the script here instead of failing the row.
    { codesign -d -r- "$1" 2>&1 || true; } | awk -v id="$2" '
      /^designated => / {
        want = "designated => identifier \"" id "\" and certificate "
        if (index($0, want) != 1) exit
        rest = substr($0, length(want) + 1)
        if (rest !~ /^(leaf|root) = H"[0-9A-Fa-f]+"$/) exit
        sub(/^(leaf|root) = H"/, "", rest)
        sub(/"$/, "", rest)
        if (length(rest) == 40) print tolower(rest)
        exit
      }'
  }

  # "key=value" per entitlement, sorted, from any plist codesign or the
  # Resources directory holds.
  ent_pairs() {
    # `|| true`: an empty file (an object signed without entitlements) is
    # not a plist, and under pipefail plutil refusing it would end the
    # script instead of failing the row.
    { plutil -convert xml1 -o - "$1" 2>/dev/null || true; } | awk '
      /<key>/ { k = $0; sub(/^.*<key>/, "", k); sub(/<\/key>.*$/, "", k); next }
      k != "" && /<(true|false)\/>/ { v = $0; sub(/^.*</, "", v); sub(/\/>.*$/, "", v); print k "=" v; k = "" }
    ' | sort
  }

  leaves=""
  for row in "${signed[@]}"; do
    IFS='|' read -r path id ents <<<"$row"
    rel="${path#"$app/"}"
    [ "$path" != "$app" ] || rel="WeMessage.app"
    if [ ! -e "$path" ]; then
      fail "missing signed object $rel"
      continue
    fi

    leaf="$(leaf_of "$path" "$id")"
    if [ -z "$leaf" ]; then
      fail "$rel has no designated requirement naming identifier $id and one certificate hash"
    else
      leaves="$leaves$leaf
"
    fi

    codesign -dvv "$path" 2>&1 | awk '/^CodeDirectory / && /flags=0x[0-9a-f]+\([^)]*runtime[^)]*\)/ {found = 1} END {exit !found}' ||
      fail "$rel is not signed with the hardened runtime (flags runtime)"

    if [ "$ents" != "-" ]; then
      codesign -d --entitlements - --xml "$path" >"$scratch/ents.plist" 2>/dev/null || : >"$scratch/ents.plist"
      want_ents="$(ent_pairs "$ents")"
      got_ents="$(ent_pairs "$scratch/ents.plist")"
      [ -n "$want_ents" ] || die "no entitlements read from $ents"
      [ "$got_ents" = "$want_ents" ] ||
        fail "$rel carries entitlements [$(printf '%s' "$got_ents" | tr '\n' ' ')], want [$(printf '%s' "$want_ents" | tr '\n' ' ')]"
    fi
  done

  distinct="$(printf '%s' "$leaves" | awk 'NF && !seen[$0]++' | awk 'END {print NR}')"
  if [ "$distinct" != "1" ]; then
    fail "the signed objects do not share one certificate leaf ($distinct distinct)"
  elif [ "$expect_leaf" != "any" ]; then
    got="$(printf '%s' "$leaves" | awk 'NF {print; exit}')"
    want="$(printf '%s' "$expect_leaf" | awk '{print tolower($0)}')"
    [ "$got" = "$want" ] || fail "signed with leaf $got, expected $want"
  fi

  printf 'verify-bundle.sh: spctl (recorded, never fatal): %s\n' \
    "$( (spctl -a -t exec -vv "$app" 2>&1 || true) | awk '{printf "%s%s", sep, $0; sep = " | "}')"
fi

if [ "$failures" -gt 0 ]; then
  printf 'verify-bundle.sh: %s failure(s) in %s\n' "$failures" "$app" >&2
  exit 2
fi
if [ -n "$expect_leaf" ]; then
  printf 'verify-bundle.sh: structure and identity ok: %s\n' "$app"
else
  printf 'verify-bundle.sh: structure ok: %s\n' "$app"
fi
