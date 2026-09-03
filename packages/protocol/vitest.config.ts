import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'protocol',
    environment: 'node',
    globals: false,
    include: ['test/**/*.spec.ts'],
    // s5 Scenario 2: the wire spec carries compile witnesses (the frame union
    // has no send member) that esbuild alone would strip.
    typecheck: {
      enabled: true,
      include: ['test/**/*.spec.ts'],
      tsconfig: './tsconfig.vitest.json',
    },
  },
});
