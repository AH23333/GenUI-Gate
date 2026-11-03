import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 85,
        lines: 90,
      },
    },
  },
});
