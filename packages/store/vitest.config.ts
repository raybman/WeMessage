import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'store',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
});
