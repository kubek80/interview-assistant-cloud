// LIVE-1…LIVE-8, HOST-5, HOST-6, FLOW-7, FLOW-10…FLOW-25, FLOW-31, FLOW-32, RES-1…RES-3, RUB-1…RUB-5,
// SCORE-1…SCORE-10, KEY-1, KEY-2, PANEL-2…PANEL-4, UX-4…UX-6, AUD-4: interviewing together in the real
// build, with two or three browser contexts signed in as different panel members.
import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import type { APIRequestContext, Browser, BrowserContext, Locator } from '@playwright/test';
import { ADMIN, expect, seed, signIn, test, uniqueEmail, type Guard, type Page } from './fixtures';
import { leadLabel } from '../src/domain/leadLabel';

type Role = 'admin' | 'organiser' | 'interviewer' | 'reviewer';
interface Person {
  id: string;
  email: string;
  name: string;
}
const H = { 'x-ia-request': '1' };
const run = Date.now().toString(36);

async function call(req: APIRequestContext, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, data?: unknown) {
  const r = await req.fetch(url, { method, headers: H, ...(data !== undefined ? { data } : {}) });
  return { status: r.status(), body: await r.json().catch(() => null) };
}

async function person(admin: Page, role: Role, name: string): Promise<Person> {
  const email = uniqueEmail(name.toLowerCase().replace(/\W+/g, '-'));
  const added = await call(admin.request, 'POST', '/api/users', { text: email, role });
  expect(added.status).toBe(201);
  const id = added.body.added[0].id as string;
  expect((await call(admin.request, 'PATCH', `/api/users/${id}`, { name })).status).toBe(200);
  return { id, email, name };
}

/** A browser context signed in as `email` (development sign-in, AUTH-6), on the default server or another instance. */
async function as(browser: Browser, guard: Guard | null, email: string, opts: { viewport?: { width: number; height: number }; baseURL?: string } = {}): Promise<{ ctx: BrowserContext; page: Page }> {
  const ctx = await browser.newContext({ viewport: opts.viewport ?? { width: 1280, height: 800 }, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
  guard?.watch(ctx);
  const r = await ctx.request.post('/api/auth/dev/sign-in', { headers: H, data: { email } });
  expect(r.status()).toBe(200);
  return { ctx, page: await ctx.newPage() };
}

interface Setup {
  roundId: string;
  interviewId: string;
  people: Person[];
  questions: Array<{ id: string; text: string; description: string; probes: string[]; lookFor: string[]; redFlags: string[]; difficulty: string; type: string; categoryId: string }>;
  categories: Array<{ id: string; weight: number; mustHave: boolean; name: string }>;
}

/** A round organised by a fresh organiser, a panel of fresh interviewers, and one planned interview. */
async function setup(admin: Page, names: string[], opts: { hide?: boolean; track?: 'qa' | 'web' | 'edge' | 'aks'; allQuestions?: boolean; recordingNotice?: boolean } = {}): Promise<Setup> {
  const org = await person(admin, 'organiser', `Org ${names[0]} ${run}`);
  const people = [org];
  for (const n of names) people.push(await person(admin, 'interviewer', `${n} ${run}`));
  // The administrator sets the round up (and is on it); the organiser is made one of its organisers.
  const orgReq = admin.request;
  const roundId = (await call(orgReq, 'POST', '/api/rounds', { name: `Live ${names.join(' ')} ${run}`, trackId: opts.track ?? 'web' })).body.id as string;
  expect((await call(orgReq, 'PUT', `/api/rounds/${roundId}/members/${org.id}`, { role: 'organiser' })).status).toBe(200);
  for (const p of people.slice(1)) expect((await call(orgReq, 'PUT', `/api/rounds/${roundId}/members/${p.id}`, { role: 'interviewer' })).status).toBe(200);
  if (opts.hide) expect((await call(orgReq, 'PATCH', `/api/rounds/${roundId}`, { hideOthersScores: true })).status).toBe(200);
  let questions: Setup['questions'] | undefined;
  let body: Record<string, unknown> = { candidate: { name: `Cand ${names[0]}` }, panel: people.slice(1).map((p) => p.id), recordingNotice: !!opts.recordingNotice };
  if (opts.allQuestions) {
    const bank = (await call(orgReq, 'GET', `/api/bank/tracks/${opts.track}`)).body;
    const active = bank.questions.filter((q: { status: string }) => q.status === 'active');
    body = { ...body, questions: { questionIds: active.map((q: { id: string }) => q.id), categories: [], timeBudgetMin: 600 } };
  }
  const planned = await call(orgReq, 'POST', `/api/rounds/${roundId}/interviews`, body);
  expect(planned.status, JSON.stringify(planned.body)).toBe(201);
  const interviewId = planned.body.id as string;
  const detail = (await call(orgReq, 'GET', `/api/interviews/${interviewId}`)).body;
  questions = detail.set.questions;
  return { roundId, interviewId, people, questions: questions!, categories: detail.set.categories };
}

/** The first panel member starts from the ready screen (consent); the others join from the interview's page. */
async function startTogether(s: Setup, pages: Page[]) {
  const [lead, ...others] = pages;
  await lead.goto(`/#/interviews/${s.interviewId}`);
  await lead.getByLabel(/I confirm the candidate has been told/).check();
  await lead.getByRole('button', { name: 'Start interview' }).click();
  await expectQuestion(lead, 1);
  for (const p of others) {
    await p.goto(`/#/interviews/${s.interviewId}`);
    await p.getByRole('button', { name: 'Join the interview' }).click();
    await expectQuestion(p, 1);
  }
}

const heading = (p: Page) => p.locator('#question-heading');
const expectQuestion = (p: Page, n: number) => expect(heading(p)).toHaveText(new RegExp(`^Question ${n} of \\d+`));
const next = (p: Page) => p.locator('.live-dock').getByRole('button', { name: /^Next/ });
const scoreRadio = (p: Page, n: number) => p.locator(`.live-dock .score-option input[value="${n}"]`);
const keyPoint = (p: Page, i: number) => p.locator('.evidence__group--look .checklist input').nth(i);
const overallSeconds = async (p: Page) => {
  const [m, s] = (await p.locator('.live-bar .timer__digits').innerText()).split(':').map(Number);
  return m * 60 + s;
};
async function focusQuestion(p: Page) {
  await heading(p).focus();
}
async function addNote(p: Page, text: string) {
  const box = p.getByPlaceholder('What did the candidate say?');
  await box.fill(text);
  await box.press('Enter');
  await expect(p.getByRole('list', { name: 'Notes for this question' })).toContainText(text);
}
/** Record changes through the API (to set up many answers quickly); the browser shows them after its next refetch. */
async function ops(req: APIRequestContext, recordId: string, list: unknown[]) {
  const r = await call(req, 'POST', `/api/records/${recordId}/ops`, { ops: list });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
}
async function recordIdOf(req: APIRequestContext, interviewId: string): Promise<string> {
  return (await call(req, 'GET', `/api/interviews/${interviewId}/live`)).body.me.recordId as string;
}
async function finish(p: Page, o: { rating: number; recommendation: string; rationale: string }) {
  await p.getByRole('button', { name: 'Finish…' }).first().click();
  const dlg = p.getByRole('dialog', { name: 'Finish and submit the interview' });
  await dlg.getByLabel(new RegExp(`^${o.rating} · `)).check();
  await dlg.getByLabel(o.recommendation, { exact: true }).check();
  await dlg.locator('#finish-rationale').fill(o.rationale);
  await dlg.getByRole('button', { name: 'Submit interview' }).click();
  await expect(p.getByRole('heading', { level: 1 })).toHaveText(/^Scorecard: /);
}

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

// ---------------------------------------------------------------------------------------------

test('LIVE-6 LIVE-2 LIVE-8 HOST-5 FLOW-7 FLOW-10 FLOW-20 FLOW-21 RES-2 KEY-1 A11Y-4 PRIV-4 UX-5: a panel member starts with consent; both see the same question and timer within a second; the lead moves everyone; a follower looks on their own and comes back; anyone takes the lead; pause and resume reach everyone', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Ana', 'Ben'], { recordingNotice: true });
  const [, ana, ben] = s.people;
  const A = (await as(browser, guard, ana.email)).page;
  const B = (await as(browser, guard, ben.email)).page;

  // FLOW-7, LIVE-6: the consent (with the recording sentence) is confirmed once, on the ready screen.
  await A.goto(`/#/interviews/${s.interviewId}`);
  await expect(A.locator('#ready-consent-text')).toContainText('This interview is being recorded or transcribed.');
  await A.getByRole('button', { name: 'Start interview' }).click();
  await expect(A.getByRole('alert')).toContainText('tick the box to confirm');
  await A.getByLabel(/I confirm the candidate has been told the text above, including that the interview is recorded/).check();
  await A.getByRole('button', { name: 'Start interview' }).click();
  await expectQuestion(A, 1);
  // UX-5: one way out while interviewing.
  await expect(A.getByRole('banner').getByRole('link')).toHaveCount(1);
  await expect(A.getByRole('banner').getByRole('link')).toHaveAccessibleName('Exit to dashboard');
  // LIVE-6: Ben sees it is running and who confirmed the consent, then joins.
  await B.goto(`/#/interviews/${s.interviewId}`);
  await expect(B.getByRole('heading', { level: 1 })).toHaveText('Interview in progress');
  await expect(B.locator('.ready__consented')).toContainText(`Consent confirmed by ${ana.name}`);
  await expect(B.locator('.ready__consented')).toContainText('including that it is recorded or transcribed');
  await B.getByRole('button', { name: 'Join the interview' }).click();
  await expectQuestion(B, 1);

  // LIVE-2, LIVE-3: the same question, the same timer (RES-2: from the server's clock), who is here and who leads.
  const [ta, tb] = await Promise.all([overallSeconds(A), overallSeconds(B)]);
  expect(Math.abs(ta - tb)).toBeLessThanOrEqual(1);
  await expect(B.getByTestId('person').filter({ hasText: 'leads' })).toContainText('Ana');
  await expect(A.getByTestId('person').filter({ hasText: 'Ben' })).toHaveClass(/person--here/);
  await expect(B.getByTestId('take-lead')).toBeVisible();
  await expect(A.getByRole('button', { name: 'Pause' })).toBeVisible();

  // The lead's Next moves everyone, within about a second.
  const t0 = Date.now();
  await next(A).click();
  await expectQuestion(B, 2);
  const latency = Date.now() - t0;
  test.info().annotations.push({ type: 'LIVE-2 latency', description: `lead Next → follower on question 2: ${latency} ms` });
  expect(latency).toBeLessThan(1500);
  // KEY-1: N for the lead moves everyone too.
  await focusQuestion(A);
  await A.keyboard.press('n');
  await expectQuestion(A, 3);
  await expectQuestion(B, 3);

  // A follower's N looks on their own: the panel stays, and the screen says so.
  await focusQuestion(B);
  await B.keyboard.press('n');
  await expectQuestion(B, 4);
  await expect(B.getByTestId('browsing')).toHaveText(/Looking on your own\. The panel is on question 3\./);
  await expect(B.getByRole('button', { name: /^Question 3: .*the panel is here/ })).toBeVisible();
  await expectQuestion(A, 3);
  // The lead moves on; the follower stays where they are until they choose to follow.
  // The lead moves on to question 4, where Ben already is: he is with the panel again by himself.
  await next(A).click();
  await expect(B.getByTestId('browsing')).toHaveCount(0);
  await expectQuestion(B, 4);
  await B.getByRole('button', { name: /^Question 7: / }).click();
  await expect(B.getByTestId('browsing')).toContainText('The panel is on question 4');
  await B.getByRole('button', { name: 'Follow the panel' }).click();
  await expectQuestion(B, 4);
  await expect(B.getByTestId('browsing')).toHaveCount(0);

  // Take the lead with one click; the previous lead is told, and their Next now only browses.
  await B.getByTestId('take-lead').click();
  await expect(B.getByRole('button', { name: 'Pause' })).toBeVisible();
  await expect(A.locator('.toast')).toContainText(`${ben.name} took the lead`);
  await expect(A.getByTestId('take-lead')).toBeVisible();
  await expect(A.getByTestId('person').filter({ hasText: 'leads' })).toContainText('Ben');
  await next(A).click();
  await expectQuestion(A, 5);
  await expectQuestion(B, 4);
  await A.getByRole('button', { name: 'Follow the panel' }).click();

  // FLOW-21: the lead pauses for everyone; both timers stop; resume restarts them.
  await B.getByRole('button', { name: 'Pause' }).click();
  await expect(A.locator('.paused-banner')).toContainText(`Paused by ${ben.name}`);
  await expect(A.locator('.paused-banner').getByRole('button', { name: 'Resume' })).toHaveCount(0);
  const paused = await overallSeconds(A);
  await A.waitForTimeout(2200);
  expect(await overallSeconds(A)).toBe(paused);
  await B.getByRole('button', { name: 'Resume' }).first().click();
  await expect(A.locator('.paused-banner')).toHaveCount(0);
  await expect.poll(() => overallSeconds(A), { timeout: 4000 }).toBeGreaterThan(paused);
  // A11Y-4: the timers are not announced as they tick.
  await expect(A.locator('.live-bar [role="timer"]')).toHaveAttribute('aria-live', 'off');
});

test('LIVE-2 HOST-5: two Nexts pressed at the same moment move the panel on by one question, not two', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Cal', 'Dee']);
  const { ctx } = await as(browser, guard, s.people[1].email);
  const A1 = await ctx.newPage();
  const B = (await as(browser, guard, s.people[2].email)).page;
  await startTogether(s, [A1, B]);
  // The lead has the interview open in two tabs and presses Next in both at once.
  const A2 = await ctx.newPage();
  await A2.goto(`/#/interviews/${s.interviewId}/live`);
  await expectQuestion(A2, 1);
  // Both presses land before either tab has heard of the other's move (a click after the screen has
  // moved would rightly mean "from 2 to 3"): fire them inside the pages at the same instant.
  const press = (p: Page) => p.evaluate(() => (document.querySelector('.live-dock__next') as HTMLButtonElement).click());
  await Promise.all([press(A1), press(A2)]);
  await expectQuestion(B, 2);
  await B.waitForTimeout(1000);
  await expectQuestion(B, 2);
  await expectQuestion(A1, 2);
  await expectQuestion(A2, 2);
  expect((await call(ctx.request, 'GET', `/api/interviews/${s.interviewId}/live`)).body.currentQuestionId).toBe(s.questions[1].id);
});

test('LIVE-1 LIVE-3 FLOW-13 FLOW-14 FLOW-15 RUB-1 RUB-3 OV-4 BANK-15: each panel member scores their own record and sees the others’ marks for the question; typing a note is never disturbed by the others’ updates', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Eve', 'Fin']);
  const A = (await as(browser, guard, s.people[1].email)).page;
  const B = (await as(browser, guard, s.people[2].email)).page;
  await startTogether(s, [A, B]);

  // Eve ticks two key points (the suggestion appears, never applied: FLOW-14, RUB-3) and scores 3.
  await keyPoint(A, 0).check();
  await keyPoint(A, 1).check();
  await expect(A.locator('.live-dock__hint')).toContainText('Suggested: 2 · Partial');
  await expect(scoreRadio(A, 2)).not.toBeChecked();
  // RUB-1: each level's label is on the score control, with its description as the accessible description.
  await expect(A.locator('.live-dock .score-option')).toHaveText([/1.*Poor/, /2.*Partial/, /3.*Solid senior/, /4.*Exceptional/]);
  await expect(scoreRadio(A, 1)).toHaveAccessibleDescription(/red flag/);
  await A.locator('.live-dock .score-option').nth(2).click();
  await expect(scoreRadio(A, 3)).toBeChecked();
  // BANK-15: lead labels are emphasised.
  const lead0 = leadLabel(s.questions[0].lookFor[0]);
  if (lead0) await expect(A.locator('.evidence__group--look .checklist li').first().locator('.item-lead')).toHaveText(lead0.lead);

  // Fin starts typing a note; meanwhile Eve keeps changing her record. Fin's field keeps focus and text.
  const field = B.getByPlaceholder('What did the candidate say?');
  await field.click();
  await field.pressSequentially('Talked about the event loop ', { delay: 20 });
  await keyPoint(A, 2).check();
  await addNote(A, 'Eve’s note on question 1');
  await expect(B.getByTestId('panel-strip')).toContainText('3');
  await field.pressSequentially('and microtasks.', { delay: 20 });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('Talked about the event loop and microtasks.');
  await field.press('Enter');
  await expect(B.getByRole('list', { name: 'Notes for this question' })).toContainText('Talked about the event loop and microtasks.');
  // FLOW-15: the note carries the elapsed interview time.
  await expect(B.getByRole('list', { name: 'Notes for this question' }).locator('.note__time')).toHaveText(/\d+:\d\d/);

  // LIVE-3: Fin scores 2; each sees the other's mark in the folded strip, and the details when opened.
  await B.locator('.live-dock .score-option').nth(1).click();
  await expect(A.getByTestId('panel-strip')).toContainText(/Fin\s+2/);
  await expect(B.getByTestId('panel-strip')).toContainText(/Eve\s+3/);
  await B.getByRole('button', { name: /Show their marks/ }).click();
  const card = B.locator('.panel-strip__card');
  await expect(card).toContainText('scored 3 · Solid senior');
  await expect(card).toContainText('Eve’s note on question 1');
  await expect(card.locator('.panel-strip__ticks li')).toHaveCount(3);
  // A record is its owner's only: the server refuses another panel member's write.
  guard.allowErrors(/status of 403/);
  const eveRecord = await recordIdOf(A.context().request, s.interviewId);
  expect((await call(B.context().request, 'POST', `/api/records/${eveRecord}/ops`, { ops: [{ t: 'score', q: s.questions[0].id, v: 1 }] })).status).toBe(403);
});

test('LIVE-3 FLOW-27: when the round hides other people’s scores, nobody sees another member’s marks (on screen or from the API) until their own record is submitted; who has scored still shows', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Gus', 'Hal'], { hide: true });
  const A = (await as(browser, guard, s.people[1].email)).page;
  const B = (await as(browser, guard, s.people[2].email)).page;
  await startTogether(s, [A, B]);
  await A.locator('.live-dock .score-option').nth(3).click();
  await addNote(A, 'Secret evidence from Gus');
  await expect(B.getByTestId('panel-strip')).toContainText(/Gus\s+has scored/);
  await expect(B.getByTestId('panel-strip')).toContainText('their marks show once you submit yours');
  await expect(B.getByRole('button', { name: /Show their marks/ })).toHaveCount(0);
  const raw = await call(B.context().request, 'GET', `/api/interviews/${s.interviewId}/records`);
  expect(raw.body.hidden).toBe(true);
  expect(JSON.stringify(raw.body)).not.toContain('Secret evidence');
  expect(raw.body.others[0].marks).toBeNull();
});

test('HOST-6 RES-1 RES-3 LIVE-8 MVP-2 OV-1 HOST-1: offline, a panel member keeps scoring; the screen says so; shared moves are not queued; on reconnect everything is sent and they are back with the panel; a reload and a late join return to the shared state with the record intact', async ({ page: admin, browser, guard }) => {
  guard.allowErrors(/ERR_INTERNET_DISCONNECTED|Failed to load resource/);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Ida', 'Jo', 'Kim']);
  const { ctx: actx, page: A } = await as(browser, guard, s.people[1].email);
  const B = (await as(browser, guard, s.people[2].email)).page;
  await startTogether(s, [A, B]);
  await expect(A.getByTestId('saving')).toHaveText(/All changes saved/);

  // Ida (the lead) loses the connection.
  await actx.setOffline(true);
  await expect(A.getByTestId('saving')).toContainText('Offline');
  await keyPoint(A, 0).check();
  await A.locator('.live-dock .score-option').nth(3).click();
  await addNote(A, 'Typed while offline');
  await expect(A.getByTestId('saving')).toContainText(/Offline · \d+ changes? kept on this computer/);
  // Her Next cannot move the panel: she looks on her own, and is told why.
  await next(A).click();
  await expect(A.locator('.toast')).toContainText('the panel can’t follow you');
  await expectQuestion(A, 2);
  await expectQuestion(B, 1);
  // The queue is kept in the browser (a reload would not lose it).
  expect(await A.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith('ia.outbox.v1.')))).toBe(true);
  // Meanwhile Jo takes the lead and moves on.
  await B.getByTestId('take-lead').click();
  await next(B).click();
  await expectQuestion(B, 2);
  await next(B).click();
  await expectQuestion(B, 3);

  // Back online: everything is sent in order, the screen says so, and Ida is with the panel again.
  await actx.setOffline(false);
  await expect(A.getByTestId('saving')).toHaveText(/All changes saved/, { timeout: 15_000 });
  await A.getByRole('button', { name: 'Follow the panel' }).click();
  await expectQuestion(A, 3);
  await expect(B.getByTestId('panel-strip')).toContainText(/Ida\s+—/); // on question 3 Ida has not scored
  await B.getByRole('button', { name: /^Question 1: / }).click(); // Jo leads: everyone goes to question 1
  await expectQuestion(A, 1);
  await expect(scoreRadio(A, 4)).toBeChecked();
  await expect(keyPoint(A, 0)).toBeChecked();
  await expect(A.getByRole('list', { name: 'Notes for this question' })).toContainText('Typed while offline');
  await expect(B.getByTestId('panel-strip')).toContainText(/Ida\s+4/);

  // Changes made offline and left behind by a closed page are sent by the next page that opens.
  await actx.setOffline(true);
  await keyPoint(A, 1).check();
  await A.close();
  await actx.setOffline(false);
  const A2 = await actx.newPage();
  await A2.goto(`/#/interviews/${s.interviewId}/live`);
  await expectQuestion(A2, 1);
  await expect(keyPoint(A2, 1)).toBeChecked();
  await expect(A2.getByTestId('saving')).toHaveText(/All changes saved/, { timeout: 15_000 });
  // LIVE-8: a reload brings Jo back to the shared state with his record intact.
  await B.locator('.live-dock .score-option').nth(1).click();
  await B.reload();
  await expectQuestion(B, 1);
  await expect(scoreRadio(B, 2)).toBeChecked();
  await expect(B.getByRole('button', { name: 'Pause' })).toBeVisible(); // still the lead
  // A late joiner arrives on the panel's question.
  const C = (await as(browser, guard, s.people[3].email)).page;
  await C.goto(`/#/interviews/${s.interviewId}`);
  await C.getByRole('button', { name: 'Join the interview' }).click();
  await expectQuestion(C, 1);
  await expect(C.getByTestId('panel-strip')).toContainText(/Ida\s+4/);
});

/** The built server once more, as a second instance against the same database (HOST-5). */
async function startInstance(port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['dist/server/main.js'], {
    env: {
      ...process.env,
      DATABASE_URL: process.env.E2E_DATABASE_URL,
      NODE_ENV: 'test',
      PORT: String(port),
      PUBLIC_URL: `http://localhost:${port}`,
      SESSION_SECRET: 'e2e-secret-e2e-secret-e2e-secret-0123456789',
      DEV_SIGN_IN: 'true',
      BOOTSTRAP_ADMINS: 'boot-admin@example.test',
      LOG_LEVEL: 'warn',
    },
    stdio: 'ignore',
  });
  await expect.poll(async () => (await fetch(`http://localhost:${port}/healthz`).catch(() => null))?.status ?? 0, { timeout: 20_000 }).toBe(200);
  return child;
}
const stopInstance = (c: ChildProcess) => new Promise<void>((resolve) => (c.exitCode !== null ? resolve() : (c.once('exit', () => resolve()), c.kill('SIGTERM'))));

test('HOST-5 HOST-6 LIVE-2 LIVE-8: panel members on two server instances stay in step; when one instance is stopped mid-interview its member keeps scoring, and on restart everything arrives', async ({ page: admin, browser, guard }) => {
  test.setTimeout(120_000);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Lea', 'Max']);
  const port = 4190 + (test.info().workerIndex % 8);
  let second = await startInstance(port);
  try {
    const A = (await as(browser, guard, s.people[1].email)).page;
    // Max is on the second instance (another origin, so not watched for "other origins").
    const { page: B } = await as(browser, null, s.people[2].email, { baseURL: `http://localhost:${port}/` });
    await startTogether(s, [A, B]);
    await next(A).click();
    await expectQuestion(B, 2);
    await B.locator('.live-dock .score-option').nth(2).click();
    await expect(A.getByTestId('panel-strip')).toContainText(/Max\s+3/);

    // The second instance stops: Max's screen says so, and he keeps scoring.
    await stopInstance(second);
    await keyPoint(B, 0).check();
    await addNote(B, 'Noted while the server was down');
    await expect(B.getByTestId('saving')).toContainText(/Offline|Reconnecting/, { timeout: 15_000 });
    // Lea moves on meanwhile.
    await next(A).click();
    await expectQuestion(A, 3);

    // It comes back: Max's changes arrive and he is with the panel again.
    second = await startInstance(port);
    await expect(B.getByTestId('saving')).toHaveText(/All changes saved/, { timeout: 30_000 });
    await expect.poll(async () => (await heading(B).innerText()).startsWith('Question 3'), { timeout: 15_000 }).toBe(true);
    await A.getByRole('button', { name: /^Question 2: / }).click();
    await expect(A.getByTestId('panel-strip')).toContainText(/Max\s+3/);
    await A.getByRole('button', { name: /Show their marks/ }).click();
    await expect(A.locator('.panel-strip__card')).toContainText('Noted while the server was down');
  } finally {
    await stopInstance(second);
  }
});

test('LIVE-4 FLOW-22 FLOW-23 FLOW-16 FLOW-17 RUB-4 UX-6 TEAM-6 AUD-2 AUD-4 FLOW-34 MVP-1: each member submits through the finish dialog; the interview waits for the others, names who it waits for, and finishes when the last one submits; a member who never joined is marked as not taking part; a submitted record is amended only with a reason', async ({ page: admin, browser, guard }) => {
  test.setTimeout(120_000);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Ned', 'Ola', 'Pia']);
  const [org, ned, ola] = s.people;
  const A = (await as(browser, guard, ned.email)).page;
  const B = (await as(browser, guard, ola.email)).page;
  await startTogether(s, [A, B]);
  // FLOW-34: the Dashboard leads with the interview in progress.
  const O = (await as(browser, guard, org.email)).page;
  await O.goto('/#/');
  await expect(O.locator('.continue')).toHaveCount(0); // the organiser is not on the panel
  await B.goto('/#/');
  await expect(B.locator('.continue')).toContainText('Cand Ned');
  await B.getByRole('link', { name: 'Continue the interview' }).click();
  await expectQuestion(B, 1);

  // UX-6, FLOW-16: Ned scores one 4 (needs a note) and leaves the rest: the dialog sums it up.
  await A.locator('.live-dock .score-option').nth(3).click();
  await A.getByRole('button', { name: 'Finish…' }).first().click();
  const dlg = A.getByRole('dialog', { name: 'Finish and submit the interview' });
  const total = s.questions.length;
  await expect(dlg).toContainText(`Not scored or skipped yet: questions 2–${total}.`);
  await expect(dlg.getByRole('button', { name: 'Question 1 scored 4' })).toBeVisible();
  await dlg.getByRole('button', { name: `Skip the remaining ${total - 1}…` }).click();
  await dlg.getByLabel(`One reason for skipping all ${total - 1}`).fill('Ran out of time');
  await dlg.getByRole('button', { name: `Skip ${total - 1} questions` }).click();
  await expect(dlg.getByRole('status')).toContainText(`Skipped ${total - 1} questions`);
  await dlg.getByRole('button', { name: 'Question 1 scored 4' }).click();
  await addNote(A, 'Quantified the outcome');
  await finish(A, { rating: 3, recommendation: 'Hire', rationale: 'Strong on the first question.' });

  // The interview waits for Ola, and says so to everyone.
  await O.goto(`/#/interviews/${s.interviewId}`);
  await expect(O.getByTestId('waiting')).toHaveText(`Waiting for ${ola.name}.`);
  await expect(O.getByRole('heading', { level: 1 })).toHaveText('Interview in progress');
  // …and on the round's list.
  await O.goto(`/#/rounds/${s.roundId}`);
  await expect(O.getByTestId('row-waiting')).toHaveText(`Waiting for ${ola.name}`);
  await O.goto(`/#/interviews/${s.interviewId}`);
  // LIVE-4: Pia never joined; the organiser marks her (and can take it back).
  const pia = O.getByTestId('panel-member').filter({ hasText: 'Pia' });
  await pia.getByRole('button', { name: /Mark as did not take part/ }).click();
  await expect(pia).toContainText('Did not take part');
  await pia.getByRole('button', { name: /Undo/ }).click();
  await expect(pia).toContainText('Not joined');
  await pia.getByRole('button', { name: /Mark as did not take part/ }).click();
  await expect(pia).toContainText('Did not take part');
  // Ola is now the lead (Ned submitted) and submits too: the interview is finished.
  await expect(B.getByRole('button', { name: 'Pause' })).toBeVisible();
  const olaRec = await recordIdOf(B.context().request, s.interviewId);
  await ops(B.context().request, olaRec, s.questions.map((q) => ({ t: 'score', q: q.id, v: 3 })));
  await B.reload();
  await finish(B, { rating: 3, recommendation: 'Hire', rationale: 'Consistent.' });
  await O.reload();
  await expect(O.getByRole('heading', { level: 1 })).toHaveText('Interview finished');
  await expect(O.getByTestId('panel-member')).toHaveText([/Ned.*Submitted.*Scorecard/, /Ola.*Submitted.*Scorecard/, /Pia.*Did not take part/]);
  await expect(O.getByRole('link', { name: /^Debrief/ })).toBeVisible();

  // FLOW-23, AUD-4: Ned's record is read-only; Amend asks for a reason, and it is in the round's log.
  await A.goto(`/#/interviews/${s.interviewId}/live`);
  await expect(A.locator('.live-readonly')).toContainText('read-only');
  await expect(A.locator('.live-dock .score-option input').first()).toBeDisabled();
  await A.getByRole('button', { name: 'Amend this question…' }).click();
  await A.locator('.amend-form .score-option').nth(2).click();
  await A.getByRole('button', { name: 'Save amendment…' }).click();
  const reason = A.getByRole('dialog', { name: 'Amend question 1' });
  await expect(reason).toContainText('Score: 4 (Exceptional) → 3 (Solid senior)');
  await reason.getByLabel('Reason for the change').fill('Re-read my notes');
  await reason.getByRole('button', { name: 'Save amendment' }).click();
  await expect(reason).toHaveCount(0);
  await expect(A.locator('.live-dock .score-option input[value="3"]')).toBeChecked();
  const log = (await call(O.context().request, 'GET', `/api/rounds/${s.roundId}/audit`)).body as Array<{ action: string; reason: string | null }>;
  expect(log.find((e) => e.action === 'record.amended')?.reason).toBe('Re-read my notes');
  expect(log.map((e) => e.action)).toEqual(expect.arrayContaining(['interview.consent_confirmed', 'interview.started', 'interview.joined', 'record.submitted', 'interview.completed', 'interview.marked_did_not_take_part']));
});

/** SCORE-1…SCORE-8 written out again, independently of src/domain/scoring.ts. */
function expected(qs: Setup['questions'], cats: Setup['categories'], scores: Array<number | null>) {
  const diff: Record<string, number> = { core: 1, advanced: 1.5, expert: 2 };
  let sw = 0;
  let swv = 0;
  let planned = 0;
  qs.forEach((q, i) => {
    const w = (q.type === 'behavioural' ? 1 : diff[q.difficulty]) * (cats.find((c) => c.id === q.categoryId)?.weight ?? 1);
    planned += w;
    if (scores[i] != null) {
      sw += w;
      swv += w * ((scores[i]! - 1) / 3);
    }
  });
  const pct = (swv / sw) * 100;
  const band = pct >= 80 ? 'Strong hire' : pct >= 65 ? 'Hire' : pct >= 50 ? 'Lean no hire' : 'No hire';
  return { pct: `${Math.round(pct)}%`, coverage: `${Math.round((sw / planned) * 100)}%`, band, insufficient: sw / planned < 0.7 };
}

test('FLOW-24 FLOW-25 FLOW-31 FLOW-32 A11Y-5 OV-4 SCORE-1 SCORE-2 SCORE-3 SCORE-4 SCORE-5 SCORE-6 SCORE-7 SCORE-9 SCORE-10 PANEL-1 PANEL-2 PANEL-3 PANEL-4 LIVE-5: each member’s scorecard matches an independent calculation; exports are recorded; two people sharing one screen have one record with both names', async ({ page: admin, browser, guard }) => {
  test.setTimeout(90_000);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Quin', 'Rae', 'Sol']);
  const [, quin, rae, sol] = s.people;
  const A = (await as(browser, guard, quin.email)).page;
  // PANEL-2, LIVE-5: Quin starts with Sol sharing his screen.
  await A.goto(`/#/interviews/${s.interviewId}`);
  await A.getByLabel(/I confirm the candidate has been told/).check();
  await A.getByRole('button', { name: /sharing this screen/ }).click();
  await A.getByLabel(sol.name).check();
  await A.getByRole('button', { name: 'Start interview' }).click();
  await expectQuestion(A, 1);
  const B = (await as(browser, guard, rae.email)).page;
  await B.goto(`/#/interviews/${s.interviewId}`);
  await B.getByRole('button', { name: 'Join the interview' }).click();
  await expectQuestion(B, 1);
  // Sol's own page says he is on Quin's screen.
  const C = (await as(browser, guard, sol.email)).page;
  await C.goto(`/#/interviews/${s.interviewId}`);
  await expect(C.locator('.ready__start')).toContainText(`You are scoring with ${quin.name} on their screen`);
  // PANEL-3: a note can be marked with who made it.
  await A.getByLabel('Note by').selectOption(sol.name);
  await addNote(A, 'Sol noticed the trade-off');
  await expect(A.getByRole('list', { name: 'Notes for this question' })).toContainText(sol.name);

  // Different scores for each record, set through the API; skipped questions lower the coverage.
  const qa = s.questions.map((_, i) => (i === 3 ? null : ((i % 4) + 1)));
  const qb = s.questions.map((_, i) => (i < 6 ? null : 3));
  const fill = (scores: Array<number | null>) =>
    s.questions.flatMap((q, i): unknown[] => (scores[i] == null ? [{ t: 'skip', q: q.id, reason: 'Not covered' }] : [{ t: 'score', q: q.id, v: scores[i] }, ...(scores[i] === 1 || scores[i] === 4 ? [{ t: 'note.add', id: crypto.randomUUID(), q: q.id, atSec: 30, text: `Evidence ${i}`, by: null }] : [])]));
  await ops(A.context().request, await recordIdOf(A.context().request, s.interviewId), fill(qa));
  await ops(B.context().request, await recordIdOf(B.context().request, s.interviewId), fill(qb));
  await A.reload();
  await B.reload();
  await A.getByRole('button', { name: 'Finish…' }).first().click();
  await expect(A.getByRole('dialog')).toContainText(`Interviewers: ${quin.name} and ${sol.name}. The rating, recommendation and rationale are recorded on behalf of all of them.`);
  await A.keyboard.press('Escape');
  await finish(A, { rating: 3, recommendation: 'Hire', rationale: 'Shared view of Quin and Sol.' });
  await finish(B, { rating: 2, recommendation: 'Lean no hire', rationale: 'Rae’s own view.' });

  for (const [page, scores, rec] of [
    [A, qa, 'Hire'],
    [B, qb, 'Lean no hire'],
  ] as const) {
    const e = expected(s.questions, s.categories, scores);
    await expect(page.getByTestId('sc-overall')).toHaveText(e.pct);
    await expect(page.getByTestId('sc-coverage')).toHaveText(e.coverage);
    await expect(page.getByTestId('sc-band')).toHaveText(e.insufficient ? /Insufficient evidence/ : new RegExp(e.band));
    await expect(page.getByTestId('sc-recommendation')).toHaveText(rec);
    // FLOW-25, OV-4: the band is labelled advisory, next to the recorded recommendation.
    await expect(page.locator('.sc-summary')).toContainText('Advisory only');
    // A11Y-5: the category chart's figures are also a table.
    await expect(page.locator('.sc-section table').first()).toBeVisible();
  }
  // PANEL-4: both names on the shared record's scorecard; LIVE-3: Rae can open it (scores are not hidden in this round).
  await expect(A.locator('.sc-meta')).toContainText(`${quin.name} and ${sol.name}`);
  await expect(A.locator('.sc-meta')).toContainText('one shared scorecard');
  await expect(A.locator('.sc-questions')).toContainText(`${sol.name}:`);
  // FLOW-31, FLOW-32: Markdown and CSV exports, recorded in the audit log.
  const [md] = await Promise.all([A.waitForEvent('download'), A.getByRole('button', { name: 'Export' }).click().then(() => A.getByRole('menuitem', { name: 'Markdown' }).click())]);
  const mdText = readFileSync(await md.path(), 'utf8');
  expect(mdText).toContain(`Interviewers: ${quin.name} and ${sol.name}`);
  expect(mdText).toContain(`(${sol.name}) Sol noticed the trade-off`);
  const [csv] = await Promise.all([A.waitForEvent('download'), A.getByRole('button', { name: 'Export' }).click().then(() => A.getByRole('menuitem', { name: /CSV/ }).click())]);
  const csvText = readFileSync(await csv.path(), 'utf8');
  expect(csvText.trim().split('\r\n')).toHaveLength(s.questions.length + 1);
  const log = (await call(admin.request, 'GET', `/api/rounds/${s.roundId}/audit`)).body as Array<{ action: string; after: { format?: string } }>;
  expect(log.filter((e) => e.action === 'scorecard.exported').map((e) => e.after.format).sort()).toEqual(['csv', 'markdown']);
});

test('FLOW-11 FLOW-12 BANK-8 LIVE-7 PRIV-3: the candidate window follows the panel’s question and shows only its number and text; the candidate view toggle too', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Tia']);
  const { ctx, page: A } = await as(browser, guard, s.people[1].email);
  await startTogether(s, [A]);
  const W = await ctx.newPage();
  await W.goto(`/#/interviews/${s.interviewId}/present`);
  await expect(W.getByRole('heading', { level: 1 })).toHaveText(/^Question 1 of \d+/);
  await expect(W.locator('.candidate-question__text')).toHaveText(s.questions[0].text);
  await next(A).click();
  await expect(W.getByRole('heading', { level: 1 })).toHaveText(/^Question 2 of \d+/);
  // FLOW-12, BANK-8: the description and the probe are on the interviewer's screen, never in the window.
  await expect(A.locator('.steer__text')).toHaveText(s.questions[1].description);
  await expect(A.locator('.probes')).toContainText(s.questions[1].probes[0]);
  const text = await W.locator('body').innerText();
  expect(text).not.toContain(s.questions[1].description.slice(0, 30));
  for (const leak of [...s.questions[1].lookFor, ...s.questions[1].redFlags]) expect(text).not.toContain(leak.slice(0, 30));
  expect(text).not.toMatch(/Probe|Suggested|Notes|Solid senior|Red flags/);
  await expect(W.getByRole('banner')).toHaveCount(0);
  // Paused: a neutral message.
  await A.getByRole('button', { name: 'Pause' }).click();
  await expect(W.getByRole('heading', { level: 1 })).toHaveText('The interview is paused. We will continue shortly.');
  await A.getByRole('button', { name: 'Resume' }).first().click();
  // The toggle (C) on the interviewer's own screen shows the same.
  await focusQuestion(A);
  await A.keyboard.press('c');
  await expect(A.locator('.candidate-question__text')).toHaveText(s.questions[1].text);
  await expect(A.locator('.live-dock')).toHaveCount(0);
  await A.keyboard.press('c');
  await expect(A.locator('.live-dock')).toBeVisible();
  // PRIV-3: no candidate data in the address.
  expect(A.url()).not.toContain('Cand');
});

test('ROUND-2 REVIEW-1 AUTH-5 HPRIV-1 LIVE-1: someone not on the round and a question reviewer are refused the live interview, its records and the candidate window, by navigation and by the API', async ({ page: admin, browser, guard }) => {
  guard.allowErrors(/status of 40[34]/);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Uma']);
  const A = (await as(browser, guard, s.people[1].email)).page;
  await startTogether(s, [A]);
  const rec = await recordIdOf(A.context().request, s.interviewId);
  const outsider = await person(admin, 'organiser', `Outsider live ${run}`);
  const reviewer = await person(admin, 'reviewer', `Reviewer live ${run}`);
  const O = (await as(browser, guard, outsider.email)).page;
  await O.goto(`/#/interviews/${s.interviewId}/live`);
  await expect(O.getByRole('heading', { level: 1 })).toHaveText('Interview not found');
  await O.goto(`/#/scorecard/${rec}`);
  await expect(O.locator('main')).toContainText('not found');
  await O.goto(`/#/interviews/${s.interviewId}/present`);
  await expect(O.getByRole('heading', { level: 1 })).toHaveText('There is nothing to show here.');
  const R = (await as(browser, guard, reviewer.email)).page;
  await R.goto(`/#/interviews/${s.interviewId}/live`);
  await expect(R.getByRole('heading', { level: 1 })).toHaveText('Not available');
  for (const p of [O, R]) {
    for (const url of [`/api/interviews/${s.interviewId}/live`, `/api/interviews/${s.interviewId}/records`, `/api/interviews/${s.interviewId}/present`, `/api/records/${rec}`]) expect((await call(p.context().request, 'GET', url)).status, url).toBe(404);
    expect((await call(p.context().request, 'POST', `/api/interviews/${s.interviewId}/join`, {})).status).toBe(404);
    expect((await call(p.context().request, 'POST', `/api/interviews/${s.interviewId}/command`, { type: 'lead' })).status).toBe(404);
    expect((await call(p.context().request, 'POST', `/api/records/${rec}/ops`, { ops: [{ t: 'flag', q: s.questions[0].id, on: true }] })).status).toBe(404);
  }
});

// ---- UX-4: every bundled question, with a second panel member's marks in the strip

type Box = { x: number; y: number; width: number; height: number };
async function box(l: Locator): Promise<Box> {
  const b = await l.boundingBox();
  expect(b, 'element is rendered').not.toBeNull();
  return b!;
}
async function frame(page: Page) {
  const vp = page.viewportSize()!;
  const dock = await box(page.locator('.live-dock'));
  const bar = await box(page.locator('.live-bar'));
  return { vp, top: bar.y + bar.height, bottom: dock.y };
}
async function expectInWindow(page: Page, what: string, l: Locator) {
  const { vp } = await frame(page);
  const b = await box(l);
  expect(b.y, `${what}: top inside the window`).toBeGreaterThanOrEqual(0);
  expect(b.y + b.height, `${what}: bottom inside the window`).toBeLessThanOrEqual(vp.height);
  expect(b.x + b.width, `${what}: right inside the window`).toBeLessThanOrEqual(vp.width);
}
async function expectBetweenBars(page: Page, what: string, l: Locator) {
  const { top, bottom } = await frame(page);
  const b = await box(l);
  expect(b.y, `${what}: not under the top bar`).toBeGreaterThanOrEqual(top - 1);
  expect(b.y + b.height, `${what}: not under the bottom bar`).toBeLessThanOrEqual(bottom + 1);
}

for (const track of ['qa', 'web', 'edge', 'aks'] as const) {
  test(`UX-4 BANK-15 LIVE-3: at 1280 × 800 every ${track} question shows the question, its whole "what to look for" list, the score buttons and Next without scrolling, with the panel strip and the people in the top bar`, async ({ page: admin, browser, guard }) => {
    test.setTimeout(240_000);
    await signIn(admin, ADMIN);
    const s = await setup(admin, ['Vic', 'Wes'], { track, allQuestions: true });
    // Every bundled question (other tests may have added more to the shared bank; those are checked too).
    const planned = new Set(s.questions.map((q) => q.id));
    expect(seed(track).questions.filter((q) => !planned.has(q.id)).map((q) => q.id)).toEqual([]);
    // Wes starts and scores everything (through the API); Vic follows on screen as a follower: the harder case
    // (the "Take the lead" button is wider than "Pause", and the panel strip is shown).
    const W = await as(browser, guard, s.people[2].email);
    const V = (await as(browser, guard, s.people[1].email)).page;
    expect((await call(W.ctx.request, 'POST', `/api/interviews/${s.interviewId}/start`, { consent: true })).status).toBe(200);
    await ops(W.ctx.request, await recordIdOf(W.ctx.request, s.interviewId), s.questions.map((q) => ({ t: 'score', q: q.id, v: 3 })));
    await V.goto(`/#/interviews/${s.interviewId}`);
    await V.getByRole('button', { name: 'Join the interview' }).click();
    let innerScrolls = 0;
    for (let n = 1; n <= s.questions.length; n++) {
      await expectQuestion(V, n);
      expect(await V.evaluate(() => window.scrollY), `question ${n}: the page is not scrolled`).toBe(0);
      await expectBetweenBars(V, `question ${n} text`, V.locator('.question-pane .question-text'));
      const looks = V.locator('.evidence__group--look .checklist li');
      await expectBetweenBars(V, `question ${n} last key point`, looks.last());
      await expectBetweenBars(V, `question ${n} checklist card`, V.locator('.interviewer-pane'));
      const cue = V.locator('.interviewer-pane__more-button');
      if (await cue.count()) {
        innerScrolls++;
        expect((await box(looks.last())).y + (await box(looks.last())).height, `question ${n}: the cue hides no key point`).toBeLessThanOrEqual((await box(cue)).y + 1);
      }
      const options = V.locator('.live-dock fieldset.score-control .score-option');
      for (let i = 0; i < 4; i++) await expectInWindow(V, `question ${n} score button ${i + 1}`, options.nth(i));
      await expectInWindow(V, `question ${n} Next`, V.locator('.live-dock').getByRole('button', { name: n === s.questions.length ? 'Finish…' : /^Next/ }));
      await expect(V.getByTestId('panel-strip')).toContainText(/Wes\s+3/);
      // BANK-15: the leading labels are emphasised.
      const leads = await V.locator('.evidence__group--look .checklist li').evaluateAll((lis) => lis.map((li) => li.querySelector('.item-lead')?.textContent ?? null));
      expect(leads).toEqual(s.questions[n - 1].lookFor.map((t) => leadLabel(t)?.lead ?? null));
      if (n < s.questions.length) {
        await focusQuestion(V);
        await V.keyboard.press('n'); // a follower's N looks on their own
      }
    }
    test.info().annotations.push({ type: 'UX-4', description: `${track}: ${innerScrolls} of ${s.questions.length} questions scroll the checklist card inside itself` });
  });
}

test('UX-5 KEY-1 KEY-2 A11Y-1 FLOW-18: one way out; help opens in a new tab; secondary actions in one menu; shortcuts never fire while typing or with a modifier', async ({ page: admin, browser, guard }) => {
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Xan']);
  const A = (await as(browser, guard, s.people[1].email)).page;
  await startTogether(s, [A]);
  const banner = A.getByRole('banner');
  await expect(banner.getByRole('link')).toHaveCount(1);
  await expect(banner.getByRole('link')).toHaveAccessibleDescription(/All changes saved/);
  const sameTab = await A.locator('main a[href]').evaluateAll((els) => els.filter((e) => e.getAttribute('target') !== '_blank').map((e) => e.textContent?.trim()));
  expect(sameTab).toEqual([]);
  const more = A.getByRole('button', { name: 'More', exact: true });
  await more.click();
  await expect(A.getByRole('menuitem')).toHaveText(['Candidate viewC', 'Open candidate window', 'Keyboard shortcuts?']);
  await A.keyboard.press('Escape');
  // KEY-2: typing a "3" or an "n" in the notes does nothing else; Ctrl+N neither.
  const field = A.getByPlaceholder('What did the candidate say?');
  await field.fill('');
  await field.pressSequentially('n3');
  await expect(scoreRadio(A, 3)).not.toBeChecked();
  await expectQuestion(A, 1);
  await A.keyboard.press('Escape');
  await focusQuestion(A);
  await A.keyboard.press('Control+n').catch(() => {});
  await expectQuestion(A, 1);
  await A.keyboard.press('3');
  await expect(scoreRadio(A, 3)).toBeChecked();
  await A.keyboard.press('f');
  await expect(A.getByRole('button', { name: /^Flagged/ })).toHaveAttribute('aria-pressed', 'true');
  await A.keyboard.press('?');
  await expect(A.getByRole('dialog', { name: 'Keyboard shortcuts' })).toContainText('moves everyone when you lead');
  await A.keyboard.press('Escape');
  // Leaving: the Dashboard's first action is to continue.
  await banner.getByRole('link', { name: 'Exit to dashboard' }).click();
  await expect(A.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(A.locator('.continue')).toContainText('Cand Xan');
  await expect(A.getByTestId('dash-counts').or(A.locator('.continue'))).toBeVisible();
});

test('A11Y-7 A11Y-3 A11Y-6 A11Y-2 UX-7 UX-8: the live screens (lead, follower, panel strip open, looking on your own, paused, offline, finish dialog, waiting, submitted, scorecard, candidate window, Dashboard) have no serious axe violations in light and dark, do not scroll sideways at 390px, and show no requirement ids', async ({ page: admin, browser, guard }) => {
  test.setTimeout(180_000);
  guard.allowErrors(/ERR_INTERNET_DISCONNECTED|Failed to load resource/);
  await signIn(admin, ADMIN);
  const s = await setup(admin, ['Yan', 'Zoe']);
  const { ctx: actx, page: A } = await as(browser, guard, s.people[1].email);
  const B = (await as(browser, guard, s.people[2].email)).page;
  await startTogether(s, [A, B]);
  await A.locator('.live-dock .score-option').nth(2).click();
  await addNote(A, 'A note for the strip');
  const problems: string[] = [];
  const words: string[] = [];
  const check = async (p: Page, name: string) => {
    await p.waitForTimeout(200);
    for (const scheme of ['light', 'dark'] as const) {
      await p.emulateMedia({ colorScheme: scheme });
      for (const v of await axe(p)) problems.push(`${scheme} ${name}: ${v}`);
    }
    await p.emulateMedia({ colorScheme: 'light' });
    await expect(p.locator('h1')).toHaveCount(1);
    const text = await p.locator('body').innerText();
    const id = text.match(/\b[A-Z][A-Z0-9]*-\d+\b/);
    if (id) words.push(`${name}: requirement id ${id[0]}`);
    const internal = text.match(/\b(fingerprint|quota|locked|outbox)\b/gi);
    if (internal) words.push(`${name}: ${internal.join(', ')}`);
  };
  const narrow = async (p: Page, name: string) => {
    const vp = p.viewportSize()!;
    await p.setViewportSize({ width: 390, height: 844 });
    await p.waitForTimeout(200);
    const over = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 0) problems.push(`390px ${name}: scrolls sideways by ${over}px`);
    await p.setViewportSize(vp);
  };
  await check(A, 'lead');
  await narrow(A, 'lead');
  await B.getByRole('button', { name: /Show their marks/ }).click();
  await check(B, 'follower, strip open');
  await narrow(B, 'follower, strip open');
  await next(B).click();
  await check(B, 'looking on your own');
  await narrow(B, 'looking on your own');
  await A.getByRole('button', { name: 'Pause' }).click();
  await expect(B.locator('.paused-banner')).toBeVisible();
  await check(B, 'paused (follower)');
  await A.getByRole('button', { name: 'Resume' }).first().click();
  await actx.setOffline(true);
  await keyPoint(A, 0).check();
  await expect(A.getByTestId('saving')).toContainText('Offline');
  await check(A, 'offline');
  await narrow(A, 'offline');
  await actx.setOffline(false);
  await expect(A.getByTestId('saving')).toHaveText(/All changes saved/, { timeout: 15_000 });
  await A.getByRole('button', { name: 'Finish…' }).first().click();
  await check(A, 'finish dialog');
  await narrow(A, 'finish dialog');
  await A.keyboard.press('Escape');
  const aRec = await recordIdOf(actx.request, s.interviewId);
  await ops(actx.request, aRec, [...s.questions.map((q) => ({ t: 'score', q: q.id, v: 3 })), { t: 'overall', rating: 3, recommendation: 'hire', rationale: 'Fine.' }]);
  expect((await call(actx.request, 'POST', `/api/records/${aRec}/submit`)).status).toBe(200);
  await A.goto(`/#/interviews/${s.interviewId}`);
  await expect(A.getByTestId('waiting')).toBeVisible();
  await check(A, 'interview page, waiting');
  await narrow(A, 'interview page, waiting');
  await A.goto(`/#/interviews/${s.interviewId}/live`);
  await expect(A.locator('.live-readonly')).toBeVisible();
  await check(A, 'submitted, read-only');
  await narrow(A, 'submitted, read-only');
  await A.goto(`/#/scorecard/${aRec}`);
  await expect(A.getByTestId('sc-overall')).toBeVisible();
  await check(A, 'scorecard');
  await narrow(A, 'scorecard');
  const W = await B.context().newPage();
  await W.goto(`/#/interviews/${s.interviewId}/present`);
  await expect(W.getByRole('heading', { level: 1 })).toHaveText(/^Question/);
  await check(W, 'candidate window');
  await B.goto('/#/');
  await expect(B.locator('.continue')).toBeVisible();
  await check(B, 'dashboard with an interview in progress');
  await narrow(B, 'dashboard');
  expect(problems).toEqual([]);
  expect(words).toEqual([]);
});
