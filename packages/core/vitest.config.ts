import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
});
