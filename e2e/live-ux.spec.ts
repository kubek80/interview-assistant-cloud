// The "Ease of use" rules of the live interview and finishing (docs/02-interview-flow.md, UX-4 to UX-6),
// measured in the real UI at a laptop-sized window.
import {
  addNote,
  continueToReady,
  expect,
  expectQuestion,
  finishInterview,
  focusQuestion,
  modal,
  openApp,
  openNewInterview,
  pickByNumber,
  scoreRadio,
  seed,
  startInterview,
  test,
  type Page,
} from './fixtures';
import type { Locator } from '@playwright/test';
import { leadLabel } from '../src/domain/leadLabel';

type Box = { x: number; y: number; width: number; height: number };

async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'element is rendered').not.toBeNull();
  return b!;
}

/** The parts of the screen between the bars: what is drawn there must not be hidden under either bar. */
async function frame(page: Page) {
  const vp = page.viewportSize()!;
  const dock = await box(page.locator('.live-dock'));
  const bar = await box(page.locator('.live-bar'));
  return { vp, top: bar.y + bar.height, bottom: dock.y, dock };
}

async function expectInWindow(page: Page, what: string, l: Locator) {
  const { vp } = await frame(page);
  const b = await box(l);
  expect(b.y, `${what}: top inside the window`).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height, `${what}: bottom inside the window`).toBeLessThanOrEqual(vp.height);
  expect(b.x, `${what}: left inside the window`).toBeGreaterThanOrEqual(0);
  expect(b.x + b.width, `${what}: right inside the window`).toBeLessThanOrEqual(vp.width);
}

async function expectBetweenBars(page: Page, what: string, l: Locator) {
  const { top, bottom } = await frame(page);
  const b = await box(l);
  expect(b.y, `${what}: not under the top bar`).toBeGreaterThanOrEqual(top - 1);
  expect(b.y + b.height, `${what}: not under the bottom bar`).toBeLessThanOrEqual(bottom + 1);
}

/**
 * UX-4: the question, the whole "what to look for" list, the four score buttons and Next (or Finish)
 * on screen, unscrolled. The checklist card never reaches under the bottom bar: when its lists do
 * not all fit it scrolls inside itself, with a cue at its bottom edge that hides no key point.
 */
async function expectQuestionAtAGlance(page: Page, n: number, last: boolean) {
  expect(await page.evaluate(() => window.scrollY), `question ${n}: the page is not scrolled`).toBe(0);
  await expectBetweenBars(page, `question ${n} text`, page.locator('.question-pane .question-text'));
  const looks = page.locator('.evidence__group--look .checklist li');
  expect(await looks.count()).toBeGreaterThan(0);
  await expectBetweenBars(page, `question ${n} last key point`, looks.last());
  const card = page.locator('.interviewer-pane');
  await expectBetweenBars(page, `question ${n} checklist card`, card);
  const inner = await card.evaluate((el) => el.scrollHeight > el.clientHeight + 1);
  const cue = page.locator('.interviewer-pane__more-button');
  if (inner) {
    await expect(cue, `question ${n}: the card scrolls inside itself, so it says what is below`).toBeVisible();
    expect((await box(looks.last())).y + (await box(looks.last())).height, `question ${n}: the cue hides no key point`).toBeLessThanOrEqual((await box(cue)).y + 1);
  } else {
    await expect(cue, `question ${n}: everything fits, so no cue`).toHaveCount(0);
  }
  const options = page.locator('.live-dock fieldset.score-control .score-option');
  await expect(options).toHaveCount(4);
  for (let i = 0; i < 4; i++) await expectInWindow(page, `question ${n} score button ${i + 1}`, options.nth(i));
  await expectInWindow(page, `question ${n} ${last ? 'Finish' : 'Next'}`, page.locator('.live-dock').getByRole('button', { name: last ? 'Finish…' : /^Next/ }));
}

/** BANK-15: in the live checklist, each item's leading label (and only that) is emphasised, as leadLabel decides. */
async function expectLabelsEmphasised(page: Page, n: number, items: readonly string[], group: 'look' | 'flags') {
  const shown = await page.locator(`.evidence__group--${group} .checklist li`).evaluateAll((lis) => lis.map((li) => ({ text: li.textContent ?? '', lead: li.querySelector('.item-lead')?.textContent ?? null })));
  expect(shown.map((x) => x.text), `question ${n}: the ${group} items, unchanged`).toEqual([...items]);
  expect(shown.map((x) => x.lead), `question ${n}: the ${group} labels`).toEqual(items.map((s) => leadLabel(s)?.lead ?? null));
}

test.describe('Ease of use: the live interview', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('UX-4 FLOW-11 FLOW-12 FLOW-20: at 1280 × 800 every question of a typical interview shows the question, its whole "what to look for" list, the four score buttons and Next without scrolling; the bars stay in view while the middle scrolls', async ({ page }) => {
    test.setTimeout(150_000);
    await openApp(page);
    await openNewInterview(page, 'qa');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('UX');
    await continueToReady(page);
    await startInterview(page);
    const total = Number((await page.locator('.progress__summary').innerText()).match(/of (\d+)/)![1]);
    expect(total).toBeGreaterThanOrEqual(10);
    for (let n = 1; n <= total; n++) {
      await expectQuestion(page, n);
      await expectQuestionAtAGlance(page, n, n === total);
      if (n < total) {
        await focusQuestion(page);
        await page.keyboard.press('n');
      }
    }

    // A long middle (many notes on one question) scrolls; the top bar, the score buttons and Next stay put.
    await page.getByRole('button', { name: /^Question 1: / }).click();
    await expectQuestion(page, 1);
    for (let i = 1; i <= 9; i++) await addNote(page, `Note ${i}: ${'the candidate explained the trade-off in some detail. '.repeat(2)}`);
    await page.getByRole('button', { name: /^Show \d+ earlier notes?$/ }).click();
    const before = await box(page.locator('.live-dock fieldset.score-control'));
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await expect.poll(() => page.evaluate(() => window.scrollY), { message: 'the middle scrolls' }).toBeGreaterThan(100);
    const options = page.locator('.live-dock fieldset.score-control .score-option');
    for (let i = 0; i < 4; i++) await expectInWindow(page, `after scrolling: score button ${i + 1}`, options.nth(i));
    await expectInWindow(page, 'after scrolling: Next', page.locator('.live-dock').getByRole('button', { name: /^Next/ }));
    await expectInWindow(page, 'after scrolling: the top bar', page.locator('.live-bar h1'));
    expect((await box(page.locator('.live-dock fieldset.score-control'))).y).toBe(before.y);
    // Nothing is left hidden under the bottom bar: the last note scrolls clear of it.
    await expectBetweenBars(page, 'the last note', page.getByRole('list', { name: 'Notes for this question' }).getByRole('listitem').last());
    // The score still works from there.
    await focusQuestion(page);
    await page.keyboard.press('3');
    await expect(scoreRadio(page, 3)).toBeChecked();
  });

  // UX-4 BANK-15: every bundled question, not a sample. One interview per track holds all of its
  // questions, so the question strip in the top bar is at its tallest (three rows of numbers): a
  // harder case than a typical interview of 14.
  for (const track of ['qa', 'web', 'edge', 'aks'] as const) {
    test(`UX-4 BANK-15: at 1280 × 800 every question of the ${track} track shows the question, its whole "what to look for" list, the score buttons and Next without scrolling; labels are emphasised`, async ({ page }) => {
      test.setTimeout(240_000);
      const questions = seed(track).questions;
      await openApp(page);
      await openNewInterview(page, track);
      await pickByNumber(page, questions.map((q) => q.number));
      await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('UX');
      await continueToReady(page);
      await startInterview(page);
      let innerScrolls = 0;
      for (let n = 1; n <= questions.length; n++) {
        await expectQuestion(page, n);
        await expect(page.locator('.question-pane .question-text')).toHaveText(questions[n - 1].text);
        await expectQuestionAtAGlance(page, n, n === questions.length);
        await expectLabelsEmphasised(page, n, questions[n - 1].lookFor, 'look');
        await expectLabelsEmphasised(page, n, questions[n - 1].redFlags, 'flags');
        if (await page.locator('.interviewer-pane__more-button').count()) innerScrolls++;
        if (n < questions.length) {
          await focusQuestion(page);
          await page.keyboard.press('n');
        }
      }
      test.info().annotations.push({ type: 'UX-4', description: `${track}: ${innerScrolls} of ${questions.length} questions scroll the checklist card inside itself` });
      // The cue scrolls the card to what is below; the bars and the page stay put.
      await page.getByRole('button', { name: /^Question 1: / }).click();
      await expectQuestion(page, 1);
      const cue = page.locator('.interviewer-pane__more-button');
      if (await cue.count()) {
        await cue.click();
        // The card scrolls (smoothly unless reduced motion is asked for) until the last red flag is inside it.
        const lastFlagInside = () =>
          page.evaluate(() => {
            const flags = document.querySelectorAll('.evidence__group--flags .checklist li');
            const card = document.querySelector('.interviewer-pane')!.getBoundingClientRect();
            return flags[flags.length - 1].getBoundingClientRect().bottom <= card.bottom + 1;
          });
        await expect.poll(lastFlagInside, { message: 'after the cue: the red flags are in view inside the card' }).toBe(true);
        expect(await page.evaluate(() => window.scrollY)).toBe(0);
      }
    });
  }

  test('UX-5 A11Y-1 FLOW-21 FLOW-34 RES-1: while an interview runs the header offers exactly one way out, help opens in a new tab, secondary actions sit in one keyboard menu, and leaving returns to the Dashboard with the interview ready to resume', async ({ page }) => {
    await openApp(page);
    await openNewInterview(page, 'qa');
    await pickByNumber(page, [1, 2, 3]);
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('EX');
    await continueToReady(page);
    // Before the start (the ready screen) the usual navigation is there.
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(5);
    await startInterview(page);
    await focusQuestion(page);
    await page.keyboard.press('3');
    await expect(scoreRadio(page, 3)).toBeChecked();
    await page.keyboard.press('n');
    await expectQuestion(page, 2);

    // One way out, explicit, saying that the work is kept.
    const banner = page.getByRole('banner');
    await expect(banner.getByRole('link')).toHaveCount(1);
    await expect(banner.getByRole('link')).toHaveAccessibleName('Exit to dashboard');
    await expect(banner.getByRole('link')).toHaveAccessibleDescription(/Saved as you go · resume any time/);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(1);
    // No other link on the screen leaves the interview: help opens in a new tab.
    const sameTab = await page.locator('main a[href]').evaluateAll((els) => els.filter((e) => e.getAttribute('target') !== '_blank').map((e) => e.textContent?.trim() || e.getAttribute('aria-label')));
    expect(sameTab).toEqual([]);

    // Secondary actions: one menu button (WAI-ARIA menu button pattern).
    const more = page.getByRole('button', { name: 'More', exact: true });
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await expect(more).toHaveAttribute('aria-expanded', 'false');
    await more.focus();
    await page.keyboard.press('ArrowDown');
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(more).toHaveAttribute('aria-expanded', 'true');
    const items = menu.getByRole('menuitem');
    const names = ['Candidate view', 'Open candidate window', 'Interviewers…', 'Transcript & recording…', 'Keyboard shortcuts'];
    await expect(items).toHaveCount(names.length);
    for (let i = 0; i < names.length; i++) await expect(items.nth(i)).toHaveAccessibleName(names[i]);
    // The shortcut hints live here (and in the shortcuts dialog), not on every control.
    await expect(items.nth(0)).toHaveAttribute('aria-keyshortcuts', 'C');
    const focused = () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
    await expect.poll(focused).toBe('Candidate viewC');
    await page.keyboard.press('End');
    await expect.poll(focused).toBe('Keyboard shortcuts?');
    await page.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe('Candidate viewC');
    await page.keyboard.press('ArrowUp');
    await expect.poll(focused).toBe('Keyboard shortcuts?');
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await expect.poll(focused).toBe('Open candidate window');
    // Keys pressed in the menu stay in the menu (no score, no move).
    await page.keyboard.press('4');
    await expect(scoreRadio(page, 4)).not.toBeChecked();
    await expectQuestion(page, 2);
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    // Enter opens it on the first item; Enter chooses; the dialog returns focus to the menu button.
    await page.keyboard.press('Enter');
    await expect.poll(focused).toBe('Candidate viewC');
    await page.keyboard.press('End');
    await page.keyboard.press('Enter');
    await expect(modal(page, 'Keyboard shortcuts')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(more).toBeFocused();
    // Tab leaves the menu and closes it; a click outside closes it too.
    await page.keyboard.press('ArrowDown');
    await expect(menu).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(menu).toHaveCount(0);
    await more.click();
    await expect(menu).toBeVisible();
    await page.locator('.question-pane .question-text').click();
    await expect(menu).toHaveCount(0);

    // Paused: still one way out.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(page.locator('.paused-banner')).toBeVisible();
    await expect(banner.getByRole('link')).toHaveCount(1);

    // Leaving: back on the Dashboard with the full navigation, the interview first in line to continue.
    await banner.getByRole('link', { name: 'Exit to dashboard' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link')).toHaveCount(5);
    await expect(page.locator('.continue')).toContainText('EX');
    await page.getByRole('link', { name: /^Continue interview/ }).click();
    await expectQuestion(page, 2);
    await expect(page.locator('.paused-banner')).toBeVisible();
    await page.getByRole('button', { name: 'Resume' }).first().click();
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    await expect(scoreRadio(page, 3)).toBeChecked();
  });

  test('UX-6 UX-9 FLOW-16 FLOW-17 FLOW-22 PANEL-4: with many questions unanswered, Finish sums them up in one line (not a row each), goes to the first one, and skips the rest with one reason; each skip can still be undone', async ({ page }) => {
    test.setTimeout(120_000);
    await openApp(page, 'Fay Finish');
    await openNewInterview(page, 'qa');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('FN');
    await continueToReady(page);
    await startInterview(page);
    const total = Number((await page.locator('.progress__summary').innerText()).match(/of (\d+)/)![1]);
    await focusQuestion(page);
    await page.keyboard.press('3');
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    await focusQuestion(page);
    await page.keyboard.press('4'); // needs a note

    await page.getByRole('button', { name: 'Finish…' }).click();
    const dlg = modal(page, 'Finish and submit the interview');
    const left = total - 2;
    await expect(dlg.getByRole('heading', { name: `${left + 1} questions to resolve first` })).toBeVisible();
    await expect(dlg).toContainText(`Not scored or skipped yet: questions 3–${total}.`);
    // A summary, not a row per question: one "go to" for the unanswered ones, one link for the missing note.
    await expect(dlg.getByRole('button', { name: /^Go to/ })).toHaveCount(1);
    await expect(dlg.getByRole('button', { name: 'Question 2 scored 4' })).toBeVisible();
    await expect(dlg.getByRole('listitem')).toHaveCount(1);
    await expect(dlg).not.toContainText('neither scored nor skipped');
    // PANEL-4 and the lock warning in one calm sentence.
    await expect(dlg).toContainText('Recorded by Fay Finish.');
    await expect(dlg).toContainText('After you submit, a change needs a reason and is recorded.');

    // Go to the first one.
    await dlg.getByRole('button', { name: 'Go to the first one (question 3)' }).click();
    await expect(dlg).toHaveCount(0);
    await expectQuestion(page, 3);

    // Skip the remaining with one reason (required).
    await page.getByRole('button', { name: 'Finish…' }).click();
    await dlg.getByRole('button', { name: `Skip the remaining ${left}…` }).click();
    const reason = dlg.getByLabel(`One reason for skipping all ${left}`);
    await expect(reason).toBeFocused();
    await dlg.getByRole('button', { name: `Skip ${left} questions` }).click();
    await expect(dlg).toContainText('A reason is required.');
    await reason.fill('Ran out of time');
    await dlg.getByRole('button', { name: `Skip ${left} questions` }).click();
    await expect(dlg.getByRole('status')).toContainText(`Skipped ${left} questions: “Ran out of time”.`);
    await expect(dlg.getByRole('heading', { name: '1 question to resolve first' })).toBeVisible();
    await expect(dlg).not.toContainText('Not scored or skipped yet');
    // Undo all of them at once, then skip again.
    await dlg.getByRole('button', { name: 'Undo' }).click();
    await expect(dlg).toContainText(`Not scored or skipped yet: questions 3–${total}.`);
    await dlg.getByRole('button', { name: `Skip the remaining ${left}…` }).click();
    await dlg.getByLabel(`One reason for skipping all ${left}`).fill('Ran out of time');
    await dlg.getByRole('button', { name: `Skip ${left} questions` }).click();
    await expect(dlg.getByRole('status')).toContainText(`Skipped ${left} questions`);
    await dlg.getByRole('button', { name: 'Keep interviewing' }).click();

    // Each question is skipped with the reason, and each skip can be undone before submitting.
    await expect(page.getByRole('button', { name: new RegExp(`^Question ${total}: Skipped`) })).toBeVisible();
    await page.getByRole('button', { name: /^Question 7: Skipped/ }).click();
    await expectQuestion(page, 7);
    await expect(page.getByText('Reason: Ran out of time')).toBeVisible();
    await page.getByRole('button', { name: 'Undo skip' }).click();
    await expect(page.getByRole('button', { name: 'Question 7: Unanswered (current)' })).toBeVisible();
    await focusQuestion(page);
    await page.keyboard.press('2');
    await expect(scoreRadio(page, 2)).toBeChecked();
    await page.getByRole('button', { name: /^Question 2: / }).click();
    await expectQuestion(page, 2);
    await addNote(page, 'Gave a measured example.');

    // Everything is resolved: Finish becomes the primary action.
    await expect(page.locator('.live-bar').getByRole('button', { name: 'Finish…' })).toHaveClass(/btn--primary/);
    await expect(page.locator('main .btn--primary:visible')).toHaveCount(1);
    await page.getByRole('button', { name: 'Finish…' }).click();
    await expect(dlg.getByRole('heading', { name: 'Every question is scored or skipped' })).toBeVisible();
    await dlg.getByRole('button', { name: 'Keep interviewing' }).click();
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: 'Solid on what we covered.' });
    await expect(page.locator('main')).toContainText('Ran out of time');
  });
});
