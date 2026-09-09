# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private vulnerability reporting instead. On the repository page,
open the **Security** tab and choose **Report a vulnerability**. That opens a
private thread visible only to the maintainers, and it lets us publish an
advisory and a fix at the same time.

There is deliberately no security contact address in this file. A published
inbox is a promise that somebody is reading it, and this project would rather
route reports somewhere with a queue, a notification, and an audit trail than
publish an address nobody has committed to watching.

Expect a first response within a week. If a report is a real vulnerability we
will tell you what the fix is and when it ships, and you will be credited in
the advisory unless you ask not to be.

## What is in scope

- The daemon's loopback HTTP and WebSocket surfaces, including anything that
  lets a local process on the same machine act as an approved operator.
- The adapter protocol, in particular anything that lets an adapter cause an
  outbound message without a human approval.
- The approval gate itself: any path that reaches the send call site without an
  approved draft.
- The launch agent, the installer, and the packaged bundle: anything that lets
  code the user did not intend run with the app's permissions.
- Anything that writes message content, contact identifiers, or agent
  credentials somewhere the user did not ask for, including logs.

## What is out of scope

- **The builds are unsigned and not notarized, by design.** Gatekeeper will
  refuse the first launch and the user has to allow it explicitly. That is a
  known, documented property of this distribution, not a vulnerability. The
  mitigation offered instead is a published SHA256 checksum for every artifact.
- Anything that requires an attacker to already have local code execution as
  the user. If a process is already running as you, it can read the iMessage
  database directly and does not need this app.
- Findings from automated scanners with no demonstrated impact.
- Denial of service against a loopback listener bound to the local machine.

## Supported versions

The most recent release is supported. This project has one supported line, and
security fixes ship as a new release rather than as backports.
