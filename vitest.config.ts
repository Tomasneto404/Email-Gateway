// Authored by Tomás Neto (TN 2026)
import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    fileParallelism: false,
    projects: [
      {
        plugins: [swc.vite({ module: { type: 'es6' } })],
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          testTimeout: 30_000,
          hookTimeout: 120_000,
        },
      },
      {
        plugins: [swc.vite({ module: { type: 'es6' } })],
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          globalSetup: ['test/helpers/global-setup.ts'],
          testTimeout: 60_000,
          hookTimeout: 180_000,
          pool: 'forks',
        },
      },
    ],
  },
});
