#!/bin/sh
# tools/swift/swift.sh: pick the Swift toolchain for apps/mac, then exec it.
#
# v2 S1. `pnpm swift:test` runs `sh tools/swift/swift.sh test --package-path
# apps/mac`. The kit's tests use swift-testing, which the Command Line Tools
# swift does not ship, so a bare `swift` on PATH is the LAST resort, not the
# first. Resolution order:
#
#   1. $WEMESSAGE_SWIFT, if set (an explicit path to a swift binary);
#   2. the newest swift-6.*-RELEASE.xctoolchain under the per-user toolchain
#      directory ($HOME/Library/Developer/Toolchains), then the system one
#      (/Library/Developer/Toolchains);
#   3. `swift` on PATH (CI: the runner's Xcode toolchain).
#
# Never select a toolchain through the TOOLCHAINS environment variable: with
# the open-source toolchains that path fails before any test runs. Every
# selection here is a direct path to a binary.
set -eu

if [ -n "${WEMESSAGE_SWIFT:-}" ]; then
  exec "$WEMESSAGE_SWIFT" "$@"
fi

# Print "<toolchain>/usr/bin/swift" for the newest swift-6.x.y release under
# $1, or nothing. Versions compare numerically (6.10 sorts above 6.9).
newest() {
  for tc in "$1"/swift-6.*-RELEASE.xctoolchain; do
    [ -x "$tc/usr/bin/swift" ] || continue
    printf '%s\n' "$tc"
  done | awk '
    {
      name = $0
      sub(/^.*\//, "", name)
      v = name
      sub(/^swift-/, "", v)
      sub(/-RELEASE\.xctoolchain$/, "", v)
      n = split(v, p, ".")
      if (n < 2 || n > 3) next
      key = sprintf("%06d.%06d.%06d", p[1], p[2], (n == 3 ? p[3] : 0))
      if (best == "" || key > best) { best = key; pick = $0 }
    }
    END { if (pick != "") print pick "/usr/bin/swift" }
  '
}

for root in "${HOME:-}/Library/Developer/Toolchains" /Library/Developer/Toolchains; do
  [ -d "$root" ] || continue
  found=$(newest "$root")
  if [ -n "$found" ]; then
    printf 'swift.sh: using %s\n' "$found" >&2
    exec "$found" "$@"
  fi
done

exec swift "$@"
