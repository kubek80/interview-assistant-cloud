// REVIEW-1 to REVIEW-7: question reviewers and the review workflow, end to end.
import AxeBuilder from '@axe-core/playwright';
import { ADMIN, ORGANISER, expect, seed, signIn, test, type Page } from './fixtures';

const REVIEWER = 'reviewer@example.test';
test.describe.configure({ mode: 'serial' });

const qa = seed('qa');
const perf = qa.questions.filter((q) => q.categoryId === 'qa-performance');

async function axe(page: Page) {
  const r = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']).analyze();
  return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('REVIEW-1: a question reviewer sees only the bank, their review list and the docs; other screens and the API refuse them', async ({ page, guard }) => {
  guard.allowErrors(/status of 403/);
  await signIn(page, REVIEWER);
  await expect(page).toHaveURL(/#\/to-review$/);
  const nav = (await page.getByRole('navigation', { name: 'Main' }).getByRole('link').allTextContents()).map((s) => s.trim().replace(/\d+ to do$/, '').trim());
  expect(nav).toEqual(['To review', 'Question bank', 'Docs']);
  for (const path of ['/users', '/admin', '/reviews', '/summary', '/rounds', '/new', '/interviews/00000000-0000-4000-8000-000000000000']) {
    await page.goto(`/#${path}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Not available');
  }
  for (const url of ['/api/users', '/api/audit', '/api/settings', '/api/reviews', '/api/audit/export', '/api/rounds', '/api/my/interviews']) expect((await page.request.get(url)).status(), url).toBe(403);
  const edit = await page.request.put('/api/bank/questions/qa-1', { headers: { 'x-ia-request': '1' }, data: {} });
  expect(edit.status()).toBe(403);
  await page.goto('/#/bank/qa');
  await expect(page.getByRole('button', { name: 'Add question' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Propose a question' })).toBeVisible();
});

test('REVIEW-7 REVIEW-2 REVIEW-3 REVIEW-4 REVIEW-5 REVIEW-6: an organiser asks for a review; the reviewer works through it; the organiser decides; the reviewer sees the outcomes', async ({ page, browser }) => {
  // The organiser asks for a review of one category.
  await signIn(page, ORGANISER, '/reviews');
  await page.getByRole('button', { name: 'Ask for a review' }).click();
  const ask = page.getByRole('dialog', { name: 'Ask for a review' });
  await ask.getByLabel('Track', { exact: true }).selectOption('qa');
  await ask.getByLabel('One category').check();
  await ask.getByLabel('Category', { exact: true }).selectOption('qa-performance');
  await ask.getByLabel(/Rita Reviewer/).check();
  await ask.getByLabel('Note for the reviewers (optional)').fill('Are these still the right metrics?');
  await ask.getByLabel('Due date (optional)').fill('2026-12-18');
  await ask.getByRole('button', { name: 'Send to 1 reviewer' }).click();
  await expect(page.getByText(/Review requested/)).toBeVisible();
  const card = page.getByRole('listitem').filter({ hasText: 'Senior QA Engineer: Performance' });
  await expect(card).toContainText(`0 of ${perf.length} done`);

  // The reviewer works through the list.
  const rctx = await browser.newContext();
  const rp = await rctx.newPage();
  await signIn(rp, REVIEWER);
  await expect(rp.getByRole('link', { name: new RegExp(`To review\\s*${perf.length}`) })).toBeVisible();
  await rp.getByRole('link', { name: 'Continue reviewing' }).click();
  await expect(rp.getByRole('heading', { name: new RegExp(`Question ${perf[0].number}`) })).toBeVisible();
  await expect(rp.getByText(perf[0].text).first()).toBeVisible();
  // 1: looks good (moves on to the next question)
  await rp.getByRole('button', { name: 'Looks good' }).click();
  await expect(rp.getByRole('heading', { name: new RegExp(`Question ${perf[1].number}`) })).toBeVisible();
  // 2: a comment, then a proposed change
  await rp.getByLabel('Add a comment').fill('Should mention DORA metrics.');
  await rp.getByRole('button', { name: 'Add comment' }).click();
  await expect(rp.getByText('Should mention DORA metrics.')).toBeVisible();
  await rp.getByRole('button', { name: 'Propose a change…' }).click();
  let editor = rp.getByRole('dialog', { name: `Propose a change to question ${perf[1].number}` });
  await editor.getByRole('textbox', { name: /^Question/ }).fill(`${perf[1].text} Which ones would you report?`);
  await editor.getByLabel(/Why do you propose this/).fill('Asks for something concrete.');
  await editor.getByRole('button', { name: 'Send proposal' }).click();
  await expect(rp.getByText(/Proposal sent/)).toBeVisible();
  await expect(rp.getByRole('heading', { name: new RegExp(`Question ${perf[2].number}`) })).toBeVisible();
  // 3: another proposed change (to be accepted with edits)
  await rp.getByRole('button', { name: 'Propose a change…' }).click();
  editor = rp.getByRole('dialog', { name: `Propose a change to question ${perf[2].number}` });
  await editor.getByRole('textbox', { name: /^Question/ }).fill('Draft rewording?');
  await editor.getByLabel(/Why do you propose this/).fill('Shorter.');
  await editor.getByRole('button', { name: 'Send proposal' }).click();
  await expect(rp.getByRole('heading', { name: new RegExp(`Question ${perf[3].number}`) })).toBeVisible();
  // 4: a change that will go out of date
  await rp.getByRole('button', { name: 'Propose a change…' }).click();
  editor = rp.getByRole('dialog', { name: `Propose a change to question ${perf[3].number}` });
  await editor.getByRole('textbox', { name: /^Question/ }).fill(`${perf[3].text} (reviewer wording)`);
  await editor.getByLabel(/Why do you propose this/).fill('Clearer.');
  await editor.getByRole('button', { name: 'Send proposal' }).click();
  await expect(rp.getByText(/4 of \d+ done/).first()).toBeVisible();
  // A new question, proposed by pasting a row (REVIEW-3).
  await rp.goto('/#/bank/qa');
  await rp.getByRole('button', { name: 'Propose several…' }).click();
  await rp.getByLabel('Rows from a spreadsheet or CSV').fill('How do you report test progress to executives?\tAbout reporting.\tPerformance\tcore\tknowledge\tA;B\tC\tWhat if it is bad news?\t');
  await rp.getByRole('dialog').getByRole('button', { name: 'Preview', exact: true }).click();
  await rp.getByLabel('Why do you propose these?').fill('A gap in the track.');
  await rp.getByRole('button', { name: 'Propose 1 question' }).click();
  await expect(rp.getByText(/Sent 1 proposal/)).toBeVisible();
  // The bank itself has not changed.
  await expect(rp.getByRole('button', { name: 'How do you report test progress to executives?' })).toHaveCount(0);

  // The organiser sees progress and the proposals.
  await page.goto('/#/reviews?tab=requests');
  await expect(card).toContainText(`4 of ${perf.length} done`);
  await page.goto('/#/reviews');
  await expect(page.getByRole('link', { name: /Reviews\s*4/ })).toBeVisible();
  // The organiser edits question 4 directly: Rita's proposal on it goes out of date (REVIEW-6).
  await page.goto('/#/bank/qa');
  await page.getByRole('button', { name: `Edit question ${perf[3].number}`, exact: true }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /^Question/ }).fill(`${perf[3].text} (organiser wording)`);
  await page.getByRole('dialog').getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/saved; it is now version/)).toBeVisible();
  await page.goto('/#/reviews');
  const stale = page.getByRole('listitem').filter({ hasText: `Change to question ${perf[3].number}` });
  await expect(stale).toContainText('Out of date');
  await stale.getByRole('link').click();
  await expect(page.getByText(/The question has changed since this was proposed/)).toBeVisible();
  await expect(page.getByRole('table')).toContainText('(organiser wording)');
  await expect(page.getByRole('table')).toContainText('(reviewer wording)');
  await expect(page.getByRole('row').filter({ hasText: 'Question' }).first()).toContainText('Changed');

  // Accept the change to question 2 as proposed: its version goes up.
  await page.goto('/#/reviews');
  await page.getByRole('link', { name: new RegExp(`Change to question ${perf[1].number}:`) }).click();
  await page.getByRole('button', { name: 'Accept', exact: true }).click();
  await expect(page.getByText(`Accepted. The question is now version ${perf[1].version + 1}.`)).toBeVisible();
  // Edit the change to question 3, then accept.
  await page.getByRole('link', { name: new RegExp(`Change to question ${perf[2].number}:`) }).click();
  await page.getByRole('button', { name: 'Edit, then accept…' }).click();
  await page.getByRole('dialog').getByRole('textbox', { name: /^Question/ }).fill('Final organiser wording?');
  await page.getByRole('dialog').getByLabel('Note for the reviewer (optional)').fill('Kept it a question.');
  await page.getByRole('dialog').getByRole('button', { name: 'Accept with these edits' }).click();
  await expect(page.getByText(/Accepted with your edits/)).toBeVisible();
  // Decline the new question, with a reason.
  await page.getByRole('link', { name: /New question: How do you report test progress/ }).click();
  await page.getByRole('button', { name: 'Decline…' }).click();
  await page.getByRole('dialog').getByLabel(/Reason/).fill('Covered by question 1 already.');
  await page.getByRole('dialog').getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByText(/Declined. The reviewer sees your reason/)).toBeVisible();
  // The bank has the accepted wording.
  await page.goto('/#/bank/qa');
  await expect(page.getByRole('button', { name: `${perf[1].text} Which ones would you report?` })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Final organiser wording?' })).toBeVisible();

  // The reviewer sees each outcome and its reason.
  await rp.goto('/#/to-review?tab=proposals');
  const mine = rp.getByRole('list');
  await expect(mine.getByRole('listitem').filter({ hasText: `Change to question ${perf[1].number}` })).toContainText('Accepted');
  await expect(mine.getByRole('listitem').filter({ hasText: `Change to question ${perf[2].number}` })).toContainText('Accepted with edits');
  await expect(mine.getByRole('listitem').filter({ hasText: `Change to question ${perf[2].number}` })).toContainText('Kept it a question.');
  await expect(mine.getByRole('listitem').filter({ hasText: 'New question' })).toContainText('Declined');
  await expect(mine.getByRole('listitem').filter({ hasText: 'New question' })).toContainText('Covered by question 1 already.');
  await expect(mine.getByRole('listitem').filter({ hasText: `Change to question ${perf[3].number}` })).toContainText('Out of date');
  await rctx.close();
});

test('A11Y-7 A11Y-6 REVIEW-1: the review screens pass axe in light and dark and do not scroll sideways at 390px', async ({ page }) => {
  const visits: Array<{ who: string; path: string; ready: (p: Page) => Promise<unknown> }> = [
    { who: REVIEWER, path: '/to-review', ready: (p) => p.getByRole('heading', { name: 'To review' }).waitFor() },
    { who: REVIEWER, path: '/to-review?tab=proposals', ready: (p) => p.locator('ul.rv-list').waitFor() },
    { who: ADMIN, path: '/reviews', ready: (p) => p.getByRole('heading', { name: 'Reviews' }).waitFor() },
    { who: ADMIN, path: '/reviews?tab=requests', ready: (p) => p.locator('ul.rv-list').waitFor() },
  ];
  const problems: string[] = [];
  for (const scheme of ['light', 'dark'] as const) {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 800 });
      await page.emulateMedia({ colorScheme: scheme });
      for (const v of visits) {
        await page.context().clearCookies();
        await signIn(page, v.who, v.path);
        await v.ready(page);
        const extra: Array<[string, () => Promise<void>]> = [];
        if (v.path === '/to-review') extra.push(['work-through', async () => (await page.getByRole('link', { name: /Senior QA Engineer/ }).first().click(), await page.getByRole('navigation', { name: 'Questions to review' }).waitFor())]);
        if (v.path === '/reviews?tab=requests') extra.push(['request', async () => (await page.getByRole('link', { name: /Senior QA Engineer/ }).first().click(), await page.getByRole('heading', { name: 'Progress' }).waitFor())]);
        if (v.path === '/to-review?tab=proposals') extra.push(['proposal', async () => (await page.getByRole('link', { name: /Change to question/ }).first().click(), await page.getByRole('table').waitFor())]);
        for (const [name, go] of [['list', async () => {}] as [string, () => Promise<void>], ...extra]) {
          await go();
          const tag = `${v.path} ${name} ${scheme} ${width}`;
          if (width === 1280) for (const x of await axe(page)) problems.push(`${tag}: ${x}`);
          else {
            const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
            if (over > 0) problems.push(`${tag}: scrolls sideways by ${over}px`);
          }
        }
      }
    }
  }
  expect(problems).toEqual([]);
});

test('REVIEW-7 A11Y-6: on the work-through screen the action bar never hides the end of the question list or the page, at 1280 and at 390', async ({ page, browser }) => {
  await signIn(page, ORGANISER);
  const reviewers = (await (await page.request.get('/api/reviews/reviewers')).json()) as Array<{ id: string; email: string }>;
  const remy = reviewers.find((r) => r.email === 'reviewer2@example.test')!;
  const created = await page.request.post('/api/reviews', { headers: { 'x-ia-request': '1' }, data: { trackId: 'web', scope: 'track', reviewerIds: [remy.id], note: 'Everything' } });
  const id = ((await created.json()) as { id: string }).id;
  for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 800 }]) {
    const ctx = await browser.newContext({ viewport });
    const p = await ctx.newPage();
    await signIn(p, 'reviewer2@example.test', `/to-review/${id}`);
    await expect(p.getByRole('heading', { name: /^Question \d+/ })).toBeVisible();
    for (const y of [0, 400, 100_000]) {
      await p.evaluate((top) => window.scrollTo(0, top), y);
      await p.waitForTimeout(100);
      // The last question in the list, scrolled into its box, is not under the bar.
      const covered = await p.evaluate(() => {
        const list = document.querySelector('.rv-work__list')!;
        list.scrollTop = list.scrollHeight;
        const last = list.querySelector('li:last-child')!.getBoundingClientRect();
        const box = list.getBoundingClientRect();
        const bar = document.querySelector('.rv-actions')!.getBoundingClientRect();
        const visibleBottom = Math.min(box.bottom, window.innerHeight);
        const overlaps = (r: DOMRect) => r.bottom > bar.top + 1 && r.top < bar.bottom - 1 && r.right > bar.left && r.left < bar.right;
        return { listOverlaps: overlaps(box), lastHidden: visibleBottom < last.bottom - 1 && box.bottom <= window.innerHeight };
      });
      expect(covered.listOverlaps, `${viewport.width}px at ${y}: list under the bar`).toBe(false);
    }
    // At the end of the page the bar is in its place below everything else.
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const end = await p.evaluate(() => {
      const bar = document.querySelector('.rv-actions')!.getBoundingClientRect();
      const before = (document.querySelector('.rv-actions')!.previousElementSibling as HTMLElement).getBoundingClientRect();
      return before.bottom <= bar.top + 1;
    });
    expect(end).toBe(true);
    await ctx.close();
  }
});
