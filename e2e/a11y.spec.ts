import { mkdirSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import {
  addNote,
  expect,
  expectQuestion,
  finishInterview,
  focusQuestion,
  modal,
  moreMenu,
  continueToReady,
  editQuestions,
  editorTab,
  openApp,
  openMoreOptions,
  openNewInterview,
  scoreAllWithKeys,
  setupInterview,
  startInterview,
  test,
  type Guard,
  type Page,
} from './fixtures';
import type { Browser } from '@playwright/test';

// Every screen of the app in the states an interviewer sees, built once through the UI.
interface Tour {
  submitted: string;
  paused: string;
  planned: string;
  running: string;
  /** UX-4, UX-6: the default 14 questions; question 1 scored 4 without a note, the rest unanswered. */
  many: string;
  draftPlan: string;
  lockedPlan: string;
  fingerprint: string;
}

let state: { storage: Awaited<ReturnType<import('@playwright/test').BrowserContext['storageState']>>; tour: Tour };

const idFrom = (page: Page) => page.url().split('/').pop()!.split('?')[0];

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openApp(page, 'Tess Tour');
  // Submitted interview with a flag, a skip and notes.
  await setupInterview(page, { pick: [1, 2, 3], candidate: { initials: 'SU', requisitionId: 'REQ-TOUR' } });
  await focusQuestion(page);
  await page.keyboard.press('f');
  await scoreAllWithKeys(page, 4, 3);
  await finishInterview(page, { rating: 4, recommendation: 'Strong hire', rationale: 'Clear evidence throughout.' });
  const submitted = idFrom(page);
  const lockedHref = await page.goto('./').then(() => page.locator('section[aria-labelledby="dash-sets"] .dash-plan__name').first().getAttribute('href'));
  const lockedPlan = lockedHref!.split('/').pop()!;
  // Paused, planned and running interviews with the same questions (FLOW-9 reuse).
  const fromPlan = async (initials: string, otherInterviewer?: string) => {
    await page.goto('./');
    await page.locator('section[aria-labelledby="dash-sets"]').getByRole('link', { name: /^Reuse/ }).first().click();
    await expect(page.locator('.ni-set__mix')).toContainText('The same questions as');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill(initials);
    if (otherInterviewer) {
      // PANEL-1: a shared scorecard with a second interviewer.
      await openMoreOptions(page);
      await page.getByRole('button', { name: 'Add interviewer' }).click();
      await page.getByLabel('Interviewer 2', { exact: true }).fill(otherInterviewer);
    }
    await continueToReady(page);
    return idFrom(page);
  };
  const paused = await fromPlan('PA');
  await page.getByRole('checkbox', { name: /I confirm the candidate has been told/ }).check();
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expectQuestion(page, 1);
  await addNote(page, 'A note on the paused interview.');
  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.locator('.paused-banner__title')).toBeVisible();
  const running = await fromPlan('RU', 'Rae Second');
  await page.getByRole('checkbox', { name: /I confirm the candidate has been told/ }).check();
  await page.getByRole('button', { name: 'Start interview' }).click();
  await expectQuestion(page, 1);
  // PANEL-3: a note marked with who made it.
  await page.getByLabel('Note by').selectOption({ label: 'Rae Second' });
  await addNote(page, 'A note by the second interviewer.');
  await page.locator('.interviewer-pane input[type=checkbox]').first().click();
  await expect(page.locator('.interviewer-pane input[type=checkbox]').first()).toBeChecked();
  const planned = await fromPlan('PL');
  // A full-length interview (the default set), question 1 scored 4 and still needing a note.
  await page.goto('./');
  await openNewInterview(page, 'web');
  await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('MA');
  await continueToReady(page);
  const many = idFrom(page);
  await startInterview(page);
  await focusQuestion(page);
  await page.keyboard.press('4');
  await expect(page.locator('.live-dock .needs-note')).toBeVisible();
  // A set-up not continued yet (the New interview screen).
  await page.goto('./');
  await openNewInterview(page, 'edge');
  const draftPlan = idFrom(page);
  const fingerprint = (await page.goto('./#/compare').then(() => page.getByLabel('Question set', { exact: true }).locator('option').nth(1).getAttribute('value')))!;
  state = { storage: await context.storageState({ indexedDB: true }), tour: { submitted, paused, planned, running, many, draftPlan, lockedPlan, fingerprint } };
  await context.close();
});

interface Screen {
  name: string;
  path: (t: Tour) => string;
  /** Optional interaction after load (open a dialog, switch a view). */
  act?: (page: Page) => Promise<void>;
  /** Puts back what `act` changed in the tour's data, before the next screen is visited. */
  undo?: (page: Page) => Promise<void>;
}

/** The `undo` of the screen visited last, run before the next visit (so each screen starts from the tour's data). */
let pendingUndo: ((page: Page) => Promise<void>) | null = null;

const SCREENS: Screen[] = [
  { name: 'dashboard', path: () => '' },
  { name: 'bank', path: () => 'bank/qa' },
  {
    name: 'bank-question-dialog',
    path: () => 'bank/qa',
    act: async (p) => {
      await p.locator('.bank-table tbody').getByRole('button').first().click();
      await expect(p.locator('dialog[open]')).toBeVisible();
    },
  },
  {
    // BANK-9: the question editor, with the per-level rubric fields expanded.
    name: 'bank-editor-dialog',
    path: () => 'bank/qa',
    act: async (p) => {
      await p.getByRole('button', { name: 'Edit question 45', exact: true }).click();
      await p.locator('dialog[open] details summary').click();
      await expect(p.locator('dialog[open]').getByText('Question-specific rubric descriptions (optional)')).toBeVisible();
    },
  },
  {
    // BANK-13: the bulk-add preview with a row that has problems.
    name: 'bank-bulk-preview',
    path: () => 'bank/qa',
    act: async (p) => {
      await p.getByRole('button', { name: 'Bulk add…' }).click();
      await p.locator('dialog[open]').getByLabel('Rows from a spreadsheet or CSV').fill('Good?\tSteer\tPerformance\tcore\tknowledge\ta\tb\tc\t\nBad\t\tNew cat\tx\tquiz\t\t\t\t');
      await p.locator('dialog[open]').getByRole('button', { name: 'Preview', exact: true }).click();
      await expect(p.locator('dialog[open]').getByText('1 of 2 rows ready to add.')).toBeVisible();
    },
  },
  { name: 'new-interview', path: (t) => `setup/${t.draftPlan}` },
  {
    // UX-3: "Edit questions" open, with the bank filters.
    name: 'new-interview-edit',
    path: (t) => `setup/${t.draftPlan}`,
    act: async (p) => {
      await editQuestions(p);
      await p.getByRole('button', { name: 'Filter by category, difficulty or type' }).click();
      await expect(p.getByRole('combobox', { name: 'Category' })).toBeVisible();
    },
  },
  {
    name: 'new-interview-mix',
    path: (t) => `setup/${t.draftPlan}`,
    act: async (p) => {
      await editQuestions(p);
      await editorTab(p, 'Change the mix');
    },
  },
  {
    name: 'new-interview-coverage',
    path: (t) => `setup/${t.draftPlan}`,
    act: async (p) => {
      await editQuestions(p);
      await editorTab(p, 'Coverage');
    },
  },
  {
    // FLOW-33, PANEL-1: More options open, a second interviewer row, and Continue's problems.
    name: 'new-interview-more-errors',
    path: (t) => `setup/${t.draftPlan}`,
    act: async (p) => {
      await openMoreOptions(p);
      await p.getByRole('button', { name: 'Add interviewer' }).click();
      await p.getByRole('button', { name: /^Continue/ }).click();
      await expect(p.getByText('Enter the interviewer’s name.', { exact: true }).first()).toBeVisible();
      await expect(p.getByRole('alert').filter({ hasText: 'to fix first' })).toBeVisible();
    },
  },
  {
    name: 'new-interview-reuse-dialog',
    path: (t) => `setup/${t.draftPlan}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Use the same questions as an earlier interview…' }).click();
      await expect(modal(p, 'Use the same questions as…')).toBeVisible();
    },
  },
  { name: 'question-set', path: (t) => `setup/${t.lockedPlan}` },
  { name: 'ready', path: (t) => `interview/${t.planned}` },
  {
    // FLOW-7: Start pressed without the consent confirmation.
    name: 'ready-refused',
    path: (t) => `interview/${t.planned}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Start interview' }).click();
      await expect(p.getByRole('alert')).toContainText('tick the box');
      await p.getByRole('button', { name: 'Preview the questions' }).click();
    },
  },
  {
    name: 'ready-discard-dialog',
    path: (t) => `interview/${t.planned}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Discard and set up again' }).click();
      await expect(modal(p, 'Discard this interview?')).toBeVisible();
    },
  },
  { name: 'interview-running', path: (t) => `interview/${t.running}` },
  { name: 'interview-paused', path: (t) => `interview/${t.paused}` },
  {
    name: 'interview-candidate-view',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await focusQuestion(p);
      await p.keyboard.press('c');
      await expect(p.locator('.candidate-question')).toBeVisible();
    },
  },
  {
    name: 'interview-finish-dialog',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Finish…' }).click();
      await expect(modal(p, 'Finish and submit the interview')).toBeVisible();
    },
  },
  {
    // UX-5: the "More" menu open.
    name: 'interview-more-menu',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'More', exact: true }).click();
      await expect(p.getByRole('menu')).toBeVisible();
    },
  },
  {
    // RUB-1: the rubric, open above the bottom bar, and a level's description shown while its button has focus.
    name: 'interview-rubric',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await p.locator('.live-dock').getByRole('button', { name: 'Rubric' }).click();
      await expect(p.locator('#rubric-panel')).toBeVisible();
      await p.locator('.live-dock .score-option').nth(2).hover();
      await expect(p.locator('.live-dock .score-option').nth(2).locator('.score-option__desc')).toBeVisible();
    },
  },
  // UX-4: a full-length interview; question 1 is scored 4 and needs a note (the bottom bar says so).
  { name: 'interview-many', path: (t) => `interview/${t.many}` },
  {
    // UX-6: many questions unanswered and one 4 without a note.
    name: 'interview-many-finish',
    path: (t) => `interview/${t.many}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Finish…' }).click();
      await expect(modal(p, 'Finish and submit the interview')).toContainText('Not scored or skipped yet');
    },
  },
  {
    name: 'interview-many-finish-skip-form',
    path: (t) => `interview/${t.many}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Finish…' }).click();
      const dlg = modal(p, 'Finish and submit the interview');
      await dlg.getByRole('button', { name: /^Skip the remaining/ }).click();
      await expect(dlg.getByLabel(/^One reason for skipping all/)).toBeFocused();
    },
  },
  {
    // UX-6: everything resolved (this changes the "many" interview: keep it the last screen that uses it).
    name: 'interview-many-finish-ready',
    path: (t) => `interview/${t.many}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Clear score' }).click();
      await expect(p.locator('.live-dock fieldset.score-control input:checked')).toHaveCount(0);
      await p.getByRole('button', { name: 'Finish…' }).click();
      const dlg = modal(p, 'Finish and submit the interview');
      await dlg.getByRole('button', { name: /^Skip the remaining/ }).click();
      await dlg.getByLabel(/^One reason for skipping all/).fill('Out of time');
      await dlg.getByRole('button', { name: /^Skip \d+ questions$/ }).click();
      await expect(dlg.getByRole('heading', { name: 'Every question is scored or skipped' })).toBeVisible();
    },
    undo: async (p) => {
      // Back to the tour's state: nothing skipped, question 1 scored 4 without a note.
      const dlg = modal(p, 'Finish and submit the interview');
      await dlg.getByRole('button', { name: 'Undo' }).click();
      await expect(dlg).toContainText('Not scored or skipped yet');
      await dlg.getByRole('button', { name: 'Keep interviewing' }).click();
      await focusQuestion(p);
      await p.keyboard.press('4');
      await expect(p.locator('.live-dock .needs-note')).toBeVisible();
    },
  },
  {
    // PANEL-1: add or remove interviewers in the live interview.
    name: 'interview-interviewers-dialog',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await moreMenu(p, 'Interviewers…');
      await expect(modal(p, 'Interviewers')).toBeVisible();
    },
  },
  {
    name: 'interview-shortcuts-dialog',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await focusQuestion(p);
      await p.keyboard.press('?');
      await expect(p.locator('dialog[open]')).toBeVisible();
    },
  },
  {
    // TR-1, TR-2, TR-4: the "Transcript & recording" dialog (option off at setup: the late notice first).
    name: 'interview-transcript-dialog',
    path: (t) => `interview/${t.running}`,
    act: async (p) => {
      await moreMenu(p, 'Transcript & recording…');
      await expect(modal(p, 'Transcript and recording')).toContainText('The candidate was not told');
    },
  },
  { name: 'interview-submitted', path: (t) => `interview/${t.submitted}` },
  {
    name: 'interview-amend',
    path: (t) => `interview/${t.submitted}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Amend this question…' }).click();
      await expect(p.locator('.amend-form')).toBeVisible();
    },
  },
  { name: 'candidate-window', path: (t) => `present/${t.running}` },
  { name: 'scorecard', path: (t) => `scorecard/${t.submitted}` },
  { name: 'debrief', path: (t) => `debrief/${t.submitted}` },
  { name: 'compare-choose', path: () => 'compare' },
  { name: 'compare', path: (t) => `compare?plan=${t.fingerprint}` },
  // SUM-1, SUM-3, TEAM-7, TEAM-9, TEAM-13: the Summary, the candidate page and its dialogs.
  { name: 'summary', path: () => 'summary' },
  { name: 'candidate', path: (t) => `candidate/${t.submitted}` },
  {
    name: 'candidate-decision-dialog',
    path: (t) => `candidate/${t.submitted}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Record panel decision' }).click();
      await expect(modal(p, 'Record the panel decision')).toBeVisible();
    },
  },
  {
    name: 'candidate-judgement-dialog',
    path: (t) => `candidate/${t.submitted}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Add another interviewer’s judgement' }).click();
      await p.locator('dialog[open] details summary').click();
      await expect(modal(p, 'Add another interviewer’s judgement')).toBeVisible();
    },
  },
  {
    name: 'candidate-panel-file-dialog',
    path: (t) => `candidate/${t.submitted}`,
    act: async (p) => {
      await p.getByRole('button', { name: 'Export', exact: true }).click();
      await p.getByRole('menuitem', { name: 'Panel file…' }).click();
      await expect(modal(p, 'Export a panel file')).toBeVisible();
    },
  },
  { name: 'admin-audit', path: () => 'admin?tab=audit' },
  { name: 'admin-privacy', path: () => 'admin?tab=privacy' },
  { name: 'admin-bank', path: () => 'admin?tab=bank' },
  { name: 'admin-device', path: () => 'admin?tab=device' },
  { name: 'admin-ai', path: () => 'admin?tab=ai' },
  { name: 'docs', path: () => 'docs' },
  { name: 'docs-scoring', path: () => 'docs/04-scoring' },
  { name: 'docs-verification', path: () => 'docs/10-verification' },
  { name: 'not-found', path: () => 'no-such-screen' },
];

async function visit(page: Page, s: Screen) {
  if (pendingUndo) {
    const undo = pendingUndo;
    pendingUndo = null;
    await undo(page);
  }
  // The candidate-view toggle is remembered per tab (sessionStorage); start every screen without it.
  // A fresh load per screen, so nothing carries over from the previous one.
  await page.evaluate(() => sessionStorage.clear()).catch(() => {});
  await page.goto('about:blank');
  await page.goto(`./#/${s.path(state.tour)}`);
  await expect(page.locator('h1').first()).toBeVisible();
  await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
  if (s.act) await s.act(page);
  pendingUndo = s.undo ?? null;
}

const shotDir = process.env.E2E_SCREENSHOT_DIR;

/** A fresh "device" holding the tour's data (each test gets its own copy). */
async function tourPage(browser: Browser, guard: Guard): Promise<Page> {
  const ctx = await browser.newContext({ storageState: state.storage });
  guard.watch(ctx);
  return ctx.newPage();
}

test.describe('Accessibility', () => {

  for (const scheme of ['light', 'dark'] as const) {
    test(`A11Y-7 A11Y-3 A11Y-6: axe (including the 24px target-size rule) finds no serious or critical violations on any screen (${scheme} scheme)`, async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
      test.setTimeout(180_000);
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      const failures: string[] = [];
      for (const s of SCREENS) {
        await visit(page, s);
        const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
        for (const v of result.violations) {
          if (v.impact === 'serious' || v.impact === 'critical') {
            failures.push(`${s.name}: ${v.id} (${v.impact}) ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
          }
        }
        if (shotDir) {
          mkdirSync(shotDir, { recursive: true });
          await page.screenshot({ path: `${shotDir}/${scheme}-desktop-${s.name}.png`, fullPage: true });
        }
      }
      expect(failures).toEqual([]);
    });
  }

  test('A11Y-7 A11Y-6 FLOW-33 UX-9: the first-run Dashboard and New interview (name asked inline) pass axe in both schemes and fit 390px', async ({ page }) => {
    const failures: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const [name, path, ready] of [
          ['dashboard-first-run', './', () => page.getByRole('heading', { name: 'Run your first structured interview' })],
          ['new-interview-first-run', './#/new', () => page.getByLabel('Your name')],
        ] as const) {
          await page.goto(path);
          await expect(ready()).toBeVisible();
          const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
          for (const v of result.violations) {
            if (v.impact === 'serious' || v.impact === 'critical') failures.push(`${scheme} ${width} ${name}: ${v.id} ${v.help}`);
          }
          const wide = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
          if (wide) failures.push(`${scheme} ${width} ${name}: horizontal scroll`);
          if (shotDir) await page.screenshot({ path: `${shotDir}/${scheme}-${width}-${name}.png`, fullPage: true });
        }
      }
    }
    expect(failures).toEqual([]);
  });

  test('UX-9: one obvious primary action on the set-up, ready, live, scorecard and debrief screens, and every standard screen (the live interview and the ready screen included) starts at the same left edge and width', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    test.setTimeout(120_000);
    await page.setViewportSize({ width: 1280, height: 800 });
    const problems: string[] = [];
    const edges = new Map<string, number>();
    // Docs (with its own page list) has its own layout; the candidate view and window are for the candidate.
    for (const s of SCREENS.filter((x) => !x.act && x.name !== 'candidate-window' && !x.name.startsWith('docs'))) {
      await visit(page, s);
      // boundingBox() does not wait: a screen that re-renders its heading as its data loads (New interview) needs a moment.
      await expect.poll(() => page.locator('main h1').boundingBox()).not.toBeNull();
      const box = (await page.locator('main h1').boundingBox())!;
      edges.set(s.name, Math.round(box.x));
      const main = (await page.locator('main').boundingBox())!;
      if (Math.round(main.width) !== 1216) problems.push(`${s.name}: main is ${main.width}px wide, not the standard 76rem`);
      if (/^(dashboard|new-interview|ready|question-set|interview-|scorecard|debrief|summary|candidate)/.test(s.name)) {
        const primaries = await page.locator('main .btn--primary:visible').count();
        if (primaries !== 1) problems.push(`${s.name}: ${primaries} primary actions`);
      }
    }
    const left = edges.get('dashboard')!;
    for (const [n, x] of edges) if (x !== left) problems.push(`${n}: heading starts at ${x}, not ${left}`);
    expect(problems).toEqual([]);
  });

  test('A11Y-3: buttons do not fade their colours on their own, so a change of light or dark scheme never leaves text on a background that is still changing', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await visit(page, SCREENS.find((s) => s.name === 'interview-running')!);
    const resting = await page.locator('main .btn').evaluateAll((els) =>
      els.filter((e) => getComputedStyle(e).transitionDuration.split(',').some((d) => parseFloat(d) > 0)).map((e) => e.textContent?.trim()),
    );
    expect(resting).toEqual([]);
    // Switching to dark: the very next frame already has the dark colours (axe sees no contrast problem).
    await page.emulateMedia({ colorScheme: 'dark' });
    const result = await new AxeBuilder({ page }).withRules(['color-contrast']).analyze();
    expect(result.violations.map((v) => v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([]);
  });

  test('UX-7: no screen outside Docs shows a requirement id', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    test.setTimeout(120_000);
    const ID = /\b(FLOW|PRIV|PANEL|SCORE|BANK|RUB|AUD|SEC|KEY|A11Y|DATA|RES|OV|TR|AI|UX|MVP)-\d+\b/;
    const shown: string[] = [];
    for (const s of SCREENS.filter((x) => !x.name.startsWith('docs'))) {
      await visit(page, s);
      const text = await page.locator('body').innerText();
      const m = ID.exec(text);
      if (m) shown.push(`${s.name}: ${m[0]}`);
      // Help is a plain "?" named in words.
      for (const name of await page.locator('a.help-q').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))) {
        if (!/^Help: [^]+$/.test(name) || ID.test(name)) shown.push(`${s.name}: help link "${name}"`);
      }
    }
    expect(shown).toEqual([]);
  });

  test('A11Y-6: at a 390px viewport no screen scrolls horizontally', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    test.setTimeout(180_000);
    await page.setViewportSize({ width: 390, height: 844 });
    const overflow: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const s of SCREENS) {
        await visit(page, s);
        const { scrollWidth, clientWidth, culprit } = await page.evaluate(() => {
          const el = document.scrollingElement ?? document.documentElement;
          const wide = [...document.querySelectorAll<HTMLElement>('body *')]
            .filter((e) => e.getBoundingClientRect().right > document.documentElement.clientWidth + 1 && !e.closest('.table-wrap, pre, .docs-table-wrap'))
            .slice(0, 3)
            .map((e) => `${e.tagName.toLowerCase()}.${[...e.classList].join('.')}`);
          return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, culprit: wide.join(', ') };
        });
        if (scrollWidth > clientWidth) overflow.push(`${scheme} ${s.name}: ${scrollWidth} > ${clientWidth} (${culprit})`);
        if (shotDir) await page.screenshot({ path: `${shotDir}/${scheme}-390-${s.name}.png`, fullPage: true });
      }
    }
    expect(overflow).toEqual([]);
  });

  test('A11Y-2 UX-5: every screen has exactly one h1, landmarks, and route changes move focus to the heading', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    for (const s of SCREENS) {
      await visit(page, s);
      await expect(page.locator('h1'), `${s.name} has one h1`).toHaveCount(1);
      if (s.name !== 'candidate-window') {
        await expect(page.locator('main')).toHaveCount(1);
        await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
      }
    }
    // Route change by a link: focus goes to the new screen's h1.
    await page.goto('./');
    for (const [link, heading] of [
      ['Question bank', /Question bank/],
      ['Summary', 'Summary'],
      ['Admin', 'Admin'],
      ['Docs', /Docs|Overview/],
      ['Dashboard', 'Dashboard'],
    ] as const) {
      await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link, exact: true }).click();
      const h1 = page.locator('h1');
      await expect(h1).toHaveText(heading);
      await expect(h1).toBeFocused();
    }
  });

  test('A11Y-1: dialogs trap focus, close with Esc and return focus to their opener; everything is reachable by keyboard', async ({ browser, guard }) => {
    const page = await tourPage(browser, guard);
    await page.goto(`./#/interview/${state.tour.running}`);
    const opener = page.getByRole('button', { name: 'Finish…' });
    await opener.focus();
    await page.keyboard.press('Enter');
    const dlg = modal(page, 'Finish and submit the interview');
    await expect(dlg).toBeVisible();
    // Tab around more times than there are controls: focus never leaves the dialog.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
    }
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await page.evaluate(() => !!document.activeElement?.closest('dialog[open]'))).toBe(true);
    }
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(opener).toBeFocused();

    // Bank question dialog opened from the keyboard.
    await page.goto('./#/bank/qa');
    const first = page.locator('.bank-table tbody').getByRole('button').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(first).toBeFocused();

    // Focus is always visible: a focused control has an outline or box-shadow.
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    const ring = await page.evaluate(() => {
      const el = document.activeElement as Element;
      const s = getComputedStyle(el);
      const kind = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0 ? 'outline' : s.boxShadow !== 'none' ? 'shadow' : 'none';
      return `${kind} on ${el.tagName.toLowerCase()} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    });
    expect(ring).not.toMatch(/^none/);

    // Skip link reaches main content.
    await page.goto('./');
    await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(page.getByRole('link', { name: 'Skip to main content' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('main')).toBeFocused();
  });
});
