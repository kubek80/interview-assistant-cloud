import {
  addNote,
  expect,
  expectQuestion,
  focusQuestion,
  modal,
  moreMenu,
  openApp,
  scoreRadio,
  seed,
  setupInterview,
  test,
  type Page,
} from './fixtures';

const QA = seed('qa');

/** The description and every L, R and P string of the question whose text is shown, except ones the question text itself contains. */
function hiddenStrings(questionText: string): string[] {
  const q = QA.questions.find((x) => x.text === questionText);
  expect(q, `question "${questionText}" is in the qa seed`).toBeTruthy();
  return [q!.description, ...q!.lookFor, ...q!.redFlags, ...q!.probes].filter((s) => !questionText.includes(s));
}

async function currentQuestionText(page: Page): Promise<string> {
  return (await page.locator('.question-pane .question-text').innerText()).trim();
}

test.describe('Interview flow rules', () => {
  test('FLOW-16 FLOW-22 RUB-4 FLOW-14: finishing is blocked until every question is resolved, every 1 or 4 has a note and the overall assessment is complete', async ({
    page,
  }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'BL' } });

    // Q1 = 4 without a note: marked as needing one.
    await focusQuestion(page);
    await page.keyboard.press('4');
    await expect(scoreRadio(page, 4)).toBeChecked();
    await expect(page.getByText('This question is scored 4 and needs a note.')).toBeVisible();
    await expect(page.getByRole('button', { name: /Question 1: Scored 4 .*needs a note/ })).toBeVisible();
    // Q2 = 1 without a note; Q3 left unanswered.
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    await focusQuestion(page);
    await page.keyboard.press('1');
    await expect(scoreRadio(page, 1)).toBeChecked();

    await page.getByRole('button', { name: 'Finish…' }).click();
    const dlg = modal(page, 'Finish and submit the interview');
    await expect(dlg.getByRole('heading', { name: '3 questions to resolve first' })).toBeVisible();
    await expect(dlg).toContainText('A score of 1 or 4 needs a note of what the candidate said');
    await expect(dlg.getByRole('button', { name: 'Question 1 scored 4' })).toBeVisible();
    await expect(dlg.getByRole('button', { name: 'Question 2 scored 1' })).toBeVisible();
    await expect(dlg).toContainText('Not scored or skipped yet: question 3.');
    await dlg.getByRole('button', { name: 'Submit interview' }).click();
    // FLOW-22: overall rating, recommendation and rationale are each required.
    await expect(dlg).toContainText('Give an overall rating (1-4).');
    await expect(dlg).toContainText('Choose a recommendation.');
    await expect(dlg).toContainText('Write a rationale for your recommendation.');
    await dlg.getByRole('group', { name: /Overall rating/ }).getByRole('radio', { name: /^2 / }).check();
    await dlg.getByRole('group', { name: /Recommendation/ }).getByRole('radio', { name: 'No hire', exact: true }).check();
    await dlg.getByLabel('Rationale').fill('Too many gaps.');
    await dlg.getByRole('button', { name: 'Submit interview' }).click();
    await expect(dlg).toBeVisible(); // still blocked by the questions
    await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();

    // Jump to question 3 from the dialog, resolve everything, then finishing works.
    await dlg.getByRole('button', { name: 'Go to question 3' }).click();
    await expectQuestion(page, 3);
    await focusQuestion(page);
    await page.keyboard.press('2');
    await expect(scoreRadio(page, 2)).toBeChecked();
    await page.keyboard.press('p');
    await expectQuestion(page, 2);
    await addNote(page, 'Could not explain the basics.');
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    await addNote(page, 'Quantified the outcome and covered failure modes.');
    await expect(page.locator('.progress').getByRole('button', { name: /needs a note/ })).toHaveCount(0);
    await page.getByRole('button', { name: 'Finish…' }).click();
    await expect(dlg.getByRole('heading', { name: 'Every question is scored or skipped' })).toBeVisible();
    // The overall answers were autosaved when the dialog closed (RES-1).
    await expect(dlg.getByLabel('Rationale')).toHaveValue('Too many gaps.');
    await dlg.getByRole('button', { name: 'Submit interview' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Scorecard: BL' })).toBeVisible();
  });

  test('FLOW-17: a skip needs a reason, leaves no score and can be undone', async ({ page }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'SK' } });
    await focusQuestion(page);
    await page.keyboard.press('3');
    await expect(scoreRadio(page, 3)).toBeChecked();
    await page.keyboard.press('s');
    const dlg = modal(page, 'Skip question 1');
    // An empty reason is refused (the field is required), so the question is not skipped.
    await dlg.getByRole('button', { name: 'Skip question' }).click();
    await expect(dlg).toBeVisible();
    await expect(page.getByText(/^Reason:/)).toHaveCount(0);
    await dlg.getByLabel('Reason for skipping').fill('   ');
    await dlg.getByRole('button', { name: 'Skip question' }).click();
    await expect(dlg).toContainText('A reason is required.');
    await dlg.getByLabel('Reason for skipping').fill('Candidate asked to move on');
    await dlg.getByRole('button', { name: 'Skip question' }).click();
    await expect(page.getByText('Reason: Candidate asked to move on')).toBeVisible();
    await expect(page.locator('fieldset.score-control input[type=radio]:checked')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Question 1: Skipped' })).toBeVisible();
    await page.getByRole('button', { name: 'Undo skip' }).click();
    await expect(page.getByRole('button', { name: 'Question 1: Unanswered (current)' })).toBeVisible();
  });

  test('FLOW-8 FLOW-9 UX-8: a question set in use (locked plan) cannot be changed in the UI', async ({ page }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'LK' }, start: false });
    await page.goto('./');
    await page.locator('section[aria-labelledby="dash-sets"]').getByRole('link', { name: 'Senior QA Engineer interview', exact: true }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Questions in interview order' })).toBeVisible();
    await expect(main).toContainText('fixed for its interviews');
    await expect(main).not.toContainText(/\b(lock|locked|plan|fingerprint|quota)\b/i);
    // Nothing on the locked plan screen edits questions, order, weights, flags or budget.
    await expect(main.locator('input:not([type=hidden]), textarea, select')).toHaveCount(0);
    for (const name of [/Remove/i, /Move/i, /Shuffle/i, /Draw/i, /Continue/i, /Reset to defaults/i]) {
      await expect(main.getByRole('button', { name })).toHaveCount(0);
    }
    // Changing it means copying it into a new set-up.
    await main.getByRole('button', { name: 'Copy and change' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
    await expect(page.getByTestId('set-summary')).toContainText(/^3 questions/);
  });

  test('FLOW-11 FLOW-12 BANK-8: the candidate view and the candidate window show only the question number and text; the description is only in the interviewer pane', async ({ page, context }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'CV', requisitionId: 'CAND-9' } });
    // Interviewer pane shows the description, L, R and P (FLOW-12); add a tick, score and note that must not leak.
    const text1 = await currentQuestionText(page);
    const secret = hiddenStrings(text1);
    const description = QA.questions.find((x) => x.text === text1)!.description;
    // The steer sits right under the question, in the interviewer's part of the screen.
    const steer = page.locator('.question-pane .steer');
    await expect(steer.getByRole('heading', { name: 'If the candidate needs steering' })).toBeVisible();
    await expect(steer).toContainText(description);
    // What to listen for (L, R) in the checklist card; the probe, asked next, under the question.
    const q = QA.questions.find((x) => x.text === text1)!;
    for (const s of [...q.lookFor, ...q.redFlags]) await expect(page.locator('.interviewer-pane')).toContainText(s);
    for (const s of q.probes) await expect(page.locator('.question-pane .probe')).toContainText(s);
    await page.locator('.interviewer-pane input[type=checkbox]').first().click();
    await focusQuestion(page);
    await page.keyboard.press('4');
    await addNote(page, 'Private interviewer note XYZZY');

    // Toggle with C.
    await focusQuestion(page);
    await page.keyboard.press('c');
    await expect(page.locator('.candidate-question')).toContainText(text1);
    const body = await page.locator('body').innerText();
    for (const s of [...secret, 'XYZZY', 'Exceptional', 'Suggested', 'CAND-9', 'Notes', 'steering']) expect(body, `candidate view leaks "${s}"`).not.toContain(s);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Question 1\s*of 3/);
    await page.keyboard.press('c');
    await expect(page.locator('.interviewer-pane')).toBeVisible();

    // The separate window follows the current question.
    const [popup] = await Promise.all([context.waitForEvent('page'), moreMenu(page, 'Open candidate window')]);
    await popup.waitForLoadState();
    await expect(popup.locator('main')).toContainText(text1);
    const check = async (text: string) => {
      const t = await popup.locator('body').innerText();
      for (const s of [...hiddenStrings(text), 'XYZZY', 'Exceptional', 'Suggested', 'CAND-9', 'Interviewer', 'Dashboard', 'steering']) {
        expect(t, `candidate window leaks "${s}"`).not.toContain(s);
      }
    };
    await check(text1);
    await focusQuestion(page);
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    const text2 = await currentQuestionText(page);
    await expect(popup.locator('main')).toContainText(text2);
    await expect(popup.locator('main')).toContainText('Question 2');
    await check(text2);
    // Paused: a neutral message, no question.
    await page.getByRole('button', { name: 'Pause' }).click();
    await expect(popup.locator('main')).not.toContainText(text2);
    await check(text2);
    await popup.close();
  });

  test('KEY-1 KEY-2 A11Y-1: shortcuts work, and never fire while typing or with Ctrl/Alt/Meta held', async ({ page }) => {
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'KB' } });

    // KEY-2: typing digits and letters in the notes field does not score, move, flag or skip.
    await focusQuestion(page);
    await page.keyboard.press('/');
    const notes = page.getByPlaceholder('What did the candidate say?');
    await expect(notes).toBeFocused();
    await page.keyboard.type('1 2 3 4 n p f s c ?');
    await expect(notes).toHaveValue('1 2 3 4 n p f s c ?');
    await expect(page.locator('fieldset.score-control input[type=radio]:checked')).toHaveCount(0);
    await expectQuestion(page, 1);
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Flag for debrief' })).toBeVisible();
    // Esc leaves the notes field.
    await page.keyboard.press('Escape');
    await expect(notes).not.toBeFocused();
    await expect(page.locator('#question-heading')).toBeFocused();

    // KEY-2: modifiers suppress shortcuts.
    for (const mod of ['Control', 'Alt', 'Meta']) {
      await page.keyboard.press(`${mod}+3`);
      await page.keyboard.press(`${mod}+n`);
      await page.keyboard.press(`${mod}+f`);
    }
    await expect(page.locator('fieldset.score-control input[type=radio]:checked')).toHaveCount(0);
    await expectQuestion(page, 1);
    await expect(page.getByRole('button', { name: 'Flag for debrief' })).toBeVisible();

    // KEY-1: every shortcut.
    await focusQuestion(page);
    for (const s of [1, 2, 3, 4] as const) {
      await page.keyboard.press(String(s));
      await expect(scoreRadio(page, s)).toBeChecked();
    }
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Flagged for debrief' })).toBeVisible();
    await page.keyboard.press('f');
    await expect(page.getByRole('button', { name: 'Flag for debrief' })).toBeVisible();
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    await focusQuestion(page);
    await page.keyboard.press('s');
    await expect(modal(page, 'Skip question 1')).toBeVisible();
    await page.keyboard.press('Escape'); // A11Y-1: Esc closes a dialog
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.keyboard.press('?');
    const help = page.locator('dialog[open]');
    await expect(help).toBeVisible();
    for (const k of ['N', 'P', 'F', 'S', 'C', '/', 'Esc', '?']) await expect(help).toContainText(k);
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await focusQuestion(page);
    await page.keyboard.press('c');
    await expect(page.locator('.candidate-question')).toBeVisible();
    await page.keyboard.press('c');
    await expect(page.locator('.interviewer-pane')).toBeVisible();
  });
});
