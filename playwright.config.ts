import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, devices } from '@playwright/test';

// End-to-end checks against the production build (docs/10-verification.md).
// `npm run e2e` builds the app and serves dist/ with the real local helper (server/, `npm run helper`),
// as `npm start` does, so the AI second opinion runs end to end. The helper runs a deterministic
// fake of the Claude Code CLI (server/test/fake-claude.mjs): no network and no real model call.
//   4173  the app; the fake answers with a valid result (FAKE_CLAUDE_MODE=ok)
//   4174  the same build; the fake returns output that does not fit (FAKE_CLAUDE_MODE=invalid)
//   4175  the same build; the fake answers slowly, for progress and cancel (FAKE_CLAUDE_MODE=slow)
// The browser keeps data per origin, so a test on 4174/4175 starts from an empty device.

const PORT = 4173;
export const INVALID_PORT = 4174;
export const SLOW_PORT = 4175;
const FAKE_CLAUDE = fileURLToPath(new URL('./server/test/fake-claude.mjs', import.meta.url));
const helper = (port: number, mode: string, extra = '') => `PORT=${port} CLAUDE_BIN=${FAKE_CLAUDE} FAKE_CLAUDE_MODE=${mode} ${extra}AI_MODEL= node server/index.mjs`;
// @playwright/test is pinned to the Playwright version whose Chromium is installed (locally
// preinstalled; in CI by `npx playwright install --with-deps chromium`). E2E_CHROMIUM_PATH can
// point at another Chromium binary if the pinned version cannot find one.
const executablePath = process.env.E2E_CHROMIUM_PATH && existsSync(process.env.E2E_CHROMIUM_PATH) ? process.env.E2E_CHROMIUM_PATH : undefined;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: process.env.CI ? 2 : 4,
  timeout: 90_000,
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
  webServer: [
    {
      command: `npm run build && ${helper(PORT, 'ok')}`,
      url: `http://localhost:${PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      // Starts at once and answers 503 until the build above has written dist/.
      command: helper(INVALID_PORT, 'invalid'),
      url: `http://localhost:${INVALID_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
    {
      command: helper(SLOW_PORT, 'slow', 'FAKE_CLAUDE_DELAY_MS=60000 '),
      url: `http://localhost:${SLOW_PORT}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
    },
  ],
});
