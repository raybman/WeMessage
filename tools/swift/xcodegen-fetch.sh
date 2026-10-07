#!/bin/sh
# tools/swift/xcodegen-fetch.sh: download the pinned XcodeGen release, verify
# its sha256 against tools/swift/xcodegen.lock.json, unzip it under --out.
# CI only (ci-swift.yml `ui` job). Never installs anything outside --out and
# never touches PATH, Homebrew or the toolchain.
#   sh tools/swift/xcodegen-fetch.sh --out <dir>
# Exit 0 with <dir>/bin/xcodegen executable; 2 on a digest mismatch; 1 on any
# other failure.
set -eu

fail() {
  printf 'xcodegen-fetch.sh: %s\n' "$*" >&2
  exit 1
}

[ "$#" -eq 2 ] && [ "$1" = "--out" ] && [ -n "$2" ] || fail "usage: sh tools/swift/xcodegen-fetch.sh --out <dir>"
out="$2"

here="$(cd "$(dirname "$0")" && pwd -P)"
lock="$here/xcodegen.lock.json"
[ -f "$lock" ] || fail "missing $lock"

# One `"key": "value"` pair per line in the lock; awk reads it.
field() {
  value="$(awk -v k="$1" -F'"' '$2 == k { print $4; n++ } END { if (n != 1) exit 1 }' "$lock")" ||
    fail "xcodegen.lock.json has no single $1"
  [ -n "$value" ] || fail "xcodegen.lock.json $1 is empty"
  printf '%s\n' "$value"
}

version="$(field version)"
asset="$(field asset)"
sha="$(field sha256)"
source_url="$(field source)"

printf '%s\n' "$sha" | awk 'length($0) != 64 || $0 ~ /[^0-9a-f]/ { exit 1 }' ||
  fail "xcodegen.lock.json sha256 is not 64 lowercase hex"

# Idempotent: a tree this script already produced is reused as is.
if [ -x "$out/bin/xcodegen" ] &&
  "$out/bin/xcodegen" --version 2>/dev/null | awk -v v="$version" 'index($0, v) { found = 1 } END { exit found ? 0 : 1 }'; then
  exit 0
fi

mkdir -p "$out"
rm -rf "$out/xcodegen" "$out/bin" "$out/share"
curl -fsSL --retry 3 --proto '=https' -o "$out/$asset" "$source_url$asset" ||
  fail "download failed: $source_url$asset"

actual="$(shasum -a 256 "$out/$asset" | awk '{ print $1 }')"
if [ "$actual" != "$sha" ]; then
  rm -f "$out/$asset"
  printf 'xcodegen-fetch.sh: sha256 mismatch for %s: got %s, lock has another\n' "$asset" "$actual" >&2
  exit 2
fi

unzip -q -o "$out/$asset" -d "$out" || fail "unzip failed: $out/$asset"
[ -f "$out/xcodegen/bin/xcodegen" ] || fail "$asset has no xcodegen/bin/xcodegen"
# SettingPresets live in share/ and the binary finds them relative to itself.
[ -d "$out/xcodegen/share" ] || fail "$asset has no xcodegen/share"
mv "$out/xcodegen/bin" "$out/bin"
mv "$out/xcodegen/share" "$out/share"
rm -rf "$out/xcodegen" "$out/$asset"
chmod +x "$out/bin/xcodegen"
test -x "$out/bin/xcodegen" || fail "$out/bin/xcodegen is not executable"
