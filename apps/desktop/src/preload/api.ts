/**
 * The renderer's view of the bridge.
 *
 * Types only: this module contributes no code to either bundle. The shape is
 * DERIVED from the channel registry rather than written out, so a channel
 * added to `ipc-channels.ts` is immediately callable and a channel removed
 * from it stops typechecking at every call site.
 */
import type { PushKey, RequestKey } from '../main/ipc-channels.js';

/**
 * Arguments and results are `unknown` on purpose.
 *
 * The DTOs live in `@wemessage/client`, and the renderer narrows what it
 * receives at the point it renders it. Typing the bridge with them would
 * mean the renderer trusting main's shapes without checking — which is the
 * habit that turns one bad payload into a blank window.
 */
export type WmRequest = (...args: readonly unknown[]) => Promise<unknown>;

export type WmBridge = Readonly<Record<RequestKey, WmRequest>> & {
  on(key: PushKey, listener: (payload: unknown) => void): () => void;
};

declare global {
  interface Window {
    readonly wm: WmBridge;
  }
}
