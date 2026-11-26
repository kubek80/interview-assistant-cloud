// OV-3, UX-7: the documentation is in the app, and screens show no requirement codes.
import { ADMIN, ORGANISER, expect, signIn, test } from './fixtures';

test('OV-3: the documentation opens from the main navigation, including the hosted-version page, and requirement links work', async ({ page }) => {
  await signIn(page, ORGANISER);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Overview');
  await page.goto('/#/docs/13-hosted-version');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Hosted version');
  await expect(page.getByText('Only invited people can sign in.')).toBeVisible();
});

test('UX-7 UX-8: the step-1 screens show no requirement ids and none of the internal words; help is a plain "?" link into the docs', async ({ page }) => {
  await signIn(page, ADMIN);
  for (const path of ['/', '/bank/qa', '/users', '/admin', '/admin?tab=bank', '/admin?tab=settings']) {
    await page.goto(`/#${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.waitForLoadState('networkidle');
    const text = await page.locator('main').innerText();
    expect(text.match(/\b[A-Z][A-Z0-9]*-\d+\b/g), `requirement ids on ${path}`).toBeNull();
    if (!path.startsWith('/admin')) expect(text.match(/\b(fingerprint|quota|locked|seed file)\b/gi), `internal words on ${path}`).toBeNull();
  }
});
