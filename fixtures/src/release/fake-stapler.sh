#!/bin/sh
# A scripted stand-in for `xcrun stapler` (s9 Sc 8).
#
# Stapling is the step that writes Apple's notarization ticket INTO the
# artefact, so a user's Mac can verify it without a network round trip. It is
# also the step whose failure is easiest to mishandle: `stapler staple` exits
# 65 when the ticket is not yet available on Apple's CDN, which happens
# routinely for a minute or two after `Accepted`, and the wrong reaction to a
# 65 is to go back and submit again. Sc 8 row 7 pins the right reaction.
#
# Writes to the SAME log as `fake-notarytool.sh`, in the same format, because
# the ordering between the two tools is the thing under test: rows 3, 4 and 5
# all assert that no `stapler` line appears at all, and that assertion is only
# meaningful if both tools are writing into one ordered file.
#
# CONTRACT
#   $FAKE_NOTARY_LOG   append-only argv log shared with fake-notarytool.sh
#   $FAKE_STAPLE_FAIL  when `1`, `staple` exits 65 and `validate` is never
#                      reached, which is the shape row 7 asserts

set -u

LOG="${FAKE_NOTARY_LOG:-/dev/null}"

now_ms() {
  perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time()*1000'
}

log_and_exit() {
  code="$1"
  shift
  line="$(now_ms)	$code"
  for a in "$@"; do
    line="$line$(printf '\037')$a"
  done
  printf '%s\n' "$line" >>"$LOG"
  exit "$code"
}

# A FAKE THAT ACCEPTS WHAT THE REAL TOOL REFUSES IS WORSE THAN NO FAKE.
#
# `stapler` cannot staple a zip. Not "should not": cannot. Measured on this
# machine, 2026-09-09:
#
#     $ xcrun stapler staple foo.zip
#     Processing: /private/tmp/stapletest/foo.zip
#     Stapler is incapable of working with ZIP archive files.
#     $ echo $?
#     66
#
# The first version of this fake exited 0 for any `staple`, and it blessed a
# `notarizeRelease` that stapled the zip. Thirty green rows, and the real
# release lane would have died AFTER a successful notarization, at the one
# point where the correct recovery is subtle and the tempting one is to
# resubmit. The refusal below is the whole reason that bug is now impossible
# to write without a red test.
# Takes the WHOLE argv, not just the path, so the line it logs is the call
# that was actually made. Logging `$2` alone put the artefact path where the
# verb belongs, and every assertion in the spec reads argv[0] as the verb.
refuse_zip() {
  case "${2:-}" in
    *.zip)
      echo "Processing: $2"
      echo "Stapler is incapable of working with ZIP archive files."
      log_and_exit 66 "$@"
      ;;
  esac
}

case "${1:-}" in
  staple)
    refuse_zip "$@"
    if [ "${FAKE_STAPLE_FAIL:-0}" = "1" ]; then
      # The real message, on the real STREAM. Both go to stdout because that
      # is where `stapler` puts them: it writes nothing at all to stderr, even
      # on failure, which was measured rather than assumed (see StapleFailed).
      # Kept verbatim because an operator reading a CI log should be able to
      # search it and find Apple's own documentation, and because row 7
      # asserts the runner surfaces the exit code rather than inventing a
      # friendlier one.
      echo "CloudKit query for WeMessage.app failed due to \"Record not found\"."
      echo "The staple and validate action failed! Error 65."
      log_and_exit 65 "$@"
    fi
    echo "The staple and validate action worked!"
    log_and_exit 0 "$@"
    ;;
  validate)
    refuse_zip "$@"
    echo "The validate action worked!"
    log_and_exit 0 "$@"
    ;;
  *)
    echo "fake-stapler: unknown verb: ${1:-<none>}" >&2
    log_and_exit 64 "$@"
    ;;
esac
