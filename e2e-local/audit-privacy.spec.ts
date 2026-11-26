import {
  addNote,
  browserToday,
  downloadText,
  expect,
  expectQuestion,
  fillCandidate,
  finishInterview,
  focusQuestion,
  modal,
  newDraft,
  openMoreOptions,
  openApp,
  scoreRadio,
  setupInterview,
  test,
  type Page,
  exportFromScorecard,
} from './fixtures';

const XSS_NOTE = '<img src=x onerror="window.__xss=1">note';
const XSS_REASON = '<script>window.__xss=2</script>skip';
const XSS_RATIONALE = '<b>bold</b><img src=x onerror="window.__xss=3">';

/** Minimal RFC 4180 parser for the exported CSV files. */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' && text[i + 1] === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i++;
    } else cell += ch;
  }
  return rows;
}

interface AuditRow {
  id: string;
  time: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  before: string;
  after: string;
  reason: string;
}

async function auditRows(page: Page): Promise<AuditRow[]> {
  await page.goto('./#/admin?tab=audit');
  await expect(page.getByRole('tab', { name: 'Audit log', selected: true })).toBeVisible();
  const csv = await downloadText(page, () => page.getByRole('button', { name: 'Export CSV' }).click());
  const [header, ...rows] = parseCsv(csv.text);
  expect(header).toEqual(['Id', 'Time', 'Actor', 'Action', 'Entity', 'Entity id', 'Before', 'After', 'Reason']);
  return rows.map(([id, time, actor, action, entity, entityId, before, after, reason]) => ({ id, time, actor, action, entity, entityId, before, after, reason }));
}

async function expectNoInjectedMarkup(page: Page) {
  expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
  await expect(page.locator('main img[src="x"], main script:not([src]), main b')).toHaveCount(0);
}

async function sessionIdFromUrl(page: Page): Promise<string> {
  return page.url().split('/').pop()!;
}

test.describe('Audit log', () => {
  test('AUD-1 AUD-2 AUD-3 AUD-4 FLOW-23 FLOW-32 BANK-7 SEC-2: lock, consent, start, submit, amendments, exports and imports are logged; text renders as text', async ({ page }) => {
    await openApp(page, 'Alex Interviewer');
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'AU', requisitionId: 'R-AUD' } });
    const sessionId = await sessionIdFromUrl(page);

    // SEC-2: hostile-looking text in a note, a skip reason and the rationale.
    await focusQuestion(page);
    await page.keyboard.press('3');
    await expect(scoreRadio(page, 3)).toBeChecked();
    await addNote(page, XSS_NOTE);
    await expect(page.getByRole('list', { name: 'Notes for this question' })).toContainText(XSS_NOTE);
    await focusQuestion(page);
    await page.keyboard.press('n');
    await expectQuestion(page, 2);
    await page.keyboard.press('s');
    const skip = modal(page, 'Skip question 2');
    await skip.getByLabel('Reason for skipping').fill(XSS_REASON);
    await skip.getByRole('button', { name: 'Skip question' }).click();
    await expect(page.getByText(`Reason: ${XSS_REASON}`)).toBeVisible();
    await expectNoInjectedMarkup(page);
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: XSS_RATIONALE });
    await expect(page.locator('.sc-rationale__text')).toHaveText(XSS_RATIONALE);
    await expect(page.locator('main')).toContainText(XSS_REASON);
    await expectNoInjectedMarkup(page);

    // FLOW-32: scorecard and session exports.
    const md = await exportFromScorecard(page, 'Markdown');
    expect(md.text).toContain('\\<img src=x'); // Markdown escapes "<" so viewers do not render it as HTML
    expect(md.text).not.toMatch(/(^|[^\\])<img/);
    await exportFromScorecard(page, 'CSV, one row per question');
    await exportFromScorecard(page, 'Interview file for the debrief');

    // AUD-4: the submitted interview opens read-only; Amend asks for a reason first.
    await page.getByRole('link', { name: /Amend \(reason required\)/ }).click();
    await expect(page.getByText(/This interview is submitted and read-only/)).toBeVisible();
    await expect(page.locator('fieldset.score-control input[type=radio]')).toHaveCount(4);
    for (const r of await page.locator('fieldset.score-control input[type=radio]').all()) await expect(r).toBeDisabled();
    await focusQuestion(page);
    await page.keyboard.press('p');
    await expectQuestion(page, 1);
    await page.keyboard.press('2'); // shortcuts cannot change a submitted record
    await expect(scoreRadio(page, 3)).toBeChecked();
    await page.getByRole('button', { name: 'Amend this question…' }).click();
    await page.locator('.amend-form fieldset.score-control input[value="2"]').check();
    await page.getByRole('textbox', { name: 'Note 1' }).fill(`${XSS_NOTE} (amended)`);
    await page.getByRole('button', { name: 'Save amendment…' }).click();
    const amend = modal(page, 'Amend question 1');
    await amend.getByRole('button', { name: 'Save amendment' }).click();
    await expect(amend).toBeVisible(); // a reason is required
    await amend.getByLabel('Reason for the change').fill('Mis-click on the score');
    await amend.getByRole('button', { name: 'Save amendment' }).click();
    await expect(amend).toHaveCount(0);
    await expect(scoreRadio(page, 2)).toBeChecked();
    await page.getByRole('button', { name: 'Amend overall' }).click();
    await page.getByLabel('Rationale').fill('Revised rationale after the debrief.');
    await page.getByRole('button', { name: 'Save amendment…' }).click();
    const amendOverall = modal(page, 'Amend the overall assessment');
    await amendOverall.getByLabel('Reason for the change').fill('Debrief discussion');
    await amendOverall.getByRole('button', { name: 'Save amendment' }).click();
    await expect(page.locator('.overall-summary')).toContainText('Revised rationale after the debrief.');

    // Plan export (dashboard) and a track export + import (Admin, BANK-7).
    await page.goto('./');
    await downloadText(page, () => page.locator('section[aria-labelledby="dash-sets"]').getByRole('button', { name: /^Export/ }).first().click());
    await page.goto('./#/admin?tab=bank');
    // BANK-4: the export asks for the track version first.
    await page.getByRole('button', { name: 'Export Senior QA Engineer' }).click();
    const track = await downloadText(page, () => modal(page, 'Export track file').getByRole('button', { name: 'Export qa.json' }).click());
    await page.getByLabel('Track file (JSON)').setInputFiles({ name: 'qa.json', mimeType: 'application/json', buffer: Buffer.from(track.text) });
    await expect(page.getByText(/Imported track qa, version/)).toBeVisible();
    // SEC-2: a hostile track file is rejected with validation errors shown as text.
    await page
      .getByLabel('Track file (JSON)')
      .setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ track: { id: '<img src=x onerror=alert(1)>' } })) });
    await expect(page.locator('main')).toContainText('not valid');
    await expectNoInjectedMarkup(page);

    // AUD-2: every logged action, with actor and entity.
    const rows = await auditRows(page);
    const of = (action: string) => rows.filter((r) => r.action === action);
    expect(of('plan.locked')).toHaveLength(1);
    expect(of('plan.locked')[0].entity).toBe('plan');
    expect(of('session.consent_confirmed').map((r) => r.entityId)).toEqual([sessionId]);
    expect(of('session.started').map((r) => r.entityId)).toEqual([sessionId]);
    expect(of('session.submitted').map((r) => r.entityId)).toEqual([sessionId]);
    const amended = of('session.amended');
    expect(amended).toHaveLength(2);
    const answerAmend = amended.find((r) => r.entity === 'answer')!;
    expect(answerAmend.reason).toBe('Mis-click on the score');
    expect(JSON.parse(answerAmend.before)).toMatchObject({ questionId: 'qa-1', score: 3 });
    expect(JSON.parse(answerAmend.after)).toMatchObject({ questionId: 'qa-1', score: 2 });
    expect(JSON.parse(answerAmend.after).notes[0].text).toBe(`${XSS_NOTE} (amended)`);
    const overallAmend = amended.find((r) => r.entity === 'session')!;
    expect(overallAmend.reason).toBe('Debrief discussion');
    expect(JSON.parse(overallAmend.before)).toEqual({ rationale: XSS_RATIONALE });
    expect(JSON.parse(overallAmend.after)).toEqual({ rationale: 'Revised rationale after the debrief.' });
    const formats = of('export').map((r) => JSON.parse(r.after).format);
    expect(formats).toEqual(expect.arrayContaining(['scorecard-markdown', 'scorecard-csv', 'session-json', 'plan-json', 'track-json']));
    expect(of('import').map((r) => r.entity)).toContain('track');
    for (const r of rows) {
      expect(r.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      // The first bank load happens before anyone has set a name on this device.
      expect(r.actor).toBe(r.action === 'bank.loaded' ? 'Unknown' : 'Alex Interviewer');
    }
    // The CSV export itself is logged too (it appears in the next export).

    // AUD-1, AUD-3: the log is shown and filterable; there are no edit or delete controls per entry.
    await page.goto('./#/admin?tab=audit');
    const log = page.getByRole('table', { name: 'Audit log' });
    await expect(log).toBeVisible();
    await expect(log.getByRole('button', { name: /edit|delete|remove/i })).toHaveCount(0);
    await page.getByLabel('Action').selectOption({ label: 'Edited after submission' });
    await expect(log.locator('tbody tr')).toHaveCount(2);
    await expect(log).toContainText('Mis-click on the score');
    await expect(log).toContainText('<img src=x onerror='); // before/after rendered as text
    await expectNoInjectedMarkup(page);
  });
});

test.describe('Retention and privacy requests', () => {
  test('PRIV-5 AUD-2 AUD-1: a session is kept on its retention date and purged the day after; the purge is logged without candidate details and amendment text is redacted', async ({
    page,
  }) => {
    await openApp(page);
    const today = await browserToday(page);
    await setupInterview(page, { pick: [1], candidate: { initials: 'PG', requisitionId: 'R-PURGE', retentionUntil: today } });
    await focusQuestion(page);
    await page.keyboard.press('3');
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: 'SECRET-P5 rationale' });
    await page.goto(page.url().replace('/scorecard/', '/interview/'));
    await page.getByRole('button', { name: 'Amend overall' }).click();
    await page.getByLabel('Rationale').fill('SECRET-P5 amended');
    await page.getByRole('button', { name: 'Save amendment…' }).click();
    const dlg = modal(page, 'Amend the overall assessment');
    await dlg.getByLabel('Reason for the change').fill('SECRET-P5 reason');
    await dlg.getByRole('button', { name: 'Save amendment' }).click();
    await expect(dlg).toHaveCount(0);

    // Same day: the retention date is the last day kept.
    await page.goto('./');
    await page.reload();
    await expect(page.getByText('PG · R-PURGE').first()).toBeVisible();

    // Two days later the app purges it when it opens.
    const later = new Date(`${today}T12:00:00`);
    later.setDate(later.getDate() + 2);
    await page.clock.install({ time: later });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Run your first structured interview' })).toBeVisible();
    const rows = await auditRows(page);
    const purge = rows.filter((r) => r.action === 'retention.purged');
    expect(purge).toHaveLength(1);
    expect(JSON.parse(purge[0].after).sessionsDeleted).toBe(1);
    const all = JSON.stringify(rows);
    expect(all).not.toContain('SECRET-P5');
    expect(all).not.toContain('R-PURGE');
    // The amendment entry itself is kept (append-only), with its candidate text redacted.
    const amended = rows.filter((r) => r.action === 'session.amended');
    expect(amended).toHaveLength(1);
    expect(amended[0].reason).toBe('[redacted]');
    expect(JSON.parse(amended[0].after)).toEqual({ redacted: true, fields: ['rationale'] });
  });

  test('PRIV-6 AUD-2: access request exports one candidate key, deletion request removes it, erase-all wipes the device', async ({ page }) => {
    await openApp(page, 'Pat Privacy');
    await setupInterview(page, { pick: [1], candidate: { initials: 'DE', requisitionId: 'req-del' } });
    await focusQuestion(page);
    await page.keyboard.press('2');
    await addNote(page, 'SECRET-P6 note');
    await finishInterview(page, { rating: 2, recommendation: 'No hire', rationale: 'SECRET-P6 rationale' });
    await page.goto(page.url().replace('/scorecard/', '/interview/'));
    await page.getByRole('button', { name: 'Amend overall' }).click();
    await page.getByLabel('Rationale').fill('SECRET-P6 amended');
    await page.getByRole('button', { name: 'Save amendment…' }).click();
    await modal(page, 'Amend the overall assessment').getByLabel('Reason for the change').fill('SECRET-P6 reason');
    await modal(page, 'Amend the overall assessment').getByRole('button', { name: 'Save amendment' }).click();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await page.goto('./');
    await setupInterview(page, { pick: [2], candidate: { initials: 'KE', requisitionId: 'R-KEEP' }, start: false });

    // Access request (key matching is case-insensitive: "de" + "REQ-DEL").
    await page.goto('./#/admin?tab=privacy');
    const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Access and deletion requests' }) });
    await card.getByRole('textbox', { name: 'Candidate', exact: true }).fill('de');
    await card.getByLabel('Requisition id').fill('REQ-DEL');
    await expect(card).toContainText('1 interview on this device for de · REQ-DEL.');
    await card.getByRole('button', { name: 'Export everything (access request)' }).click();
    const access = await downloadText(page, () => modal(page, 'Export everything for this candidate?').getByRole('button', { name: 'Export' }).click());
    expect(access.name).toMatch(/^interview-candidate-data-[0-9a-f]{8}-\d{4}-\d{2}-\d{2}\.json$/); // PRIV-3: no candidate data in file names
    const json = JSON.parse(access.text);
    expect(json.kind).toBe('candidate-data');
    expect(json.sessions).toHaveLength(1);
    expect(json.sessions[0].answers[0].notes[0].text).toBe('SECRET-P6 note');
    expect(json.audit.some((e: { action: string }) => e.action === 'session.amended')).toBe(true);

    // Deletion request.
    await card.getByRole('button', { name: 'Delete everything (deletion request)' }).click();
    await modal(page, 'Delete everything for this candidate?').getByRole('button', { name: 'Delete 1 interview' }).click();
    await expect(card).toContainText('Deletion request: deleted 1 interview for de · REQ-DEL.');
    await page.goto('./');
    await expect(page.getByText('KE · R-KEEP').first()).toBeVisible();
    await expect(page.getByText(/DE · REQ-DEL/i)).toHaveCount(0);
    const rows = await auditRows(page);
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['privacy.access_request', 'privacy.deletion_request']));
    expect(JSON.stringify(rows)).not.toMatch(/SECRET-P6|REQ-DEL|req-del/);

    // Erase all data on this device.
    await page.goto('./#/admin?tab=privacy');
    await page.getByRole('button', { name: 'Erase all data…' }).click();
    const erase = modal(page, 'Erase all data on this device?');
    await expect(erase.getByRole('button', { name: 'Erase everything' })).toBeDisabled();
    await erase.getByLabel('Type ERASE to confirm').fill('ERASE');
    await erase.getByRole('button', { name: 'Erase everything' }).click();
    await expect(page.getByText('All data on this device was erased.')).toBeVisible();
    await page.goto('./');
    await expect(page.getByRole('heading', { name: 'Run your first structured interview' })).toBeVisible();
    await expect(page.locator('section[aria-labelledby="dash-sets"] .dash-plan')).toHaveCount(0);
    await page.goto('./#/admin?tab=audit');
    const log = page.getByRole('table', { name: 'Audit log' });
    await expect(log).toContainText('All data erased');
    await expect(log).not.toContainText('Interview submitted');
    // The bank is reloaded after the erase; settings are gone too (the name is asked again).
    await page.goto('./');
    await expect(page.locator('.dash-banklinks > li')).toHaveCount(4);
    await page.goto('./#/new');
    await expect(page.getByLabel('Your name')).toBeVisible();
  });

  test('RES-1 PRIV-6: candidate details typed on an unfinished set-up survive closing the tab, and deleting the set-up removes them', async ({ page, context }) => {
    await openApp(page);
    await newDraft(page, 'web');
    await fillCandidate(page, { initials: 'TB', requisitionId: 'R-TAB' });
    const draftUrl = page.url();
    await page.waitForTimeout(300);
    await page.close();

    const again = await context.newPage();
    await again.goto(draftUrl);
    await expect(again.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
    await expect(again.getByRole('textbox', { name: 'Candidate', exact: true })).toHaveValue('TB');
    await openMoreOptions(again);
    await expect(again.getByLabel('Requisition id')).toHaveValue('R-TAB');

    await again.goto('./');
    await again.locator('section[aria-labelledby="dash-drafts"]').getByRole('button', { name: /Delete/ }).first().click();
    await modal(again, 'Delete this set-up?').getByRole('button', { name: 'Delete set-up' }).click();
    await expect(again.locator('section[aria-labelledby="dash-drafts"]')).toHaveCount(0);
    const left = await again.evaluate(
      () =>
        new Promise<number>((resolve, reject) => {
          const req = indexedDB.open('interview-assistant');
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const tx = req.result.transaction('candidateDrafts', 'readonly');
            const count = tx.objectStore('candidateDrafts').count();
            count.onsuccess = () => {
              resolve(count.result);
              req.result.close();
            };
          };
        }),
    );
    expect(left).toBe(0);
  });
});

test.describe('Imported files', () => {
  test('SEC-2 FLOW-26 DATA-4: imported plan and session files are validated, hostile files are rejected, and their text renders as text', async ({ page }) => {
    await openApp(page, 'Iris Import');
    await setupInterview(page, { pick: [1, 2], candidate: { initials: 'IM', requisitionId: 'R-IMP' } });
    for (const n of [1, 2]) {
      await expectQuestion(page, n);
      await focusQuestion(page);
      await page.keyboard.press('3');
      await expect(scoreRadio(page, 3)).toBeChecked();
      if (n === 1) await page.keyboard.press('n');
    }
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: 'ok' });
    const own = JSON.parse((await exportFromScorecard(page, 'Interview file for the debrief')).text);
    const ownId = own.session.id as string;

    // A "panelist" file built from it, with markup in every free-text field.
    const hostile = JSON.parse(JSON.stringify(own));
    hostile.session.id = '00000000-0000-4000-8000-000000000001';
    hostile.session.interviewer.name = '<img src=x onerror="window.__xss=4">Eve';
    // DATA-5: the interviewers list starts with that name; PANEL-3: a note author with markup too.
    hostile.session.interviewers = [hostile.session.interviewer.name];
    hostile.session.overall.rationale = '<script>window.__xss=5</script>';
    for (const a of hostile.answers) {
      a.sessionId = hostile.session.id;
      a.notes = [{ atSec: 1, text: '<img src=x onerror="window.__xss=6">', by: hostile.session.interviewer.name }];
    }
    const files = [
      { name: 'hostile.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(hostile)) },
      { name: 'truncated.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(own).slice(0, 200)) },
      { name: 'proto.json', mimeType: 'application/json', buffer: Buffer.from('{"__proto__":{"polluted":1},"kind":"interview-session","formatVersion":1}') },
      { name: 'wrong-kind.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ ...own, kind: 'interview-plan' })) },
      {
        name: 'tampered.json',
        mimeType: 'application/json',
        buffer: Buffer.from(JSON.stringify({ ...own, session: { ...own.session, id: 'x2' }, plan: { ...own.plan, questions: own.plan.questions.slice(1) } })),
      },
    ];
    await page.goto(`./#/debrief/${ownId}`);
    await page.getByLabel('Import other interviewers’ files').setInputFiles(files);
    const main = page.locator('main');
    await expect(main).toContainText('Imported <img src=x onerror="window.__xss=4">Eve’s interview into this panel.');
    await expect(main).toContainText('Not imported: The file is not valid JSON.');
    await expect(main).toContainText('Expected a file of kind "interview-session"');
    await expect(main).toContainText('fingerprint does not match the plan contents');
    expect(await page.evaluate(() => (({}) as Record<string, unknown>).polluted)).toBeUndefined();
    await expect(page.getByRole('table', { name: /Panelists/ })).toContainText('<img src=x onerror="window.__xss=4">Eve');
    await expectNoInjectedMarkup(page);
    await page.goto(`./#/scorecard/${hostile.session.id}`);
    await expect(page.locator('.sc-rationale__text')).toHaveText('<script>window.__xss=5</script>');
    await expect(main).toContainText('<img src=x onerror="window.__xss=6">');
    await expectNoInjectedMarkup(page);

    // A plan file with markup in its name is shown as text on the dashboard.
    await page.goto('./');
    const plan = JSON.parse((await downloadText(page, () => page.locator('section[aria-labelledby="dash-sets"]').getByRole('button', { name: /^Export/ }).first().click())).text);
    plan.plan.id = '00000000-0000-4000-8000-000000000002';
    plan.plan.name = '<img src=x onerror="window.__xss=7">Shared plan';
    await page.getByTestId('import-input').setInputFiles({ name: 'plan.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(plan)) });
    await expect(page.getByRole('link', { name: '<img src=x onerror="window.__xss=7">Shared plan', exact: true })).toBeVisible();
    await page.getByTestId('import-input').setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":"interview-plan","formatVersion":1,"plan":{}}') });
    await expect(page.getByRole('alert')).toContainText('Import failed');
    await expect(page.getByRole('alert')).toContainText('Not imported: The question set file is not valid.');
    await expectNoInjectedMarkup(page);
  });
});
