// Shared fixtures for the end-to-end suite. Every helper drives the real UI of the production build
// served by the real server; the only shortcut is development sign-in (AUTH-6) instead of Google.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';

export { expect };
export type { Page } from '@playwright/test';

export interface SeedFile {
  track: { id: string; name: string; version: string };
  categories: Array<{ id: string; name: string; weight: number; mustHave: boolean }>;
  questions: Array<{ id: string; number: number; text: string; version: number; categoryId: string }>;
}

/** Reads a seed file straight from the repository (expected values only, never to drive the app). */
export function seed(trackId: 'qa' | 'web' | 'edge' | 'aks'): SeedFile {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../seed/${trackId}.json`, import.meta.url)), 'utf8')) as SeedFile;
}

export interface Guard {
  console: string[];
  foreignRequests: string[];
  errors: string[];
  allowErrors: (re: RegExp) => void;
  watch: (context: BrowserContext) => void;
}

/**
 * Automatic for every test: it fails if the app logs a console error, throws, or requests another
 * origin (SEC-1: the app talks only to its own server).
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const allowed: RegExp[] = [];
      const g: Guard = { console: [], foreignRequests: [], errors: [], allowErrors: (re) => allowed.push(re), watch: (ctx) => watchContext(ctx) };
      const watchPage = (page: Page) => {
        page.on('console', (m) => {
          g.console.push(m.text());
          if (m.type() === 'error') g.errors.push(`console: ${m.text()}`);
        });
        page.on('pageerror', (e) => g.errors.push(`pageerror: ${e.message}`));
      };
      const watchContext = (ctx: BrowserContext) => {
        ctx.on('page', watchPage);
        ctx.pages().forEach(watchPage);
        ctx.on('request', (r) => {
          const u = r.url();
          if (/^(data|blob|about):/.test(u)) return;
          if (new URL(u).origin !== origin) g.foreignRequests.push(u);
        });
      };
      watchContext(context);
      await use(g);
      // A 401/403 that the app handles is logged by Chromium as a failed resource load; expected ones are allowed per test.
      const errors = g.errors.filter((e) => !allowed.some((re) => re.test(e)) && !/Failed to load resource: the server responded with a status of 401/.test(e));
      expect(errors, 'console errors').toEqual([]);
      expect(g.foreignRequests, 'requests to other origins').toEqual([]);
    },
    { auto: true },
  ],
});

/** AUTH-6: signs in through the development sign-in form, as a developer would. */
export async function signIn(page: Page, email: string, path = '/'): Promise<void> {
  await page.goto(`/#/sign-in?returnTo=${encodeURIComponent(path)}`);
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Sign in as this user' }).click();
  await expect(page.getByRole('button', { name: /account/ })).toBeVisible();
}

export const ADMIN = 'admin@example.test';
export const ORGANISER = 'organiser@example.test';
export const INTERVIEWER = 'interviewer@example.test';

/** A unique address for one test run, so parallel tests never collide. */
export const uniqueEmail = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}@example.test`;
