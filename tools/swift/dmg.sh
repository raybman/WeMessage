#!/usr/bin/env bash
# Put a signed WeMessage.app in a disk image, and sign the image with the
# same identity.
#
#   dmg.sh --app <WeMessage.app> --out <file.dmg> --identity <leaf sha1>
#
# The window is plain on purpose (D-UI-181): the volume is named WeMessage
# and holds the app and an Applications symlink, nothing else. No background
# art, no icon layout, no Finder scripting: hdiutil only, so the image is
# built the same way on a headless runner as anywhere else.
#
#   1. stage       a temporary folder: WeMessage.app and Applications -> /Applications
#   2. hdiutil create -volname WeMessage -srcfolder <stage> -ov -format UDZO
#   3. hdiutil verify     the image's own checksums, before it is signed
#   4. codesign --force --timestamp=none --sign <leaf>   the image itself
#   5. codesign --verify --verbose=2, and the image's designated requirement
#      must name the same leaf
#
# --identity is the certificate's 40-hex SHA-1, never its name, for the same
# reason as in sign.sh. --timestamp=none: no Apple timestamp server signs for
# a self-signed leaf, and leaving it out keeps the lane offline.
#
# Exit codes: 2 usage or not an app; 3 the identity is not a valid
# code-signing identity in any keychain on the search list; 4 hdiutil or
# codesign failed to build or sign the image; 5 the signed image does not
# verify, or carries another leaf. Nothing here reads a secret or a keychain
# password: the caller imports the identity, this script only names it.
set -euo pipefail

usage() {
  printf 'dmg.sh: %s\n' "$*" >&2
  exit 2
}

app=""
out=""
identity=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --app)
      [ "$#" -ge 2 ] || usage "--app needs a path"
      app="$2"
      shift 2
      ;;
    --out)
      [ "$#" -ge 2 ] || usage "--out needs a path"
      out="$2"
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
[ -n "$out" ] || usage "--out is required"
[ -n "$identity" ] || usage "--identity is required"
printf '%s\n' "$identity" | awk 'length($0) != 40 || $0 ~ /[^0-9A-Fa-f]/ {exit 1}' ||
  usage "--identity is the 40-hex SHA-1 of the signing certificate, never its name"
case "$out" in
  *.dmg) ;;
  *) usage "--out must name a .dmg file: $out" ;;
esac
[ -d "$app/Contents" ] || usage "--app is not an app bundle: $app"
[ "$(basename "$app")" = "WeMessage.app" ] || usage "--app must be WeMessage.app: $app"
app="$(cd "$app" && pwd -P)"
mkdir -p "$(dirname "$out")"
out="$(cd "$(dirname "$out")" && pwd -P)/$(basename "$out")"

# --- the identity -------------------------------------------------------------
want="$(printf '%s' "$identity" | awk '{print toupper($0)}')"
security find-identity -v -p codesigning |
  awk -v want="$want" 'toupper($2) == want {found = 1} END {exit !found}' || {
  printf 'dmg.sh: no valid code-signing identity %s in the keychain search list\n' "$identity" >&2
  exit 3
}

# --- 1. stage -------------------------------------------------------------------
stage="$(mktemp -d)"
trap 'rm -rf "$stage"' EXIT
cp -R "$app" "$stage/WeMessage.app"
ln -s /Applications "$stage/Applications"

# --- 2, 3. the image ---------------------------------------------------------------
hdiutil create -volname WeMessage -srcfolder "$stage" -ov -format UDZO "$out" >&2 || {
  printf 'dmg.sh: hdiutil create failed\n' >&2
  exit 4
}
hdiutil verify "$out" >&2 || {
  printf 'dmg.sh: hdiutil verify failed on the unsigned image\n' >&2
  exit 4
}

# --- 4. sign the image -------------------------------------------------------------
codesign --force --timestamp=none --sign "$identity" "$out" || {
  printf 'dmg.sh: codesign failed on %s\n' "$out" >&2
  exit 4
}

# --- 5. verify it, and that it names this leaf ---------------------------------------
codesign --verify --verbose=2 "$out" || {
  printf 'dmg.sh: the signed image does not verify: %s\n' "$out" >&2
  exit 5
}
got="$(codesign -d -r- "$out" 2>&1 |
  awk 'match($0, /certificate (leaf|root) = H"[0-9A-Fa-f]+"/) {
         s = substr($0, RSTART, RLENGTH); sub(/.*H"/, "", s); sub(/"$/, "", s); print toupper(s); exit
       }')"
[ "$got" = "$want" ] || {
  printf 'dmg.sh: the image is signed by %s, expected %s\n' "${got:-nothing}" "$identity" >&2
  exit 5
}

printf 'dmg.sh: %s, signed and verified with %s\n' "$out" "$identity"
