import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'fixtures',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    passWithNoTests: true,
  },
});
