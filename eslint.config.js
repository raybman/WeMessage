import tseslint from 'typescript-eslint';

// Flat config (§1.7). A tripwire for INV-1 alongside dependency-cruiser:
// consistent-type-imports (protocol type-only, §1.6).
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      // `dist-bundle/` is the daemon bundler's esbuild output, gitignored.
      // `**/dist/**` does not match it; the name is not `dist`.
      '**/dist-bundle/**',
      // The pack lane's output, gitignored. `dist-pack/` holds a packed
      // `.app` whose resources are a COPY of a daemon bundle, so leaving it
      // unignored lints generated files from inside a bundle and reports
      // esbuild's output as if a human had written it.
      '**/dist-pack/**',
      '**/dist-pack-next/**',
      '**/node_modules/**',
      '**/coverage/**',
      '**/*.tsbuildinfo',
      '.astro/**',
      'site/**',
      'docs/**',
      '.vercel/**',
    ],
  },
  ...tseslint.configs.recommended,
  {
    // Type-aware linting for every composite-tsconfig source tree.
    files: ['packages/**/src/**/*.ts', 'fixtures/src/**/*.ts'],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
    },
  },
);
