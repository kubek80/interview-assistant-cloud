// MVP-3: the scorecard in the UI equals an independent calculation written here from the formulas
// in docs/04-scoring.md. This file deliberately does not import the app's scoring module.
import {
  addNote,
  expect,
  expectQuestion,
  newInterviewFromSet,
  finishInterview,
  focusQuestion,
  modal,
  openApp,
  scoreRadio,
  seed,
  setupInterview,
  test,
  type Page,
} from './fixtures';

const QA = seed('qa');
const DIFFICULTY_WEIGHT = { core: 1.0, advanced: 1.5, expert: 2.0 } as const; // SCORE-2
type Entry = number | 'skip';

interface Expected {
  overall: number | null;
  coverage: number;
  band: string;
  categories: Map<string, { pct: number | null; avg: number | null }>;
  strengths: string[];
  concerns: string[];
}

/** docs/04-scoring.md, written out independently of src/domain/scoring.ts. */
function expected(numbers: number[], entries: Entry[], weights: Record<string, number>, mustHave: string[]): Expected {
  const qs = numbers.map((n) => QA.questions.find((q) => q.number === n)!);
  const catName = (id: string) => QA.categories.find((c) => c.id === id)!.name;
  const rows = qs.map((q, i) => {
    const difficulty = q.type === 'behavioural' ? 'core' : q.difficulty; // RUB-6
    const w = DIFFICULTY_WEIGHT[difficulty] * (weights[catName(q.categoryId)] ?? 1); // SCORE-2
    const e = entries[i];
    const v = e === 'skip' ? null : (e - 1) / 3; // SCORE-1
    return { cat: catName(q.categoryId), w, v, score: e === 'skip' ? null : e };
  });
  const answered = rows.filter((r) => r.v !== null);
  const sw = answered.reduce((a, r) => a + r.w, 0);
  const swv = answered.reduce((a, r) => a + r.w * r.v!, 0);
  const overall = sw > 0 ? (swv / sw) * 100 : null; // SCORE-3
  const coverage = sw / rows.reduce((a, r) => a + r.w, 0); // SCORE-6
  const categories = new Map<string, { pct: number | null; avg: number | null }>();
  for (const cat of new Set(rows.map((r) => r.cat))) {
    const a = answered.filter((r) => r.cat === cat);
    const csw = a.reduce((x, r) => x + r.w, 0);
    categories.set(cat, {
      pct: csw > 0 ? (a.reduce((x, r) => x + r.w * r.v!, 0) / csw) * 100 : null, // SCORE-4
      avg: a.length ? a.reduce((x, r) => x + r.score!, 0) / a.length : null,
    });
  }
  const strengths = [...categories].filter(([, c]) => c.avg !== null && c.avg >= 3).map(([n]) => n); // SCORE-5
  const concerns = [...categories]
    .filter(([n, c]) => (c.avg !== null && c.avg <= 2) || (mustHave.includes(n) && c.avg === null))
    .map(([n]) => n);
  // SCORE-7 on the unrounded value, SCORE-8 cap, SCORE-6 insufficient evidence.
  let band = overall === null ? 'no band yet' : overall >= 80 ? 'Strong hire' : overall >= 65 ? 'Hire' : overall >= 50 ? 'Lean no hire' : 'No hire';
  const capped = mustHave.some((n) => (categories.get(n)?.avg ?? 99) < 2) && (band === 'Strong hire' || band === 'Hire');
  if (capped) band = 'Lean no hire (capped)';
  if (coverage < 0.7) band = 'Insufficient evidence';
  return { overall, coverage, band, categories, strengths, concerns };
}

const pct = (x: number | null) => (x === null ? '–' : `${Math.round(x)}%`); // SCORE-10
const avg = (x: number | null) => (x === null ? '–' : (Math.round(x * 10) / 10).toFixed(1));

async function enter(page: Page, entries: Entry[]) {
  for (let i = 0; i < entries.length; i++) {
    await expectQuestion(page, i + 1);
    const e = entries[i];
    await focusQuestion(page);
    if (e === 'skip') {
      await page.keyboard.press('s');
      const dlg = modal(page, `Skip question ${i + 1}`);
      await dlg.getByLabel('Reason for skipping').fill('Not reached');
      await dlg.getByRole('button', { name: 'Skip question' }).click();
      await expect(page.getByText('Reason: Not reached')).toBeVisible();
    } else {
      await page.keyboard.press(String(e));
      await expect(scoreRadio(page, e)).toBeChecked();
      if (e === 1 || e === 4) await addNote(page, `Evidence ${i + 1}`);
    }
    if (i < entries.length - 1) {
      await focusQuestion(page);
      await page.keyboard.press('n');
    }
  }
}

async function assertScorecard(page: Page, exp: Expected) {
  const overallCard = page.locator('.sc-figure', { hasText: 'Overall' }).first();
  await expect(overallCard.locator('.sc-big')).toHaveText(pct(exp.overall));
  await expect(overallCard).toContainText(`Coverage ${pct(exp.coverage * 100)}`);
  await expect(page.locator('.sc-figure', { hasText: 'Advisory band' }).locator('.badge')).toHaveText(`Advisory: ${exp.band}`);
  const table = page.getByRole('table', { name: 'Category figures' });
  for (const [name, c] of exp.categories) {
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name, exact: true }) });
    await expect(row.locator('td').nth(3)).toHaveText(pct(c.pct));
    await expect(row.locator('td').nth(4)).toHaveText(avg(c.avg));
  }
  const strengths = page.locator('.card', { has: page.getByRole('heading', { name: 'Strengths' }) });
  for (const s of exp.strengths) await expect(strengths).toContainText(s);
  const concerns = page.locator('.card', { has: page.getByRole('heading', { name: 'Concerns' }) });
  if (exp.concerns.length === 0) await expect(concerns).toContainText('None.');
  for (const c of exp.concerns) await expect(concerns).toContainText(c);
}

const FINISH = { rating: 3, recommendation: 'Lean no hire', rationale: 'Per the evidence.' };

test.describe('Scoring', () => {
  test('MVP-3 SCORE-1 SCORE-2 SCORE-3 SCORE-4 SCORE-5 SCORE-6 SCORE-7 SCORE-8 SCORE-10 FLOW-6 FLOW-9 FLOW-24: scorecards match an independent calculation of the docs/04 worked example', async ({
    page,
  }) => {
    await openApp(page);
    // The worked example: Q1 core Strategy, Q2 advanced Automation frameworks (weight 1.2),
    // Q3 expert Strategy, Q4 advanced Strategy.
    const numbers = [1, 10, 7, 4];
    const weights = { 'Automation frameworks': 1.2 };

    // A: 4, 3, 2, skipped → 59.72% (60%), coverage 76%, Lean no hire; both categories average 3.0.
    const a: Entry[] = [4, 3, 2, 'skip'];
    await setupInterview(page, { pick: numbers, weights: { 'Automation frameworks': '1.2' }, candidate: { initials: 'WA', requisitionId: 'EX-1' } });
    await enter(page, a);
    await finishInterview(page, FINISH);
    const expA = expected(numbers, a, weights, []);
    expect(expA.overall!).toBeCloseTo(59.72, 2); // the docs' own figure
    expect(expA.coverage).toBeCloseTo(0.762, 3);
    await assertScorecard(page, expA);

    // B: the same questions (FLOW-9 reuse), Q3 also skipped → coverage 44%: Insufficient evidence.
    await newInterviewFromSet(page, { initials: 'WB', requisitionId: 'EX-2' }, { start: true });
    const b: Entry[] = [4, 3, 'skip', 'skip'];
    await enter(page, b);
    await finishInterview(page, FINISH);
    const expB = expected(numbers, b, weights, []);
    expect(expB.coverage).toBeCloseTo(0.444, 3);
    await assertScorecard(page, expB);

    // C: Automation frameworks must-have, 4, 1, 4, 4 → 71.43% Hire, capped to Lean no hire.
    await page.goto('./');
    const c: Entry[] = [4, 1, 4, 4];
    await setupInterview(page, {
      pick: numbers,
      weights: { 'Automation frameworks': '1.2' },
      mustHave: ['Automation frameworks'],
      candidate: { initials: 'WC', requisitionId: 'EX-3' },
    });
    await enter(page, c);
    await finishInterview(page, FINISH);
    const expC = expected(numbers, c, weights, ['Automation frameworks']);
    expect(expC.overall!).toBeCloseTo(71.43, 2);
    expect(expC.band).toBe('Lean no hire (capped)');
    await assertScorecard(page, expC);
    await expect(page.getByText('Must-have cap applied.')).toBeVisible();
    await expect(page.locator('main')).toContainText('Automation frameworks');
  });
});
