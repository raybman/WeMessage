#!/bin/sh
# A scripted stand-in for `xcrun notarytool` (s9 Sc 8).
#
# WHY THIS EXISTS. Notarization is a network round trip to Apple that takes
# minutes, needs a paid certificate this project does not have (F-136), and
# has exactly one interesting failure mode we must never ship: submitting the
# same artefact twice. A duplicate submission is a duplicate ticket in Apple's
# review queue, and no assertion written against the real service can catch it
# without creating one. So the state machine is proved here, against a script
# that records every argv it was handed, and row 11 re-runs the same spec
# against the real tool when a credential exists.
#
# WHY POSIX sh AND NOT bash. `test/release/notarize.spec.ts` runs on Linux CI
# as well as macOS, and this file is on the far side of a `spawn`, so it gets
# whatever `/bin/sh` is. No arrays, no `local`, no `[[`, no `$'...'`.
#
# WHAT IT NEVER DOES. It never opens the file named by `--key`. Sc 8 row 9
# plants a sentinel inside that file and greps everything this script wrote;
# a fake that echoed its own stdin, or that cat'd the key to prove it was
# readable, would put a private key into a log and the row would convict it.
#
# CONTRACT
#   $FAKE_NOTARY_SCENARIO  accepted | in-progress-then-accepted | invalid |
#                          rejected | hang | submit-fails
#   $FAKE_NOTARY_LOG       append-only argv log, one line per invocation:
#                            <epoch_ms> <TAB> <exit> <TAB> <argv joined by US>
#                          US is 0x1f, which cannot occur in a path or a flag,
#                          so the reader splits argv EXACTLY rather than by
#                          guessing at spaces. Sc 8 asserts full argv vectors,
#                          not substrings, because "did it pass --key-id" and
#                          "does the argv contain the text --key-id somewhere"
#                          are different questions and only the first one is
#                          the contract.
#   $FAKE_NOTARY_STATE     directory for the poll counter. Defaults beside the
#                          log, so a caller that sets only the log still works.
#
# The timestamp is milliseconds via perl. `date +%s` is seconds, and Sc 8
# row 2 asserts the poll back-off is NON-DECREASING inside a 2000 ms deadline:
# at second resolution every interval reads as zero and the assertion passes
# without having looked at anything. perl ships with macOS and with
# ubuntu-24.04, which is the whole platform set this runs on.

set -u

LOG="${FAKE_NOTARY_LOG:-/dev/null}"
SCENARIO="${FAKE_NOTARY_SCENARIO:-accepted}"
STATE="${FAKE_NOTARY_STATE:-$(dirname "$LOG")}"
COUNTER="$STATE/poll-count"

now_ms() {
  perl -MTime::HiRes -e 'printf "%d", Time::HiRes::time()*1000'
}

# Append this invocation's argv and exit code, then exit with it. Called on
# every path out of the script, including the failures, because "which calls
# did NOT happen" is half of what Sc 8 asserts (rows 3, 5 and 7 all turn on a
# call being absent) and an unlogged invocation is indistinguishable from one
# that never occurred.
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

SUB_ID="7f3b1c28-0000-4a11-9c5e-2b6ad0e41f90"

case "${1:-}" in
  submit)
    if [ "$SCENARIO" = "submit-fails" ]; then
      # The shape a wrong or expired App Store Connect key produces. The
      # runner must surface this text rather than a generic non-zero exit,
      # because "HTTP status code: 401" is the only thing that tells an
      # operator the credential is the problem and not the artefact.
      echo "Error: HTTP status code: 401. Unable to authenticate." >&2
      log_and_exit 1 "$@"
    fi
    rm -f "$COUNTER"
    if [ "$SCENARIO" = "accepted" ]; then
      printf '{"id":"%s","status":"Accepted","message":"Successfully uploaded file"}\n' "$SUB_ID"
    else
      printf '{"id":"%s","status":"In Progress","message":"Successfully uploaded file"}\n' "$SUB_ID"
    fi
    log_and_exit 0 "$@"
    ;;
  info)
    # The counter file is the only state this fake keeps. `info` is the one
    # verb called more than once, and a scenario like
    # `in-progress-then-accepted` is defined by WHICH call it is.
    n=0
    if [ -f "$COUNTER" ]; then n="$(cat "$COUNTER")"; fi
    n=$((n + 1))
    printf '%s' "$n" >"$COUNTER"
    case "$SCENARIO" in
      accepted) status="Accepted" ;;
      in-progress-then-accepted)
        if [ "$n" -le 3 ]; then status="In Progress"; else status="Accepted"; fi
        ;;
      hang) status="In Progress" ;;
      invalid) status="Invalid" ;;
      rejected) status="Rejected" ;;
      *) status="Accepted" ;;
    esac
    printf '{"id":"%s","status":"%s","createdDate":"2026-09-09T00:00:00.000Z","name":"placeholder.zip"}\n' \
      "$SUB_ID" "$status"
    log_and_exit 0 "$@"
    ;;
  log)
    # Real `notarytool log <id>` prints the JSON body to stdout when no
    # destination file is given, and the runner is the thing that decides
    # where it lands. Keeping that division here is what lets row 11 point
    # the same runner at the real tool without a second code path.
    cat "$(dirname "$0")/notary-log.invalid.json"
    log_and_exit 0 "$@"
    ;;
  *)
    echo "fake-notarytool: unknown verb: ${1:-<none>}" >&2
    log_and_exit 64 "$@"
    ;;
esac
