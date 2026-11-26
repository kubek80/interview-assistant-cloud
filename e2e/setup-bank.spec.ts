import {
  expect,
  expectQuestion,
  finishInterview,
  focusQuestion,
  editorTab,
  newDraft,
  openApp,
  openMoreOptions,
  selectedRows,
  setSummary,
  scoreRadio,
  seed,
  setupInterview,
  test,
} from './fixtures';

const QA = seed('qa');

test.describe('Question bank and plan set-up', () => {
  test('BANK-1 BANK-2 BANK-15 RUB-1 RUB-5 RUB-6 OV-2: the bank lists about 50 questions per track (every question of its seed file), filters and searches, and shows L, R, P and the rubric', async ({ page }) => {
    await openApp(page);
    let total = 0;
    for (const t of ['qa', 'web', 'edge', 'aks'] as const) {
      const n = seed(t).questions.length;
      expect(n, `${t}: about 50 questions`).toBeGreaterThanOrEqual(45);
      expect(n, `${t}: about 50 questions`).toBeLessThanOrEqual(60);
      total += n;
      await page.goto(`./#/bank/${t}`);
      await expect(page.getByText(`Showing all ${n} questions`)).toBeVisible();
    }
    expect(total).toBe(207);
    await page.goto('./#/bank/qa');
    await page.getByLabel('Search text').fill('flaky');
    const expected = QA.questions.filter((q) => [q.text, ...q.lookFor, ...q.redFlags, ...q.probes].some((s) => s.toLowerCase().includes('flaky'))).length;
    await expect(page.getByRole('status').filter({ hasText: /Showing/ })).toContainText(`${expected}`);
    await page.getByLabel('Search text').fill('');
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Behavioural & leadership' });
    await expect(page.locator('.bank-table tbody tr')).toHaveCount(6);
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ index: 0 });
    await page.getByRole('checkbox', { name: /Expert/ }).check();
    await expect(page.locator('.bank-table tbody tr')).toHaveCount(QA.questions.filter((q) => q.difficulty === 'expert').length);
    await page.getByRole('checkbox', { name: /Expert/ }).uncheck();
    await page.getByRole('checkbox', { name: /Design/ }).check();
    await expect(page.locator('.bank-table tbody tr')).toHaveCount(QA.questions.filter((q) => q.type === 'design').length);
    await page.getByRole('checkbox', { name: /Design/ }).uncheck();

    // A behavioural question: its own key points and red flags cover the RUB-5 themes in its own
    // words (no shared items); treated as core (RUB-6). BANK-15: five key points and four red flags,
    // full sentences, with a leading label emphasised where an item has one.
    const q45 = QA.questions.find((q) => q.number === 45)!;
    expect([q45.lookFor.length, q45.redFlags.length]).toEqual([5, 4]);
    await page.locator('.bank-table tbody tr', { hasText: q45.text }).getByRole('button').first().click();
    const dlg = page.locator('dialog[open]');
    await expect(dlg).toContainText(q45.text);
    for (const s of [...q45.lookFor, ...q45.redFlags, ...q45.probes]) await expect(dlg).toContainText(s);
    await expect(dlg).not.toContainText('Shared');
    await expect(dlg.locator('.item-lead').first()).toHaveText(q45.lookFor[0].slice(0, q45.lookFor[0].indexOf(':') + 1));
    await expect(dlg).toContainText('treated as core');
    for (const label of ['Poor', 'Partial', 'Solid senior', 'Exceptional']) await expect(dlg).toContainText(label); // RUB-1
    await page.keyboard.press('Escape');
  });

  test('FLOW-2 FLOW-3 FLOW-4 FLOW-5 FLOW-6 FLOW-7 PRIV-1 UX-3 UX-8: filters, the mix, the time meter, coverage, weights and the candidate checks on the New interview screen', async ({ page }) => {
    await openApp(page);
    await newDraft(page, 'qa');
    // FLOW-3: an unmet quota is reported (draw from one category: the draw never exceeds what it allows).
    await editorTab(page, 'Change the mix');
    // Default mix: 9 knowledge (8 to 10), 2 scenarios, 1 design exercise, 2 behavioural.
    for (const [t, n] of [['knowledge', '9'], ['scenario', '2'], ['design', '1'], ['behavioural', '2']]) await expect(page.locator(`#mix-${t}`)).toHaveText(n);
    await expect(page.locator('.mix')).toContainText('8 to 10 keeps interviews comparable');
    await page.getByRole('button', { name: 'Fewer knowledge questions' }).click();
    await expect(page.getByRole('button', { name: 'Fewer knowledge questions' })).toBeDisabled();
    await page.getByRole('button', { name: 'More knowledge questions' }).click();
    await page.getByLabel('Draw from').selectOption({ label: 'Performance' });
    await page.getByRole('button', { name: 'Draw 14 questions' }).click();
    await expect(page.locator('.ni-note--warn')).toContainText('Not enough questions in the bank for this mix');
    // The list re-renders after the warning appears: wait for it rather than reading it once.
    await expect.poll(() => selectedRows(page).count()).toBeLessThanOrEqual(QA.questions.filter((q) => q.categoryId === 'qa-performance').length);
    await page.getByLabel('Draw from').selectOption({ index: 0 });
    await page.getByRole('button', { name: 'Draw 14 questions' }).click();
    await expect(page.locator('.ni-note--warn')).toHaveCount(0);
    await expect(setSummary(page)).toContainText(/^14 questions/);
    // FLOW-2: filter the bank by category, difficulty and type.
    await editorTab(page, 'Add questions');
    await page.getByRole('button', { name: 'Filter by category, difficulty or type' }).click();
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ label: 'Behavioural & leadership' });
    await expect(page.locator('li.add-item')).toHaveCount(6);
    await page.getByRole('combobox', { name: 'Category' }).selectOption({ index: 0 });
    await page.getByRole('group', { name: 'Filter questions' }).getByRole('checkbox', { name: /Design/ }).check();
    await expect(page.locator('li.add-item')).toHaveCount(QA.questions.filter((q) => q.type === 'design').length);
    // FLOW-5: coverage counts add up to the selection.
    await editorTab(page, 'Coverage');
    const counts = await page.locator('.coverage__count').allInnerTexts();
    expect(counts.map(Number).reduce((a, b) => a + b, 0)).toBe(14);
    // FLOW-4: the meter compares estimates to the budget and warns when over.
    await page.getByLabel('Time budget (minutes)').fill('20');
    await expect(setSummary(page)).toContainText('over the 20-minute budget');
    await page.getByLabel('Time budget (minutes)').fill('120');
    await expect(setSummary(page)).not.toContainText('over');
    // FLOW-6: weights and must-have, validated (More options › Advanced).
    await openMoreOptions(page);
    await page.getByLabel('Weight for Performance').fill('0');
    await expect(page.locator('main')).toContainText('Use a weight from 0.1 to 10.');
    await page.getByLabel('Weight for Performance').fill('1.5');
    await page.getByRole('checkbox', { name: 'Must-have for Performance' }).check();
    await expect(page.locator('.ni-more__summary')).toContainText('1 weight changed · must-have: Performance');
    // FLOW-7: Continue lists what is missing and focuses it; PRIV-1: a name or initials, up to 60 characters.
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'to fix first' })).toContainText('name or initials');
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toBeFocused();
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('x'.repeat(70));
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toHaveValue('x'.repeat(60));
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('ann@example.com');
    await page.getByRole('button', { name: /^Continue/ }).click();
    await expect(page.locator('main')).toContainText('Use letters, spaces, hyphens, apostrophes and full stops only.');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Siobhán O’Neill-Brown');
    await expect(page.locator('main')).not.toContainText('Use letters, spaces');
  });

  test('OV-4 FLOW-14 FLOW-19 FLOW-20 RUB-3 FLOW-25: the suggestion is never applied, timers turn amber and red, the progress list jumps', async ({ page }) => {
    await page.clock.install();
    await openApp(page);
    await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'TI' } });
    // RUB-3 / OV-4: ticking every key point plus the probe suggests 4, but no score is chosen for you.
    const boxes = page.locator('.interviewer-pane input[type=checkbox]');
    const q1 = QA.questions[0];
    for (let i = 0; i < q1.lookFor.length; i++) {
      await boxes.nth(i).click();
      await expect(boxes.nth(i)).toBeChecked();
    }
    await page.getByRole('checkbox', { name: 'Handled the probe without help' }).click();
    await expect(page.locator('.suggestion')).toContainText('Suggested: 4');
    await expect(page.locator('fieldset.score-control input[type=radio]:checked')).toHaveCount(0);
    // FLOW-19: question timer amber at its estimate (3 min), overall amber at 80% and red over budget.
    await page.clock.fastForward('03:05');
    await expect(page.locator('.timer', { hasText: 'This question' })).toContainText('Estimate reached');
    await page.clock.fastForward('46:00');
    await expect(page.locator('.timer', { hasText: 'Overall' })).toContainText('Nearly out of time');
    await page.clock.fastForward('12:00');
    await expect(page.locator('.timer', { hasText: 'Overall' })).toContainText('Over time');
    // FLOW-20: jump to any question from the progress list.
    await page.getByRole('button', { name: /^Question 3: Unanswered/ }).click();
    await expectQuestion(page, 3);
    await focusQuestion(page);
    await page.keyboard.press('2');
    await expect(scoreRadio(page, 2)).toBeChecked();
    await expect(page.getByRole('button', { name: /^Question 3: Scored 2/ })).toBeVisible();
  });

  test('OV-3: the documentation is in the app, works offline, and links requirement ids to their page', async ({ page, context }) => {
    await openApp(page);
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise<void>((r) => navigator.serviceWorker.addEventListener('controllerchange', () => r(), { once: true }));
      }
    });
    await context.setOffline(true);
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Docs' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.goto('./#/docs/04-scoring');
    await expect(page.getByRole('heading', { level: 1, name: 'Scoring' })).toBeVisible();
    await expect(page.locator('main')).toContainText('59.72%');
    await page.goto('./#/docs/10-verification');
    await expect(page.getByRole('heading', { level: 1, name: 'Verification' })).toBeVisible();
    await page.locator('main a.req-link', { hasText: 'SCORE-3' }).first().click();
    await expect(page).toHaveURL(/docs\/04-scoring\?req=SCORE-3/);
    // The page does not scroll sideways because of wide tables; tables scroll on their own.
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('./#/docs/10-verification');
    await expect(page.getByRole('heading', { level: 1, name: 'Verification' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const region = page.getByRole('region', { name: 'Table 2' });
    await expect(region).toHaveAttribute('tabindex', '0');
    expect(await region.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
  });
});

test('FLOW-24 FLOW-25 A11Y-5 SCORE-9: the scorecard labels the band as advisory next to the recorded recommendation and gives chart figures as a table', async ({ page }) => {
  await openApp(page);
  await setupInterview(page, { pick: [1, 8], candidate: { initials: 'SC' } });
  await focusQuestion(page);
  await page.keyboard.press('3');
  await expect(scoreRadio(page, 3)).toBeChecked();
  await page.keyboard.press('n');
  await expectQuestion(page, 2);
  await focusQuestion(page);
  await page.keyboard.press('2');
  await expect(scoreRadio(page, 2)).toBeChecked();
  await finishInterview(page, { rating: 2, recommendation: 'No hire', rationale: 'Gaps.' });
  const summary = page.locator('.sc-summary');
  await expect(summary.locator('.sc-figure', { hasText: 'Advisory band' })).toContainText('Advisory:');
  await expect(summary.locator('.sc-decision')).toContainText('No hire');
  await expect(summary.locator('.sc-decision')).toContainText('2 – Partial');
  await expect(page.getByRole('table', { name: 'Category figures' })).toBeVisible();
  await expect(page.getByRole('table', { name: 'All questions in interview order' })).toBeVisible();
});
