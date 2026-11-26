// USER-1…USER-4: the Users page in the real build.
import { ADMIN, expect, signIn, test, uniqueEmail } from './fixtures';

test.describe.configure({ mode: 'serial' });

test('USER-1 USER-4 AUD-3: add many people with a preview, change a role, and see it all in the audit log', async ({ page }) => {
  const a = uniqueEmail('ana');
  const b = uniqueEmail('ben');
  await signIn(page, ADMIN, '/users');
  await expect(page.getByRole('heading', { name: 'Users' })).toBeVisible();
  await page.getByRole('button', { name: 'Add people' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add people' });
  await dialog.getByLabel('Email addresses').fill(`${a}, ${b}\n${ADMIN}\nnot-an-email\n${a}`);
  await expect(dialog.getByText('Will be added')).toBeVisible();
  await expect(dialog.getByText('Already have access')).toBeVisible();
  await expect(dialog.getByText('Listed twice')).toBeVisible();
  await expect(dialog.getByText('Not email addresses')).toBeVisible();
  await dialog.getByLabel('Role').selectOption('organiser');
  await dialog.getByRole('button', { name: 'Add 2 people' }).click();
  await expect(page.getByText(/Added 2 people as organiser/)).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: a });
  await expect(row).toContainText('Never');
  await expect(row.getByLabel(/Role for/)).toHaveValue('organiser');
  await row.getByLabel(/Role for/).selectOption('interviewer');
  await expect(page.getByText(/is now interviewer/)).toBeVisible();
  await page.goto('/#/admin');
  await page.getByLabel('Search').fill(a);
  await expect(page.getByRole('row').filter({ hasText: 'Person added' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'Person changed' })).toHaveCount(1);
  await expect(page.getByRole('row').filter({ hasText: 'Person changed' })).toContainText('Ada Admin <admin@example.test>');
});

test('USER-3 AUTH-4: deactivating someone signs them out at once; reactivating lets them back; never-signed-in people can be removed', async ({ page, browser }) => {
  const c = uniqueEmail('cal');
  const d = uniqueEmail('dot');
  await signIn(page, ADMIN, '/users');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.getByLabel('Email addresses').fill(`${c}\n${d}`);
  await page.getByRole('button', { name: 'Add 2 people' }).click();
  await expect(page.getByText(/Added 2 people/)).toBeVisible();
  // Cal signs in elsewhere and is using the app.
  const other = await browser.newContext();
  const cal = await other.newPage();
  await signIn(cal, c, '/bank');
  await expect(cal.getByRole('heading', { name: 'Question bank' })).toBeVisible();
  // The administrator deactivates Cal.
  const row = page.getByRole('row').filter({ hasText: c });
  await row.getByRole('button', { name: /More/ }).click();
  await page.getByRole('menuitem', { name: 'Deactivate…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
  await expect(row).toContainText('Deactivated');
  // Cal is signed out straight away: the open page notices without any action of theirs (live stream closed).
  await expect(cal.getByRole('heading', { name: 'Sign in' })).toBeVisible({ timeout: 15_000 });
  expect((await cal.request.get('/api/bank/tracks')).status()).toBe(401);
  await cal.getByLabel('Email', { exact: true }).fill(c);
  await cal.getByRole('button', { name: 'Sign in as this user' }).click();
  await expect(cal).toHaveURL(/no-access/);
  // Reactivate: Cal can sign in again.
  await row.getByRole('button', { name: /More/ }).click();
  await page.getByRole('menuitem', { name: 'Reactivate' }).click();
  await expect(row).not.toContainText('Deactivated');
  await signIn(cal, c);
  await other.close();
  // Dot never signed in: they can be removed; Cal has signed in, so cannot.
  await row.getByRole('button', { name: /More/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Remove…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const dotRow = page.getByRole('row').filter({ hasText: d });
  await dotRow.getByRole('button', { name: /More/ }).click();
  await page.getByRole('menuitem', { name: 'Remove…' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByRole('row').filter({ hasText: d })).toHaveCount(0);
});

test('USER-3: the last active administrator cannot demote or deactivate themself', async ({ page, guard }) => {
  guard.allowErrors(/status of 409/); // the refused change itself
  await signIn(page, ADMIN, '/users');
  const me = page.getByRole('row').filter({ hasText: '(you)' });
  await me.getByRole('button', { name: /More/ }).click();
  await expect(page.getByRole('menuitem', { name: 'Deactivate…' })).toHaveAttribute('aria-disabled', 'true');
  await page.keyboard.press('Escape');
  await me.getByLabel(/Role for/).selectOption('organiser');
  await page.getByRole('alertdialog').getByRole('button', { name: 'Change my role' }).click();
  await expect(page.getByText(/This is the last active administrator/)).toBeVisible();
  await expect(me.getByLabel(/Role for/)).toHaveValue('admin');
});
