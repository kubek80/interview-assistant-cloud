import {
  TRACK_NAMES,
  bankRow,
  browserToday,
  continueToReady,
  editQuestions,
  editorTab,
  expect,
  expectQuestion,
  focusQuestion,
  modal,
  newInterviewForm,
  openApp,
  openMoreOptions,
  openNewInterview,
  seed,
  selectedRows,
  setSummary,
  startInterview,
  test,
  type Page,
} from './fixtures';

/** YYYY-MM-DD `days` after `today`. */
function plusDays(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** The required fields of the New interview screen that are still empty. */
async function requiredToFill(page: Page): Promise<string[]> {
  return newInterviewForm(page)
    .locator('input[required]')
    .evaluateAll((els) =>
      (els as HTMLInputElement[]).filter((e) => !e.value).map((e) => document.querySelector(`label[for="${e.id}"]`)?.textContent?.replace('*', '').trim() ?? e.id),
    );
}

/** UX-1: the Continue button is inside the 1280 × 800 viewport without scrolling. */
async function continueAboveTheFold(page: Page): Promise<void> {
  await page.evaluate(() => window.scrollTo(0, 0));
  const box = (await page.getByRole('button', { name: /^Continue/ }).boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(800);
}

test.describe('New interview and the ready screen', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('FLOW-33 UX-1 UX-2 AUD-1 FLOW-7 FLOW-10 PRIV-4 A11Y-2: from a fresh browser to a running interview: name and initials, Continue, consent on the ready screen, Start', async ({ page }) => {
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run your first structured interview' })).toBeVisible();
    await page.getByTestId('new-interview').click();
    await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
    // UX-2: a balanced set is already drawn; it is summarised with its mix in words.
    await expect(setSummary(page)).toContainText(/^14 questions · about \d+ min/);
    await expect(page.locator('.ni-set__mix')).toHaveText('9 knowledge questions, 2 scenarios, 1 design exercise and 2 behavioural questions');
    // UX-1: everything needed is above the fold; the first time, the name is asked inline.
    await continueAboveTheFold(page);
    expect(await requiredToFill(page)).toEqual(['Your name', 'Candidate']);
    await expect(page.getByLabel('Role')).toHaveValue(/.+/);
    // Consent is not asked for here (FLOW-7): it is confirmed on the ready screen.
    await expect(page.getByText('Notes and ratings from this interview')).toHaveCount(0);

    // Nothing continues without the required details; focus goes to the first problem.
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByLabel('Your name')).toBeFocused();
    await expect(page.getByRole('alert')).toContainText('Enter your name.');
    await page.getByLabel('Role').selectOption('qa');
    await expect(page.getByLabel('Role')).toHaveValue('qa');
    await page.getByLabel('Your name').fill('Quinn First');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('QS');
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toHaveValue('QS');
    expect(await requiredToFill(page)).toEqual([]);
    await page.getByRole('button', { name: /^Continue/ }).click();

    // The ready screen: who, the consent text to read, one Start (focused, A11Y-2).
    await expect(page.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
    const main = page.locator('main');
    await expect(main).toContainText('QS');
    await expect(main).toContainText(TRACK_NAMES.qa);
    await expect(main).toContainText('14 questions');
    await expect(main).toContainText('Notes and ratings from this interview are recorded');
    const start = page.getByRole('button', { name: 'Start interview' });
    await expect(start).toBeFocused();
    await expect(page.locator('.toast')).toHaveCount(0);
    // FLOW-7: Start is refused until the interviewer confirms the candidate has been told.
    await page.keyboard.press('Enter');
    await expect(page.getByRole('alert')).toContainText('tick the box to confirm');
    const told = page.getByRole('checkbox', { name: /I confirm the candidate has been told/ });
    await expect(told).toBeFocused();
    await expect(page.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
    await page.keyboard.press('Space');
    await start.click();
    await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();
    await expectQuestion(page, 1);

    // The name is now this device's interviewer (AUD-1); the set was pinned and the consent recorded.
    await page.goto('./#/admin?tab=audit');
    const log = page.getByRole('table', { name: 'Audit log' });
    await expect(log).toContainText('Plan locked');
    await expect(log).toContainText('Consent confirmed');
    await expect(log).toContainText('Quinn First');
  });

  test('UX-1 UX-2 FLOW-33: after the first run, an interview is set up with exactly two inputs (role and initials) and Continue', async ({ page }) => {
    await openApp(page, 'Tara Two');
    await openNewInterview(page);
    await continueAboveTheFold(page);
    expect(await requiredToFill(page)).toEqual(['Candidate']);
    await expect(page.getByLabel('Your name')).toHaveCount(0);
    // Count what the interviewer does: choose the role, type the initials, press Continue.
    let inputs = 0;
    await page.getByLabel('Role').selectOption('web');
    inputs++;
    await expect(page.getByLabel('Role')).toHaveValue('web');
    await expect(setSummary(page)).toContainText(/^14 questions/);
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('TW');
    inputs++;
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
    expect(inputs).toBe(2);
    await expect(page.locator('main')).toContainText(TRACK_NAMES.web);
    // The role is remembered for the next interview.
    await page.goto('./');
    await openNewInterview(page);
    await expect(page.getByLabel('Role')).toHaveValue('web');
  });

  test('UX-3 FLOW-2 FLOW-3 FLOW-4 FLOW-5 RES-1: questions are edited in place: reorder by keyboard and by dragging, remove, add from the bank, change the mix', async ({ page }) => {
    await openApp(page);
    await openNewInterview(page, 'qa');
    const url = page.url();
    await editQuestions(page);
    const rows = selectedRows(page);
    await expect(rows).toHaveCount(14);
    const texts = () => rows.locator('.set-row__text').allInnerTexts();
    const strip = (t: string) => t.replace(/^Question \d+:\s*/, '');
    const before = (await texts()).map(strip);

    // Keyboard: move question 1 down; focus stays with it.
    await page.getByRole('button', { name: 'Move question 1 down' }).focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await texts()).map(strip).slice(0, 2)).toEqual([before[1], before[0]]);
    await expect(page.getByRole('button', { name: 'Move question 2 down' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await texts()).map(strip)[2]).toBe(before[0]);

    // Drag: the last question onto the first place.
    const now = (await texts()).map(strip);
    await rows.last().locator('.set-row__grip').dragTo(rows.first());
    await expect.poll(async () => (await texts()).map(strip)[0]).toBe(now[13]);

    // Remove, then add one from the bank (search and the FLOW-2 filters); it goes to the end.
    const removed = strip((await texts())[0]);
    await page.getByRole('button', { name: 'Remove question 1', exact: true }).click();
    await expect(rows).toHaveCount(13);
    await expect(setSummary(page)).toContainText(/^13 questions/);
    await editorTab(page, 'Add questions');
    await page.getByRole('button', { name: 'Filter by category, difficulty or type' }).click();
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Performance' });
    await expect(page.getByRole('status').filter({ hasText: new RegExp(`^Showing \\d+ of ${seed('qa').questions.length} questions$`) })).toBeVisible();
    const candidate = page.locator('li.add-item:not(.add-item--chosen)').first();
    const added = await candidate.locator('.add-item__text').innerText();
    await candidate.getByRole('checkbox').check();
    await expect(rows).toHaveCount(14);
    await expect.poll(async () => (await texts()).map(strip)[13]).toBe(added);
    expect(added).not.toBe(removed);

    // FLOW-4: the time budget and meter head the list.
    await page.getByLabel('Time budget (minutes)').fill('30');
    await expect(page.locator('.set-editor__time')).toContainText('over the budget');
    await expect(setSummary(page)).toContainText('over the 30-minute budget');
    await page.getByLabel('Time budget (minutes)').fill('60');

    // FLOW-3 in plain words: knowledge stays within 8 to 10; a new mix is drawn and can be undone.
    await editorTab(page, 'Change the mix');
    await page.getByRole('button', { name: 'More knowledge questions' }).click();
    await expect(page.getByRole('button', { name: 'More knowledge questions' })).toBeDisabled();
    await expect(page.locator('#mix-knowledge')).toHaveText('10');
    await page.getByRole('button', { name: 'Fewer scenarios' }).click();
    await page.getByRole('button', { name: 'Fewer scenarios' }).click();
    await expect(page.getByRole('button', { name: 'Fewer scenarios' })).toBeDisabled();
    await page.getByRole('button', { name: 'Draw 13 questions' }).click();
    await expect(setSummary(page)).toContainText(/^13 questions/);
    await expect(page.locator('.ni-set__mix')).toHaveText('10 knowledge questions, 1 design exercise and 2 behavioural questions');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(setSummary(page)).toContainText(/^14 questions/);
    // An unmet quota is explained (FLOW-3): draw only from one small category.
    await page.getByLabel('Draw from').selectOption({ label: 'Performance' });
    await page.getByRole('button', { name: 'Draw 13 questions' }).click();
    await expect(page.locator('.ni-note--warn')).toContainText('Not enough questions in the bank for this mix');
    // FLOW-5: coverage per category.
    await editorTab(page, 'Coverage');
    await expect(page.getByRole('table', { name: 'Questions per category' })).toContainText('Performance');
    expect(page.url()).toBe(url);

    // RES-1: everything was saved as it was made.
    const order = (await texts()).map(strip);
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('ED');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('R-ED');
    await page.waitForTimeout(300);
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toHaveValue('ED');
    await editQuestions(page);
    expect((await texts()).map(strip)).toEqual(order);
    await expect(page.locator('.ni-more__summary')).toContainText('Requisition R-ED');
    // The mix and "Draw from" are kept too.
    await editorTab(page, 'Change the mix');
    await expect(page.locator('#mix-knowledge')).toHaveText('10');
    await expect(page.locator('#mix-scenario')).toHaveText('0');
    await expect(page.getByLabel('Draw from')).toHaveValue(/performance/);
    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('heading', { name: 'In interview order' })).toHaveCount(0);
    await expect(page.locator('#ni-edit')).toBeFocused();
  });

  test('FLOW-8 FLOW-33: an interview that has not started can be discarded and set up again, from the ready screen and from the Dashboard', async ({ page }) => {
    await openApp(page);
    await openNewInterview(page, 'qa');
    const setupUrl = page.url();
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('DS');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('R-DS');
    await continueToReady(page);
    await page.getByRole('button', { name: 'Discard and set up again' }).click();
    await modal(page, 'Discard this interview?').getByRole('button', { name: 'Discard and set up again' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
    expect(page.url()).toBe(setupUrl);
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toHaveValue('DS');
    await expect(page.locator('.ni-more__summary')).toContainText('Requisition R-DS');
    await continueToReady(page);

    // From the Dashboard: the interview waiting to start is the one to continue, or discard.
    await page.goto('./');
    const card = page.getByRole('region', { name: 'Ready to start' });
    await expect(card).toContainText('DS · R-DS');
    await card.getByRole('button', { name: /^Discard/ }).click();
    await modal(page, 'Discard this interview?').getByRole('button', { name: 'Discard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
    await page.goto('./');
    await expect(page.getByRole('region', { name: 'Ready to start' })).toHaveCount(0);
    await expect(page.locator('section[aria-labelledby="dash-drafts"]')).toContainText('For DS · R-DS');
  });

  test('FLOW-34 RES-1: an unfinished interview is the Dashboard’s most prominent action and resumes in one click', async ({ page }) => {
    await openApp(page, 'Casey Continue');
    await openNewInterview(page);
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('CO');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('R-34');
    await continueToReady(page);
    await startInterview(page);
    await focusQuestion(page);
    await page.keyboard.press('n');
    await expectQuestion(page, 2);

    await page.goto('./');
    const main = page.locator('main');
    const cont = page.getByRole('region', { name: /Continue your interview/ });
    await expect(cont).toContainText('CO · R-34');
    await expect(cont).toContainText('In progress');
    const order = await main.locator('section').evaluateAll((els) => els.map((e) => e.getAttribute('aria-labelledby')));
    expect(order.indexOf('continue-title')).toBeLessThan(order.indexOf('dash-sessions'));
    await expect(main.locator('.btn--primary')).toHaveCount(1);
    await expect(main.locator('.btn--primary')).toHaveText(/Continue interview/);
    await expect(page.getByTestId('new-interview')).toBeVisible();
    await cont.getByRole('link', { name: /Continue interview/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();
    await expectQuestion(page, 2);

    await page.goto('./#/bank/qa');
    await page.getByRole('banner').getByRole('link', { name: 'Back to interview' }).click();
    await expectQuestion(page, 2);
  });

  test('FLOW-9 FLOW-33: "Use the same questions as…" an earlier interview, so the results are comparable', async ({ page }) => {
    await openApp(page);
    await openNewInterview(page, 'edge');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('FI');
    await continueToReady(page);
    await page.goto('./');
    await openNewInterview(page, 'qa');
    await page.getByRole('button', { name: 'Use the same questions as an earlier interview…' }).click();
    const dlg = modal(page, 'Use the same questions as…');
    await dlg.getByRole('button', { name: 'Use these questions' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Choose a question set first.');
    await dlg.getByRole('radio', { name: /used for FI/ }).check();
    await dlg.getByRole('button', { name: 'Use these questions' }).click();
    await expect(page.locator('.ni-set__mix')).toContainText('The same questions as');
    await expect(page.getByLabel('Role')).toHaveValue('edge');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('SE');
    await continueToReady(page);
    await page.goto('./');
    await expect(page.locator('section[aria-labelledby="dash-sets"] .dash-plan').first()).toContainText('2 interviews');
  });

  test('FLOW-33 FLOW-7 PRIV-5: the device retention period is the default for a new interview', async ({ page }) => {
    await openApp(page);
    const today = await browserToday(page);
    await page.goto('./#/admin?tab=device');
    const days = page.getByLabel('Default retention period (days)');
    await expect(days).toHaveValue('90');
    await days.fill('0');
    await page.getByRole('button', { name: 'Save retention period' }).click();
    await expect(page.locator('main')).toContainText('Enter whole days from 1 to 3650.');
    await days.fill('30');
    await page.getByRole('button', { name: 'Save retention period' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
    await page.goto('./#/new');
    await expect(setSummary(page)).toBeVisible();
    await openMoreOptions(page);
    await expect(page.getByLabel('Keep the record until')).toHaveValue(plusDays(today, 30));
  });
});

test('UX-3 A11Y-1: the bank peek dialog adds a question and returns focus', async ({ page }) => {
  await openApp(page);
  await openNewInterview(page, 'qa');
  await editQuestions(page);
  const row = page.locator('li.add-item:not(.add-item--chosen)').first();
  const text = await row.locator('.add-item__text').innerText();
  const eye = bankRow(page, text).getByRole('button', { name: /^Look at question/ });
  await eye.click();
  const dlg = page.locator('dialog[open]');
  await expect(dlg).toContainText(text);
  await dlg.getByRole('button', { name: 'Add to this interview' }).click();
  await expect(dlg.getByRole('button', { name: 'Remove from this interview' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(eye).toBeFocused();
  await expect(bankRow(page, text)).toHaveClass(/add-item--chosen/);
  await expect(selectedRows(page)).toHaveCount(15);
  await expect(page.getByRole('checkbox', { name: /I confirm the candidate has been told/ })).toHaveCount(0);
});
