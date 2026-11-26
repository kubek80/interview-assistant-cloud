// A11Y-1…A11Y-7 for the step-1 screens: axe in light and dark, and no sideways scrolling at 390px.
import AxeBuilder from '@axe-core/playwright';
import { ADMIN, INTERVIEWER, expect, signIn, test, type Page } from './fixtures';

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const SCREENS: Array<{ name: string; as?: string; path: string; ready: (p: Page) => Promise<unknown>; open?: (p: Page) => Promise<unknown> }> = [
  { name: 'sign-in', path: '/sign-in', ready: (p) => p.getByRole('heading', { name: 'Sign in' }).waitFor() },
  { name: 'no-access', path: '/no-access', ready: (p) => p.getByRole('heading', { level: 1 }).waitFor() },
  { name: 'users', as: ADMIN, path: '/users', ready: (p) => p.getByRole('table').waitFor() },
  {
    name: 'add people',
    as: ADMIN,
    path: '/users',
    ready: (p) => p.getByRole('table').waitFor(),
    open: async (p) => {
      await p.getByRole('button', { name: 'Add people' }).click();
      await p.getByLabel('Email addresses').fill('x1@example.test, admin@example.test, nope');
      await p.getByText('Will be added').waitFor();
    },
  },
  { name: 'bank (organiser view)', as: ADMIN, path: '/bank/qa', ready: (p) => p.getByRole('table').waitFor() },
  { name: 'bank (interviewer view)', as: INTERVIEWER, path: '/bank/web', ready: (p) => p.getByRole('table').waitFor() },
  { name: 'admin', as: ADMIN, path: '/admin', ready: (p) => p.getByRole('table').waitFor() },
  { name: 'home', as: ADMIN, path: '/', ready: (p) => p.getByRole('heading', { level: 1 }).waitFor() },
];

for (const scheme of ['light', 'dark'] as const) {
  test(`A11Y-7 A11Y-3 A11Y-6: no serious or critical axe violations on the sign-in, no-access, Users, bank and Admin screens (${scheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const problems: string[] = [];
    for (const s of SCREENS) {
      if (s.as) await signIn(page, s.as, s.path);
      else {
        await page.context().clearCookies();
        await page.goto(`/#${s.path}`);
      }
      await s.ready(page);
      await s.open?.(page);
      for (const v of await axe(page)) problems.push(`${s.name}: ${v}`);
      await page.context().clearCookies();
    }
    expect(problems).toEqual([]);
  });
}

test('A11Y-6 UX-9: at 390px wide nothing scrolls sideways on the step-1 screens', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 800 });
  const wide: string[] = [];
  for (const s of SCREENS) {
    if (s.as) await signIn(page, s.as, s.path);
    else {
      await page.context().clearCookies();
      await page.goto(`/#${s.path}`);
    }
    await s.ready(page);
    await s.open?.(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) wide.push(`${s.name}: ${overflow}px`);
    await page.context().clearCookies();
  }
  expect(wide).toEqual([]);
});

test('A11Y-1 A11Y-2: the sign-in screen and the Users page work with the keyboard; one h1 per screen', async ({ page }) => {
  await page.goto('/#/sign-in');
  await expect(page.locator('h1')).toHaveCount(1);
  await page.getByLabel('Email', { exact: true }).focus();
  await page.keyboard.type(ADMIN);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Welcome/);
  await page.goto('/#/users');
  await expect(page.locator('h1')).toHaveCount(1);
  await page.getByRole('button', { name: 'Add people' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Email addresses')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Add people' })).toBeFocused();
});
