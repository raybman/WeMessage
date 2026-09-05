# @wemessage/adapter-luna

**NOT LIVE-VERIFIED.** The `luna` adapter passes the WeMessage adapter conformance kit and nothing beyond it: as of 2026-09-05 it has never exchanged a byte with the system it is named after, because live verification is pending a Luna vanguard install.

That paragraph is not written by hand. It is rendered from `LUNA_VERIFICATION`
in `src/verification.ts` by `verificationBanner()`, and a test asserts this
file contains the rendered string byte for byte. Editing this sentence to
claim more, or editing the value to claim more, fails the same row. The claim
is a value; this is only where it is printed.

Everything else here is true of the code in `src/`, which is real, tested, and
does what the rest of this file says. What has not happened is the last step:
running it against an actual Luna.

## What it is

A translator between the Gen-2 `ChannelAdapter` contract and the WeMessage
adapter wire.

```
gateway  --draft.request-->  host.receive(inbound)
gateway  <--draft.submit--   channel.deliver(completion)
```

Luna hands back a finished completion; a completion is a draft. A human
approves it; the daemon sends it. The adapter has no send path, and neither
does the protocol it speaks — there is no `send` frame to reach for.

```
src/contract.ts       the Gen-2 contract, transcribed by hand and cited
src/verification.ts   the verification tier as a value, and its checker
src/index.ts          the adapter: request queue, deliver -> submit, stop
test/luna.spec.ts     conformance, fail-soft, INV-2, and the honesty rows
```

## Using it

```ts
import { createLunaChannelAdapter } from '@wemessage/adapter-luna';

const channel = createLunaChannelAdapter({
  url: 'ws://127.0.0.1:8787/v1/agent',
  token: process.env.WEMESSAGE_ADAPTER_TOKEN,
  ws: yourSocketFactory,
  host: yourLunaHost,
});

await channel.start();
```

The token comes from the environment, never from an argument list and never
from a file in this repo. There is no default, and a committed one would be a
credential in a public repository.

Three behaviours are worth knowing before you wire it in:

- **A missing token disables the channel; it does not throw.** `start()`
  resolves, `state()` is `'disabled'`, and the socket factory is never called.
  This is the opposite of `@wemessage/adapter-sol`, which fails closed in its
  constructor, and the difference is deliberate: sol is a whole process, while
  a channel is one of several inside somebody else's boot sequence. Throwing
  there would take the other channels down with it.
- **`deliver()` answers; it cannot originate.** It fulfils an open
  `draft.request` for that chat. With no open request it rejects with
  `no-open-request` and writes nothing to the socket.
- **`start()` is idempotent.** Calling it twice dials once. The digest lists a
  double-start bug among the things not to trigger, so the connect loop is
  memoised rather than re-entered.

## What is transcribed, and what is a guess

There is no Luna source in this tree and no Luna reachable from this machine.
`src/contract.ts` was typed by hand from two second-hand documents, and
`LUNA_CONTRACT_CLAIMS` in that file records, per claim, which of the two it
came from — or that it came from neither. The list below is checked against
the `assumed` half of that array by a test in `test/luna.spec.ts`: an
assumption cannot be dropped from this file while staying in the code, and a
transcribed claim cannot be quietly demoted into it.

**These are assumptions. They are our invention, not Luna's documentation:**

- `stop()` exists on the channel lifecycle — settled by reading Luna's `packages/channels` on a vanguard install.
- `websocket` is a member of that transport enum — settled by reading the enum members.
- the object handed back carries a chat identifier and a text body — settled by reading one real channel's call site.
- the lifecycle methods are promise-returning rather than callbacks — settled by reading the interface.
- a channel with no credential reports the state word `disabled` — settled by reading the state vocabulary, if one is even exposed.
- Luna is entered through a single inbound method, called `receive` here — settled by reading the host side of any existing channel.

If any of these is wrong, the fix is local: the host seam is injected, so a
wrong guess costs one file in this package and reaches neither the gateway
core nor the wire.

## What would change the badge

Not an edit to this file. `LUNA_VERIFICATION` would have to become
`tier: 'live-verified'`, which the type system will not let anyone write
without also naming a spec that ran against a real Luna and the date it ran;
`liveVerificationOffenders()` then requires that spec to exist, to be a
`test/*.spec.ts` this project runs, and to be tracked by git. Until somebody
does that work, the honest badge is the one at the top.
