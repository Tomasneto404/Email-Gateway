import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against a running stack (docker compose up with compose.override.yml).
 *   MG_BASE_URL  default http://127.0.0.1:3000
 *   MG_CLI       command prefix to run the gateway CLI (default: docker compose exec -T api node dist/cli.js)
 */
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.MG_BASE_URL ?? 'http://127.0.0.1:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
