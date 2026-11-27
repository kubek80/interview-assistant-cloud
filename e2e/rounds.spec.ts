// ROUND-1…ROUND-5, FLOW-2…FLOW-9, FLOW-33, FLOW-34, TEAM-1, TEAM-2, TEAM-15, TEAM-16, UX-1…UX-3, UX-7…UX-9,
// PANEL-1, PRIV-1, HOST-5: hiring rounds, their questions and planning interviews, in the real build.
import AxeBuilder from '@axe-core/playwright';
import pg from 'pg';
import type { Browser, BrowserContext } from '@playwright/test';
import { ADMIN, expect, signIn, test, uniqueEmail, type Guard, type Page } from './fixtures';

type Role = 'admin' | 'organiser' | 'interviewer' | 'reviewer';
interface Person {
  id: string;
  email: string;
  name: string;
}

async function call(page: Page, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown) {
  const r = await page.request.fetch(url, { method, headers: { 'x-ia-request': '1' }, ...(data !== undefined ? { data } : {}) });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

/** A fresh person for one test (so parallel tests never share a Dashboard). */
async function person(admin: Page, role: Role, name: string): Promise<Person> {
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, '-'));
  const added = await call(admin, 'POST', '/api/users', { text: email, role });
  expect(added.status).toBe(201);
  const id = added.body.added[0].id as string;
  expect((await call(admin, 'PATCH', `/api/users/${id}`, { name })).status).toBe(200);
  return { id, email, name };
}

async function as(browser: Browser, guard: Guard, who: string, path = '/', viewport = { width: 1280, height: 800 }): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport });
  guard.watch(ctx);
  const page = await ctx.newPage();
  await signIn(page, who, path);
  return { ctx, page };
}

const run = Date.now().toString(36);
const db = () => new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** Lines for Plan several: candidate, date, time, panel, note. */
function pasteLines(n: number, panel: string, start = 0): string {
  const first = ['Ana', 'Bo', 'Chen', 'Dee', 'Eli', 'Fay', 'Gus', 'Hana', 'Ivo', 'Jo'];
  const last = ['Diaz', 'Li', 'Wu', 'Ng', 'Park'];
  return Array.from({ length: n }, (_, k) => {
    const i = k + start;
    const day = `2027-0${1 + (i % 3)}-${String(10 + (i % 7)).padStart(2, '0')}`;
    return `${first[i % 10]} ${last[Math.floor(i / 10) % 5]}, ${day}, ${String(9 + (i % 8)).padStart(2, '0')}:00, ${panel}`;
  }).join('\n');
}

test('ROUND-1 ROUND-3 UX-2 UX-3 FLOW-2 FLOW-4 FLOW-5 FLOW-6 FLOW-7 FLOW-10 FLOW-33 TEAM-1 TEAM-15 FLOW-8 FLOW-9 ROUND-4 PANEL-1 PRIV-1 PRIV-3: an organiser creates a round, changes its questions, adds the team, plans one interview and 25 by pasting; the questions are then fixed', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const olive = await person(admin, 'organiser', `Olive ${run}`);
  const ian = await person(admin, 'interviewer', `Ian ${run}`);
  const { page } = await as(browser, guard, olive.email, '/rounds');

  // ROUND-1: create a round: name, role, requisition. The creator organises it.
  await page.getByRole('button', { name: 'New round' }).click();
  const dialog = page.getByRole('dialog', { name: 'New round' });
  await dialog.getByLabel('Name').fill(`Web engineers ${run}`);
  await dialog.getByLabel('Role').selectOption('web');
  await dialog.getByLabel('Requisition id').fill('Web spring');
  await dialog.getByRole('button', { name: 'Create round' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Web engineers ${run}`);
  await expect(page.getByText('Round created. Its questions are drawn and ready.')).toBeVisible();
  const roundId = /#\/rounds\/([0-9a-f-]{36})/.exec(page.url())![1];

  // ROUND-3, UX-2: a balanced set is already drawn; edit it in place (UX-3, FLOW-2, FLOW-4, FLOW-6).
  await page.getByRole('navigation', { name: 'Round sections' }).getByRole('link', { name: /Questions/ }).click();
  const summary = page.getByTestId('set-summary');
  await expect(summary).toContainText('14 questions');
  await expect(page.getByText('9 knowledge questions, 2 scenarios, 1 design exercise and 2 behavioural questions')).toBeVisible();
  const codeBefore = await page.getByTestId('set-code').innerText();
  await page.getByRole('button', { name: 'Edit questions' }).click();
  const list = page.getByRole('list', { name: 'Questions in interview order' });
  const firstText = await list.getByRole('listitem').first().getByRole('button').first().innerText();
  await page.getByRole('button', { name: 'Remove question 1', exact: true }).click();
  await expect(summary).toContainText('13 questions');
  await page.getByRole('button', { name: 'Move question 1 down', exact: true }).click();
  await page.getByLabel('Search the bank').fill('what');
  await page.getByRole('list', { name: 'Questions in the bank' }).getByRole('checkbox', { checked: false }).first().check();
  await expect(summary).toContainText('14 questions');
  await page.getByRole('tab', { name: 'Coverage' }).click();
  await expect(page.getByRole('table', { name: 'Questions per category' })).toContainText('Auth & security');
  await page.getByLabel('Time budget (minutes)').fill('75');
  await expect(summary).toContainText('of 75');
  await page.getByRole('button', { name: /^Weights/ }).click();
  await page.getByRole('checkbox', { name: /Must-have for Auth & security/ }).check();
  await expect(page.getByText(/must-have: Auth & security/)).toBeVisible();
  await expect(page.getByTestId('set-code')).toContainText('Saved');
  await expect(page.getByTestId('set-code')).not.toHaveText(codeBefore);
  await page.reload();
  await expect(summary).toContainText('14 questions');
  await expect(summary).toContainText('of 75');
  await page.getByRole('button', { name: 'Edit questions' }).click();
  await expect(list.getByText(firstText)).toHaveCount(0);

  // ROUND-2: the team.
  await page.getByRole('navigation', { name: 'Round sections' }).getByRole('link', { name: /Team/ }).click();
  await page.getByLabel('Person').selectOption({ label: `${ian.name} (${ian.email})` });
  await page.getByRole('button', { name: 'Add to team' }).click();
  await expect(page.getByRole('row', { name: new RegExp(ian.name) })).toContainText('Interviewer');

  // TEAM-1, PANEL-1, FLOW-33: plan one interview; Continue opens the ready screen.
  await page.getByRole('link', { name: 'New interview' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('New interview');
  await expect(page.getByRole('checkbox', { name: /\(you\)/ })).toBeChecked();
  await page.getByRole('textbox', { name: 'Candidate' }).fill('Ana Diaz');
  await page.getByRole('checkbox', { name: ian.name }).check();
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to start');
  await expect(page.locator('.ready__key')).toHaveText('Ana Diaz');
  await expect(page.getByText(`You and ${ian.name}`)).toBeVisible();
  await expect(page.getByText(/Notes and ratings from this interview are recorded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start interview' })).toBeFocused();
  expect(page.url()).not.toMatch(/Ana|Diaz/); // PRIV-3: random ids only
  // FLOW-7, FLOW-10: Start needs the confirmation; starting itself is the next step (nothing is recorded yet).
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByRole('alert')).toContainText('Read the text above to the candidate');
  await expect(page.getByLabel(/I confirm the candidate has been told/)).toBeFocused();
  await page.getByLabel(/I confirm the candidate has been told/).check();
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByText('Coming in the next step')).toBeVisible();

  // FLOW-8: the round's questions are now fixed.
  await page.goto(`/#/rounds/${roundId}/questions`);
  await expect(page.getByText('These questions are fixed: 1 interview uses them.')).toBeVisible();

  // TEAM-15: 25 more by pasting, with the panel named by email.
  await page.goto(`/#/rounds/${roundId}/plan`);
  await page.getByLabel('Candidates, one per line').fill(pasteLines(25, ian.email));
  await expect(page.getByRole('heading', { name: '25 ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Plan 25 interviews' }).click();
  await expect(page.getByTestId('plan-done')).toContainText('25 interviews planned');
  await page.getByRole('link', { name: 'See the round’s interviews' }).click();
  await expect(page.getByTestId('round-counts')).toContainText('26 upcoming');

  // FLOW-9: changing fixed questions makes a new set for future interviews, with a plain warning.
  await page.goto(`/#/rounds/${roundId}/questions`);
  await expect(page.getByText('These questions are fixed: 26 interviews use them.')).toBeVisible();
  const fixedCode = await page.getByTestId('set-code').innerText();
  await page.getByRole('button', { name: 'Edit questions' }).click();
  await page.getByRole('button', { name: 'Remove question 14' }).click();
  await page.getByRole('button', { name: 'Save as a new set for future interviews' }).click();
  await expect(page.getByRole('alertdialog')).toContainText('Candidates on different sets are marked as not directly comparable');
  await page.getByRole('button', { name: 'Save new set' }).click();
  await expect(page.getByText(/Saved as a new question set/)).toBeVisible();
  await expect(summary).toContainText('13 questions');
  await expect(page.getByTestId('set-code')).not.toHaveText(fixedCode);
  await expect(page.getByText(/These questions are fixed/)).toHaveCount(0);
});

test('ROUND-4 TEAM-2 TEAM-16 ROUND-2 FLOW-1 FLOW-34 UX-9: an interviewer sees their own upcoming interviews first among 40, can search them, cannot manage the round, and continues an interview in progress', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const org = await person(admin, 'organiser', `Oscar ${run}`);
  const ivy = await person(admin, 'interviewer', `Ivy ${run}`);
  const { page: op } = await as(browser, guard, org.email);
  const round = await call(op, 'POST', '/api/rounds', { name: `Forty ${run}`, trackId: 'qa' });
  const roundId = round.body.id as string;
  await call(op, 'PUT', `/api/rounds/${roundId}/members/${ivy.id}`, { role: 'interviewer' });
  const lines = Array.from({ length: 40 }, (_, i) => ({
    candidate: `Cand ${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(97 + Math.floor(i / 26))}`,
    date: `2027-02-${String(1 + (i % 9)).padStart(2, '0')}`,
    time: `${String(9 + (i % 8)).padStart(2, '0')}:30`,
    panel: i % 2 ? [ivy.id, org.id] : [org.id],
  }));
  expect((await call(op, 'POST', `/api/rounds/${roundId}/interviews/bulk`, { lines })).status).toBe(201);

  const { page } = await as(browser, guard, ivy.email);
  await expect(page.getByTestId('dash-counts')).toContainText('40 upcoming');
  await expect(page.getByRole('heading', { name: 'Your upcoming interviews' })).toBeVisible();
  // Mine first: the first section holds only interviews I am on, soonest first.
  await expect(page.getByTestId('my-row').first()).toContainText(`You and ${org.name}`);
  await expect(page.getByTestId('my-row')).toHaveCount(20);
  // The others are folded away for an interviewer.
  await expect(page.getByTestId('other-upcoming-row').first()).toBeHidden();
  await page.getByRole('button', { name: 'Show 20' }).click();
  await expect(page.getByTestId('other-upcoming-row').first()).toBeVisible();
  // UX-9: one obvious action: their next interview.
  await expect(page.getByTestId('next-interview')).toContainText('Your next interview: Cand Ja, Mon, Feb 1, 2027 at 10:30');
  // TEAM-16: search by candidate.
  await page.getByLabel('Find a candidate').fill('cand ba');
  await expect(page.getByTestId('my-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Clear' }).click();

  // The round: readable, not manageable.
  await page.goto(`/#/rounds/${roundId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`Forty ${run}`);
  await expect(page.getByTestId('new-interview')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Round sections' }).getByRole('link')).toHaveText([/Interviews/, /Team/, /Questions/]);
  await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0);
  await page.getByRole('navigation', { name: 'Round sections' }).getByRole('link', { name: /Team/ }).click();
  await expect(page.getByText('Add someone to the team')).toHaveCount(0);
  await page.goto(`/#/rounds/${roundId}/new`);
  await expect(page.getByText('Only the round’s organisers plan its interviews.')).toBeVisible();
  guard.allowErrors(/status of 403/);
  expect((await call(page, 'PATCH', `/api/rounds/${roundId}`, { name: 'Mine now' })).status).toBe(403);
  expect((await call(page, 'POST', `/api/rounds/${roundId}/interviews`, { candidate: { name: 'X' }, panel: [ivy.id] })).status).toBe(403);

  // FLOW-34: an interview in progress (started in step 2b) is the most prominent action.
  const c = db();
  await c.connect();
  const mine = (await call(page, 'GET', '/api/my/interviews')).body.find((i: { onMyPanel: boolean; roundId: string }) => i.onMyPanel && i.roundId === roundId);
  await c.query(`UPDATE interviews SET state = 'in_progress', started_at = now() WHERE id = $1`, [mine.id]);
  await c.end();
  await page.goto('/#/');
  await expect(page.getByRole('link', { name: 'Continue the interview' })).toBeVisible();
  await expect(page.getByTestId('dash-counts')).toContainText('39 upcoming · 1 in progress');
});

test('ROUND-2 REVIEW-1 AUTH-5 HPRIV-1: someone not on a round cannot see it by navigation or by calling the API; an administrator sees every round; a question reviewer is refused', async ({ page: admin, browser, guard }) => {
  guard.allowErrors(/status of 40[34]/);
  await signIn(admin, ADMIN);
  const owner = await person(admin, 'organiser', `Owner ${run}`);
  const outsider = await person(admin, 'organiser', `Outsider ${run}`);
  const reviewer = await person(admin, 'reviewer', `Rev ${run}`);
  const { page: op } = await as(browser, guard, owner.email);
  const roundId = (await call(op, 'POST', '/api/rounds', { name: `Private ${run}`, trackId: 'edge' })).body.id as string;
  const interviewId = (await call(op, 'POST', `/api/rounds/${roundId}/interviews`, { candidate: { name: 'Secret Person' }, panel: [owner.id] })).body.id as string;

  const { page } = await as(browser, guard, outsider.email, '/rounds');
  await expect(page.getByRole('link', { name: `Private ${run}` })).toHaveCount(0);
  await page.goto(`/#/rounds/${roundId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Round not found');
  await page.goto(`/#/interviews/${interviewId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Interview not found');
  for (const url of [`/api/rounds/${roundId}`, `/api/rounds/${roundId}/interviews`, `/api/rounds/${roundId}/question-set`, `/api/interviews/${interviewId}`]) expect((await call(page, 'GET', url)).status, url).toBe(404);
  expect((await call(page, 'POST', `/api/interviews/${interviewId}/cancel`, {})).status).toBe(404);
  expect(JSON.stringify((await call(page, 'GET', '/api/my/interviews')).body)).not.toContain('Secret');

  // Administrators see every round.
  await admin.goto('/#/rounds');
  await expect(admin.getByRole('link', { name: `Private ${run}` })).toBeVisible();
  await admin.getByRole('link', { name: `Private ${run}` }).click();
  await expect(admin.getByRole('heading', { level: 1 })).toHaveText(`Private ${run}`);
  await expect(admin.getByText('Secret Person').first()).toBeVisible();

  // REVIEW-1: a reviewer is refused, and cannot be put on the team.
  const { page: rp } = await as(browser, guard, reviewer.email);
  await rp.goto(`/#/rounds/${roundId}`);
  await expect(rp.getByRole('heading', { level: 1 })).toHaveText('Not available');
  expect([403, 404]).toContain((await call(rp, 'GET', `/api/rounds/${roundId}`)).status);
  expect((await call(rp, 'GET', '/api/rounds')).status).toBe(403);
  const refused = await call(op, 'PUT', `/api/rounds/${roundId}/members/${reviewer.id}`, { role: 'interviewer' });
  expect(refused.status).toBe(400);
  await op.goto(`/#/rounds/${roundId}/team`);
  await expect(op.getByLabel('Person').locator('option', { hasText: reviewer.email })).toHaveCount(0);
});

test('HOST-5 ROUND-4 TEAM-2: planning, changes and cancelling appear for another member of the round without reloading', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const org = await person(admin, 'organiser', `Live Org ${run}`);
  const member = await person(admin, 'interviewer', `Live Ian ${run}`);
  const { page: op } = await as(browser, guard, org.email);
  const roundId = (await call(op, 'POST', '/api/rounds', { name: `Live ${run}`, trackId: 'aks' })).body.id as string;
  await call(op, 'PUT', `/api/rounds/${roundId}/members/${member.id}`, { role: 'interviewer' });

  const { page } = await as(browser, guard, member.email);
  await expect(page.getByText('You are not on the panel of any upcoming interview.')).toBeVisible();

  // The organiser plans one through the UI ("Save" for a later day).
  await op.goto(`/#/rounds/${roundId}/new`);
  await op.getByRole('textbox', { name: 'Candidate' }).fill('Lou Reed');
  await op.locator('#ni-date').fill('2027-03-04');
  await op.locator('#ni-time').fill('10:15');
  await op.getByRole('checkbox', { name: member.name }).check();
  await op.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(op.getByRole('heading', { level: 1 })).toHaveText(`Live ${run}`);

  const row = page.getByTestId('my-row').filter({ hasText: 'Lou Reed' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('10:15');

  // Changed from the round's list: the other member sees the new time.
  const orow = op.getByTestId('upcoming-row').filter({ hasText: 'Lou Reed' });
  await orow.getByRole('button', { name: /Change/ }).click();
  await op.getByRole('menuitem', { name: 'Change date, interviewers or note' }).click();
  const dialog = op.getByRole('dialog', { name: 'Change the planned interview' });
  await dialog.getByLabel('Time').fill('14:45');
  await dialog.getByLabel('Note for the interviewers').fill('Video link in the invite');
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(row).toContainText('14:45');
  await expect(row).toContainText('Video link in the invite');

  // Cancelled: it disappears for both.
  await orow.getByRole('button', { name: /Change/ }).click();
  await op.getByRole('menuitem', { name: 'Cancel interview' }).click();
  await op.getByRole('alertdialog').getByRole('button', { name: 'Cancel interview' }).click();
  await expect(orow).toHaveCount(0);
  await expect(row).toHaveCount(0);
});

test('ROUND-5 ROUND-1 LIVE-3 HPRIV-4: a round is closed (read-only) and reopened with a reason; settings are saved; the round’s changes are listed', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const org = await person(admin, 'organiser', `Closer ${run}`);
  const { page } = await as(browser, guard, org.email);
  const roundId = (await call(page, 'POST', '/api/rounds', { name: `Closing ${run}`, trackId: 'qa' })).body.id as string;
  await page.goto(`/#/rounds/${roundId}/settings`);
  await page.getByLabel(/Hide other people’s scores/).check();
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.getByText('Settings saved.')).toBeVisible();
  await page.getByRole('button', { name: 'Close the round…' }).click();
  await page.getByRole('dialog').getByLabel(/Reason/).fill('Role filled');
  await page.getByRole('dialog').getByRole('button', { name: 'Close round' }).click();
  await expect(page.getByText(/It is read-only/).first()).toBeVisible();
  await expect(page.getByTestId('new-interview')).toHaveCount(0);
  await page.goto(`/#/rounds/${roundId}/new`);
  await expect(page.getByText('This round is closed, so no interviews can be planned in it.')).toBeVisible();
  await page.goto(`/#/rounds/${roundId}/settings`);
  await page.getByRole('button', { name: 'Reopen the round' }).first().click();
  await page.getByRole('dialog').getByLabel('Why is it reopened?').fill('Second opening');
  await page.getByRole('dialog').getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByText('The round is open again.')).toBeVisible();
  await expect(page.getByTestId('new-interview')).toBeVisible();
  const history = page.locator('.round-history');
  await expect(history).toContainText('Round reopened');
  await expect(history).toContainText('Round closed');
  await expect(history).toContainText('Round settings changed');
});

test('UX-1 UX-9 TEAM-1: New interview: the one required input and the primary action are visible without scrolling at 1280 × 800; a later date makes "Save" the primary action', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const org = await person(admin, 'organiser', `UX ${run}`);
  const { page } = await as(browser, guard, org.email);
  const roundId = (await call(page, 'POST', '/api/rounds', { name: `UX ${run}`, trackId: 'web' })).body.id as string;
  // From the Dashboard, an organiser of exactly one open round goes straight to it.
  await page.goto('/#/');
  await page.getByTestId('new-interview').click();
  await expect(page).toHaveURL(new RegExp(`#/rounds/${roundId}/new$`));
  await expect(page.getByTestId('set-summary')).toContainText('14 questions');
  const vh = 800;
  for (const loc of [page.getByRole('textbox', { name: 'Candidate' }), page.getByRole('button', { name: /Continue/ })]) {
    const box = (await loc.boundingBox())!;
    expect(box.y + box.height, 'visible without scrolling').toBeLessThanOrEqual(vh);
  }
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  // Required inputs: only the candidate.
  await expect(page.locator('main [required], main [aria-required="true"]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: /Continue/ })).toHaveClass(/btn--primary/);
  await page.locator('#ni-date').fill('2030-01-02');
  await expect(page.getByRole('button', { name: 'Save', exact: true })).toHaveClass(/btn--primary/);
  await expect(page.getByRole('button', { name: 'Continue now' })).not.toHaveClass(/btn--primary/);
  // Nothing typed: Continue says what is missing and moves focus there.
  await page.locator('#ni-date').fill('');
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByRole('alert')).toContainText('Enter the candidate’s name or initials.');
  await expect(page.getByRole('textbox', { name: 'Candidate' })).toBeFocused();
  // ROUND-3: an individual interview can have different questions, clearly marked.
  await page.getByRole('textbox', { name: 'Candidate' }).fill('Ken Own');
  await page.getByRole('button', { name: 'Use different questions for this interview…' }).click();
  await expect(page.getByText(/cannot be compared directly with the others/)).toBeVisible();
  await page.getByRole('button', { name: 'Remove question 1', exact: true }).click();
  await page.getByRole('button', { name: /Continue/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Ready to start');
  await expect(page.getByText(/Different questions from the round’s current set/)).toBeVisible();
  await expect(page.locator('.ready__facts')).toContainText('13 questions');
});

test('A11Y-7 A11Y-3 A11Y-6 A11Y-2 UX-7 UX-8 UX-9: the round screens have no serious axe violations in light and dark, do not scroll sideways at 390px, and show no requirement ids or internal words', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const org = await person(admin, 'organiser', `Axe ${run}`);
  const ian = await person(admin, 'interviewer', `Axe Ian ${run}`);
  const { page: op } = await as(browser, guard, org.email);
  const roundId = (await call(op, 'POST', '/api/rounds', { name: `Axe ${run}`, trackId: 'web' })).body.id as string;
  await call(op, 'PUT', `/api/rounds/${roundId}/members/${ian.id}`, { role: 'interviewer' });
  const lines = Array.from({ length: 12 }, (_, i) => ({ candidate: `Axe ${String.fromCharCode(65 + i)}`, date: `2027-04-0${1 + (i % 5)}`, time: '10:00', panel: [org.id, ian.id], note: i ? '' : 'Room four' }));
  await call(op, 'POST', `/api/rounds/${roundId}/interviews/bulk`, { lines, recordingNotice: true });
  const interviewId = (await call(op, 'GET', `/api/rounds/${roundId}/interviews`)).body[0].id as string;
  const screens: Array<{ name: string; path: string; ready: (p: Page) => Promise<unknown>; open?: (p: Page) => Promise<unknown> }> = [
    { name: 'dashboard', path: '/', ready: (p) => p.getByTestId('my-row').first().waitFor() },
    { name: 'rounds', path: '/rounds', ready: (p) => p.getByTestId('round-card').first().waitFor() },
    { name: 'new round', path: '/rounds', ready: (p) => p.getByTestId('round-card').first().waitFor(), open: (p) => p.getByRole('button', { name: 'New round' }).click() },
    { name: 'round interviews', path: `/rounds/${roundId}`, ready: (p) => p.getByTestId('upcoming-row').first().waitFor() },
    { name: 'round team', path: `/rounds/${roundId}/team`, ready: (p) => p.getByRole('table').waitFor() },
    { name: 'round questions', path: `/rounds/${roundId}/questions`, ready: (p) => p.getByTestId('set-summary').waitFor() },
    {
      name: 'round questions editing',
      path: `/rounds/${roundId}/questions`,
      ready: (p) => p.getByTestId('set-summary').waitFor(),
      open: async (p) => {
        await p.getByRole('button', { name: 'Edit questions' }).click();
        await p.getByRole('button', { name: /^Weights/ }).click();
      },
    },
    { name: 'round settings', path: `/rounds/${roundId}/settings`, ready: (p) => p.getByRole('button', { name: 'Save settings' }).waitFor() },
    { name: 'new interview', path: `/rounds/${roundId}/new`, ready: (p) => p.getByTestId('set-summary').waitFor(), open: (p) => p.getByRole('button', { name: /More options/ }).click() },
    {
      name: 'plan several preview',
      path: `/rounds/${roundId}/plan`,
      ready: (p) => p.getByLabel('Candidates, one per line').waitFor(),
      open: async (p) => {
        await p.getByLabel('Candidates, one per line').fill(`Pat Low, 2027-05-01, 09:00, ${ian.email}\nBad 1\nSam Fox, 2027-05-01, 10:00, nobody at all`);
        await p.getByText('1 ready · 2 with problems').waitFor();
      },
    },
    { name: 'ready screen', path: `/interviews/${interviewId}`, ready: (p) => p.getByRole('button', { name: 'Start interview' }).waitFor() },
    {
      name: 'change dialog',
      path: `/interviews/${interviewId}`,
      ready: (p) => p.getByRole('button', { name: 'Start interview' }).waitFor(),
      open: (p) => p.getByRole('button', { name: 'Change date, interviewers or note' }).click(),
    },
  ];
  const problems: string[] = [];
  const words: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    await op.emulateMedia({ colorScheme: scheme });
    for (const s of screens) {
      await op.goto(`/#${s.path}`);
      await s.ready(op);
      await s.open?.(op);
      await op.waitForTimeout(150);
      for (const v of await axe(op)) problems.push(`${scheme} ${s.name}: ${v}`);
      if (scheme === 'light') {
        await expect(op.locator('h1')).toHaveCount(1);
        const text = await op.locator('body').innerText();
        if (/\b[A-Z][A-Z0-9]*-\d+\b/.test(text)) words.push(`${s.name}: requirement id ${text.match(/\b[A-Z][A-Z0-9]*-\d+\b/)![0]}`);
        const internal = text.match(/\b(fingerprint|quota|locked|lock|seed file|plan id)\b/gi);
        if (internal) words.push(`${s.name}: ${internal.join(', ')}`);
      }
      await op.keyboard.press('Escape');
    }
  }
  expect(problems).toEqual([]);
  expect(words).toEqual([]);

  // 390 px wide: nothing scrolls sideways.
  const { page: narrow } = await as(browser, guard, org.email, '/', { width: 390, height: 800 });
  const wide: string[] = [];
  for (const s of screens) {
    await narrow.goto(`/#${s.path}`);
    await s.ready(narrow);
    await s.open?.(narrow);
    await narrow.waitForTimeout(150);
    const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 0) wide.push(`${s.name}: ${overflow}px`);
    await narrow.keyboard.press('Escape');
  }
  expect(wide).toEqual([]);
  // The interviewer's Dashboard too.
  const { page: ip } = await as(browser, guard, ian.email, '/', { width: 390, height: 800 });
  await ip.getByTestId('my-row').first().waitFor();
  expect(await ip.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  for (const v of await axe(ip)) problems.push(`interviewer dashboard 390: ${v}`);
  expect(problems).toEqual([]);
});
