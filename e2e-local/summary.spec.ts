// SUM-1…SUM-6, TEAM-7…TEAM-14: the Summary screen, the candidate page, panel decisions, judgements
// entered by hand, panel files and the round report. Separate browser contexts play the organiser,
// two interviewers and the hiring manager, each on their own computer.
import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Browser } from '@playwright/test';
import {
  browserToday,
  downloadText,
  expect,
  exportFromScorecard,
  finishInterview,
  importFiles,
  modal,
  openApp,
  scoreAllWithKeys,
  startInterview,
  test,
  type Guard,
  type Page,
} from './fixtures';
import { mixedSpec, panelEntry, panelFileText } from './round-data';

const shotDir = process.env.E2E_SCREENSHOT_DIR;

function plusDays(today: string, days: number): string {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() + days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function computer(browser: Browser, guard: Guard, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  guard.watch(ctx);
  const page = await ctx.newPage();
  await openApp(page, name);
  return page;
}

/** A11Y-7, A11Y-6: axe in both schemes, and no sideways scroll at 390px, for the current state; screenshots when asked. */
async function checkState(page: Page, name: string, widths = [1280, 390]): Promise<string[]> {
  const failures: string[] = [];
  const size = page.viewportSize()!;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of widths) {
      await page.setViewportSize({ width, height: width === 1440 ? 900 : width === 390 ? 844 : 800 });
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      for (const v of result.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') failures.push(`${name} ${scheme} ${width}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 2).join(' | ')}`);
      }
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (wide) failures.push(`${name} ${scheme} ${width}: horizontal scroll`);
      if (shotDir) {
        mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: `${shotDir}/summary-${name}-${scheme}-${width}.png`, fullPage: true });
      }
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(size);
  return failures;
}

/** UX-7, UX-8: no requirement codes and only the words an interviewer would use. */
async function plainWords(page: Page, where: string) {
  const text = await page.locator('body').innerText();
  expect(text, `${where}: no requirement ids`).not.toMatch(/\b(TEAM|FLOW|PRIV|UX|SUM|SCORE|AUD)-\d+/);
  expect(text, `${where}: plain words`).not.toMatch(/\b(session|sessions|fingerprint|plan file|panelist file)\b/i);
}

/**
 * Plans `n` interviews with "Plan several" (one role, the same questions), exports the invitations
 * and returns them, as the organiser would.
 */
async function planRound(page: Page, n: number, opts: { firstDay?: number; names?: string[]; prefix?: string } = {}) {
  const today = await browserToday(page);
  const first = ['Ana', 'Bo', 'Chen', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo', 'Kai', 'Lin', 'Mo', 'Nia', 'Oli'];
  const last = ['Diaz', 'Li', 'Wu', 'Ng', 'Park', 'Sato', 'Okafor', 'Silva'];
  const names = opts.names ?? ['Ben Second', 'Cy Third'];
  const lines = ['Candidate\tDate\tTime\tRequisition\tInterviewers'];
  for (let i = 0; i < n; i++) {
    const who = `${opts.prefix ?? ''}${first[i % first.length]} ${last[Math.floor(i / first.length) % last.length]}`;
    lines.push(`${who}\t${plusDays(today, (opts.firstDay ?? -10) + Math.floor(i / 3))}\t${9 + (i % 3) * 2}:00\tREQ-${i % 2 ? '7' : '8'}\t${names.join('; ')}`);
  }
  await page.goto('./#/');
  await page.getByRole('link', { name: 'Plan several' }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'Plan several interviews' })).toBeVisible();
  await page.getByLabel('Role').selectOption('qa');
  await page.getByLabel('Candidates, one per line').fill(lines.join('\n'));
  await page.getByRole('button', { name: `Plan ${n} interview${n === 1 ? '' : 's'}` }).click();
  await expect(page.getByTestId('plan-done')).toBeVisible();
  const inv = await downloadText(page, () => page.getByRole('button', { name: 'Export invitations for all of them' }).click());
  return JSON.parse(inv.text) as { interviews: Parameters<typeof panelEntry>[0][] };
}

/** Results from the interviewers in mixed states, arriving as one panel file through "Import files". */
async function importMixedResults(page: Page, inv: { interviews: Parameters<typeof panelEntry>[0][] }, names = ['Ben Second', 'Cy Third']) {
  const text = panelFileText(inv.interviews.map((it, i) => panelEntry(it, mixedSpec(i, names))));
  const results = await importFiles(page, { name: 'round.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(results).toContainText(`Panel file from Olive Organiser: ${inv.interviews.length} candidates`);
}

async function openSummary(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Summary', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Summary' })).toBeVisible();
}

test.describe('Summary of a round', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('SUM-6 SUM-1 SUM-2 A11Y-7 A11Y-6: the Summary screen opens quickly with fifty interviews, stays scannable and fits a phone', async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page, 'Olive Organiser');
    const inv = await planRound(page, 50);
    await importMixedResults(page, inv);
    await page.goto('./#/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    const t0 = Date.now();
    await openSummary(page);
    await expect(page.getByTestId('summary-row')).toHaveCount(50);
    const ms = Date.now() - t0;
    expect(ms, `Summary with 50 interviews rendered in ${ms} ms`).toBeLessThan(3000);
    // Responsive: sorting and filtering 50 rows.
    const t1 = Date.now();
    await page.getByRole('button', { name: /^Score/ }).click();
    await page.getByLabel('Find a candidate').fill('ana');
    await expect(page.getByTestId('summary-row').first()).toContainText('Ana');
    expect(Date.now() - t1).toBeLessThan(2000);
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(page.getByTestId('sum-counts')).toContainText('50 candidates');
    const failures = await checkState(page, '50');
    await plainWords(page, 'summary with 50');
    expect(failures).toEqual([]);
  });
});

const row = (page: Page, who: string) => page.getByTestId('summary-row').filter({ has: page.getByRole('link', { name: who, exact: true }) });

async function questionCount(page: Page): Promise<number> {
  return Number((await page.locator('.ready__facts').innerText()).match(/(\d+) questions/)![1]);
}

/** An interviewer runs one interview from Upcoming, submits it and exports the interview file. */
async function interview(p: Page, who: string, score: 2 | 3, rec: string, dir: string): Promise<string> {
  await p.goto('./#/');
  await p.getByTestId('upcoming-row').filter({ hasText: who }).getByRole('link', { name: /^Start/ }).click();
  await expect(p.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
  const n = await questionCount(p);
  await startInterview(p);
  await scoreAllWithKeys(p, score, n);
  await finishInterview(p, { rating: score, recommendation: rec, rationale: `${who}: ${rec} on the evidence.` });
  const f = await exportFromScorecard(p, 'Interview file for the debrief');
  const path = `${dir}/${who.replace(/\W+/g, '-')}-${Math.random().toString(16).slice(2, 6)}.json`;
  writeFileSync(path, f.text);
  return path;
}

async function openCandidate(page: Page, who: string) {
  await page.goto('./#/summary');
  await row(page, who).getByRole('link', { name: who, exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: who })).toBeVisible();
}

test.describe('A round of interviews, from planning to the hiring manager', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('SUM-1 SUM-2 SUM-3 SUM-4 SUM-5 TEAM-7 TEAM-8 TEAM-9 TEAM-10 TEAM-11 TEAM-12 TEAM-13 TEAM-14 TEAM-6 TEAM-15 UX-7 UX-8: plan six, two interviewers interview, judgements by hand, decisions, summary, report, panel file to the hiring manager, conflicts, corrections and a deletion request', async ({ page, browser, guard }, testInfo) => {
    test.setTimeout(480_000);
    const dir = testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    const failures: string[] = [];
    await openApp(page, 'Olive Organiser');
    const today = await browserToday(page);

    // TEAM-15: six interviews with "Plan several", same questions, a shared note and the recording option.
    const people = ['Ana Diaz', 'Bo Li', 'Chen Wu', 'Dee Ng', 'Eli Park', 'Fay Sato'];
    const lines = people.map((p, i) => `${p}, ${plusDays(today, i < 3 ? -1 : i)}, ${9 + i}:00, REQ-42, Ben Second; Cy Third`);
    await page.goto('./#/plan');
    await page.getByLabel('Role').selectOption('qa');
    await page.getByLabel('Candidates, one per line').fill(lines.join('\n'));
    await page.getByLabel('Note for the interviewers').fill('Room 4, video link in the calendar');
    await page.getByRole('checkbox', { name: 'These interviews will be recorded or transcribed' }).check();
    failures.push(...(await checkState(page, 'plan-several')));
    await page.getByRole('button', { name: 'Plan 6 interviews' }).click();
    await expect(page.getByTestId('plan-done')).toContainText('They all have the same questions');
    const inv = await downloadText(page, () => page.getByRole('button', { name: 'Export invitations for all of them' }).click());
    const invJson = JSON.parse(inv.text);
    expect(invJson.interviews[0]).toMatchObject({ note: 'Room 4, video link in the calendar', recordingNotice: true });
    const invPath = `${dir}/invitation.json`;
    writeFileSync(invPath, inv.text);
    // Upcoming: one role, so it is not repeated on every line.
    await page.goto('./#/');
    await expect(page.getByTestId('upcoming-row').first()).toContainText('with Ben Second and Cy Third');
    await expect(page.getByTestId('upcoming-row').first()).not.toContainText('Senior QA Engineer');

    // Two interviewers, each on their own computer.
    const files: string[] = [];
    const ben = await computer(browser, guard, 'Ben Second');
    await importFiles(ben, invPath);
    files.push(await interview(ben, 'Ana Diaz', 3, 'Hire', dir));
    files.push(await interview(ben, 'Bo Li', 2, 'Lean no hire', dir));
    await ben.context().close();
    const cy = await computer(browser, guard, 'Cy Third');
    await importFiles(cy, invPath);
    files.push(await interview(cy, 'Ana Diaz', 3, 'Hire', dir));
    files.push(await interview(cy, 'Chen Wu', 2, 'Lean no hire', dir));
    await cy.context().close();

    // TEAM-5: the organiser imports all four at once.
    const results = await importFiles(page, files);
    await expect(results).toContainText('Imported 4 of 4 files');

    // SUM-1, TEAM-6: the Summary: outcome, score source and what is missing. The organiser, who planned
    // these for others, is never waited for.
    await openSummary(page);
    await expect(page.getByTestId('summary-row')).toHaveCount(6);
    await expect(row(page, 'Ana Diaz')).toContainText('All agree');
    await expect(row(page, 'Ana Diaz')).toContainText('Panel median of 2');
    await expect(row(page, 'Ana Diaz')).toContainText('No panel decision yet');
    await expect(row(page, 'Bo Li')).toContainText('Waiting for 1 judgement: Cy Third');
    await expect(row(page, 'Bo Li')).toContainText('One interviewer (Ben Second)');
    await expect(row(page, 'Chen Wu')).toContainText('Waiting for 1 judgement: Ben Second');
    await expect(row(page, 'Dee Ng')).toContainText('Not interviewed yet');
    await expect(page.locator('main')).not.toContainText('Olive Organiser');
    failures.push(...(await checkState(page, 'round-6', [1280, 1440, 390])));
    await plainWords(page, 'summary');

    // TEAM-7: Cy scored Bo on paper: entered by hand with question scores (type 1–4, the next is selected).
    await openCandidate(page, 'Bo Li');
    await page.getByRole('button', { name: 'Add another interviewer’s judgement' }).click();
    let dlg = modal(page, 'Add another interviewer’s judgement');
    await expect(dlg.getByLabel('Interviewer')).toHaveValue('Cy Third');
    await dlg.getByRole('group', { name: /Their overall rating/ }).getByRole('radio', { name: /^3 / }).check();
    await dlg.getByRole('group', { name: /Their recommendation/ }).getByRole('radio', { name: 'Hire', exact: true }).check();
    await dlg.getByLabel('Their rationale').fill('Good debugging story; on paper.');
    await dlg.getByText('Question scores and notes').click();
    const n = await dlg.getByRole('textbox', { name: /^Score for question/ }).count();
    await dlg.getByLabel('Score for question 1', { exact: true }).focus();
    for (let i = 0; i < n; i++) await page.keyboard.press('3');
    await dlg.getByLabel('Note for question 2', { exact: true }).fill('Explained flaky tests well');
    await expect(dlg.getByLabel(`Score for question ${n}`, { exact: true })).toHaveValue('3');
    failures.push(...(await checkState(page, 'judgement-dialog')));
    await plainWords(page, 'judgement dialog');
    await dlg.getByRole('button', { name: 'Save judgement' }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    const cyRow = page.getByTestId('judgement-row').filter({ hasText: 'Cy Third' });
    await expect(cyRow).toContainText('Entered by Olive Organiser on behalf of Cy Third');
    await expect(cyRow).toContainText('100%'.replace('100', '67'));

    // TEAM-7: Ben's judgement of Chen came by e-mail, with no question scores.
    await openCandidate(page, 'Chen Wu');
    await page.getByRole('button', { name: 'Add another interviewer’s judgement' }).click();
    dlg = modal(page, 'Add another interviewer’s judgement');
    await expect(dlg.getByLabel('Interviewer')).toHaveValue('Ben Second');
    await dlg.getByRole('group', { name: /Their overall rating/ }).getByRole('radio', { name: /^2 / }).check();
    await dlg.getByRole('group', { name: /Their recommendation/ }).getByRole('radio', { name: 'Lean no hire', exact: true }).check();
    await dlg.getByLabel('Their rationale').fill('Not enough depth on automation.');
    await dlg.getByRole('button', { name: 'Save judgement' }).click();
    const benRow = page.getByTestId('judgement-row').filter({ hasText: 'Ben Second' });
    await expect(benRow).toContainText('No question scores');
    await expect(benRow).toContainText('Not in the panel score');
    await expect(page.getByTestId('cand-score')).toContainText('One interviewer (Cy Third)');

    // TEAM-9 TEAM-12: Ana's panel decision from the debrief, agreed scores started from the median (only on that click).
    await openCandidate(page, 'Ana Diaz');
    await page.getByRole('link', { name: 'Debrief', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Debrief' })).toBeVisible();
    await page.getByRole('button', { name: 'Record panel decision' }).click();
    dlg = modal(page, 'Record the panel decision');
    await expect(dlg.getByRole('checkbox', { name: 'Ben Second' })).toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Cy Third' })).toBeChecked();
    await dlg.getByRole('group', { name: /Agreed recommendation/ }).getByRole('radio', { name: 'Hire', exact: true }).check();
    await dlg.getByLabel('Why').fill('Both saw solid, grounded answers.');
    await dlg.getByText('Agreed rating and question scores').click();
    await expect(dlg.getByLabel('Agreed score for question 1', { exact: true })).toHaveValue('');
    await dlg.getByRole('button', { name: 'Start from the panel’s median' }).click();
    await expect(dlg.getByLabel('Agreed score for question 1', { exact: true })).toHaveValue('3');
    failures.push(...(await checkState(page, 'decision-dialog')));
    await plainWords(page, 'decision dialog');
    await dlg.getByRole('button', { name: 'Save panel decision' }).click();
    await expect(page.getByTestId('decision-card')).toContainText('Hire');
    await expect(page.getByTestId('decision-card')).toContainText('Agreed by Ben Second and Cy Third');
    // TEAM-12: beside, never instead of, the individual figures, median and spread.
    await expect(page.locator('.dbf-figure', { hasText: 'Panel score' })).toBeVisible();
    failures.push(...(await checkState(page, 'debrief-decided')));
    // ...and on each scorecard.
    await page.getByRole('link', { name: /^Scorecard of Ben Second/ }).click();
    await expect(page.getByTestId('decision-note')).toContainText('Hire');

    // TEAM-10: Dee withdrew: a decision with no judgements at all, from the candidate page. Fast: pick, one sentence, save.
    await openCandidate(page, 'Dee Ng');
    await page.getByRole('button', { name: 'Record panel decision' }).click();
    dlg = modal(page, 'Record the panel decision');
    await dlg.getByRole('group', { name: /Agreed recommendation/ }).getByRole('radio', { name: 'No hire', exact: true }).check();
    await dlg.getByLabel('Why').fill('Withdrew before the interview.');
    await dlg.getByRole('button', { name: 'Save panel decision' }).click();
    await expect(page.getByTestId('decision-card')).toContainText('No hire');

    // SUM-4: the written summary is saved as it is typed and survives a reload.
    await openCandidate(page, 'Ana Diaz');
    await page.getByRole('textbox', { name: 'Written summary' }).fill('Clear thinker; ready for the final round.');
    await expect(page.getByTestId('summary-status')).toContainText('last edited by Olive Organiser');
    await page.reload();
    await expect(page.getByRole('textbox', { name: 'Written summary' })).toHaveValue('Clear thinker; ready for the final round.');
    await expect(page.getByTestId('cand-score')).toContainText('Agreed scores');
    failures.push(...(await checkState(page, 'candidate', [1280, 1440, 390])));
    await plainWords(page, 'candidate page');

    // SUM-1: outcome, score source, missing states; sort, filter and search.
    await openSummary(page);
    await expect(row(page, 'Ana Diaz')).toContainText('Panel decision');
    await expect(row(page, 'Ana Diaz')).toContainText('Agreed scores');
    await expect(row(page, 'Ana Diaz')).toContainText('Nothing');
    await expect(row(page, 'Bo Li')).toContainText('Split');
    await expect(row(page, 'Bo Li')).toContainText('Panel median of 2');
    await expect(row(page, 'Chen Wu')).toContainText('One interviewer (Cy Third)');
    await expect(row(page, 'Dee Ng')).toContainText('Panel decision');
    await page.getByLabel('Outcome').selectOption('split');
    await expect(page.getByTestId('summary-row')).toHaveCount(1);
    await page.getByLabel('Outcome').selectOption('');
    await page.getByRole('button', { name: /not interviewed yet/ }).click();
    await expect(page.getByTestId('summary-row')).toHaveCount(2);
    await page.getByRole('button', { name: /not interviewed yet/ }).click();
    await page.getByLabel('Find a candidate').fill('  chen   WU ');
    await expect(page.getByTestId('summary-row')).toHaveCount(1);
    await page.getByLabel('Find a candidate').fill('');
    await page.getByRole('button', { name: /^Candidate/ }).click();
    await expect(page.getByTestId('summary-row').first()).toContainText('Ana Diaz');
    await page.getByRole('button', { name: /^Candidate/ }).click();
    await expect(page.getByTestId('summary-row').first()).toContainText('Fay Sato');
    await page.getByRole('button', { name: /^Score/ }).click();
    await expect(page.getByTestId('summary-row').first()).toContainText('Ana Diaz');

    // SUM-5: the round report as Markdown, CSV and a print layout.
    const exportMenu = async (item: string) => {
      await page.getByRole('button', { name: 'Export', exact: true }).click();
      await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
    };
    const md = await downloadText(page, () => exportMenu('Round report (Markdown)'));
    expect(md.name).toMatch(/^interview-round-report-/);
    expect(md.text.indexOf('## Overview')).toBeLessThan(md.text.indexOf('## Ana Diaz'));
    expect(md.text).toContain('Clear thinker; ready for the final round.');
    expect(md.text).toContain('Entered by Olive Organiser on behalf of Cy Third');
    expect(md.text).toContain('Panel decision: Hire');
    const csv = await downloadText(page, () => exportMenu('Table as CSV'));
    expect(csv.text.split('\r\n')).toHaveLength(8);
    expect(csv.text).toContain('Ana Diaz,REQ-42');
    await exportMenu('Round report: print or save as PDF');
    await expect(page.getByTestId('round-print')).toHaveCount(1);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('round-print')).toBeVisible();
    await expect(page.getByTestId('round-print')).toContainText('Interview round summary');
    await expect(page.getByRole('heading', { name: 'Ana Diaz · REQ-42' })).toBeVisible();
    await expect(page.locator('.summary__screen')).toBeHidden();
    if (shotDir) await page.screenshot({ path: `${shotDir}/summary-print.png`, fullPage: true });
    if (shotDir) await page.pdf?.({ path: `${shotDir}/summary-print.pdf`, format: 'A4' }).catch(() => {});
    await page.emulateMedia({ media: 'screen' });

    // TEAM-13: one panel file for the whole view, to the hiring manager.
    await page.reload();
    await exportMenu('Panel file for everyone shown…');
    dlg = modal(page, 'Export a panel file');
    await expect(dlg.getByRole('checkbox', { name: 'Include transcripts' })).not.toBeChecked();
    await expect(dlg.getByRole('checkbox', { name: 'Include the AI second opinion' })).not.toBeChecked();
    failures.push(...(await checkState(page, 'panel-file-dialog')));
    const panel = await downloadText(page, () => dlg.getByRole('button', { name: 'Export panel file' }).click());
    const panelPath = `${dir}/panel.json`;
    writeFileSync(panelPath, panel.text);
    expect(JSON.parse(panel.text).panels).toHaveLength(6);
    const cells = async (p: Page) => (await p.getByTestId('summary-row').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ')).sort();
    const organiserView = await cells(page);

    const hm = await computer(browser, guard, 'Hana Manager');
    await importFiles(hm, panelPath);
    await openSummary(hm);
    await expect(hm.getByTestId('summary-row')).toHaveCount(6);
    expect(await cells(hm)).toEqual(organiserView);
    // The hiring manager changes Ana's decision; a later file from the organiser does not overwrite it silently.
    await hm.goto('./#/summary');
    await row(hm, 'Ana Diaz').getByRole('link', { name: 'Ana Diaz', exact: true }).click();
    await hm.getByRole('button', { name: /^Change/ }).click();
    dlg = modal(hm, 'Change the panel decision');
    await dlg.getByRole('group', { name: /Agreed recommendation/ }).getByRole('radio', { name: 'Lean no hire', exact: true }).check();
    await dlg.getByRole('button', { name: 'Save the change' }).click();
    await expect(dlg.getByText('Give a reason for the change.')).toBeVisible();
    await dlg.getByLabel('Reason for the change').fill('Budget for one hire only');
    await dlg.getByRole('button', { name: 'Save the change' }).click();
    await expect(hm.getByTestId('decision-card')).toContainText('Lean no hire');
    const again = await importFiles(hm, panelPath);
    await expect(again).toContainText('1 difference to settle');
    await expect(again).toContainText('their panel decision differs from yours (yours kept for now)');
    await expect(hm.getByTestId('import-conflict')).toContainText('Olive Organiser’s panel decision is different');
    failures.push(...(await checkState(hm, 'import-conflict')));
    await plainWords(hm, 'import conflict');
    await hm.getByRole('button', { name: /^Take theirs/ }).click();
    await expect(hm.getByTestId('import-conflict')).toContainText('Took theirs');
    await openSummary(hm);
    await expect(row(hm, 'Ana Diaz')).toContainText('Hire');
    await expect(row(hm, 'Ana Diaz')).not.toContainText('Lean no hire');
    await hm.context().close();

    // TEAM-8 AUD-4: a hand-entered judgement and a decision are corrected with a reason; both audited.
    await openCandidate(page, 'Bo Li');
    await page.getByRole('button', { name: /^Correct…/ }).click();
    dlg = modal(page, 'Correct Cy Third’s judgement');
    await dlg.getByRole('group', { name: /Their recommendation/ }).getByRole('radio', { name: 'Lean no hire', exact: true }).check();
    await dlg.getByLabel('Reason for the correction').fill('Misread the paper form');
    await dlg.getByRole('button', { name: 'Save the correction' }).click();
    await expect(page.getByTestId('judgement-row').filter({ hasText: 'Cy Third' })).toContainText('Lean no hire');
    await openCandidate(page, 'Dee Ng');
    await page.getByRole('button', { name: /^Change/ }).click();
    dlg = modal(page, 'Change the panel decision');
    await dlg.getByLabel('Why').fill('Withdrew; may reapply next year.');
    await dlg.getByLabel('Reason for the change').fill('Clearer wording');
    await dlg.getByRole('button', { name: 'Save the change' }).click();
    await expect(page.getByTestId('decision-card')).toContainText('may reapply');
    await page.goto('./#/admin?tab=audit');
    const log = page.getByRole('table', { name: 'Audit log' });
    await page.getByLabel('Action').selectOption({ label: 'Panel decision changed' });
    await expect(log.locator('tbody tr')).toHaveCount(1);
    await expect(log).toContainText('Clearer wording');
    await page.getByLabel('Action').selectOption({ label: 'Edited after submission' });
    await expect(log).toContainText('Misread the paper form');
    await page.getByLabel('Action').selectOption({ label: 'Judgement entered on someone’s behalf' });
    await expect(log.locator('tbody tr')).toHaveCount(2);

    // TEAM-14: a deletion request removes Bo's records, hand-entered judgement, decision and summary.
    await page.goto('./#/admin?tab=privacy');
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Access and deletion requests' }) });
    await card.getByRole('textbox', { name: 'Candidate', exact: true }).fill('bo li');
    await card.getByLabel('Requisition id').fill('req-42');
    await card.getByRole('button', { name: /Delete/ }).first().click();
    await modal(page, 'Delete everything for this candidate?').getByRole('button', { name: /^Delete/ }).click();
    await expect(card).toContainText('Deletion request: deleted 3 interviews');
    await openSummary(page);
    await expect(page.getByTestId('summary-row')).toHaveCount(5);
    await expect(page.locator('main')).not.toContainText('Bo Li');
    expect(failures).toEqual([]);
  });
});

test.describe('Summary with different question sets', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('SUM-2 SUM-1 A11Y-7: candidates asked different questions are listed together, grouped by question set and marked as not directly comparable', async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page, 'Olive Organiser');
    const a = await planRound(page, 8);
    const b = await planRound(page, 4, { prefix: 'Mx ', firstDay: -3 });
    expect(a.interviews[0].plan.id).not.toBe(b.interviews[0].plan.id);
    const text = panelFileText([...a.interviews, ...b.interviews].map((it, i) => panelEntry(it, mixedSpec(i, ['Ben Second', 'Cy Third']))));
    await importFiles(page, { name: 'round.json', mimeType: 'application/json', buffer: Buffer.from(text) });
    await openSummary(page);
    await expect(page.getByTestId('summary-row')).toHaveCount(12);
    await expect(page.getByRole('note')).toContainText('2 different question sets');
    const groups = page.locator('.sum-group');
    await expect(groups).toHaveCount(2);
    await expect(groups.nth(0).getByTestId('summary-row')).toHaveCount(4); // the newest round first
    await expect(groups.nth(1).getByTestId('summary-row')).toHaveCount(8);
    // FLOW-30: the category matrix stays one click away for a question set.
    await groups.nth(1).getByRole('link', { name: /^Compare by category/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Compare candidates' })).toBeVisible();
    await expect(page.locator('.cmp-matrix')).toContainText('Panel median of 2');
    await expect(page.locator('.cmp-matrix')).toContainText('one interviewer’s');
    await openSummary(page);
    const failures = await checkState(page, 'mixed-12', [1280, 1440, 390]);
    expect(failures).toEqual([]);
  });

  for (const n of [3, 30]) {
    test(`screenshots of the Summary with ${n} candidates in mixed states`, async ({ page }) => {
      test.skip(!shotDir, 'only when E2E_SCREENSHOT_DIR is set');
      test.setTimeout(240_000);
      await openApp(page, 'Olive Organiser');
      const inv = await planRound(page, n);
      await importMixedResults(page, inv);
      await openSummary(page);
      expect(await checkState(page, `round-${n}`, [1280, 1440, 390])).toEqual([]);
    });
  }
});
