#!/usr/bin/env bash
# Gather the G2 evidence lines a CI log printed into a Markdown report.
#
#   g2-report.sh --title <text> <log>...
#
# v2 S7a. The Kit's G2PerfTests and the ui lane's Board00PerfTests print one
# line per measure (WeMessageKit/Perf/G2Limits.swift is the writer):
#
#   G2|<metric>|<value>|<unit>|<limit or ->|<hard or soft>
#
# A line counts only when `G2|` starts it (after blanks), so a compiler
# echoing the source that prints one is never read as a measure. Every line
# found becomes one table row on stdout, in log order:
#
#   hard, value <= limit   ok
#   hard, value  > limit   OVER
#   hard, value  -         UNMEASURED (a hard row nobody measured is red)
#   soft                   reported (never red; `-` means not measurable here)
#
# Exit codes: 0 every hard row within its limit; 1 a hard row OVER or
# UNMEASURED; 2 usage, or a log that cannot be read; 3 no G2 line in any
# log; 4 a G2 line that is not six well-formed fields (the line is named on
# stderr, and no report is written: a half-read log is not evidence). On 0
# and 1 the whole report is written first, so a red run still shows its
# numbers. Awk only, no network, nothing written but stdout.
set -euo pipefail

usage() {
  echo "usage: g2-report.sh --title <text> <log>..." >&2
  exit 2
}

title=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --title)
      [ "$#" -ge 2 ] || usage
      title="$2"
      shift 2
      ;;
    --)
      shift
      break
      ;;
    -*) usage ;;
    *) break ;;
  esac
done
[ -n "$title" ] || usage
[ "$#" -gt 0 ] || usage
for log in "$@"; do
  [ -f "$log" ] && [ -r "$log" ] || {
    echo "g2-report: cannot read $log" >&2
    exit 2
  }
done

set +e
awk -v title="$title" '
  function num(s) { return s ~ /^[0-9]+(\.[0-9]+)?$/ }
  /^[ \t]*G2\|/ {
    line = $0
    sub(/^[ \t]+/, "", line)
    sub(/\r$/, "", line)
    n = split(line, f, "|")
    ok = n == 6 && f[2] ~ /^[a-z][a-z0-9-]*$/ && (f[3] == "-" || num(f[3])) \
      && f[4] ~ /^[A-Za-z]+$/ && (f[6] == "hard" || f[6] == "soft") \
      && (f[5] == "-" || num(f[5])) && !(f[6] == "hard" && f[5] == "-")
    if (!ok) { bad = line; exit }
    rows++
    if (f[6] == "soft") {
      verdict = "reported"
    } else {
      hard++
      if (f[3] == "-") { verdict = "UNMEASURED"; red++ }
      else if (f[3] + 0 > f[5] + 0) { verdict = "OVER"; red++ }
      else verdict = "ok"
    }
    out[rows] = "| " f[2] " | " f[3] " | " f[4] " | " f[5] " | " f[6] " | " verdict " |"
  }
  END {
    if (bad != "") { print "g2-report: malformed line: " bad > "/dev/stderr"; exit 4 }
    if (rows == 0) { print "g2-report: no G2 line in the log" > "/dev/stderr"; exit 3 }
    print "# G2 report: " title
    print ""
    print "| metric | value | unit | limit | kind | verdict |"
    print "|---|---|---|---|---|---|"
    for (i = 1; i <= rows; i++) print out[i]
    print ""
    printf "%d rows, %d hard, %d red.\n", rows, hard, red
    exit (red > 0 ? 1 : 0)
  }
' "$@"
code=$?
set -e
exit "$code"
