import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Browser } from '@playwright/test';
import {
  downloadText,
  expect,
  newInterviewFromSet,
  finishInterview,
  openApp,
  scoreAllWithKeys,
  setupInterview,
  startInterview,
  test,
  type Guard,
  type Page,
  exportFromScorecard,
  setIndependentScoring,
} from './fixtures';

const FINISH = { rating: 3, recommendation: 'Hire', rationale: 'Independent rating.' };

async function panelist(browser: Browser, guard: Guard, name: string): Promise<Page> {
  const ctx = await browser.newContext();
  guard.watch(ctx);
  const page = await ctx.newPage();
  await openApp(page, name);
  return page;
}

/** Imports a question set file on the dashboard and starts an interview from it. */
async function interviewFromPlanFile(page: Page, planPath: string, candidate: { initials: string; requisitionId: string }) {
  await page.goto('./');
  await page.getByTestId('import-input').setInputFiles(planPath);
  await expect(page.locator('section[aria-labelledby="dash-sets"]')).toContainText('Senior QA Engineer interview');
  await newInterviewFromSet(page, candidate, { start: true });
}

async function exportSession(page: Page, dir: string, label: string): Promise<string> {
  const f = await exportFromScorecard(page, 'Interview file for the debrief');
  expect(f.name).toMatch(/^interview-session-[0-9a-f]{8}-/);
  const path = `${dir}/${label}.json`;
  writeFileSync(path, f.text);
  return path;
}

test.describe('Panels and debrief', () => {
  test('FLOW-9 FLOW-26 FLOW-27 FLOW-28 FLOW-29 FLOW-30 SCORE-11 DATA-4: with independent scoring on, blind until own submission, then median and spread; grouping and comparison need the same fingerprint', async ({
    page,
    browser,
    guard,
  }, testInfo) => {
    const dir = testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    // Panelist A plans and locks the interview and shares the plan file.
    await openApp(page, 'Ana Lead');
    await setIndependentScoring(page, true); // FLOW-27: off by default; this panel scores independently
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'MK', requisitionId: 'REQ-42' }, start: false });
    await page.goto('./');
    const plan = await downloadText(page, () => page.locator('section[aria-labelledby="dash-sets"]').getByRole('button', { name: /^Export/ }).first().click());
    const planJson = JSON.parse(plan.text);
    expect(planJson.kind).toBe('interview-plan'); // DATA-4
    expect(planJson.formatVersion).toBe(1);
    const planPath = `${dir}/plan.json`;
    writeFileSync(planPath, plan.text);

    // Panelists B and C, each on their own device (browser context). B types the requisition id in lower case.
    const b = await panelist(browser, guard, 'Ben Second');
    await interviewFromPlanFile(b, planPath, { initials: 'mk', requisitionId: 'req-42' });
    await scoreAllWithKeys(b, 2, 3);
    await finishInterview(b, FINISH);
    const bFile = await exportSession(b, dir, 'ben');
    const bJson = JSON.parse(readFileSync(bFile, 'utf8'));
    expect(bJson.kind).toBe('interview-session');
    expect(bJson.plan.fingerprint).toBe(planJson.plan.fingerprint); // FLOW-9: same plan, same fingerprint on another device

    const c = await panelist(browser, guard, 'Cy Third');
    await interviewFromPlanFile(c, planPath, { initials: 'MK', requisitionId: 'REQ-42' });
    await scoreAllWithKeys(c, 3, 3);
    await finishInterview(c, FINISH);
    const cFile = await exportSession(c, dir, 'cy');

    // A session on a different plan for the same candidate (different fingerprint), from C.
    await c.goto('./');
    await setupInterview(c, { pick: [1, 2, 4], candidate: { initials: 'MK', requisitionId: 'REQ-42' } });
    await scoreAllWithKeys(c, 3, 3);
    await finishInterview(c, FINISH);
    const otherPlanFile = await exportSession(c, dir, 'cy-other-plan');

    // FLOW-27: only submitted sessions can be imported.
    const draft = JSON.parse(JSON.stringify(bJson));
    draft.session.state = 'in_progress';
    draft.session.submittedAt = null;
    const draftPath = `${dir}/draft.json`;
    writeFileSync(draftPath, JSON.stringify(draft));

    // A starts their own interview, then imports the panelists' files before submitting.
    await page.goto('./');
    // FLOW-34: the interview to continue leads the Dashboard (and is not listed again below it).
    await page.getByRole('link', { name: /^Continue interview/ }).click();
    await startInterview(page);
    const ownUrl = page.url();
    const ownId = ownUrl.split('/').pop()!;
    await page.goto(`./#/debrief/${ownId}`);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('Debrief');
    const input = page.getByLabel('Import other interviewers’ files');
    await input.setInputFiles([bFile, cFile, otherPlanFile, draftPath]);
    await expect(page.getByText('Imported Ben Second’s interview into this panel.')).toBeVisible();
    await expect(page.getByText('Imported Cy Third’s interview into this panel.')).toBeVisible();
    await expect(page.getByText(/It is not part of this panel/)).toBeVisible(); // FLOW-29: other fingerprint
    await expect(page.getByText(/Not imported: .*not valid/)).toBeVisible();
    await expect(page.locator('main')).toContainText('Only submitted interviews can be imported.');

    // Blind: only the names and "submitted" are shown; no percentages anywhere on the screen.
    const panelTable = page.getByRole('table', { name: /Panelists/ });
    await expect(panelTable).toContainText('Ben Second');
    await expect(panelTable).toContainText('Cy Third');
    await expect(panelTable).toContainText('Submitted');
    await expect(panelTable).toContainText('Hidden until your own interview is submitted');
    await expect(page.locator('main')).not.toContainText('%');
    await expect(page.locator('main')).not.toContainText('Panel score');
    // Blind also on the imported scorecard URL and on the dashboard.
    await page.goto(`./#/scorecard/${bJson.session.id}`);
    await expect(page.getByText('Hidden until your own interview is submitted (blind scoring).')).toBeVisible();
    await expect(page.locator('main')).not.toContainText('%');
    await page.goto(`./#/interview/${bJson.session.id}`);
    await expect(page).toHaveURL(new RegExp(`#/debrief/${bJson.session.id}`));
    await expect(page.locator('main')).not.toContainText('%');
    await page.goto('./#/compare');
    await expect(page.locator('main')).not.toContainText('Ben Second');

    // A submits (all 4s): panel shows each percentage, the median and the spread warning.
    await page.goto(ownUrl);
    await scoreAllWithKeys(page, 4, 3);
    await finishInterview(page, FINISH);
    await page.goto(`./#/debrief/${ownId}`);
    await expect(panelTable.getByRole('row', { name: /Ana Lead \(you\)/ })).toContainText('100%');
    await expect(panelTable.getByRole('row', { name: /Ben Second/ })).toContainText('33%');
    await expect(panelTable.getByRole('row', { name: /Cy Third/ })).toContainText('67%');
    await expect(panelTable.getByRole('row')).toHaveCount(4); // header + 3 panelists; the other-plan session is not grouped (FLOW-29)
    await expect(page.locator('.dbf-figure', { hasText: 'Panel score' }).locator('.dbf-big')).toHaveText('67%'); // SCORE-11 median
    await expect(page.getByText('The panel disagrees by more than 20 points.')).toBeVisible();
    await expect(page.getByRole('table', { name: /Average score .* per category/ })).toBeVisible();

    // FLOW-30: choose a plan first; only that plan's submitted sessions are shown.
    await page.goto('./#/compare');
    const select = page.getByLabel('Question set', { exact: true });
    const options = await select.locator('option').allTextContents();
    const ours = options.find((o) => o.includes(planJson.plan.fingerprint.slice(0, 8)))!;
    expect(ours).toContain('3 submitted');
    await select.selectOption({ label: ours });
    const matrix = page.locator('.cmp-matrix');
    await expect(matrix).toContainText('Ben Second');
    await expect(matrix).toContainText('Cy Third');
    await expect(matrix).toContainText('Ana Lead');
    const other = options.find((o) => !o.includes(planJson.plan.fingerprint.slice(0, 8)) && /submitted/.test(o));
    expect(other, 'the other plan is a separate choice').toBeTruthy();
    await select.selectOption({ label: other! });
    await expect(matrix).not.toContainText('Ben Second');
    await expect(matrix).not.toContainText('Ana Lead');

    await b.context().close();
    await c.context().close();
  });
});
