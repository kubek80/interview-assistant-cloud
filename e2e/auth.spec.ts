// AUTH-1, AUTH-2, AUTH-4, AUTH-6: signing in and out of the real build.
import { ADMIN, INTERVIEWER, ORGANISER, expect, signIn, test } from './fixtures';

const navLinks = async (page: import('@playwright/test').Page) =>
  (await page.getByRole('navigation', { name: 'Main' }).getByRole('link').allTextContents()).map((s) => s.replace(/\s*\d+\s*(proposals waiting|to do)$/, '').trim());

test('AUTH-6 USER-2 HOST-8: development sign-in as administrator, organiser and interviewer shows each the screens of their role', async ({ page, context }) => {
  await signIn(page, ADMIN);
  expect(await navLinks(page)).toEqual(['Dashboard', 'Rounds', 'Question bank', 'Reviews', 'Users', 'Admin', 'Docs']);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Dashboard');
  await expect(page.getByText('Welcome, Ada.')).toBeVisible();
  await context.clearCookies();
  await signIn(page, ORGANISER);
  expect(await navLinks(page)).toEqual(['Dashboard', 'Rounds', 'Question bank', 'Reviews', 'Docs']);
  await context.clearCookies();
  await signIn(page, INTERVIEWER);
  expect(await navLinks(page)).toEqual(['Dashboard', 'Rounds', 'Question bank', 'Docs']);
  // A screen for administrators only says so, and the server refuses its data anyway.
  await page.goto('/#/users');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not available');
  expect((await page.request.get('/api/users')).status()).toBe(403);
});

test('AUTH-2: an account that is not on the Users list sees the no-access page, which shows nothing of the app', async ({ page, guard }) => {
  guard.allowErrors(/status of 403/); // the refused sign-in request itself
  await page.goto('/#/sign-in');
  await page.getByLabel('Email', { exact: true }).fill('stranger@example.test');
  await page.getByRole('button', { name: 'Sign in as this user' }).click();
  await expect(page).toHaveURL(/#\/no-access$/);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('You don’t have access');
  const text = await page.locator('body').innerText();
  expect(text).not.toMatch(/Question bank|example\.test|Senior|Users/);
  expect((await page.request.get('/api/me')).status()).toBe(401);
  expect((await page.request.get('/api/bank/tracks')).status()).toBe(401);
});

test('AUTH-1 AUTH-4: a signed-out visitor is asked to sign in, returns to the page they asked for, and signing out ends the session', async ({ page }) => {
  await page.goto('/#/bank/web');
  await expect(page).toHaveURL(/#\/sign-in\?returnTo=%2Fbank%2Fweb$/);
  await page.getByLabel('Email', { exact: true }).fill(ORGANISER);
  await page.getByRole('button', { name: 'Sign in as this user' }).click();
  await expect(page).toHaveURL(/#\/bank\/web$/);
  await expect(page.getByRole('heading', { name: 'Senior Software Engineer (Web Applications)' })).toBeVisible();
  const cookies = await page.context().cookies();
  const session = cookies.find((c) => c.name === 'ia_session')!;
  expect(session.httpOnly).toBe(true);
  expect(session.sameSite).toBe('Lax');
  expect(await page.evaluate(() => document.cookie)).toBe(''); // AUTH-4: no token readable by scripts
  await page.getByRole('button', { name: /account/ }).click();
  await page.getByRole('menuitem', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
  await page.goto('/#/bank');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});
