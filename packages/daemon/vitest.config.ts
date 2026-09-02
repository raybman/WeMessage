import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'daemon',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
  },
});
