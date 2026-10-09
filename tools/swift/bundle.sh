#!/usr/bin/env bash
# Lay out WeMessage.app from parts that already exist, without Xcode.
#
#   bundle.sh --exe <WeMessage> --node <extracted node dir> \
#             --bundle <dist-bundle-node> --out <dir>
#
# --exe     the `swift build -c release` product (the host).
# --node    the directory node-fetch.sh extracted: bin/node and LICENSE.
# --bundle  apps/mac/dist-bundle-node, written by
#           `tools/release/bin/bundle-daemon.mjs --runtime node`
#           (bin/, daemon/, migrations/).
# --out     an empty or absent directory; the app is $out/WeMessage.app.
#
# Every path must be absolute. Copies only: nothing here runs anything it
# copies, and nothing is written outside --out. Directory copies use ditto,
# which keeps modes (the shims are 755, wemessage.mjs is not). The app is
# unsigned on exit; signing is tools/swift/sign.sh, and the layout check is
# tools/swift/verify-bundle.sh. Refusals exit 2.
set -euo pipefail

die() {
  printf 'bundle.sh: %s\n' "$*" >&2
  exit 2
}

exe=""
node=""
bundle=""
out=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --exe) exe="${2:-}"; shift 2 ;;
    --node) node="${2:-}"; shift 2 ;;
    --bundle) bundle="${2:-}"; shift 2 ;;
    --out) out="${2:-}"; shift 2 ;;
    *) die "unknown argument: $1" ;;
  esac
done

for pair in "--exe:$exe" "--node:$node" "--bundle:$bundle" "--out:$out"; do
  flag="${pair%%:*}"
  value="${pair#*:}"
  [ -n "$value" ] || die "$flag is required"
  case "$value" in
    /*) ;;
    *) die "$flag must be an absolute path: $value" ;;
  esac
done

here="$(cd "$(dirname "$0")" && pwd -P)"
repo="$(cd "$here/../.." && pwd -P)"
template="$repo/apps/mac/Resources/Info.plist"
icon="$repo/apps/mac/Resources/icon.icns"

[ -f "$exe" ] && [ -x "$exe" ] || die "--exe is not an executable file: $exe"
[ -f "$node/bin/node" ] || die "--node has no bin/node: $node"
[ -f "$node/LICENSE" ] || die "--node has no LICENSE: $node"
for part in bin daemon migrations; do
  [ -d "$bundle/$part" ] || die "--bundle has no $part/: $bundle"
done
[ -f "$bundle/daemon/ABI.json" ] || die "--bundle has no daemon/ABI.json"
runtime="$(plutil -extract runtime raw -o - "$bundle/daemon/ABI.json" 2>/dev/null)" ||
  die "--bundle daemon/ABI.json has no runtime"
[ "$runtime" = "node" ] || die "--bundle is the $runtime flavour; run bundle-daemon.mjs --runtime node"
[ -f "$template" ] || die "missing $template"
[ -f "$icon" ] || die "missing $icon"

version="$(plutil -extract version raw -o - "$repo/package.json" 2>/dev/null)" ||
  die "package.json has no version"

if [ -e "$out" ]; then
  [ -d "$out" ] || die "--out exists and is not a directory: $out"
  [ -z "$(ls -A "$out")" ] || die "--out is not empty: $out"
fi

app="$out/WeMessage.app"
mkdir -p "$out"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources/licenses"

cp "$template" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $version" "$app/Contents/Info.plist"
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $version" "$app/Contents/Info.plist"
printf 'APPL????' > "$app/Contents/PkgInfo"

cp "$exe" "$app/Contents/MacOS/WeMessage"
chmod 755 "$app/Contents/MacOS/WeMessage"

# Icon: apps/mac/Resources/icon.icns, a byte copy of the v1 desktop app's mark
# (v2 S6a), made so this script never read that app's tree. Rendering
# it from the brand source with iconutil is deferred to S7 polish.
cp "$icon" "$app/Contents/Resources/AppIcon.icns"

ditto "$bundle/bin" "$app/Contents/Resources/bin"
ditto "$bundle/daemon" "$app/Contents/Resources/daemon"
ditto "$bundle/migrations" "$app/Contents/Resources/migrations"
# esbuild marks any output that starts with a hashbang 755, so the CLI module
# arrives executable. Only the shims are entry points; the module is not.
chmod 644 "$app/Contents/Resources/bin/wemessage.mjs"

cp "$node/bin/node" "$app/Contents/Resources/daemon/node"
chmod 755 "$app/Contents/Resources/daemon/node"
cp "$node/LICENSE" "$app/Contents/Resources/licenses/LICENSE.node.txt"

printf '%s\n' "$app"
