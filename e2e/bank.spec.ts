// DB-1…DB-4, BANK-2, BANK-9…BANK-13, USER-2: the question bank, from the database, in the real build.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ADMIN, INTERVIEWER, ORGANISER, expect, seed, signIn, test } from './fixtures';

test('DB-1 BANK-2 BANK-8 RUB-1 RUB-6: everyone signed in browses the four bundled tracks from the database, filters and opens a question with its description, lists and rubric', async ({ page }) => {
  await signIn(page, INTERVIEWER, '/bank/aks');
  const tracks = page.getByRole('navigation', { name: 'Tracks' }).getByRole('link');
  await expect(tracks).toHaveCount(4);
  await expect(page.getByText(`Showing all ${seed('aks').questions.length} questions`)).toBeVisible();
  await page.getByLabel('Search text').fill('kubenet');
  await expect(page.getByText(/^Showing \d+ of \d+ questions/)).toBeVisible();
  const first = seed('aks').questions.find((q) => /kubenet/i.test(q.text))!;
  await page.getByRole('button', { name: first.text }).click();
  const dialog = page.getByRole('dialog');
  const full = JSON.parse(readFileSync('seed/aks.json', 'utf8')).questions.find((q: { id: string }) => q.id === first.id);
  await expect(dialog).toContainText(full.description);
  await expect(dialog).toContainText(full.lookFor[0].split(':')[0]);
  await expect(dialog).toContainText(full.redFlags[0].split(':')[0]);
  for (const level of ['Poor', 'Partial', 'Solid senior', 'Exceptional']) await expect(dialog).toContainText(level);
});

test('USER-2 DB-1: interviewers read the bank and cannot change it', async ({ page }) => {
  await signIn(page, INTERVIEWER, '/bank/qa');
  await expect(page.getByRole('table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Edit question/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'New track…' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Export CSV' })).toBeVisible();
  await page.getByRole('button', { name: seed('qa').questions[0].text }).click();
  await expect(page.getByRole('dialog').getByRole('button', { name: 'Edit' })).toHaveCount(0);
});

test('BANK-9 BANK-11 DB-1: an organiser edits a question; its version goes up and everyone sees the change', async ({ page, browser }) => {
  const q = seed('edge').questions[4];
  await signIn(page, ORGANISER, '/bank/edge');
  await page.getByRole('button', { name: `Edit question ${q.number}`, exact: true }).click();
  const editor = page.getByRole('dialog');
  const text = editor.getByRole('textbox', { name: /^Question/ });
  await text.fill(`${q.text} (reworded)`);
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(`Question ${q.number} saved; it is now version ${q.version + 1}.`)).toBeVisible();
  // Another person's open bank shows it without reloading (HOST-5).
  const other = await browser.newContext();
  const viewer = await other.newPage();
  await signIn(viewer, INTERVIEWER, '/bank/edge');
  await expect(viewer.getByRole('button', { name: `${q.text} (reworded)` })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: `${q.text} (reworded)` })).toBeVisible();
  await other.close();
});

test('BANK-13: many questions are added at once by pasting rows, after a preview', async ({ page }) => {
  await signIn(page, ORGANISER, '/bank/web');
  await page.getByRole('button', { name: 'Bulk add…' }).click();
  const rows = [
    'How do you cache a GraphQL API at the edge?\tWe want to hear about caching GraphQL responses.\tSystem design\tadvanced\tdesign\tPersisted queries;CDN keys\tCaches everything\tWhat about auth?\t',
    'How do you load-test a websocket service?\tAbout load testing websockets.\tTesting, CI/CD & observability\tcore\tknowledge\tTools;Metrics\tNo baseline\tWhich metrics?\t',
  ].join('\n');
  await page.getByRole('dialog').getByLabel('Rows from a spreadsheet or CSV').fill(rows);
  await page.getByRole('dialog').getByRole('button', { name: 'Preview' }).click();
  await expect(page.getByRole('dialog')).toContainText('How do you cache a GraphQL API at the edge?');
  await page.getByRole('dialog').getByRole('button', { name: /^Add 2 questions/ }).click();
  await expect(page.getByRole('button', { name: 'How do you load-test a websocket service?' })).toBeVisible();
});

test('DB-3 DB-2: an administrator uploads a track file, sees what would change, then imports it', async ({ page }) => {
  const file = JSON.parse(readFileSync('seed/aks.json', 'utf8'));
  const q = file.questions[7];
  q.probes = [...q.probes, 'What would you monitor first?'];
  const dir = mkdtempSync(join(tmpdir(), 'e2e-'));
  writeFileSync(join(dir, 'aks.json'), JSON.stringify(file));
  writeFileSync(join(dir, 'broken.json'), '{"track": {"id": "x"}}');
  await signIn(page, ADMIN, '/admin?tab=bank');
  await page.getByRole('tab', { name: 'Question files' }).click();
  const input = page.getByLabel('Track files or CSV files');
  await input.setInputFiles(join(dir, 'broken.json'));
  await expect(page.getByText('These files have problems. Nothing was imported.')).toBeVisible();
  await input.setInputFiles(join(dir, 'aks.json'));
  const report = page.getByRole('table', { name: 'What the import would do' });
  await expect(report.getByRole('row').nth(1)).toContainText('Senior Platform Engineer (AKS with Azure)');
  await expect(report).toContainText(`Question ${q.number}: version ${q.version} → ${q.version + 1}`);
  await page.getByRole('button', { name: 'Import', exact: true }).click();
  await expect(page.getByText(/Imported: 0 added, 1 changed/)).toBeVisible();
  await page.goto('/#/bank/aks');
  await page.getByRole('button', { name: q.text }).click();
  await expect(page.getByRole('dialog')).toContainText('What would you monitor first?');
});

test('DB-4 BANK-7: a track exports as a track file and as CSV', async ({ page }) => {
  await signIn(page, ORGANISER, '/bank/qa');
  const csv = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export CSV' }).click();
  expect((await csv).suggestedFilename()).toMatch(/^qa-questions-\d{4}-\d{2}-\d{2}\.csv$/);
  await page.getByRole('button', { name: 'Export track file…' }).click();
  const json = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: 'Export qa.json' }).click();
  const file = JSON.parse(readFileSync(await (await json).path(), 'utf8'));
  expect(file.track.id).toBe('qa');
  expect(file.questions.length).toBeGreaterThanOrEqual(50);
});
