import { existsSync } from 'node:fs';
import { defineConfig, devices } from '@playwright/test';

// End-to-end checks against the production build served by the real server and PostgreSQL
// (docs/10-verification.md). `npm run e2e` builds the app, then scripts/e2e-server.mjs creates a
// fresh database (migrate + seed, as a deployment does), adds test users and starts the server with
// development sign-in (AUTH-6). Needs a PostgreSQL: `npm run db:start`, or TEST_DATABASE_URL.
// @playwright/test is pinned to the Playwright version whose Chromium is installed (locally
// preinstalled; in CI by `npx playwright install --with-deps chromium`). E2E_CHROMIUM_PATH can
// point at another Chromium binary if the pinned version cannot find one.

export const PORT = 4173;
const adminUrl = process.env.TEST_DATABASE_URL ?? 'postgres://ia@127.0.0.1:54329/ia_test';
const e2eDb = new URL(adminUrl);
e2eDb.pathname = '/ia_e2e';
/** For tests that run the command-line tasks against the same database. */
process.env.E2E_DATABASE_URL = e2eDb.href;
const executablePath = process.env.E2E_CHROMIUM_PATH && existsSync(process.env.E2E_CHROMIUM_PATH) ? process.env.E2E_CHROMIUM_PATH : undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}/`,
    trace: 'off',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    acceptDownloads: true,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && node scripts/e2e-server.mjs`,
    url: `http://localhost:${PORT}/healthz`,
    reuseExistingServer: false,
    timeout: 240_000,
    env: { PORT: String(PORT), TEST_DATABASE_URL: adminUrl },
  },
});
