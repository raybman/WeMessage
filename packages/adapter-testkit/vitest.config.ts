import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'adapter-testkit',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
});
