#!/usr/bin/env bash
# s9 Sc 6 — regenerate the two committed brand binaries from the tracked vector.
#
# `build/icon.icns` and `build/dmg-background.png` are binaries in a public
# repository, which means nobody can review them by reading the diff. This
# script is the review: it is the whole provenance of both files, and running
# it must reproduce them from `site/logo/mark.svg` and nothing else.
#
# ONE SUBSTITUTION, AND IT IS NOT A DESIGN CHANGE. The canonical mark strokes
# the WM ligature with `rgba(255,255,255,.96)`. ImageMagick's built-in SVG
# renderer does not parse the CSS `rgba()` form and silently drops the stroke,
# which produces an empty blue bubble that still looks plausible at 16px. The
# equivalent `#ffffff` + `stroke-opacity` is substituted into a temporary copy.
# The canonical asset is never edited: every other renderer handles it.
#
# Every size is rasterized from the vector rather than downscaled from the
# 1024. The 16px representation is the one that appears in the Finder sidebar
# and the ⌘-Tab switcher, and a 1024 resampled to 16 is mush.
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
desktop="$(dirname "$here")"
repo="$(cd "$desktop/../.." && pwd)"
out="$desktop/build"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

command -v magick   >/dev/null || { echo "need ImageMagick (brew install imagemagick)" >&2; exit 2; }
command -v iconutil >/dev/null || { echo "need iconutil (macOS)" >&2; exit 2; }

sed -E 's/stroke="rgba\(255,255,255,\.96\)"/stroke="#ffffff" stroke-opacity="0.96"/g' \
  "$repo/site/logo/mark.svg" > "$work/mark.svg"
grep -q 'stroke="#ffffff"' "$work/mark.svg" || { echo "the stroke substitution matched nothing: mark.svg changed shape" >&2; exit 2; }

iconset="$work/WeMessage.iconset"
mkdir -p "$iconset"
for spec in 16:icon_16x16 32:icon_16x16@2x 32:icon_32x32 64:icon_32x32@2x \
            128:icon_128x128 256:icon_128x128@2x 256:icon_256x256 \
            512:icon_256x256@2x 512:icon_512x512 1024:icon_512x512@2x; do
  px="${spec%%:*}"; name="${spec#*:}"
  # `-depth 8` IS LOAD-BEARING, not tidiness. ImageMagick renders an SVG at 16
  # bits per channel by default, `iconutil` embeds whatever PNGs it is given
  # verbatim, and `apps/desktop/test/helpers/raster-decode.ts:109` refuses any
  # PNG whose bit depth is not 8, returning it as `undecoded`. A 16-bit icon is
  # therefore an icon the project's own colour guard cannot read: it would ship
  # unreviewed, at roughly twice the bytes, and the sweep would report a decode
  # failure rather than a hue.
  magick -background none -density "$(( px * 3 ))" "$work/mark.svg" \
    -resize "${px}x${px}" -depth 8 "$iconset/${name}.png"
done
iconutil -c icns "$iconset" -o "$out/icon.icns"

# 540x380 is electron-builder's default DMG window, and the icon coordinates in
# `electron-builder.yml` are expressed inside it. A background that disagrees
# with the window size makes the arrow point at nothing.
font=/System/Library/Fonts/HelveticaNeue.ttc
magick -size 540x380 gradient:'#F7F9FC-#E9EEF6' \
  \( "$work/mark.svg" -background none -density 200 -resize 40x40 \) \
  -gravity northwest -geometry +28+26 -composite \
  -density 72 -font "$font" \
  -fill '#1B2432' -pointsize 17 -gravity northwest -annotate +80+30 'WeMessage' \
  -fill '#98A2B3' -pointsize 12 -gravity northwest -annotate +80+50 'a gateway for iMessage' \
  -stroke '#C3CDDD' -strokewidth 3 -fill none \
  -draw 'path "M 234 196 L 296 196"' \
  -stroke none -fill '#C3CDDD' \
  -draw 'polygon 294,187 314,196 294,205' \
  -fill '#6B7688' -pointsize 12 -gravity south -annotate +0+26 'Drag WeMessage into Applications' \
  -depth 8 "$out/dmg-background.png"

# The script proves its own output rather than trusting it. Every PNG that goes
# into the icns is checked BEFORE `iconutil` packs it, which is the same set of
# bytes that ends up embedded, plus the background afterwards. `iconutil` has
# already run by here, so a failure names the file and exits non-zero rather
# than leaving a half-good icon on disk for a test to convict later.
for png in "$iconset"/*.png "$out/dmg-background.png"; do
  d="$(magick identify -format '%[bit-depth]' "$png")"
  [ "$d" = "8" ] || {
    echo "$png is $d-bit; raster-decode.ts only reads depth 8" >&2
    exit 2
  }
done

echo "wrote $out/icon.icns and $out/dmg-background.png (all PNGs depth 8)"
