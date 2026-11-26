import { expect, expectQuestion, focusQuestion, openApp, scoreRadio, setupInterview, test, type Page } from './fixtures';

/** Seconds shown by a timer ("m:ss" or "h:mm:ss"). */
async function timerSec(page: Page, label: 'Overall' | 'This question'): Promise<number> {
  const t = await page.locator('.timer', { hasText: label }).locator('.timer__digits').innerText();
  return t.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);
}

async function snapshotQuestion(page: Page) {
  const ticks = await page.locator('.interviewer-pane input[type=checkbox]').evaluateAll((els) => els.map((e) => (e as HTMLInputElement).checked));
  const score = await page.locator('fieldset.score-control input[type=radio]:checked').getAttribute('value').catch(() => null);
  const notes = await page.getByRole('list', { name: 'Notes for this question' }).innerText().catch(() => '');
  const flagged = await page.getByRole('button', { name: /Flagged for debrief/ }).count();
  return { ticks, score, notes, flagged };
}

test.describe('Resilience', () => {
  test('MVP-2 RES-1 RES-2 FLOW-13 FLOW-21 DATA-3: a reload mid-interview (running, paused, half-typed note) loses nothing and timers do not reset', async ({ page }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3, 4], candidate: { initials: 'RS', requisitionId: 'R-1' } });

    // Question 1: ticks, a red flag, the probe, a score, a flag and a finished note.
    const boxes = page.locator('.interviewer-pane input[type=checkbox]');
    for (const i of [0, 1]) {
      await boxes.nth(i).click();
      await expect(boxes.nth(i)).toBeChecked();
    }
    await focusQuestion(page);
    await page.keyboard.press('3');
    await expect(scoreRadio(page, 3)).toBeChecked();
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: /Flagged for debrief/ })).toBeVisible();
    const box = page.getByPlaceholder('What did the candidate say?');
    await box.fill('Finished note on question one');
    await box.press('Enter');
    await expect(page.getByRole('list', { name: 'Notes for this question' })).toContainText('Finished note on question one');
    const q1 = await snapshotQuestion(page);

    // Question 2: a half-typed note (no Enter), then reload straight away.
    await focusQuestion(page);
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    await page.getByPlaceholder('What did the candidate say?').pressSequentially('Half typed thou', { delay: 20 });
    await page.waitForTimeout(700); // longer than the autosave debounce
    await page.waitForTimeout(1500);
    const overallBefore = await timerSec(page, 'Overall');
    expect(overallBefore).toBeGreaterThanOrEqual(1);
    await page.reload();

    // RES-1: same question, the half-typed note is kept as a note entry.
    await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();
    await expectQuestion(page, 2);
    await expect(page.getByRole('list', { name: 'Notes for this question' })).toContainText('Half typed thou');
    // RES-2: the overall timer continues from stored timestamps; it did not reset.
    expect(await timerSec(page, 'Overall')).toBeGreaterThanOrEqual(overallBefore);
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    expect(await snapshotQuestion(page)).toEqual(q1);

    // FLOW-21: pause, reload while paused; time does not move and the state stays paused.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.paused-banner__title')).toBeVisible();
    const pausedOverall = await timerSec(page, 'Overall');
    const pausedQuestion = await timerSec(page, 'This question');
    await page.reload();
    await expect(page.locator('.paused-banner__title')).toBeVisible();
    await page.waitForTimeout(2200);
    expect(await timerSec(page, 'Overall')).toBe(pausedOverall);
    expect(await timerSec(page, 'This question')).toBe(pausedQuestion);
    await expectQuestion(page, 1);
    expect(await snapshotQuestion(page)).toEqual(q1);

    // A note typed while paused also survives (RES-1).
    await page.getByPlaceholder('What did the candidate say?').pressSequentially('Typed while paused', { delay: 20 });
    await page.waitForTimeout(700);
    await page.reload();
    await expect(page.getByRole('list', { name: 'Notes for this question' })).toContainText('Typed while paused');

    // Resume: timers run on from where they stopped.
    await page.getByRole('button', { name: 'Resume' }).first().click();
    await expect(page.locator('.paused-banner__title')).toHaveCount(0);
    await page.waitForTimeout(2200);
    expect(await timerSec(page, 'Overall')).toBeGreaterThan(pausedOverall);
    expect(await timerSec(page, 'Overall')).toBeLessThan(pausedOverall + 10);
  });

  test('RES-2 DATA-3: per-question time is kept per question across navigation and reload', async ({ page }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'PQ' } });
    await page.waitForTimeout(2200);
    await focusQuestion(page);
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    expect(await timerSec(page, 'This question')).toBeLessThanOrEqual(1);
    await page.reload();
    await expectQuestion(page, 2);
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    const q1 = await timerSec(page, 'This question');
    expect(q1).toBeGreaterThanOrEqual(2);
  });
});
