// Shared fixtures and UI helpers for the end-to-end suite. Every helper drives the real UI of the
// production build: there are no shortcuts into the database.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { test as base, expect, type BrowserContext, type Download, type Locator, type Page } from '@playwright/test';

export { expect };
export type { Page } from '@playwright/test';

export interface SeedQuestion {
  id: string;
  number: number;
  categoryId: string;
  text: string;
  /** BANK-8: the interviewer's steer; never shown to the candidate (FLOW-11). */
  description: string;
  difficulty: 'core' | 'advanced' | 'expert';
  type: 'knowledge' | 'scenario' | 'design' | 'behavioural';
  timeMin: number;
  lookFor: string[];
  redFlags: string[];
  probes: string[];
  version: number;
}
export interface SeedFile {
  track: { id: string; name: string; version: string };
  categories: Array<{ id: string; name: string; weight: number; mustHave: boolean }>;
  questions: SeedQuestion[];
}

/** Reads a seed file straight from the repository (used for expected values, never to drive the app). */
export function seed(trackId: 'qa' | 'web' | 'edge' | 'aks'): SeedFile {
  return JSON.parse(readFileSync(fileURLToPath(new URL(`../seed/${trackId}.json`, import.meta.url)), 'utf8')) as SeedFile;
}

export interface Guard {
  /** Console messages of every type, for PRIV-3 checks. */
  console: string[];
  /** Requests whose origin is not the app's origin (PRIV-2, SEC-1). */
  foreignRequests: string[];
  /** Every request URL (PRIV-3: no candidate data in URLs). */
  requests: string[];
  /** Every page URL seen (PRIV-3). */
  pageUrls: string[];
  /** Console errors and uncaught page errors. */
  errors: string[];
  /** Turn off the end-of-test "no console errors" check for a test that expects one. */
  allowErrors: (re: RegExp) => void;
  /** Applies the same checks to another browser context (e.g. a second panelist). */
  watch: (context: BrowserContext) => void;
}

/**
 * The `guard` fixture is automatic: every test fails if the app logs a console error, throws an
 * uncaught error, or makes a request to another origin (PRIV-2, SEC-1).
 */
export const test = base.extend<{ guard: Guard }>({
  guard: [
    async ({ context, baseURL }, use) => {
      const origin = new URL(baseURL!).origin;
      const allowed: RegExp[] = [];
      const g: Guard = {
        console: [],
        foreignRequests: [],
        requests: [],
        pageUrls: [],
        errors: [],
        allowErrors: (re) => allowed.push(re),
        watch: (ctx) => watchContext(ctx),
      };
      const watchPage = (page: Page) => {
        page.on('console', (m) => {
          g.console.push(m.text());
          if (m.type() === 'error') g.errors.push(`console: ${m.text()}`);
        });
        page.on('pageerror', (e) => g.errors.push(`pageerror: ${e.message}`));
        page.on('framenavigated', (f) => {
          if (f === page.mainFrame()) g.pageUrls.push(f.url());
        });
      };
      const watchContext = (ctx: BrowserContext) => {
        ctx.pages().forEach(watchPage);
        ctx.on('page', watchPage);
        ctx.on('request', (r) => {
          const url = r.url();
          g.requests.push(url);
          if (!url.startsWith('data:') && !url.startsWith('blob:') && new URL(url).origin !== origin) g.foreignRequests.push(url);
        });
      };
      watchContext(context);
      await use(g);
      expect(g.foreignRequests, 'no request may leave the origin (PRIV-2, SEC-1)').toEqual([]);
      expect(
        g.errors.filter((e) => !allowed.some((re) => re.test(e))),
        'no console errors',
      ).toEqual([]);
    },
    { auto: true },
  ],
});

// ------------------------------------------------------------------------------------------------
// UI helpers

/** An open modal (role dialog or alertdialog) by its title (A11Y-1 dialogs are native <dialog>s). */
export function modal(page: Page, title: string | RegExp) {
  return page.locator('dialog[open]').filter({ has: page.getByRole('heading', { name: title }) });
}

export const TRACK_NAMES = {
  qa: 'Senior QA Engineer',
  web: 'Senior Software Engineer (Web Applications)',
  edge: 'Senior Platform Engineer (Akamai & Apigee)',
  aks: 'Senior Platform Engineer (AKS with Azure)',
} as const;

/** The New interview screen's form (FLOW-33). */
export function newInterviewForm(page: Page) {
  return page.locator('form[aria-label="New interview"]');
}

/** Opens the dashboard and, on a new device, sets the interviewer name in Admin › Device. */
export async function openApp(page: Page, name = 'Alex Interviewer'): Promise<void> {
  await page.goto('./#/admin?tab=device');
  const field = page.getByLabel('Your name on this device');
  await expect(field).toBeVisible();
  // The stored name loads asynchronously; give it a moment before deciding it is empty.
  await page.waitForTimeout(150);
  if (!(await field.inputValue()).trim()) {
    await field.fill(name);
    await page.getByRole('button', { name: 'Save name' }).click();
    await expect(page.getByText('Saved.')).toBeVisible();
  }
  // Back without reloading the document (tests that wait for the service worker rely on it).
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

/** The set summary line, e.g. "14 questions · about 58 min of your 60". */
export function setSummary(page: Page) {
  return page.getByTestId('set-summary');
}

/** Dashboard → "New interview" → the New interview screen with a set drawn (UX-2); optionally another role. */
export async function openNewInterview(page: Page, track?: keyof typeof TRACK_NAMES): Promise<void> {
  if (!(await page.getByTestId('new-interview').count())) {
    await page.goto('./#/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  }
  await page.getByTestId('new-interview').first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
  await expect(setSummary(page)).toContainText(/\d+ questions?/);
  if (track) await chooseRole(page, track);
}

/** FLOW-33: changes the role; a new set is drawn for it. */
export async function chooseRole(page: Page, track: keyof typeof TRACK_NAMES): Promise<void> {
  const role = page.getByLabel('Role');
  if ((await role.inputValue()) !== track) {
    await role.selectOption(track);
    await expect(role).toHaveValue(track);
    await expect(role).toBeEnabled();
  }
}

/** Kept name for older call sites: the New interview screen for a role, with "Edit questions" open. */
export async function newDraft(page: Page, track: keyof typeof TRACK_NAMES): Promise<void> {
  await openNewInterview(page, track);
  await editQuestions(page);
}

/** UX-3: opens "Edit questions" in place. */
export async function editQuestions(page: Page): Promise<void> {
  const b = page.locator('#ni-edit');
  if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
  await expect(page.getByRole('heading', { name: 'In interview order' })).toBeVisible();
}

/** UX-3: shows one of the tabs beside the list ("Add questions", "Change the mix", "Coverage"). */
export async function editorTab(page: Page, name: 'Add questions' | 'Change the mix' | 'Coverage'): Promise<void> {
  await page.getByRole('tab', { name }).click();
  await expect(page.getByRole('tab', { name })).toHaveAttribute('aria-selected', 'true');
}

/** The rows of the selected questions, in interview order. */
export function selectedRows(page: Page) {
  return page.getByRole('list', { name: 'Questions in interview order' }).locator('li.set-row');
}

/** Opens More options (FLOW-33). */
export async function openMoreOptions(page: Page): Promise<void> {
  const t = page.locator('.ni-more__toggle');
  if ((await t.getAttribute('aria-expanded')) !== 'true') await t.click();
  await expect(page.locator('#ni-more-body')).toBeVisible();
}

/** FLOW-3, UX-2: "Shuffle" draws a new set. Returns the number of questions. */
export async function randomDraw(page: Page): Promise<number> {
  await page.getByRole('button', { name: 'Shuffle' }).click();
  await expect(page.getByText(/New questions drawn/).first()).toBeVisible();
  const text = await setSummary(page).innerText();
  return Number(text.match(/(\d+) questions?/)![1]);
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A bank question's row in "Add questions", by its exact text. */
export function bankRow(page: Page, text: string) {
  return page.locator('li.add-item').filter({ has: page.locator('.add-item__text', { hasText: new RegExp(`^${escapeRe(text)}$`) }) });
}

/** A bank question's row in "Add questions", by its number in the bank. */
export function bankQuestion(page: Page, n: number) {
  return page.locator(`li.add-item[data-question="${n}"]`);
}

/** Replaces the drawn set with these bank questions, in this order (by bank number, from the seed file). */
export async function pickByNumber(page: Page, numbers: number[]): Promise<void> {
  await editQuestions(page);
  const rows = selectedRows(page);
  while ((await rows.count()) > 0) {
    const n = await rows.count();
    await rows.first().getByRole('button', { name: /^Remove question/ }).click();
    await expect(rows).toHaveCount(n - 1);
  }
  await editorTab(page, 'Add questions');
  for (const n of numbers) await bankQuestion(page, n).getByRole('checkbox').check();
  await expect(rows).toHaveCount(numbers.length);
  await expect(setSummary(page)).toContainText(`${numbers.length} question`);
}

export interface CandidateOpts {
  initials: string;
  requisitionId?: string;
  interviewer?: string;
  retentionUntil?: string;
}

/** FLOW-7: fills the candidate details on the New interview screen (optional ones under More options). */
export async function fillCandidate(scope: Page | Locator, c: CandidateOpts): Promise<void> {
  const page = 'page' in scope ? (scope as Locator).page() : (scope as Page);
  await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill(c.initials);
  if (c.interviewer !== undefined) await page.getByLabel('Your name').fill(c.interviewer);
  if (c.requisitionId !== undefined || c.retentionUntil !== undefined) await openMoreOptions(page);
  if (c.requisitionId !== undefined) await page.getByLabel('Requisition id').fill(c.requisitionId);
  if (c.retentionUntil !== undefined) await page.getByLabel('Keep the record until').fill(c.retentionUntil);
}

/** FLOW-8: "Continue" pins the set and opens the ready screen (FLOW-10). */
export async function continueToReady(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Continue/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Ready to start' })).toBeVisible();
}

/** FLOW-7, PRIV-4: on the ready screen, confirm the candidate has been told. */
export async function confirmConsent(page: Page): Promise<void> {
  await page.getByRole('checkbox', { name: /I confirm the candidate has been told/ }).check();
}

/** FLOW-10: confirms consent (if not yet) and starts. */
export async function startInterview(page: Page): Promise<void> {
  const box = page.getByRole('checkbox', { name: /I confirm the candidate has been told/ });
  if (!(await box.isChecked())) await box.check();
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();
  await expect(page.locator('#question-heading')).toContainText('Question 1');
}

/** Full set-up through the UI: New interview → questions → candidate → Continue → (optionally) start. */
export async function setupInterview(
  page: Page,
  opts: { track?: keyof typeof TRACK_NAMES; pick?: number[]; candidate: CandidateOpts; start?: boolean; weights?: Record<string, string>; mustHave?: string[]; recording?: boolean },
): Promise<void> {
  await openNewInterview(page, opts.track ?? 'qa');
  if (opts.pick) await pickByNumber(page, opts.pick);
  if (opts.weights || opts.mustHave || opts.recording !== undefined) await openMoreOptions(page);
  for (const [category, w] of Object.entries(opts.weights ?? {})) {
    await page.getByLabel(`Weight for ${category}`).fill(w);
  }
  for (const category of opts.mustHave ?? []) {
    await page.getByRole('checkbox', { name: `Must-have for ${category}` }).check();
  }
  if (opts.recording !== undefined) await page.getByRole('checkbox', { name: 'This interview will be recorded or transcribed' }).setChecked(opts.recording);
  await fillCandidate(page, opts.candidate);
  await continueToReady(page);
  if (opts.start !== false) await startInterview(page);
}

/**
 * FLOW-9: a new interview with the same questions as an earlier one: Dashboard › Question sets ›
 * "Reuse" (the first set listed, or the one named), then the candidate, then Continue.
 */
export async function newInterviewFromSet(page: Page, candidate: CandidateOpts, opts: { setName?: string | RegExp; start?: boolean } = {}): Promise<void> {
  await page.goto('./#/');
  const sets = page.locator('section[aria-labelledby="dash-sets"]');
  const reuse = sets.getByRole('link', { name: opts.setName ? new RegExp(`^Reuse.*${typeof opts.setName === 'string' ? escapeRe(opts.setName) : opts.setName.source}`) : /^Reuse/ });
  await reuse.first().click();
  await expect(page.getByRole('heading', { level: 1, name: 'New interview' })).toBeVisible();
  await expect(page.locator('.ni-set__mix')).toContainText('The same questions as');
  await fillCandidate(page, candidate);
  await continueToReady(page);
  if (opts.start) await startInterview(page);
}

/**
 * UX-5: chooses an item from the live interview's "More" menu (an ARIA menu button): candidate view,
 * candidate window, interviewers, transcript and recording, keyboard shortcuts.
 */
export async function moreMenu(page: Page, item: string | RegExp): Promise<void> {
  const button = page.getByRole('button', { name: 'More', exact: true });
  await button.click();
  await expect(button).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
  await expect(page.getByRole('menu')).toHaveCount(0);
}

/** Focuses the question heading so single-key shortcuts apply (KEY-2: not while typing). */
export async function focusQuestion(page: Page): Promise<void> {
  await page.locator('#question-heading').focus();
}

export async function currentQuestionNumber(page: Page): Promise<number> {
  const t = await page.locator('#question-heading').innerText();
  return Number(t.match(/Question (\d+)/)![1]);
}

/** Waits until the live screen shows question `n`. */
export async function expectQuestion(page: Page, n: number): Promise<void> {
  await expect(page.locator('#question-heading')).toContainText(new RegExp(`^Question ${n}\\b`));
}

/** The live screen's score radio for a level (RUB-1). */
export function scoreRadio(page: Page, score: number) {
  return page.locator(`fieldset.score-control input[type=radio][value="${score}"]`);
}

/** Adds a note with the composer and Enter (FLOW-15). */
export async function addNote(page: Page, text: string): Promise<void> {
  const box = page.getByPlaceholder('What did the candidate say?');
  await box.fill(text);
  await box.press('Enter');
  await expect(page.getByRole('list', { name: 'Notes for this question' })).toContainText(text);
  await box.press('Escape');
}

/** Opens Finish, fills the overall assessment and submits (FLOW-22, FLOW-23). */
export async function finishInterview(page: Page, o: { rating: number; recommendation: string; rationale: string }): Promise<void> {
  await page.getByRole('button', { name: 'Finish…' }).click();
  const dlg = modal(page, 'Finish and submit the interview');
  await dlg.getByRole('group', { name: /Overall rating/ }).getByRole('radio', { name: new RegExp(`^${o.rating} `) }).check();
  await dlg.getByRole('group', { name: /Recommendation/ }).getByRole('radio', { name: o.recommendation, exact: true }).check();
  await dlg.getByLabel('Rationale').fill(o.rationale);
  await dlg.getByRole('button', { name: 'Submit interview' }).click();
  await expect(page.getByRole('heading', { level: 1, name: /^Scorecard: / })).toBeVisible();
}

/** Scores every remaining question with `score` using keys, adding a note where 1 or 4 needs one. */
export async function scoreAllWithKeys(page: Page, score: 1 | 2 | 3 | 4, total: number): Promise<void> {
  for (let n = 1; n <= total; n++) {
    await expectQuestion(page, n);
    await focusQuestion(page);
    await page.keyboard.press(String(score));
    await expect(scoreRadio(page, score)).toBeChecked();
    if (score === 1 || score === 4) await addNote(page, `Evidence for question ${n}`);
    if (n < total) {
      await focusQuestion(page);
      await page.keyboard.press('n');
    }
  }
}

/** FLOW-31: the scorecard's "Export" menu: "Markdown", "CSV, one row per question", "Interview file for the debrief". */
export async function exportFromScorecard(page: Page, item: 'Markdown' | 'CSV, one row per question' | 'Interview file for the debrief') {
  return downloadText(page, async () => {
    await page.getByRole('button', { name: 'Export', exact: true }).click();
    await page.getByRole('menu').getByRole('menuitem', { name: item, exact: true }).click();
  });
}

/** Saves a download and returns its text. */
export async function downloadText(page: Page, trigger: () => Promise<unknown>): Promise<{ name: string; text: string; download: Download }> {
  const [download] = await Promise.all([page.waitForEvent('download'), trigger()]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path!, 'utf8'), download };
}

/** Today's local date as YYYY-MM-DD in the browser. */
export async function browserToday(page: Page): Promise<string> {
  return page.evaluate(() => {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  });
}

/** FLOW-27: Admin › This device › "Hide other people's scores until I have submitted mine". */
export async function setIndependentScoring(page: Page, on: boolean): Promise<void> {
  await page.goto('./#/admin?tab=device');
  const box = page.getByRole('checkbox', { name: 'Hide other people’s scores until I have submitted mine' });
  await expect(box).toBeEnabled();
  await box.setChecked(on);
  await expect(box).toBeChecked({ checked: on });
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Dashboard', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
}

/** TEAM-4, TEAM-5: Dashboard › "Import files" with one or more files; returns the result summary. */
export async function importFiles(page: Page, files: Parameters<Locator['setInputFiles']>[0]) {
  if (!(await page.getByTestId('import-input').count())) {
    await page.goto('./#/');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  }
  await page.getByTestId('import-input').setInputFiles(files);
  const results = page.locator('#import-results');
  await expect(results).toBeVisible();
  return results;
}
