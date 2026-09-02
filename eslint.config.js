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
    // Type-aware linting only for package source (composite tsconfigs cover these).
    files: ['packages/**/src/**/*.ts', 'fixtures/*.ts'],
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
    files: ['apps/desktop/**/*.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
);
