import { mkdirSync, writeFileSync } from 'node:fs';
import {
  downloadText,
  expect,
  expectQuestion,
  finishInterview,
  focusQuestion,
  continueToReady,
  modal,
  moreMenu,
  openApp,
  openMoreOptions,
  openNewInterview,
  pickByNumber,
  scoreAllWithKeys,
  startInterview,
  test,
  type Page,
  exportFromScorecard,
} from './fixtures';

/** Live screen: adds a note marked with who made it (PANEL-3). */
async function noteBy(page: Page, who: string, text: string) {
  await page.getByLabel('Note by').selectOption({ label: who });
  const box = page.getByPlaceholder('What did the candidate say?');
  await box.fill(text);
  await box.press('Enter');
  await expect(page.getByRole('list', { name: 'Notes for this question' }).getByRole('listitem').filter({ hasText: text })).toContainText(who);
  await box.press('Escape');
}

async function questionCount(page: Page): Promise<number> {
  return Number((await page.locator('#question-heading').innerText()).match(/of (\d+)/)![1]);
}

test.describe('Several interviewers on one machine', () => {
  test('PANEL-1 PANEL-2 PANEL-3 PANEL-4 PANEL-5 DATA-5 RES-1 FLOW-33: two interviewers share one scorecard: New interview, attributed notes, add and remove mid-interview (audited), reload, names on finish, scorecard, exports, dashboard, debrief and comparison', async ({
    page,
    browser,
    guard,
  }, testInfo) => {
    const dir = testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    await openApp(page, 'Ana Lead');

    // PANEL-1: New interview with a second interviewer: one click, one name (under More options).
    await openNewInterview(page, 'qa');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('SH');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('REQ-77');
    await page.getByRole('button', { name: 'Add interviewer' }).click();
    const second = page.getByLabel('Interviewer 2', { exact: true });
    await expect(second).toBeFocused();
    // Names must differ.
    await second.fill('ana lead');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.locator('main')).toContainText('Each interviewer needs a different name.');
    await expect(second).toBeFocused();
    await second.fill('Ben Second');
    await expect(page.locator('.ni-more__summary')).toContainText('with Ben Second');
    await continueToReady(page);

    // PANEL-4: the ready screen names both.
    await expect(page.locator('.ready__facts')).toContainText('with Ana Lead and Ben Second');
    await startInterview(page);
    await expect(page.locator('.live-bar')).toContainText('with Ana Lead and Ben Second');
    const total = await questionCount(page);

    // PANEL-3: notes marked with who made them; the choice is remembered.
    await noteBy(page, 'Ben Second', 'Ben heard the numbers');
    await noteBy(page, 'Ana Lead', 'Ana heard the trade-off');
    await expect(page.getByLabel('Note by')).toHaveValue('Ana Lead');

    // PANEL-1: add and remove an interviewer mid-interview.
    await moreMenu(page, 'Interviewers…');
    const people = modal(page, 'Interviewers');
    await people.getByLabel('Add an interviewer').fill('Cy Third');
    await people.getByRole('button', { name: 'Add interviewer' }).click();
    await expect(people.getByRole('list', { name: 'Interviewers on this interview' })).toContainText('Cy Third');
    await people.getByRole('button', { name: 'Remove Cy Third' }).click();
    await expect(people.getByRole('list', { name: 'Interviewers on this interview' })).not.toContainText('Cy Third');
    await people.getByRole('button', { name: 'Done' }).click();
    await expect(page.locator('.live-bar')).toContainText('with Ana Lead and Ben Second');

    // RES-1, DATA-5: a reload keeps the interviewers, the attributed notes and the chosen author.
    await page.reload();
    await expectQuestion(page, 1);
    await expect(page.locator('.live-bar')).toContainText('with Ana Lead and Ben Second');
    const notes = page.getByRole('list', { name: 'Notes for this question' });
    await expect(notes.getByRole('listitem').filter({ hasText: 'Ben heard the numbers' })).toContainText('Ben Second');
    await expect(notes.getByRole('listitem').filter({ hasText: 'Ana heard the trade-off' })).toContainText('Ana Lead');
    await expect(page.getByLabel('Note by')).toHaveValue('Ana Lead');

    // PANEL-2: one record: there is nothing to switch between.
    await expect(page.getByText(/Scoring as/)).toHaveCount(0);
    await focusQuestion(page);
    await scoreAllWithKeys(page, 3, total);

    // PANEL-4: the finish step lists the names and says the decision is on behalf of all of them.
    await page.getByRole('button', { name: 'Finish…' }).click();
    const finish = modal(page, 'Finish and submit the interview');
    await expect(finish).toContainText('Interviewers: Ana Lead and Ben Second. The rating, recommendation and rationale are recorded on behalf of all of them.');
    await finish.getByRole('button', { name: 'Keep interviewing' }).click();
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: 'Agreed between us.' });

    // Scorecard and exports (PANEL-3, PANEL-4).
    const meta = page.locator('.sc-meta');
    await expect(meta).toContainText('Interviewers');
    await expect(meta).toContainText('Ana Lead and Ben Second (one shared scorecard)');
    await expect(page.locator('.sc-decision')).toContainText('Recorded by Ana Lead and Ben Second, on behalf of all of them.');
    const md = await exportFromScorecard(page, 'Markdown');
    expect(md.text).toContain('- Interviewers: Ana Lead and Ben Second (one shared scorecard)');
    expect(md.text).toMatch(/\[\d+:\d\d\] \(Ben Second\) Ben heard the numbers/);
    const csv = await exportFromScorecard(page, 'CSV, one row per question');
    expect(csv.text).toMatch(/\(Ana Lead\) Ana heard the trade-off/);
    const sessionId = page.url().split('/').pop()!;
    const planFile = await (async () => {
      await page.goto('./');
      return downloadText(page, () => page.getByRole('button', { name: /^Export/ }).first().click());
    })();
    const planPath = `${dir}/plan.json`;
    writeFileSync(planPath, planFile.text);

    // Dashboard row (PANEL-4).
    await expect(page.locator('section[aria-labelledby="dash-sessions"]')).toContainText('Ana Lead and Ben Second');

    // PANEL-5: a shared scorecard from another machine joins the debrief as one entry with both names.
    const ctx = await browser.newContext();
    guard.watch(ctx);
    const other = await ctx.newPage();
    await openApp(other, 'Cy Third');
    await other.getByTestId('import-input').setInputFiles(planPath);
    await expect(other.locator('section[aria-labelledby="dash-sets"]')).toContainText('Senior QA Engineer interview');
    await other.locator('section[aria-labelledby="dash-sets"]').getByRole('link', { name: /^Reuse/ }).first().click();
    await expect(other.locator('.ni-set__mix')).toContainText('The same questions as');
    await other.getByRole('textbox', { name: 'Candidate', exact: true }).fill('SH');
    await openMoreOptions(other);
    await other.getByLabel('Requisition id').fill('REQ-77');
    await other.getByRole('button', { name: 'Add interviewer' }).click();
    await other.getByLabel('Interviewer 2', { exact: true }).fill('Di Fourth');
    await continueToReady(other);
    await startInterview(other);
    await scoreAllWithKeys(other, 2, total);
    await finishInterview(other, { rating: 2, recommendation: 'Lean no hire', rationale: 'Shallow.' });
    const file = await exportFromScorecard(other, 'Interview file for the debrief');
    expect(JSON.parse(file.text).session.interviewers).toEqual(['Cy Third', 'Di Fourth']);
    const filePath = `${dir}/shared.json`;
    writeFileSync(filePath, file.text);
    await ctx.close();

    await page.goto(`./#/debrief/${sessionId}`);
    await page.getByLabel('Import other interviewers’ files').setInputFiles(filePath);
    await expect(page.getByText('Imported Cy Third and Di Fourth’s interview into this panel.')).toBeVisible();
    const panel = page.getByRole('table', { name: /Panelists/ });
    await expect(panel.getByRole('row')).toHaveCount(3); // header + two shared scorecards
    await expect(panel.getByRole('row', { name: /Ana Lead and Ben Second \(you\)/ })).toContainText('67%');
    await expect(panel.getByRole('row', { name: /Cy Third and Di Fourth/ })).toContainText('33%');

    // Comparison names everyone (PANEL-4).
    await page.goto('./#/compare');
    const select = page.getByLabel('Question set', { exact: true });
    await select.selectOption({ index: 1 });
    await expect(page.locator('.cmp-matrix')).toContainText('Ana Lead and Ben Second');
    await expect(page.locator('.cmp-matrix')).toContainText('Cy Third and Di Fourth');

    // AUD-2: adding and removing interviewers is in the audit log.
    await page.goto('./#/admin?tab=audit');
    const log = page.getByRole('table', { name: 'Audit log' });
    await page.getByLabel('Action').selectOption({ label: 'Interviewer added' });
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await expect(log).toContainText('Cy Third');
    await page.getByLabel('Action').selectOption({ label: 'Interviewer removed' });
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await expect(log).toContainText('Cy Third');
  });

  test('PANEL-1 FLOW-7 RES-1: the New interview screen names more interviewers; names must differ before Continue; the set-up keeps them', async ({ page }) => {
    await openApp(page, 'Ana Lead');
    await openNewInterview(page, 'qa');
    await pickByNumber(page, [1, 2]);
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('ST');
    await openMoreOptions(page);
    await page.getByRole('button', { name: 'Add interviewer' }).click();
    await page.getByLabel('Interviewer 2', { exact: true }).fill('Ben Second');
    await page.getByRole('button', { name: 'Add interviewer' }).click();
    await page.getByLabel('Interviewer 3', { exact: true }).fill('BEN second');
    // Saved as typed (RES-1): a reload keeps the names.
    await page.waitForTimeout(600);
    await page.reload();
    await openMoreOptions(page);
    await expect(page.getByLabel('Interviewer 3', { exact: true })).toHaveValue('BEN second');
    await page.getByRole('button', { name: /^Continue/ }).click();
    const problems = page.getByRole('alert').filter({ hasText: 'to fix first' });
    await expect(problems).toContainText('Interviewer 3: Each interviewer needs a different name.');
    await page.getByRole('button', { name: 'Remove interviewer 3 (BEN second)' }).click();
    await expect(page.getByLabel('Interviewer 3', { exact: true })).toHaveCount(0);
    await continueToReady(page);
    await expect(page.locator('.ready__facts')).toContainText('with Ana Lead and Ben Second');
    await expect(page.locator('.ready__facts')).toContainText('2 questions');
  });
});
