import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        'packages/*/src/index.ts',
        'packages/*/src/types.ts',
        'packages/*/src/main.ts',
        'packages/*/src/main.tsx',
      ],
      thresholds: {
        statements: 90,
        branches: 90,
        functions: 85,
        lines: 90,
      },
    },
  },
});
