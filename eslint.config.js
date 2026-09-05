import tseslint from 'typescript-eslint';

// Flat config (§1.7). Two independent tripwires for INV-1 alongside dependency-cruiser:
// consistent-type-imports (protocol type-only, §1.6) + no-restricted-imports(electron).
export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
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
    //
    // s8 Sc1 widens this to `apps/desktop/src`, including `.tsx`. Until S8
    // the app was two lines and the glob's omission cost nothing; the GUI
    // slice makes it the largest untyped-lint surface in the repo, and the
    // renderer is TSX (F-100), so an extension list that stopped at `.ts`
    // would have left the screens unlinted while looking complete.
    // `apps/desktop/tsconfig.json` includes `src/**/*.tsx` for exactly this
    // reason: `projectService` resolves the nearest tsconfig, and a file no
    // project claims is a lint error rather than a linted file.
    files: [
      'packages/**/src/**/*.ts',
      'apps/desktop/src/**/*.{ts,tsx}',
      'fixtures/src/**/*.ts',
    ],
    extends: [...tseslint.configs.recommendedTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        // Preact's automatic runtime (F-100). Set here as well as in the
        // tsconfigs so the parser and the compiler cannot disagree about
        // which `jsx` factory a `.tsx` file desugars to.
        jsxPragma: null,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'electron is only permitted in apps/desktop (INV-1, §2.7).',
            },
          ],
        },
      ],
    },
  },
  {
    // `electron` is banned everywhere else by the rule above; apps/desktop is
    // the one place it is the point. The boundary is still enforced, by
    // dependency-cruiser's `no-electron-outside-desktop` — the same fence
    // drawn once rather than a hole. `.tsx` joins `.ts` for the same reason
    // the type-aware block above did (s8 Sc1).
    files: ['apps/desktop/**/*.{ts,tsx}'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
