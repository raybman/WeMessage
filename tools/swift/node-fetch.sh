#!/usr/bin/env bash
# Fetch the Node runtime WeMessage.app bundles, and prove it is the one pinned.
#
# Reads tools/swift/node.lock.json, downloads node-v<version>-darwin-arm64.tar.gz
# and SHASUMS256.txt from the lock's source, and refuses (exit 2) unless the
# tarball's sha256 equals BOTH the lock and the published SHASUMS256.txt line.
# Two checks, because they fail differently: the lock catches a release that
# was re-cut under the same version, SHASUMS256.txt catches a lock edited by
# hand to match a bad download.
#
# Writes only under apps/mac/.build/node (ignored), extracts to
# apps/mac/.build/node/<version>/, and prints the node binary's path on
# stdout. It never runs the binary it fetched.
set -euo pipefail

die() {
  printf 'node-fetch.sh: %s\n' "$*" >&2
  exit 2
}

[ "$#" -eq 0 ] || die "takes no arguments"

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
lock="$repo/tools/swift/node.lock.json"
cache="$repo/apps/mac/.build/node"

[ -f "$lock" ] || die "missing $lock"

field() {
  plutil -extract "$1" raw -o - "$lock" 2>/dev/null || die "node.lock.json has no $1"
}

version="$(field version)"
sha="$(field darwin-arm64.sha256)"
source_url="$(field source)"

printf '%s\n' "$version" | awk '!/^[0-9]+\.[0-9]+\.[0-9]+$/ {exit 1}' ||
  die "node.lock.json version is not N.N.N: $version"
printf '%s\n' "$sha" | awk 'length($0) != 64 || $0 ~ /[^0-9a-f]/ {exit 1}' ||
  die "node.lock.json darwin-arm64.sha256 is not 64 lowercase hex"
[ "$source_url" = "https://nodejs.org/dist/v$version/" ] ||
  die "node.lock.json source is not the nodejs.org dist directory for v$version"

tarball="node-v$version-darwin-arm64.tar.gz"
sums="node-v$version-SHASUMS256.txt"

mkdir -p "$cache"

fetch() {
  curl -fsSL --proto '=https' --retry 3 -o "$cache/$2.part" "$source_url$1" ||
    die "download failed: $source_url$1"
  mv -f "$cache/$2.part" "$cache/$2"
}

[ -f "$cache/$tarball" ] || fetch "$tarball" "$tarball"
fetch SHASUMS256.txt "$sums"

actual="$(shasum -a 256 "$cache/$tarball" | awk '{print $1}')"
published="$(awk -v f="$tarball" '$2 == f {print $1; n++} END {if (n != 1) exit 1}' "$cache/$sums")" ||
  die "SHASUMS256.txt does not list $tarball exactly once"

if [ "$actual" != "$sha" ] || [ "$published" != "$sha" ]; then
  rm -f "$cache/$tarball"
  die "sha256 mismatch for $tarball: got $actual, lock $sha, SHASUMS256.txt $published"
fi

# Always extract afresh, so a tree left half-written by an interrupted run is
# never the one that gets bundled.
rm -rf "$cache/$version"
stage="$(mktemp -d "$cache/.extract.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
tar -xzf "$cache/$tarball" -C "$stage"
[ -f "$stage/node-v$version-darwin-arm64/bin/node" ] || die "$tarball has no bin/node"
[ -f "$stage/node-v$version-darwin-arm64/LICENSE" ] || die "$tarball has no LICENSE"
mv "$stage/node-v$version-darwin-arm64" "$cache/$version"

printf '%s\n' "$cache/$version/bin/node"
