/**
 * The bridge, and the only thing that crosses it.
 *
 * `contextIsolation: true` plus `sandbox: true` means this script runs in a
 * world the document cannot see, with a curated subset of Electron and no
 * Node. Everything the renderer can do is what `exposeInMainWorld` hands it
 * here, so this file IS the app's attack surface, and it is deliberately a
 * loop over a constant rather than a list of methods:
 *
 *  - `window.wm` has exactly one function per REQUEST key in
 *    `ipc-channels.ts`, named the same. No `invoke`, no `send`, no
 *    `ipcRenderer`: a generic escape hatch would make the registry
 *    decorative, since any channel could then be reached by string.
 *  - `wm.on` accepts only a PUSH key and throws `unknown-channel` otherwise.
 *    A renderer cannot listen on a request channel and cannot listen on a
 *    name nobody wrote down.
 *
 * Both directions are asserted at run time in `shell.e2e.spec.ts` row 2:
 * the renderer's key set against `REQUEST_KEYS`, and `ipcMain`'s live
 * handler map against `REQUEST_CHANNELS`. The registry cannot drift from
 * either side without failing a row.
 *
 * Nothing here reads, receives, stores or forwards a credential. The
 * arch row over this directory forbids even the WORDS, so the absence is
 * reviewable without reading the code.
 */
import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, isPushKey, REQUEST_KEYS } from '../main/ipc-channels.js';

type Unsubscribe = () => void;

const bridge: Record<string, unknown> = {};

for (const key of REQUEST_KEYS) {
  const channel: string = CHANNELS[key];
  bridge[key] = (...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args);
}

bridge['on'] = (
  key: string,
  listener: (payload: unknown) => void,
): Unsubscribe => {
  if (!isPushKey(key)) throw new Error('unknown-channel');
  const channel: string = CHANNELS[key];
  const wrapped = (_event: unknown, payload: unknown): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, wrapped);
  return (): void => {
    ipcRenderer.removeListener(channel, wrapped);
  };
};

contextBridge.exposeInMainWorld('wm', bridge);

/**
 * A marker in the PRELOAD's world, never the document's.
 *
 * If this is ever visible from `window`, the two worlds are one whatever
 * the flags claim, and every other guarantee on this page is void. The e2e
 * reads it back as `undefined` from the renderer for exactly that reason.
 */
(globalThis as unknown as { __wmPreloadWorld?: boolean }).__wmPreloadWorld =
  true;
