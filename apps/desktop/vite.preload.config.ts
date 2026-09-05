import { defineConfig } from 'vite';

/**
 * The preload bundle, and the reason it is a second Vite invocation.
 *
 * `sandbox: true` is not negotiable, and a sandboxed preload is evaluated as
 * a plain CommonJS script: no ESM loader, no `require` of a relative sibling,
 * no bare specifiers. So the preload has to be bundled to ONE file, in CJS,
 * with `electron` left external because it is injected rather than resolved.
 * The package is `"type": "module"`, which is why the output is `.cjs`.
 *
 * It cannot ride along in the renderer build: that one is a document build
 * with a different root, a different format and a different target.
 */
export default defineConfig({
  build: {
    outDir: 'dist/app/preload',
    emptyOutDir: true,
    target: 'node22',
    minify: false,
    sourcemap: true,
    lib: {
      entry: 'src/preload/index.ts',
      formats: ['cjs'],
      fileName: () => 'index.cjs',
    },
    rollupOptions: { external: ['electron'] },
  },
});
