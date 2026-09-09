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
