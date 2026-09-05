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
