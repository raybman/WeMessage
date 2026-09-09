import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';

/**
 * The renderer bundle.
 *
 * Two settings here are security decisions rather than build preferences:
 *
 *  - `modulePreload.polyfill: false`. The polyfill is injected as an INLINE
 *    `<script type="module">`, and `default-src 'self'` refuses inline
 *    script. With it on, the app boots to a blank window and an empty
 *    console. Turning the CSP off to accommodate a preload polyfill would be
 *    the tail wagging the dog; Chromium supports modulepreload natively.
 *  - `base: './'`. Assets are referenced relatively so the document resolves
 *    them against `app://-/`, which is what keeps every request inside the
 *    scheme main serves and the CSP's `'self'`.
 *
 * `emptyOutDir` is explicit because the output lands beside `tsc -b`'s, one
 * level up from this config's root, and Vite refuses to empty a directory
 * outside its root unless told to.
 */
/**
 * THE SHIPPED BYTES DO NOT DEPEND ON THE BUILDER'S SHELL.
 *
 * Vite decides `isProduction` from the AMBIENT `NODE_ENV`, falling back to
 * the mode only when the variable is unset, so `vite build` in a shell that
 * exported anything else is a development build wearing a production
 * command's name. `@preact/preset-vite` branches on exactly that flag and
 * swaps `@babel/plugin-transform-react-jsx` for its `-development` twin,
 * which annotates every element with `{fileName, lineNumber, columnNumber}`.
 * `fileName` is ABSOLUTE. The bundle then carries the build machine's home
 * directory, once per JSX site, into a file every user downloads.
 *
 * This is not hypothetical and it is not a test-only concern. It shipped:
 * `vitest` exports `NODE_ENV=test`, so `apps/desktop/test/pack.spec.ts`
 * built the app through a child process that inherited it, and s9 Sc 6
 * row 13's public-string sweep convicted the packed asar for
 * `absolute-user-path`. Measured, same source, same command:
 *
 *     NODE_ENV=test     237,271 bytes, 2 absolute paths under $HOME
 *     NODE_ENV unset    149,299 bytes, 0
 *
 * 88 KB of that difference is development scaffolding a user was going to
 * download and never run.
 *
 * The assignment is here rather than in the `bundle` script because the
 * script is not the only entry: `pnpm build`, `tools/release/bin/pack.mjs`
 * and a bare `vite build` in a maintainer's terminal all land on this file,
 * and only this file is common to all of them. It is written before
 * `defineConfig` because Vite reads the config module first and computes
 * `isProduction` afterwards, which is what makes the override effective at
 * all; that ordering was verified against vite 7.3.6 rather than assumed.
 */
process.env['NODE_ENV'] = 'production';

export default defineConfig({
  root: 'src/renderer',
  base: './',
  plugins: [preact()],
  build: {
    outDir: '../../dist/app/renderer',
    emptyOutDir: true,
    target: 'chrome134',
    sourcemap: true,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
