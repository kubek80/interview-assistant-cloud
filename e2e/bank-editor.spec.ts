// Managing the question bank in the app (docs/05-question-bank.md, BANK-8…BANK-14), driven through the UI.
import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {
  downloadText,
  expect,
  modal,
  newDraft,
  openApp,
  seed,
  setupInterview,
  bankQuestion,
  startInterview,
  test,
  type Page,
} from './fixtures';

const QA = seed('qa');
const shotDir = process.env.E2E_SCREENSHOT_DIR;

/** Reads the stored plans for assertions only (fingerprints are not shown on every screen). */
async function storedPlans(page: Page): Promise<Array<{ fingerprint: string | null; questions: Array<{ id: string; version: number; text: string }> }>> {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('interview-assistant');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('plans').objectStore('plans').getAll();
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            open.result.close();
            resolve(
              (req.result as Array<{ fingerprint: string | null; questions: Array<{ id: string; version: number; text: string }> }>).map((p) => ({
                fingerprint: p.fingerprint,
                questions: p.questions.map((q) => ({ id: q.id, version: q.version, text: q.text })),
              })),
            );
          };
        };
      }),
  );
}

async function openBank(page: Page, track = 'qa') {
  await page.goto(`./#/bank/${track}`);
  await expect(page.getByRole('heading', { level: 2, name: /./ }).first()).toBeVisible();
  await expect(page.getByText(/Showing all \d+ questions|has no questions yet/)).toBeVisible();
}

/** Pastes text into a field the way a browser does (a paste event with clipboard data). */
async function paste(selector: ReturnType<Page['locator']>, text: string) {
  await selector.focus();
  await selector.evaluate((el, t) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, text);
}

test.describe('Managing the question bank', () => {
  test('BANK-9 BANK-11 BANK-14 FLOW-8 FLOW-9 FLOW-12: editing a question raises its version; a new plan gets a new fingerprint while a locked plan keeps the old wording', async ({ page }) => {
    await openApp(page);
    const q1 = QA.questions[0];
    // A plan locked before the edit.
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'OL' }, start: false });
    const oldInterview = page.url();

    await openBank(page);
    await expect(page.getByText(/Unexported changes since/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Edit question 1', exact: true }).click();
    const dlg = modal(page, 'Edit question 1');
    await expect(dlg.getByRole('textbox', { name: 'Question', exact: true })).toHaveValue(q1.text);
    await expect(dlg).toContainText(`Version ${q1.version}.`);
    await dlg.getByRole('textbox', { name: 'Question', exact: true }).fill('EDITED: how would you set up testing for a brand-new product team?');
    await dlg.getByLabel('Description (for the interviewer)').fill('EDITED STEER: tell us the first things you would decide and agree on.');
    await expect(dlg).toContainText(`Saving raises the version from ${q1.version} to ${q1.version + 1} (changed: text, description)`);
    await dlg.getByRole('textbox', { name: 'Question', exact: true }).press('Control+Enter'); // BANK-9: Ctrl+Enter saves
    await expect(dlg).toHaveCount(0);
    await expect(page.getByText(`Question 1 saved; it is now version ${q1.version + 1}.`)).toBeVisible();
    await expect(page.locator('.bank-table tbody tr').first()).toContainText('EDITED: how would you set up testing');
    // BANK-14: the track now has unexported changes, and the change is in the audit log with before and after.
    await expect(page.getByText(/Unexported changes since/)).toBeVisible();
    await page.goto('./#/admin?tab=audit');
    await page.getByLabel('Action').selectOption({ label: 'Question edited' });
    const row = page.getByRole('table', { name: 'Audit log' }).locator('tbody tr').first();
    await expect(row).toContainText('Question qa-1');
    await row.getByText('Show values').click();
    await expect(row).toContainText(q1.text);
    await expect(row).toContainText('EDITED: how would you set up testing');

    // A plan built after the edit: new wording, new description in the interviewer pane (FLOW-12).
    await page.goto('./');
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'NW' } });
    await expect(page.locator('.question-pane .question-text')).toHaveText('EDITED: how would you set up testing for a brand-new product team?');
    await expect(page.locator('.question-pane .steer')).toContainText('If the candidate needs steering');
    await expect(page.locator('.question-pane .steer')).toContainText('EDITED STEER');

    // The plan locked before the edit still shows the old wording and description.
    await page.goto(oldInterview);
    await startInterview(page);
    await expect(page.locator('.question-pane .question-text')).toHaveText(q1.text);
    await expect(page.locator('.question-pane .steer')).toContainText(q1.description);

    const plans = await storedPlans(page);
    expect(plans).toHaveLength(2);
    const [before, after] = [plans.find((p) => p.questions[0].version === q1.version)!, plans.find((p) => p.questions[0].version === q1.version + 1)!];
    expect(before.questions[0].text).toBe(q1.text);
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });

  test('BANK-9 BANK-10 BANK-5 RUB-5 BANK-15 BANK-2: a question added in a form is offered for new interviews; retired, it is not; restored, it is again', async ({ page }) => {
    await openApp(page);
    await openBank(page);
    await page.getByRole('button', { name: 'Add question' }).first().click();
    const dlg = modal(page, 'Add a question');
    // Inline validation: nothing is saved and focus goes to the first problem.
    await dlg.getByRole('button', { name: 'Add question' }).click();
    await expect(dlg.getByText('Enter the question text.')).toBeVisible();
    await expect(dlg.getByText(/Enter a description/)).toBeVisible();
    await expect(dlg.getByText('Add at least one probe.')).toBeVisible();
    await expect(dlg.getByRole('textbox', { name: 'Question', exact: true })).toBeFocused();

    await dlg.getByRole('textbox', { name: 'Question', exact: true }).fill('Tell us about a release you stopped at the last minute.');
    await dlg.getByLabel('Description (for the interviewer)').fill('We want a real example of a time you decided a release should not go out: what you saw, what you did and what happened.');
    await dlg.getByLabel('Category').selectOption({ label: 'Behavioural & leadership' });
    // BANK-5: the time estimate follows type and difficulty until it is changed; behavioural forces core.
    await expect(dlg.getByLabel('Time estimate (minutes)')).toHaveValue('3');
    await dlg.getByLabel('Type').selectOption('design');
    await dlg.getByLabel('Difficulty').selectOption('expert');
    await expect(dlg.getByLabel('Time estimate (minutes)')).toHaveValue('8');
    await dlg.getByLabel('Type').selectOption('behavioural');
    await expect(dlg.getByLabel('Difficulty')).toBeDisabled();
    await expect(dlg.getByLabel('Difficulty')).toHaveValue('core');
    await expect(dlg.getByLabel('Time estimate (minutes)')).toHaveValue('4');
    // RUB-5: a new behavioural question is offered the themes as starting items, to be reworded.
    await expect(dlg.getByText('Start from the behavioural themes?')).toBeVisible();
    await dlg.getByRole('button', { name: 'Insert the starting items' }).click();
    await expect(dlg.getByLabel('Key point 1', { exact: true })).toHaveValue(/^Specific situation: /);
    await expect(dlg.getByLabel('Key point 4', { exact: true })).toHaveValue(/^Reflection: /);
    await expect(dlg.getByLabel('Red flag 3', { exact: true })).toHaveValue(/^Cannot say how it ended/);
    await expect(dlg.getByText('Start from the behavioural themes?')).toHaveCount(0); // never offered over items already there
    // BANK-15: an item is a sentence; its box grows to show all of it (several lines, no inner scroll).
    const first = dlg.getByLabel('Key point 1', { exact: true });
    const oneLine = (await dlg.getByLabel('Key point 5', { exact: true }).boundingBox())!.height; // the empty row after the starting items
    await first.fill(
      'Specific situation: describes the release they stopped, the defect or risk they found, who wanted to ship anyway and why, how close it was to going out to customers, and what the business would have lost if it had shipped that day.',
    );
    await expect.poll(async () => (await first.boundingBox())!.height).toBeGreaterThan(oneLine * 1.8);
    expect(await first.evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
    await first.press('End');
    await page.keyboard.press('Shift+Enter'); // no line break inside an item
    await expect(first).not.toHaveValue(/\n/);
    // List editing: Enter adds the next item, pasting several lines adds one per line, items can be moved and removed.
    const last = dlg.getByLabel('Key point 5', { exact: true });
    await last.fill('Named the risk in numbers');
    await last.press('Enter');
    await expect(dlg.getByLabel('Key point 6', { exact: true })).toBeFocused();
    await paste(dlg.getByLabel('Key point 6', { exact: true }), 'Told the stakeholders\n- Agreed a new date\nFollowed up');
    await expect(dlg.getByLabel('Key point 8', { exact: true })).toHaveValue('Followed up');
    await expect(dlg.getByLabel('Key point 7', { exact: true })).toHaveValue('Agreed a new date');
    await dlg.getByRole('button', { name: 'Move key point 8 up' }).click();
    await expect(dlg.getByLabel('Key point 7', { exact: true })).toHaveValue('Followed up');
    await dlg.getByRole('button', { name: 'Remove key point 8' }).click();
    await expect(dlg.getByLabel('Key point 8', { exact: true })).toHaveCount(0);
    await dlg.getByLabel('Probe 1', { exact: true }).fill('What would you do differently?');
    // Unsaved-changes guard on close.
    await page.keyboard.press('Escape');
    const discard = modal(page, 'Discard your changes?');
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Keep editing' }).click();
    await expect(dlg).toBeVisible();
    await dlg.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByText('Question 51 added.')).toBeVisible();
    await expect(page.getByText('Showing all 51 questions')).toBeVisible();

    // Offered when building a plan.
    await page.goto('./');
    await newDraft(page, 'qa');
    await expect(bankQuestion(page, 51)).toHaveCount(1);

    // Retired: not offered (BANK-10).
    await openBank(page);
    await page.locator('.bank-table tbody tr', { hasText: 'release you stopped' }).getByRole('button').first().click();
    const detail = modal(page, 'Question 51');
    await expect(detail).toContainText('We want a real example');
    await detail.getByRole('button', { name: 'Retire' }).click();
    await expect(page.getByText(/Question 51 retired/)).toBeVisible();
    await page.keyboard.press('Escape');
    await page.goto('./');
    await newDraft(page, 'qa');
    await expect(bankQuestion(page, 50)).toHaveCount(1);
    await expect(bankQuestion(page, 51)).toHaveCount(0);

    // Restored, and duplicated into a new question 52 (numbers are never reused).
    await openBank(page);
    await page.getByRole('checkbox', { name: 'Include retired questions' }).check();
    await page.locator('.bank-table tbody tr', { hasText: 'release you stopped' }).getByRole('button').first().click();
    await modal(page, 'Question 51').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByText(/Question 51 restored/)).toBeVisible();
    await modal(page, 'Question 51').getByRole('button', { name: 'Duplicate' }).click();
    const dup = modal(page, 'New question from question 51');
    await dup.getByRole('textbox', { name: 'Question', exact: true }).fill('Tell us about a release you shipped despite doubts.');
    await dup.getByRole('button', { name: 'Add question' }).click();
    await expect(page.getByText('Question 52 added.')).toBeVisible();
    await expect(modal(page, 'Question 52')).toContainText('shipped despite doubts');
  });

  test('BANK-13 BANK-12: pasted rows are previewed with each row’s problems; accepting adds only the good rows; a CSV export round-trips into a new track', async ({ page }) => {
    await openApp(page);
    await openBank(page);
    await page.getByRole('button', { name: 'Bulk add…' }).click();
    const dlg = page.locator('dialog[open]');
    const header = ['Question', 'Description', 'Category', 'Difficulty', 'Type', 'Key points', 'Red flags', 'Probes', 'Time (min)'].join('\t');
    const rows = [
      ['How do you choose what to automate first?', 'We want to hear how you decide which tests are worth automating.', 'Automation frameworks', 'core', 'knowledge', 'risk; frequency; stability', 'automate everything', 'What would you never automate?', ''],
      ['Bad row with no description', '', 'Automation frameworks', 'super', 'knowledge', 'a', 'b', 'c', ''],
      ['Walk us through testing a payments webhook.', 'Describe how you would test a service that receives payment notifications.', 'Payments', 'advanced', 'scenario', 'idempotency\nretries\nsignatures', 'only happy path', 'What if events arrive twice?', '6'],
    ].map((r) => r.join('\t').replace(/idempotency\nretries\nsignatures/, '"idempotency\nretries\nsignatures"'));
    await dlg.getByLabel('Rows from a spreadsheet or CSV').fill([header, ...rows].join('\n'));
    await dlg.getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dlg.getByText('2 of 3 rows ready to add.')).toBeVisible();
    const bad = dlg.locator('tbody tr', { hasText: 'Bad row with no description' });
    await expect(bad).toContainText('2 problems');
    await expect(bad).toContainText('Unknown difficulty “super”');
    await expect(bad).toContainText('Enter a description');
    await expect(dlg.getByRole('checkbox', { name: 'Create “Payments”' })).toBeChecked();
    await expect(dlg.locator('tbody tr', { hasText: 'payments webhook' })).toContainText('3 / 1 / 1');
    expect(await page.locator('.bank-table tbody tr').count()).toBe(50); // nothing added yet
    await dlg.getByRole('button', { name: 'Add 2 questions' }).click();
    await expect(page.getByText('Added 2 questions and 1 category.')).toBeVisible();
    await expect(page.getByText('Showing all 52 questions')).toBeVisible();
    await expect(page.locator('.bank-table tbody tr', { hasText: 'payments webhook' })).toContainText('Payments');

    // Template download.
    await page.getByRole('button', { name: 'Bulk add…' }).click();
    const template = await downloadText(page, () => page.locator('dialog[open]').getByRole('button', { name: 'Download the CSV template' }).click());
    expect(template.name).toBe('question-bank-template.csv');
    expect(template.text.split('\r\n')[0]).toBe('Question,Description,Category,Difficulty,Type,Key points,Red flags,Probes,Time (min)');
    await page.keyboard.press('Escape');

    // CSV export, then import into a new track: the same questions come back (round trip).
    const csv = await downloadText(page, () => page.getByRole('button', { name: 'Export CSV' }).click());
    expect(csv.name).toMatch(/^qa-questions-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.getByRole('button', { name: 'New track…' }).click();
    const nt = modal(page, 'New track');
    await nt.getByLabel('Track name').fill('Senior QA Engineer (copy)');
    await nt.getByLabel('Track id').fill('qacopy');
    await nt.getByLabel('First category').fill('Strategy & risk');
    await nt.getByRole('button', { name: 'Create track' }).click();
    await expect(page.getByRole('heading', { level: 2, name: 'Senior QA Engineer (copy)' })).toBeVisible();
    await expect(page.getByText('This track has no questions yet.')).toBeVisible();
    await page.getByRole('button', { name: 'Bulk add…' }).first().click();
    await page.locator('dialog[open]').getByLabel('Or import a CSV file').setInputFiles({ name: csv.name, mimeType: 'text/csv', buffer: Buffer.from(csv.text) });
    const prev = page.locator('dialog[open]');
    await expect(prev.getByText('52 of 52 rows ready to add.')).toBeVisible();
    await prev.getByRole('button', { name: 'Add 52 questions' }).click();
    await expect(page.getByText('Showing all 52 questions')).toBeVisible();
    const copy = await downloadText(page, () => page.getByRole('button', { name: 'Export CSV' }).click());
    expect(copy.text).toBe(csv.text);
  });

  test('BANK-4 BANK-7 BANK-14 BANK-6: exporting the track file asks for the version and clears the marker; re-import replaces local changes after a warning; a newer bundled seed is offered, never forced', async ({ page }) => {
    await openApp(page);
    await openBank(page);
    // Change something (BANK-14 marker appears).
    await page.getByRole('button', { name: 'Edit question 2', exact: true }).click();
    let dlg = modal(page, 'Edit question 2');
    await dlg.getByLabel('Time estimate (minutes)').fill('9');
    await expect(dlg).toContainText('Changes to the category, time estimate or status do not change the version.');
    await dlg.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Question 2 saved.').last()).toBeVisible();
    await expect(page.getByText(/Unexported changes since/)).toBeVisible();

    // Export asks for the next version.
    await page.getByRole('button', { name: 'Export track file…' }).click();
    const exp = modal(page, 'Export track file');
    const version = exp.getByLabel('Track version');
    await expect(version).not.toHaveValue(QA.track.version);
    await expect(version).toHaveValue(/^\d{4}\.\d{2}(\.\d+)?$/);
    await version.fill('2026.1');
    await exp.getByRole('button', { name: 'Export qa.json' }).click();
    await expect(exp).toContainText('Use year.month');
    await version.fill('2026.11.2');
    const file = await downloadText(page, () => exp.getByRole('button', { name: 'Export qa.json' }).click());
    expect(file.name).toBe('qa.json');
    const exported = JSON.parse(file.text);
    expect(exported.track.version).toBe('2026.11.2');
    expect(exported.questions[1].timeMin).toBe(9);
    expect(exported.questions[1].description).toBe(QA.questions[1].description);
    await expect(page.getByText(/Unexported changes since/)).toHaveCount(0);
    await expect(page.locator('.bank-track-head')).toContainText('version 2026.11.2');

    // A new local change, then re-import the exported file: warned first, then replaced.
    await page.getByRole('button', { name: 'Edit question 3', exact: true }).click();
    dlg = modal(page, 'Edit question 3');
    await dlg.getByRole('textbox', { name: 'Question', exact: true }).fill('Local change that will be replaced');
    await dlg.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText(/Unexported changes since/)).toBeVisible();
    await page.getByRole('button', { name: 'Import track file…' }).click();
    const imp = modal(page, 'Import a track file');
    await imp.getByLabel('Track file (JSON)').setInputFiles({ name: 'qa.json', mimeType: 'application/json', buffer: Buffer.from(file.text) });
    await expect(imp).toContainText('has changes on this device that have not been exported');
    await imp.getByRole('button', { name: 'Replace with the file' }).click();
    await expect(imp).toContainText('Imported track qa, version 2026.11.2');
    await imp.getByRole('button', { name: 'Close' }).last().click();
    await expect(page.locator('.bank-table tbody tr').nth(2)).toContainText(QA.questions[2].text);
    await expect(page.getByText(/Unexported changes since/)).toHaveCount(0);

    // BANK-6: an older track with local changes is not overwritten by the newer bundled seed.
    const older = { ...exported, track: { ...exported.track, version: '2026.10' } };
    await page.getByRole('button', { name: 'Import track file…' }).click();
    await modal(page, 'Import a track file').getByLabel('Track file (JSON)').setInputFiles({ name: 'qa.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(older)) });
    await expect(page.getByText('Imported track qa, version 2026.10')).toBeVisible();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Edit question 2', exact: true }).click();
    dlg = modal(page, 'Edit question 2');
    await dlg.getByLabel('Time estimate (minutes)').fill('10');
    await dlg.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Question 2 saved.').last()).toBeVisible();
    await expect(page.locator('.bank-table tbody tr').nth(1)).toContainText('10 min');
    await expect(page.getByText(/Unexported changes since/)).toBeVisible();
    await page.reload(); // the app starts again and checks the bundled seeds
    const alert = page.locator('.alert', { hasText: `A newer version of Senior QA Engineer (${QA.track.version}) is bundled` });
    await expect(alert).toBeVisible();
    await expect(page.locator('.bank-table tbody tr').nth(1)).toContainText('10 min'); // not overwritten
    await page.goto('./#/admin?tab=bank');
    await expect(page.locator('.alert', { hasText: `A newer version of Senior QA Engineer (${QA.track.version}) is bundled` })).toBeVisible();
    await expect(page.getByRole('table', { name: 'Tracks on this device' })).toContainText('Unexported changes since');
    await page.getByRole('button', { name: `Replace with version ${QA.track.version}…` }).click();
    await modal(page, /Replace Senior QA Engineer/).getByRole('button', { name: 'Replace' }).click();
    await expect(page.locator('.alert', { hasText: 'A newer version' })).toHaveCount(0);
    await expect(page.getByRole('table', { name: 'Tracks on this device' }).locator('tr', { hasText: 'Senior QA Engineer' })).toContainText('2026.11');
  });

  test('A11Y-1 A11Y-7 BANK-9 BANK-13: the editor and the bulk preview are keyboard-friendly and pass axe in light and dark', async ({ page }) => {
    await openApp(page);
    await openBank(page);
    const failures: string[] = [];
    const scan = async (name: string) => {
      const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      for (const v of r.violations) if (v.impact === 'serious' || v.impact === 'critical') failures.push(`${name}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
    };
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      // Editor, opened from the keyboard; focus returns to the opener on Esc.
      const opener = page.getByRole('button', { name: 'Edit question 45', exact: true });
      await opener.focus();
      await page.keyboard.press('Enter');
      const dlg = modal(page, 'Edit question 45');
      await expect(dlg.getByRole('textbox', { name: 'Question', exact: true })).toBeFocused();
      await dlg.locator('details summary').click();
      await scan(`editor ${scheme}`);
      if (shotDir) {
        mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: `${shotDir}/${scheme}-bank-editor.png` });
      }
      for (let i = 0; i < 60; i++) {
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('dialog[open]')).toHaveCount(0);
      await expect(opener).toBeFocused();
      // Bulk preview with problems.
      await page.getByRole('button', { name: 'Bulk add…' }).click();
      await page.locator('dialog[open]').getByLabel('Rows from a spreadsheet or CSV').fill('Good?\tSteer\tPerformance\tcore\tknowledge\ta\tb\tc\t\nBad\t\tNew cat\tx\tquiz\t\t\t\t');
      await page.keyboard.press('Tab');
      await page.locator('dialog[open]').getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(page.locator('dialog[open] .bulk__summary')).toBeFocused();
      await expect(page.locator('dialog[open] .bulk__summary')).toContainText('1 of 2 rows ready to add.');
      await scan(`bulk preview ${scheme}`);
      if (shotDir) await page.screenshot({ path: `${shotDir}/${scheme}-bank-bulk-preview.png` });
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Categories…' }).click();
      await scan(`categories ${scheme}`);
      await page.keyboard.press('Escape');
    }
    expect(failures).toEqual([]);
  });
});
