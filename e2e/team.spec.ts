// TEAM-1…TEAM-6, TEAM-14, TEAM-15, TEAM-16: planning ahead, invitations, collecting results.
// Separate browser contexts play the organiser and two interviewers on their own computers.
import { mkdirSync, writeFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { Browser } from '@playwright/test';
import {
  browserToday,
  downloadText,
  expect,
  finishInterview,
  importFiles,
  modal,
  openApp,
  openMoreOptions,
  openNewInterview,
  pickByNumber,
  scoreAllWithKeys,
  startInterview,
  test,
  exportFromScorecard,
  type Guard,
  type Page,
} from './fixtures';

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

/** A11Y-7, A11Y-6, UX-9: axe in both schemes and no horizontal scroll at 390px for the current state. */
async function checkState(page: Page, name: string): Promise<string[]> {
  const failures: string[] = [];
  const size = page.viewportSize()!;
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      for (const v of result.violations) {
        if (v.impact === 'serious' || v.impact === 'critical') failures.push(`${name} ${scheme} ${width}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 2).join(' | ')}`);
      }
      const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      if (wide) failures.push(`${name} ${scheme} ${width}: horizontal scroll`);
      if (shotDir) {
        mkdirSync(shotDir, { recursive: true });
        await page.screenshot({ path: `${shotDir}/team-${name}-${scheme}-${width}.png`, fullPage: true });
      }
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await page.setViewportSize(size);
  return failures;
}

/** UX-7, UX-8: no requirement codes and none of the app's internal words on the screen. */
async function plainWords(page: Page, where: string) {
  const text = await page.locator('main').innerText();
  expect(text, `${where}: no requirement ids`).not.toMatch(/\b(TEAM|FLOW|PRIV|UX)-\d+/);
  expect(text, `${where}: plain words`).not.toMatch(/\b(session|fingerprint|plan file|panelist file)\b/i);
}

const upcomingRow = (page: Page, who: string) => page.getByTestId('upcoming-row').filter({ hasText: who });

/** New interview › Save for later, with the schedule dialog filled. */
async function saveForLater(page: Page, o: { date?: string; time?: string; interviewers?: string[]; note?: string }) {
  await page.getByRole('button', { name: 'Save for later' }).click();
  const dlg = modal(page, 'Save for later');
  await expect(dlg).toBeVisible();
  if (o.date) await dlg.getByLabel('Date').fill(o.date);
  if (o.time) await dlg.getByLabel('Time').fill(o.time);
  if (o.interviewers) {
    // Replace the names offered (the people at this machine) with the panel.
    while ((await dlg.getByRole('button', { name: /^Remove interviewer/ }).count()) > 0) await dlg.getByRole('button', { name: /^Remove interviewer/ }).first().click();
    for (const [i, n] of o.interviewers.entries()) {
      await dlg.getByRole('button', { name: 'Add interviewer' }).click();
      await dlg.getByLabel(`Interviewer ${i + 1}`, { exact: true }).fill(n);
    }
  }
  if (o.note) await dlg.getByLabel('Note for the interviewers').fill(o.note);
  await dlg.getByRole('button', { name: 'Save for later' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

test.describe('Planning ahead and working as a panel', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test('TEAM-1 TEAM-2 TEAM-3 TEAM-4 TEAM-5 TEAM-6 FLOW-27 FLOW-29 SCORE-11: an organiser plans two interviews, two interviewers import the invitation, interview and send their files, the organiser imports them and debriefs', async ({
    page,
    browser,
    guard,
  }, testInfo) => {
    test.setTimeout(300_000);
    const dir = testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    const failures: string[] = [];
    await openApp(page, 'Olive Organiser');
    const today = await browserToday(page);
    const day1 = plusDays(today, 1);
    const day2 = plusDays(today, 2);

    // TEAM-1: Save for later beside Continue; UX-1: the default path is unchanged.
    await openNewInterview(page, 'qa');
    await pickByNumber(page, [1, 2, 3]);
    await page.locator('#ni-edit').click();
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Ana Diaz');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('REQ-42');
    await page.getByRole('button', { name: 'Save for later' }).click();
    await expect(modal(page, 'Save for later').getByLabel('Interviewer 1', { exact: true })).toHaveValue('Olive Organiser');
    failures.push(...(await checkState(page, 'save-for-later-dialog')));
    await modal(page, 'Save for later').getByRole('button', { name: 'Cancel' }).click();
    await saveForLater(page, { date: day2, time: '10:00', interviewers: ['Ben Second', 'Cy Third'] });
    await expect(page.locator('.toast')).toContainText('Saved for later: Ana Diaz');
    // A second one, same questions (reuse), a day earlier.
    await page.locator('section[aria-labelledby="dash-sets"]').getByRole('link', { name: /^Reuse/ }).first().click();
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Bo Li');
    await openMoreOptions(page);
    await page.getByLabel('Requisition id').fill('REQ-42');
    await saveForLater(page, { date: day1, time: '09:00', interviewers: ['Ben Second', 'Cy Third'] });
    // TEAM-2: soonest first, grouped by day ("Tomorrow"), with the role and interviewers; nothing in the Continue card.
    const rows = page.getByTestId('upcoming-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText('Bo Li · REQ-42');
    await expect(rows.nth(1)).toContainText('Ana Diaz · REQ-42');
    await expect(page.locator('.up-day__title').first()).toContainText('Tomorrow');
    // One role in the list: it is not repeated on every line.
    await expect(rows.nth(0)).toContainText('with Ben Second and Cy Third');
    await expect(rows.nth(0)).not.toContainText('Senior QA Engineer');
    await expect(rows.nth(0)).not.toContainText('Still to come'); // nobody has submitted yet: "with …" says it
    await expect(page.locator('.continue')).toHaveCount(0);
    // TEAM-2: Change (date, time, interviewers, note), never the questions.
    await upcomingRow(page, 'Ana Diaz').getByRole('button', { name: /^Change/ }).click();
    const change = modal(page, 'Change the planned interview');
    await expect(change).toContainText('The questions stay the same.');
    failures.push(...(await checkState(page, 'change-dialog')));
    await change.getByLabel('Note for the interviewers').fill('Room 4, bring the laptop');
    await change.getByRole('button', { name: 'Save changes' }).click();
    await expect(upcomingRow(page, 'Ana Diaz')).toContainText('Room 4, bring the laptop');
    await plainWords(page, 'dashboard with upcoming');

    // TEAM-3: select both and export one invitation file.
    await upcomingRow(page, 'Ana Diaz').getByRole('checkbox').check();
    await upcomingRow(page, 'Bo Li').getByRole('checkbox').check();
    const inv = await downloadText(page, () => page.getByRole('button', { name: 'Export 2 invitations' }).click());
    expect(inv.name).toMatch(/^interview-invitation-[0-9a-f]{8}-/);
    const invJson = JSON.parse(inv.text);
    expect(invJson.kind).toBe('interview-invitation');
    expect(invJson.interviews.map((i: { candidate: { initials: string } }) => i.candidate.initials)).toEqual(['Ana Diaz', 'Bo Li']);
    expect(invJson.interviews[0]).toMatchObject({ date: day2, time: '10:00', expectedInterviewers: ['Ben Second', 'Cy Third'], note: 'Room 4, bring the laptop', organiser: 'Olive Organiser' });
    expect(inv.text).not.toMatch(/"score"|"answers"/);
    const invPath = `${dir}/invitation.json`;
    writeFileSync(invPath, inv.text);

    // TEAM-4: each interviewer imports it; re-importing does not duplicate.
    const files: Record<string, string> = {};
    for (const [name, score] of [['Ben Second', 2], ['Cy Third', 3]] as const) {
      const p = await computer(browser, guard, name);
      let results = await importFiles(p, invPath);
      await expect(results).toContainText('Invitation from Olive Organiser: 2 interviews (2 added to Upcoming).');
      if (name === 'Ben Second') failures.push(...(await checkState(p, 'import-results')));
      await expect(p.getByTestId('upcoming-row')).toHaveCount(2);
      await expect(upcomingRow(p, 'Ana Diaz')).toContainText('from Olive Organiser');
      results = await importFiles(p, invPath);
      await expect(results).toContainText('already here, nothing changed');
      await expect(p.getByTestId('upcoming-row')).toHaveCount(2);
      // Start from Upcoming: the ready screen with consent, as usual.
      await upcomingRow(p, 'Ana Diaz').getByRole('link', { name: /^Start/ }).click();
      await expect(p.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
      await expect(p.locator('main')).toContainText('Room 4, bring the laptop');
      await expect(p.getByRole('button', { name: 'Discard and set up again' })).toHaveCount(0);
      await startInterview(p);
      await scoreAllWithKeys(p, score, 3);
      await finishInterview(p, { rating: score, recommendation: score === 3 ? 'Hire' : 'Lean no hire', rationale: `${name} rationale.` });
      const f = await exportFromScorecard(p, 'Interview file for the debrief');
      expect(JSON.parse(f.text).session.invitationId).toBe(invJson.interviews[0].invitationId);
      files[name] = `${dir}/${name.split(' ')[0]}.json`;
      writeFileSync(files[name], f.text);
      // TEAM-4: a changed invitation updates what has not started and leaves the started one alone.
      if (name === 'Ben Second') {
        const changed = JSON.parse(inv.text);
        for (const it of changed.interviews) it.time = '15:00';
        writeFileSync(`${dir}/invitation-changed.json`, JSON.stringify(changed));
        results = await importFiles(p, `${dir}/invitation-changed.json`);
        await expect(results).toContainText('Ana Diaz · REQ-42');
        await expect(results).toContainText('already submitted here, left as it is');
        await expect(results).toContainText('Bo Li · REQ-42');
        await expect(results).toContainText('updated (time)');
        await expect(upcomingRow(p, 'Bo Li')).toContainText('15:00');
        await expect(p.getByTestId('interview-row').filter({ hasText: 'Ana Diaz' })).toContainText('Submitted');
      }
      await p.context().close();
    }

    // TEAM-5, TEAM-6: the organiser imports both files at once from the Dashboard; each is matched.
    await page.goto('./');
    await expect(upcomingRow(page, 'Ana Diaz').getByTestId('attendance')).toHaveCount(0);
    let results = await importFiles(page, files['Ben Second']);
    await expect(results).toContainText('Ben Second’s interview with Ana Diaz · REQ-42: matched.');
    // TEAM-6: the organiser planned this for others (Olive is not expected), so once someone has submitted
    // it leaves Upcoming and is followed under Interviews, waiting for the others; the organiser is never waited for.
    const anaRow = page.getByTestId('interview-row').filter({ hasText: 'Ana Diaz' });
    await expect(upcomingRow(page, 'Ana Diaz')).toHaveCount(0);
    await expect(anaRow).toContainText('Waiting for others');
    await expect(anaRow).toContainText('Submitted: Ben Second');
    await expect(anaRow).toContainText('Still to come: Cy Third');
    await expect(anaRow).not.toContainText('Olive Organiser');
    results = await importFiles(page, [files['Ben Second'], files['Cy Third']]);
    await expect(results).toContainText('Imported 2 of 2 files');
    await expect(results).toContainText('Cy Third’s interview with Ana Diaz · REQ-42: matched.');
    await expect(results).toContainText('it replaces the copy imported before');
    await expect(anaRow).toContainText('Submitted: Ben Second, Cy Third');
    await expect(anaRow).not.toContainText('Still to come');
    await expect(anaRow).not.toContainText('Waiting for others');
    // Imported records are folded into their interview, not listed again.
    await expect(page.getByTestId('interview-row')).toHaveCount(1);
    failures.push(...(await checkState(page, 'dashboard-collected')));
    await plainWords(page, 'dashboard after import');

    // FLOW-27 default (independent scoring off): the debrief shows both at once, with median and spread.
    await anaRow.getByRole('link', { name: /^Debrief/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Debrief' })).toBeVisible();
    const who = page.getByTestId('attendance');
    await expect(who).toContainText('Expected');
    await expect(who).toContainText('Ben Second, Cy Third');
    await expect(who.locator('dd').nth(2)).toHaveText('Nobody');
    const table = page.getByRole('table', { name: /Panelists/ });
    await expect(table.getByRole('row', { name: /Ben Second/ })).toContainText('33%');
    await expect(table.getByRole('row', { name: /Cy Third/ })).toContainText('67%');
    await expect(page.locator('.dbf-figure', { hasText: 'Panel score' }).locator('.dbf-big')).toHaveText('50%');
    await expect(page.locator('.dbf-figure', { hasText: 'Spread' })).toContainText('33 points (above 20)');
    await expect(page.locator('main')).not.toContainText('Hidden until');
    failures.push(...(await checkState(page, 'debrief-attendance')));

    // TEAM-2: cancel (with confirmation).
    await page.goto('./');
    await upcomingRow(page, 'Bo Li').getByRole('button', { name: /^More/ }).click();
    await page.getByRole('menuitem', { name: 'Cancel interview' }).click();
    await modal(page, 'Cancel this interview?').getByRole('button', { name: 'Cancel interview' }).click();
    await expect(page.getByTestId('upcoming-row')).toHaveCount(0);
    expect(failures).toEqual([]);
  });

  test('TEAM-4 SEC-2 UX-7: a hostile invitation file is rejected as a whole and explained; markup in a valid one is shown as text', async ({ page }, testInfo) => {
    const dir = testInfo.outputDir;
    mkdirSync(dir, { recursive: true });
    await openApp(page, 'Olive Organiser');
    await openNewInterview(page, 'qa');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Ana Diaz');
    await saveForLater(page, {});
    const inv = JSON.parse((await downloadText(page, async () => {
      await upcomingRow(page, 'Ana Diaz').getByRole('button', { name: /^More/ }).click();
      await page.getByRole('menuitem', { name: 'Export invitation' }).click();
    })).text);
    const tampered = JSON.parse(JSON.stringify(inv));
    tampered.interviews[0].plan.questions[0].version = 99;
    tampered.interviews[0].candidate.initials = '<img src=x onerror="window.__xss=1">';
    const markup = JSON.parse(JSON.stringify(inv));
    markup.interviews[0].invitationId = '00000000-0000-4000-8000-0000000000ab';
    markup.interviews[0].note = '<img src=x onerror="window.__xss=2">Note';
    markup.interviews[0].organiser = '<b>Mallory</b>';
    markup.interviews[0].candidate.initials = 'Eve Example';
    const results = await importFiles(page, [
      { name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(tampered)) },
      { name: 'markup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(markup)) },
      { name: 'track.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ track: { id: 'x' } })) },
      { name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{"kind":') },
    ]);
    await expect(results).toContainText('Imported 1 of 4 files');
    await expect(results).toContainText('Not imported: The invitation file is not valid.');
    await expect(results).toContainText('must be a name or initials');
    await expect(results).toContainText('Question bank files are imported on the Question bank screen');
    await expect(results).toContainText('Not imported: The file is not valid JSON.');
    await expect(results).toContainText('Invitation from <b>Mallory</b>');
    await expect(upcomingRow(page, 'Eve Example')).toContainText('<img src=x onerror="window.__xss=2">Note');
    expect(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss)).toBeUndefined();
    expect(await page.locator('main img').count()).toBe(0);
    await plainWords(page, 'import results');
  });

  test('TEAM-15 TEAM-16 TEAM-3: forty interviews planned from one paste, then the Dashboard stays scannable: counts, grouped by day, search, filters, show more, no sideways scroll at 390px', async ({ page }) => {
    test.setTimeout(240_000);
    await openApp(page, 'Olive Organiser');
    const today = await browserToday(page);
    const first = ['Ana', 'Bo', 'Chen', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo'];
    const last = ['Diaz', 'Li', 'Wu', 'Ng'];
    const lines = ['Candidate\tDate\tTime\tRequisition\tInterviewers'];
    for (let i = 0; i < 40; i++) {
      const name = `${first[i % 10]} ${last[Math.floor(i / 10)]}`;
      const date = i < 36 ? plusDays(today, 1 + Math.floor(i / 6)) : '';
      lines.push(`${name}\t${date}\t${date ? `${9 + (i % 6)}:00` : ''}\t${i % 2 ? 'REQ-7' : 'REQ-8'}\tBen Second; Cy Third`);
    }
    lines.push('ann@example.com\t31/02/2026\t\t\t');
    await page.goto('./');
    await page.getByRole('link', { name: 'Plan several' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Plan several interviews' })).toBeVisible();
    await page.getByLabel('Role').selectOption('web');
    await page.getByLabel('Candidates, one per line').fill(lines.join('\n'));
    await expect(page.getByRole('heading', { name: '40 ready · 1 with problems' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Preview' })).toContainText('is not a date');
    const failures = await checkState(page, 'plan-several-preview');
    // Nothing was created by the preview.
    await page.goto('./');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(0);
    await page.goBack();
    await page.getByLabel('Role').selectOption('web');
    await page.getByLabel('Candidates, one per line').fill(lines.slice(0, 41).join('\n'));
    await page.getByRole('button', { name: 'Plan 40 interviews' }).click();
    await expect(page.getByRole('heading', { name: '40 interviews planned' })).toBeVisible();
    await expect(page.getByTestId('plan-done')).toContainText('They all have the same questions');
    failures.push(...(await checkState(page, 'plan-several-done')));
    const all = await downloadText(page, () => page.getByRole('button', { name: 'Export invitations for all of them' }).click());
    const file = JSON.parse(all.text);
    expect(file.interviews).toHaveLength(40);
    expect(new Set(file.interviews.map((i: { plan: { fingerprint: string } }) => i.plan.fingerprint)).size).toBe(1);

    await page.getByRole('link', { name: 'Go to the Dashboard' }).click();
    await expect(page.getByTestId('dash-counts')).toHaveText('40 upcoming · 0 in progress · 0 waiting for other interviewers · 0 finished');
    // Grouped by day, soonest first, a page at a time.
    await expect(page.locator('.up-day__title').first()).toContainText('Tomorrow');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(12);
    await page.getByRole('button', { name: 'Show all 40 upcoming' }).click();
    await expect(page.getByTestId('upcoming-row')).toHaveCount(40);
    await expect(page.locator('.up-day__title').last()).toContainText('No date yet');
    failures.push(...(await checkState(page, 'dashboard-40')));
    // Search by candidate (case and spaces do not matter); filter by requisition and state.
    await page.getByLabel('Find a candidate').fill('chen  WU');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(1);
    await page.getByLabel('Find a candidate').fill('diaz');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(10);
    await page.getByLabel('Requisition').selectOption('REQ-7');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(5);
    await page.getByLabel('State').selectOption('finished');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(0);
    await expect(page.locator('main')).toContainText('No upcoming interview matches.');
    await page.getByRole('button', { name: 'Clear' }).click();
    await page.getByLabel('Role').selectOption('qa');
    await expect(page.locator('main')).toContainText('No upcoming interview matches.');
    await page.getByLabel('Role').selectOption('web');
    await expect(page.getByTestId('upcoming-row')).toHaveCount(40);
    // One day's invitations at once.
    const day = await downloadText(page, () => page.locator('.up-day').first().getByRole('button', { name: /^Export this day/ }).click());
    expect(JSON.parse(day.text).interviews).toHaveLength(6);
    await plainWords(page, 'dashboard with 40');
    expect(failures).toEqual([]);
  });

  test('UX-1 TEAM-1: Save for later sits beside Continue; the default path is still two inputs with Continue above the fold', async ({ page }) => {
    await openApp(page, 'Olive Organiser');
    await openNewInterview(page, 'qa');
    const cont = (await page.getByRole('button', { name: /^Continue/ }).boundingBox())!;
    const later = (await page.getByRole('button', { name: 'Save for later' }).boundingBox())!;
    expect(cont.y + cont.height).toBeLessThanOrEqual(800);
    expect(later.y + later.height).toBeLessThanOrEqual(800);
    expect(await page.locator('main .btn--primary:visible').count()).toBe(1);
    // Save for later checks the same things as Continue first.
    await page.getByRole('button', { name: 'Save for later' }).click();
    await expect(page.getByRole('textbox', { name: 'Candidate', exact: true })).toBeFocused();
    await expect(page.locator('dialog[open]')).toHaveCount(0);
  });
});

test('TEAM-14: invitation files carry the candidate and requisition only; a deletion request removes planned interviews', async ({ page }) => {
  await openApp(page, 'Olive Organiser');
  await openNewInterview(page, 'qa');
  await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('Ana Diaz');
  await openMoreOptions(page);
  await page.getByLabel('Requisition id').fill('REQ-9');
  await saveForLater(page, { note: 'Bring ID' });
  const inv = JSON.parse((await downloadText(page, async () => {
    await upcomingRow(page, 'Ana Diaz').getByRole('button', { name: /^More/ }).click();
    await page.getByRole('menuitem', { name: 'Export invitation' }).click();
  })).text);
  expect(Object.keys(inv.interviews[0].candidate).sort()).toEqual(['initials', 'requisitionId']);
  expect(JSON.stringify(inv)).not.toMatch(/consentAt|retentionPurged|"answers"/);
  await page.goto('./#/admin?tab=privacy');
  const card = page.locator('.card', { has: page.getByRole('heading', { name: 'Access and deletion requests' }) });
  await card.getByRole('textbox', { name: 'Candidate', exact: true }).fill('ana diaz');
  await card.getByLabel('Requisition id').fill('req-9');
  const access = await downloadText(page, async () => {
    await card.getByRole('button', { name: /Export/ }).first().click();
    await modal(page, 'Export everything for this candidate?').getByRole('button', { name: 'Export', exact: true }).click();
  });
  expect(JSON.parse(access.text).plannedInterviews[0].note).toBe('Bring ID');
  await card.getByRole('button', { name: /Delete/ }).first().click();
  await modal(page, 'Delete everything for this candidate?').getByRole('button', { name: /^Delete/ }).click();
  await expect(card).toContainText('Deletion request: deleted 1 interview');
  await page.goto('./');
  await expect(page.getByTestId('upcoming-row')).toHaveCount(0);
});
