#!/usr/bin/env bash
# Sign an assembled WeMessage.app, inside-out, with one self-signed identity.
#
#   sign.sh --app <WeMessage.app> --identity <leaf sha1>
#
# --identity is the 40-hex SHA-1 of the signing certificate, never its
# common name: the throwaway identity CI mints and the real one share a
# naming scheme, and two certificates with one name on a runner must never
# be ambiguous.
#
# THE ORDER IS THE CONTRACT. Nested code first, the bundle last, so that the
# seal on the app records the hashes of code that is already signed:
#
#   1. the better-sqlite3 addon   sh.wemessage.gateway.better-sqlite3
#   2. the bundled node           sh.wemessage.gateway.node, node.entitlements
#   3. the host executable        sh.wemessage.gateway, WeMessage.entitlements
#   4. the app                    sh.wemessage.gateway, WeMessage.entitlements
#
# Every one with --options runtime (the hardened runtime TCC expects) and
# --timestamp=none (no Apple timestamp server signs for a self-signed leaf,
# and leaving it out keeps the lane offline and the signature deterministic).
#
# Before anything is signed, every file under Contents/ is read for a Mach-O
# header, executable or not (the addon is a .node file without the exec
# bit). Any Mach-O other than the three above is refused: an addon nobody
# listed here would otherwise ship carrying only the linker's signature.
#
# Exit codes: 2 usage or not an assembled app; 3 the identity is not a valid
# code-signing identity in any keychain on the search list (missing, or its
# certificate not trusted for code signing); 4 codesign failed; 5 a Mach-O
# outside the signed set. Nothing here reads a secret or a keychain
# password: the caller imports the identity, this script only names it.
set -euo pipefail

usage() {
  printf 'sign.sh: %s\n' "$*" >&2
  exit 2
}

app=""
identity=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app)
      [ "$#" -ge 2 ] || usage "--app needs a path"
      app="$2"
      shift 2
      ;;
    --identity)
      [ "$#" -ge 2 ] || usage "--identity needs the certificate's SHA-1"
      identity="$2"
      shift 2
      ;;
    *) usage "unknown argument: $1" ;;
  esac
done

[ -n "$app" ] || usage "--app is required"
[ -n "$identity" ] || usage "--identity is required"
printf '%s\n' "$identity" | awk 'length($0) != 40 || $0 ~ /[^0-9A-Fa-f]/ {exit 1}' ||
  usage "--identity is the 40-hex SHA-1 of the signing certificate, never its name"
[ -d "$app" ] || usage "--app is not a directory: $app"
app="$(cd "$app" && pwd -P)"

here="$(cd "$(dirname "$0")" && pwd -P)"
res="$(cd "$here/../../apps/mac/Resources" && pwd -P)"

r="$app/Contents/Resources"
addon="$r/daemon/node_modules/better-sqlite3/prebuilds/darwin-arm64.node"
node="$r/daemon/node"
exe="$app/Contents/MacOS/WeMessage"
for f in "$addon" "$node" "$exe"; do
  [ -f "$f" ] || usage "not an assembled WeMessage.app, missing ${f#"$app/"}"
done

# --- the identity -------------------------------------------------------------
# `-v`: valid identities only. A self-signed certificate that is not trusted
# for code signing is listed without it and still refused by codesign, so it
# counts as missing here, with the reason said.
want="$(printf '%s' "$identity" | awk '{print toupper($0)}')"
security find-identity -v -p codesigning |
  awk -v want="$want" 'toupper($2) == want {found = 1} END {exit !found}' || {
  printf 'sign.sh: no valid code-signing identity %s in the keychain search list\n' "$identity" >&2
  printf 'sign.sh: import it, and trust its certificate for code signing, first\n' >&2
  exit 3
}

# --- the Mach-O sweep -----------------------------------------------------------
# Read by magic number, not by `file`: 64-bit and 32-bit, either byte order,
# and universal (fat) binaries.
is_macho() {
  case "$(od -An -tx1 -N4 "$1" 2>/dev/null | awk '{for (i = 1; i <= NF; i++) s = s $i} END {print s}')" in
    cffaedfe | cefaedfe | feedfacf | feedface | cafebabe | bebafeca) return 0 ;;
    *) return 1 ;;
  esac
}

strays=0
while IFS= read -r -d '' f; do
  case "$f" in
    "$addon" | "$node" | "$exe") continue ;;
  esac
  if is_macho "$f"; then
    printf 'sign.sh: unsigned Mach-O outside the signed set: %s\n' "${f#"$app/"}" >&2
    strays=$((strays + 1))
  fi
done < <(find "$app/Contents" -type f -print0)
if [ "$strays" -gt 0 ]; then
  printf 'sign.sh: add it to this script (and to verify-bundle.sh) or keep it out of the bundle\n' >&2
  exit 5
fi

# --- signing, inside-out ----------------------------------------------------------

sign() {
  local target="$1"
  shift
  codesign --force --options runtime --timestamp=none --sign "$identity" "$@" "$target" || {
    printf 'sign.sh: codesign failed on %s\n' "${target#"$app/"}" >&2
    exit 4
  }
}

sign "$addon" --identifier sh.wemessage.gateway.better-sqlite3
sign "$node" --identifier sh.wemessage.gateway.node --entitlements "$res/node.entitlements"
sign "$exe" --identifier sh.wemessage.gateway --entitlements "$res/WeMessage.entitlements"
sign "$app" --identifier sh.wemessage.gateway --entitlements "$res/WeMessage.entitlements"

printf 'sign.sh: signed addon, node, host and app with %s\n' "$identity"
