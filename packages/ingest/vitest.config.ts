import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'ingest',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
});
