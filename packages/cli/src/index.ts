// @wemessage/cli — Commander CLI (status / watch / auth, §3.8), implemented in
// bin.ts (Scenario 11). The library surface stays type-only: the CLI is a thin
// client (§2.5) and everything programmatic belongs to @wemessage/client.
export type { GatewayEventPayload, StatusPayload } from '@wemessage/client';
