import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  addNote,
  currentQuestionNumber,
  expect,
  expectQuestion,
  fillCandidate,
  focusQuestion,
  confirmConsent,
  continueToReady,
  modal,
  openApp,
  openNewInterview,
  randomDraw,
  scoreRadio,
  test,
  exportFromScorecard,
} from './fixtures';

test.describe('MVP pilot end to end', () => {
  test('MVP-1 OV-1 RES-3 FLOW-1 FLOW-3 FLOW-7 FLOW-8 FLOW-10 FLOW-13 FLOW-15 FLOW-17 FLOW-18 FLOW-22 FLOW-23 FLOW-24 FLOW-31 KEY-1 PRIV-3: a 10+ question interview works end to end offline through the UI', async ({
    page,
    context,
    guard,
  }) => {
    // First load online, then wait until the service worker controls the page (OV-1).
    await openApp(page, 'Alex Interviewer');
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((resolve) => navigator.serviceWorker.addEventListener('controllerchange', () => resolve(), { once: true }));
      }
    });

    // From here on the browser is offline. A reload is served by the service worker.
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'You are offline' })).toContainText('continues to be saved on this device'); // RES-3

    // FLOW-1: four tracks listed; FLOW-3: a set drawn with default quotas, shuffled once.
    await expect(page.locator('.dash-banklinks > li')).toHaveCount(4);
    await openNewInterview(page, 'qa');
    const drawn = await randomDraw(page);
    expect(drawn).toBeGreaterThanOrEqual(10);

    // FLOW-7: candidate details; FLOW-8: Continue pins the set.
    await fillCandidate(page, { initials: 'jd', requisitionId: 'REQ-77' });
    await continueToReady(page);
    await expect(page.getByText('JD · REQ-77').first()).toBeVisible();

    // FLOW-7, FLOW-10: consent with the candidate, then start.
    await confirmConsent(page);
    await page.getByRole('button', { name: 'Start interview' }).click();
    await expectQuestion(page, 1);

    // Score every question with the keyboard (KEY-1), with ticks and notes (FLOW-13, FLOW-15),
    // one skip with a reason (FLOW-17, key S) and one flag (FLOW-18, key F).
    const scores = [3, 2, 4, 1, 3, 2, 3, 3, 4, 2, 3, 3, 2, 3];
    for (let n = 1; n <= drawn; n++) {
      await expectQuestion(page, n);
      expect(await currentQuestionNumber(page)).toBe(n);
      if (n === 2) {
        await focusQuestion(page);
        await page.keyboard.press('s');
        const dlg = modal(page, `Skip question ${n}`);
        await dlg.getByLabel('Reason for skipping').fill('Ran out of time on this topic');
        await dlg.getByRole('button', { name: 'Skip question' }).click();
        await expect(page.getByText('Reason: Ran out of time on this topic')).toBeVisible();
      } else {
        const tick = page.locator('.checklist').first().getByRole('checkbox').first();
        await tick.click();
        await expect(tick).toBeChecked();
        const score = scores[n - 1];
        await focusQuestion(page);
        await page.keyboard.press(String(score));
        await expect(scoreRadio(page, score)).toBeChecked();
        if (score === 1 || score === 4 || n === 1) await addNote(page, `Q${n}: candidate described a concrete example`);
      }
      if (n === 3) {
        await focusQuestion(page);
        await page.keyboard.press('f');
        await expect(page.getByRole('button', { name: /Flagged for debrief/ })).toBeVisible();
      }
      if (n < drawn) {
        await focusQuestion(page);
        await page.keyboard.press('n');
      }
    }

    // FLOW-22 / FLOW-23: finish and submit.
    await page.getByRole('button', { name: 'Finish…' }).click();
    const finish = modal(page, 'Finish and submit the interview');
    await expect(finish.getByRole('heading', { name: 'Every question is scored or skipped' })).toBeVisible();
    await finish.getByRole('group', { name: /Overall rating/ }).getByRole('radio', { name: /^3 / }).check();
    await finish.getByRole('group', { name: /Recommendation/ }).getByRole('radio', { name: 'Hire', exact: true }).check();
    await finish.getByLabel('Rationale').fill('Solid across most areas; probe the skipped topic in the debrief.');
    await finish.getByRole('button', { name: 'Submit interview' }).click();

    // FLOW-24: the scorecard.
    await expect(page.getByRole('heading', { level: 1, name: 'Scorecard: JD · REQ-77' })).toBeVisible();
    const main = page.locator('main');
    await expect(main).toContainText('Advisory');
    await expect(main).toContainText('Ran out of time on this topic');
    await expect(main).toContainText('Hire');
    await expect(main).toContainText('Solid across most areas');

    // FLOW-31: Markdown and CSV exports (made offline).
    const md = await exportFromScorecard(page, 'Markdown');
    expect(md.name).toMatch(/^interview-scorecard-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.md$/);
    expect(md.text).toContain('# Scorecard: JD (REQ-77)');
    expect(md.text).toContain('Ran out of time on this topic');
    expect(md.text).toContain('Advisory band');
    const csv = await exportFromScorecard(page, 'CSV, one row per question');
    expect(csv.name).toMatch(/\.csv$/);
    const lines = csv.text.trim().split('\r\n');
    expect(lines[0]).toMatch(/^Order,Question id,/);
    // One row per question; notes may contain line breaks only inside quoted cells.
    const rows = csv.text.match(/\r\n\d+,qa-\d+,/g) ?? [];
    expect(rows).toHaveLength(drawn);

    // The scorecard is still there after an offline reload.
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Scorecard: JD · REQ-77' })).toBeVisible();

    // PRIV-3: initials and requisition never appear in a URL or the console.
    for (const u of [...guard.pageUrls, ...guard.requests]) expect(u).not.toMatch(/REQ-77|\bJD\b/i);
    for (const m of guard.console) expect(m).not.toMatch(/REQ-77|\bJD\b/);
  });

  test('SEC-1 PRIV-2 TR-2: the built index.html ships a strict CSP and loads only same-origin resources', async ({ page }) => {
    const html = readFileSync(fileURLToPath(new URL('../dist/index.html', import.meta.url)), 'utf8');
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    expect(csp, 'CSP meta tag present').toBeTruthy();
    const directives = Object.fromEntries(csp!.split(';').map((d) => d.trim().split(/\s+/)).map(([k, ...v]) => [k, v]));
    expect(directives['script-src']).toEqual(["'self'"]);
    expect(directives['connect-src']).toEqual(["'self'"]);
    expect(directives['default-src']).toEqual(["'self'"]);
    // TR-2: a recording plays from an object URL of the stored file; blob: is allowed for media only.
    expect(directives['media-src']).toEqual(["'self'", 'blob:']);
    expect(Object.entries(directives).filter(([k, v]) => k !== 'media-src' && (v as string[]).some((x) => /blob:|data:|\*|https?:/.test(x) && !(k === 'img-src' && x === 'data:')))).toEqual([]);
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
    // No inline scripts and no third-party URLs in the shipped HTML.
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)[^>]*>/);
    expect(html).not.toMatch(/https?:\/\//);
    // The page renders under that policy without CSP violations (the guard fails on console errors).
    await openApp(page);
    await page.goto('./#/docs');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  });
});
