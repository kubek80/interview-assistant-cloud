// TR-1…TR-4 and AI-1…AI-12 through the real UI, served by the local helper (server/) with the
// deterministic fake Claude Code CLI (server/test/fake-claude.mjs): no network, no real model call.
// Port 4173: valid replies; 4174: replies that do not fit; 4175: slow replies (see playwright.config.ts).
import { mkdtempSync, openSync, closeSync, ftruncateSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import {
  addNote,
  downloadText,
  expect,
  finishInterview,
  continueToReady,
  openMoreOptions,
  openNewInterview,
  setupInterview,
  modal,
  moreMenu,
  openApp,
  scoreAllWithKeys,
  seed,
  startInterview,
  test,
  type Page,
  exportFromScorecard,
} from './fixtures';

const FIXTURES = fileURLToPath(new URL('../src/domain/transcript/fixtures/', import.meta.url));
const fixture = (name: string) => join(FIXTURES, name);
const SHOTS = process.env.E2E_SCREENSHOT_DIR;

/** A transcript of the four-question plan. The candidate is "Zed Quinn"; "Morgan" is a colleague mentioned. */
const TRANSCRIPT = [
  '[00:00:05] Alex Interviewer: Welcome Zed, thanks for coming in. How would you decide what to automate first?',
  '[00:00:15] Zed Quinn: I start from risk and map the critical user journeys first, then automate the stable ones.',
  '[00:01:00] Alex Interviewer: Tell me about a flaky test you fixed.',
  '[00:01:10] Zed Quinn: I quarantined the flaky checkout test and replaced a fixed sleep with an explicit wait, together with Morgan.',
  '[00:02:00] Alex Interviewer: How do you report quality to stakeholders?',
  '[00:02:10] Zed Quinn: A weekly dashboard of escaped defects, cycle time and the riskiest open areas.',
  '[00:03:00] Alex Interviewer: Thanks, that is all from me.',
].join('\n');

/** A silent mono 8 kHz 8-bit WAV of `seconds`. */
function silentWav(seconds = 10): Buffer {
  const rate = 8000;
  const n = rate * seconds;
  const b = Buffer.alloc(44 + n, 0x80);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + n, 4);
  b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24);
  b.writeUInt32LE(rate, 28);
  b.writeUInt16LE(1, 32);
  b.writeUInt16LE(8, 34);
  b.write('data', 36);
  b.writeUInt32LE(n, 40);
  return b;
}

/** Turns the AI second opinion on in Admin (AI-2). */
async function enableAi(page: Page): Promise<void> {
  await page.goto('./#/admin?tab=ai');
  await expect(page.getByRole('tab', { name: 'AI second opinion', selected: true })).toBeVisible();
  await page.getByRole('checkbox', { name: /I have read the privacy notice above/ }).check();
  await page.getByRole('button', { name: 'Turn on the AI second opinion' }).click();
  await expect(page.locator('.adm-ai__state')).toContainText('Turned on');
}

/** Setup with the "recorded or transcribed" option (TR-4), qa questions 1-4, started. Returns the session id. */
async function startRecordedInterview(page: Page, opts: { initials: string; requisitionId?: string; recorded?: boolean }): Promise<string> {
  await setupInterview(page, { pick: [1, 2, 3, 4], recording: opts.recorded !== false, candidate: { initials: opts.initials, requisitionId: opts.requisitionId } });
  return page.url().split('/').pop()!.split('?')[0];
}

/** The live interview's "Transcript & recording" dialog. */
async function openAttachments(page: Page) {
  await moreMenu(page, 'Transcript & recording…');
  const dlg = modal(page, 'Transcript and recording');
  await expect(dlg).toBeVisible();
  return dlg;
}

async function pasteTranscript(scope: ReturnType<Page['locator']>, text = TRANSCRIPT): Promise<void> {
  await scope.getByRole('button', { name: 'Paste text', exact: true }).click();
  await scope.getByLabel('Transcript text').fill(text);
  await scope.getByRole('button', { name: 'Attach pasted text' }).click();
  await expect(scope.getByRole('list', { name: 'Transcript lines' })).toBeVisible();
}

/** AI-3, AI-5: the three steps. Retries when another test's run holds the helper (it runs one at a time). */
async function runAi(page: Page, opts: { extraName?: string; shots?: string } = {}): Promise<ReturnType<typeof aiDialog>> {
  await page.getByRole('button', { name: /^Run AI second opinion/ }).first().click();
  const dlg = aiDialog(page);
  await expect(dlg.getByRole('heading', { name: /Who is speaking/ })).toBeVisible();
  // AI-5: prefilled from who says the most.
  await expect(dlg.getByRole('combobox', { name: 'Label for speaker 1' })).toHaveValue('Interviewer 1');
  await expect(dlg.getByRole('combobox', { name: 'Label for speaker 2' })).toHaveValue('Candidate');
  if (opts.extraName) {
    await dlg.getByRole('button', { name: 'Add a name to replace' }).click();
    await dlg.getByLabel('Name 1', { exact: true }).fill(opts.extraName);
    await dlg.getByLabel('Replace name 1 with').selectOption('Other speaker 1');
  }
  if (opts.shots) await shot(page, `${opts.shots}-ai-step1`);
  await dlg.getByRole('button', { name: /Next: what is sent/ }).click();
  await expect(dlg.getByRole('heading', { name: /What is sent, and where/ })).toBeVisible();
  if (opts.shots) {
    await dlg.getByText(/Show exactly the transcript that will be sent/).click();
    await shot(page, `${opts.shots}-ai-step2`);
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    await dlg.getByRole('button', { name: attempt ? 'Try again' : 'Send and run' }).click();
    const done = dlg.getByRole('heading', { name: /Done/ });
    const failed = dlg.getByRole('heading', { name: /Not completed/ });
    await expect(done.or(failed)).toBeVisible({ timeout: 30_000 });
    if (await done.isVisible()) break;
    await expect(dlg.getByText('already running')).toBeVisible();
    await page.waitForTimeout(500);
  }
  await expect(dlg.getByRole('heading', { name: /Done/ })).toBeVisible();
  if (opts.shots) await shot(page, `${opts.shots}-ai-step3-done`);
  return dlg;
}

/** The AI run dialog (nested inside the "Transcript and recording" dialog in the live interview). */
function aiDialog(page: Page) {
  return page.getByRole('dialog', { name: 'Run AI second opinion' });
}

async function shot(page: Page, name: string) {
  // A modal dialog stays at the top of the viewport, so a full-page shot would show it cut off.
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: (await page.locator('dialog[open]').count()) === 0 });
}

/** Rows of the IndexedDB attachment tables (read only, to check deletion: never used to drive the app). */
async function storedCounts(page: Page): Promise<Record<string, number>> {
  return page.evaluate(
    () =>
      new Promise<Record<string, number>>((resolve, reject) => {
        const req = indexedDB.open('interview-assistant');
        req.onerror = () => reject(req.error);
        req.onsuccess = () => {
          const idb = req.result;
          const names = ['transcripts', 'recordings', 'aiResults'];
          const tx = idb.transaction(names, 'readonly');
          const out: Record<string, number> = {};
          let left = names.length;
          for (const n of names) {
            const c = tx.objectStore(n).count();
            c.onsuccess = () => {
              out[n] = c.result;
              if (--left === 0) {
                idb.close();
                resolve(out);
              }
            };
          }
        };
      }),
  );
}

async function axe(page: Page, label: string, failures: string[]) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  for (const v of result.violations) {
    if (v.impact === 'serious' || v.impact === 'critical') failures.push(`${label}: ${v.id} ${v.help} → ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
  }
}

test.describe('Transcripts and recordings', () => {
  test('TR-4 PRIV-4 FLOW-7: "recorded or transcribed" is chosen under More options; the ready screen adds the docs sentence to the consent text and the confirmation covers it; the choice is remembered, also for reused questions', async ({ page }) => {
    const SENTENCE = 'This interview is being recorded or transcribed. The transcript may be analysed by an AI tool to give your interviewers a second opinion; people still make every rating and the decision.';
    await openApp(page);
    await openNewInterview(page, 'qa');
    await openMoreOptions(page);
    const option = page.getByRole('checkbox', { name: 'This interview will be recorded or transcribed' });
    await expect(option).not.toBeChecked(); // off by default
    await option.check();
    await expect(page.locator('.ni-more__summary')).toContainText('recorded or transcribed');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('rc');
    await continueToReady(page);
    await expect(page.locator('.consent__text')).toContainText(SENTENCE);
    const told = page.getByRole('checkbox', { name: /including that the interview is recorded or transcribed/ });
    await expect(told).toBeVisible();
    await startInterview(page);
    // Told at setup: a transcript can be attached straight away (no late notice).
    let dlg = await openAttachments(page);
    await expect(dlg).not.toContainText('The candidate was not told');
    await page.keyboard.press('Escape');

    // Remembered on this device, for a new set and for the same questions again.
    await page.goto('./');
    await openNewInterview(page, 'qa');
    await openMoreOptions(page);
    await expect(page.getByRole('checkbox', { name: 'This interview will be recorded or transcribed' })).toBeChecked();
    await page.getByRole('checkbox', { name: 'This interview will be recorded or transcribed' }).uncheck();
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('NR');
    await continueToReady(page);
    await expect(page.locator('.consent__text')).not.toContainText(SENTENCE);
    await startInterview(page);
    dlg = await openAttachments(page);
    await expect(dlg).toContainText('The candidate was not told');
    await page.keyboard.press('Escape');
    await page.goto('./');
    await page.locator('section[aria-labelledby="dash-sets"]').getByRole('link', { name: /^Reuse/ }).first().click();
    await expect(page.locator('.ni-set__mix')).toContainText('The same questions as');
    await openMoreOptions(page);
    await expect(page.getByRole('checkbox', { name: 'This interview will be recorded or transcribed' })).not.toBeChecked();
  });

  test('TR-1 TR-3: a transcript is attached by paste and from .txt, .vtt (Teams and Zoom), .srt and .docx files, shown read-only with line numbers, speakers, timestamps and search, replaced and removed with confirmation; audited without content', async ({ page }) => {
    await openApp(page);
    const sessionId = await startRecordedInterview(page, { initials: 'TX' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    const lines = dlg.getByRole('list', { name: 'Transcript lines' });
    await expect(lines.locator('li')).toHaveCount(7);
    await expect(lines.locator('li').nth(1)).toContainText('2');
    await expect(lines.locator('li').nth(1)).toContainText('00:00:15');
    await expect(lines.locator('li').nth(1)).toContainText('Zed Quinn:');
    await expect(dlg).toContainText('speakers Alex Interviewer, Zed Quinn');
    // Search.
    await dlg.getByRole('searchbox', { name: 'Search the transcript' }).fill('flaky');
    await expect(dlg.getByText('2 matching lines')).toBeVisible();
    await expect(lines.locator('mark').first()).toHaveText('flaky');
    await dlg.getByRole('searchbox', { name: 'Search the transcript' }).fill('');

    // Replace with each file format (TR-1), confirming each replacement.
    const files: Array<[string, RegExp]> = [
      ['plain.txt', /Plain text/],
      ['teams.vtt', /WebVTT/],
      ['zoom.vtt', /WebVTT/],
      ['sample.srt', /SubRip/],
      ['teams-new.docx', /Word/],
      ['teams-old.docx', /Word/],
      ['teams-paste.txt', /Plain text/],
    ];
    for (const [name, format] of files) {
      await dlg.getByRole('button', { name: 'Replace…' }).click();
      await dlg.getByLabel('Transcript file').setInputFiles(fixture(name));
      const confirm = page.getByRole('alertdialog', { name: 'Replace the transcript?' });
      await confirm.getByRole('button', { name: 'Replace transcript', exact: true }).click();
      await expect(dlg.locator('.tp-meta')).toContainText(format);
      await expect(lines.locator('li').first()).toBeVisible();
    }
    await expect(dlg.locator('.tp-meta')).toContainText('Priya Natarajan');

    // A parse error is shown in plain words and nothing changes.
    await dlg.getByRole('button', { name: 'Replace…' }).click();
    await dlg.getByLabel('Transcript file').setInputFiles({ name: 'notes.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(dlg.getByRole('alert')).toContainText('.pdf files are not supported');
    await dlg.getByRole('button', { name: 'Keep the current transcript' }).click();
    await expect(dlg.locator('.tp-meta')).toContainText('Plain text');

    // Remove, with confirmation.
    await dlg.getByRole('button', { name: 'Remove transcript…' }).click();
    await page.getByRole('alertdialog', { name: 'Remove the transcript?' }).getByRole('button', { name: 'Remove transcript', exact: true }).click();
    await expect(dlg.getByRole('button', { name: 'Choose a transcript file…' })).toBeVisible();

    // TR-3: attach/replace/remove are in the audit log, without the content.
    await page.keyboard.press('Escape');
    await page.goto('./#/admin?tab=audit');
    const csv = await downloadText(page, () => page.getByRole('button', { name: 'Export CSV' }).click());
    expect(csv.text).toContain(`transcript.attached,session,${sessionId}`);
    expect((csv.text.match(/transcript\.replaced/g) ?? []).length).toBe(7);
    expect(csv.text).toContain('transcript.removed');
    for (const s of ['Zed Quinn', 'critical user journeys', 'Priya', 'flaky']) expect(csv.text).not.toContain(s);
  });

  test('TR-4 AUD-2: when the option was off, attaching first asks to confirm the candidate has since been told; the time is stored and audited', async ({ page }) => {
    await openApp(page);
    await startRecordedInterview(page, { initials: 'LT', recorded: false });
    const dlg = await openAttachments(page);
    await expect(dlg).toContainText('The candidate was not told this interview is recorded or transcribed');
    await expect(dlg.locator('.consent__text')).toContainText('This interview is being recorded or transcribed.');
    await expect(dlg.getByRole('button', { name: 'Choose a transcript file…' })).toBeDisabled();
    await expect(dlg.getByRole('button', { name: 'Choose a recording…' })).toBeDisabled();
    await dlg.getByRole('button', { name: 'Confirm and continue' }).click();
    await expect(dlg.getByRole('alert')).toContainText('Tick the box');
    await dlg.getByRole('checkbox', { name: /has since been told/ }).check();
    await dlg.getByRole('button', { name: 'Confirm and continue' }).click();
    await expect(dlg.getByText('The candidate was not told')).toHaveCount(0);
    await pasteTranscript(dlg);
    await page.keyboard.press('Escape');
    await page.goto('./#/admin?tab=audit');
    await expect(page.locator('main')).toContainText('Candidate told of recording (confirmed later)');
  });

  test('TR-2: a recording is attached for playback on this device (size shown, warning above 200 MB), a transcript timestamp seeks it, and it is removed; it is never sent anywhere', async ({ page, guard }) => {
    await openApp(page);
    await startRecordedInterview(page, { initials: 'RE' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await expect(dlg).toContainText('never sent anywhere');
    await expect(dlg).toContainText('not transcribed');

    // Above 200 MB: a warning first; cancelling stores nothing. (A sparse file: nothing is read.)
    const dir = mkdtempSync(join(tmpdir(), 'ia-e2e-'));
    const big = join(dir, 'long interview.wav');
    const fd = openSync(big, 'w');
    ftruncateSync(fd, 201 * 1024 * 1024);
    closeSync(fd);
    await dlg.getByLabel('Recording file').setInputFiles(big);
    const warn = page.getByRole('alertdialog', { name: 'Store a large recording?' });
    await expect(warn).toContainText('201.0 MB, more than 200.0 MB');
    await warn.getByRole('button', { name: 'Cancel' }).click();
    await expect(dlg.locator('audio')).toHaveCount(0);

    await dlg.getByLabel('Recording file').setInputFiles({ name: 'interview.wav', mimeType: 'audio/wav', buffer: silentWav(10) });
    const audio = dlg.locator('audio');
    await expect(audio).toHaveAttribute('src', /^blob:/);
    await expect(dlg).toContainText('interview.wav · 78.2 KB · audio/wav');
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.readyState)).toBeGreaterThan(0);
    await dlg.getByRole('button', { name: 'Play the recording from 00:00:05' }).click();
    await expect.poll(() => audio.evaluate((a: HTMLAudioElement) => a.currentTime)).toBeGreaterThanOrEqual(4.9);

    // The page reload plays it back from IndexedDB.
    await page.reload();
    const again = await openAttachments(page);
    await expect(again.locator('audio')).toHaveAttribute('src', /^blob:/);
    await again.getByRole('button', { name: 'Remove recording…' }).click();
    await page.getByRole('alertdialog', { name: 'Remove the recording?' }).getByRole('button', { name: 'Remove recording', exact: true }).click();
    await expect(again.locator('audio')).toHaveCount(0);
    await expect(again.getByRole('button', { name: 'Choose a recording…' })).toBeVisible();
    // Nothing was uploaded: no request carried a body.
    expect(guard.requests.filter((u) => /api\//.test(u))).toEqual([]);
  });
});

test.describe('AI second opinion', () => {
  // The helper runs one AI request at a time: keep this file's runs in one worker, in order.
  test.describe.configure({ mode: 'default' });

  test('AI-2 AI-1: off by default (nothing is requested); Admin shows the privacy notice and needs an acknowledgement; the helper status is shown', async ({ page, guard }) => {
    await openApp(page);
    await startRecordedInterview(page, { initials: 'OF' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await expect(dlg).toContainText('The AI second opinion is turned off on this device');
    await expect(dlg.getByRole('button', { name: /Run AI second opinion/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(guard.requests.filter((u) => /\/api\//.test(u)), 'no helper request while the feature is off').toEqual([]);

    await page.goto('./#/admin?tab=ai');
    const main = page.locator('main');
    await expect(main.getByText('Off', { exact: true })).toBeVisible();
    await expect(main.getByRole('heading', { name: 'Privacy notice for AI and transcripts' })).toBeVisible();
    await expect(main).toContainText('The transcript leaves this device when the AI second opinion is run');
    await expect(main).toContainText('APP 1.7-1.9');
    await page.getByRole('button', { name: 'Turn on the AI second opinion' }).click();
    await expect(page.getByRole('alert')).toContainText('Tick the box');
    await expect(main.getByText('Off', { exact: true })).toBeVisible();
    await page.getByRole('checkbox', { name: /I have read the privacy notice above/ }).check();
    await page.getByRole('button', { name: 'Turn on the AI second opinion' }).click();
    await expect(main.getByText('On', { exact: true })).toBeVisible();
    await expect(main.getByRole('status').filter({ hasText: 'Ready.' })).toContainText('Claude Code 2.1.999');
    await expect(main).toContainText('Claude Code’s default');
    await page.goto('./#/admin?tab=audit');
    await expect(page.locator('main')).toContainText('AI second opinion turned on');
  });

  test('AI-3 AI-5 AI-6 AI-7 AI-8 AI-9 AI-10 AI-11 AI-12 OV-4: run before submit shows only "ready"; after submit a labelled section with comparison, worth-discussing list and verified quotations; human figures unchanged; nothing identifying is sent', async ({
    page,
  }) => {
    test.setTimeout(150_000);
    await openApp(page, 'Alex Interviewer');
    await enableAi(page);
    await page.goto('./');
    const sessionId = await startRecordedInterview(page, { initials: 'ZQ', requisitionId: 'REQ-ZZ-91' });
    const bodies: string[] = [];
    page.on('request', (r) => {
      if (r.url().endsWith('api/ai/second-opinion')) bodies.push(r.postData() ?? '');
    });

    // AI-9: run during the interview: only "ready" is shown, never a score.
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    const run = await runAi(page, { extraName: 'Morgan', shots: 'transcripts' });
    await expect(run).toContainText('AI second opinion is ready — shown after you submit.');
    await run.getByRole('button', { name: 'Close' }).last().click();
    await expect(dlg.getByRole('status').filter({ hasText: 'AI second opinion is ready — shown after you submit.' })).toBeVisible();
    for (const hidden of ['Fake rationale', 'Worth discussing', 'Not covered']) expect(await page.content()).not.toContain(hidden);
    await shot(page, 'transcripts-live-dialog-ready');
    await page.keyboard.press('Escape');

    // AI-5: what was sent. No initials, requisition id, interviewer names, notes or human scores.
    expect(bodies).toHaveLength(1);
    const body = JSON.parse(bodies[0]);
    expect(Object.keys(body).sort()).toEqual(['questions', 'transcript', 'version']);
    expect(body.transcript.speakers).toEqual(['Interviewer 1', 'Candidate']);
    expect(body.transcript.text).toContain('[00:00:15] Candidate: I start from risk');
    expect(body.transcript.text).toContain('Welcome Candidate');
    expect(body.transcript.text).toContain('together with Other speaker 1');
    for (const forbidden of [/\bZQ\b/, /REQ-ZZ-91/, /Alex/, /Interviewer\b(?! \d)/, /Zed/, /Quinn/, /Morgan/, /NOTE-SECRET/, /RATIONALE-SECRET/, /coveredKeyPoints|redFlagsSeen|"notes"|"overall"|recommendation/]) {
      expect(bodies[0]).not.toMatch(forbidden);
    }
    for (const q of body.questions) expect(Object.keys(q).sort()).toEqual(['description', 'id', 'keyPoints', 'probes', 'redFlags', 'rubric', 'text']);
    // The only scores sent are the rubric's level numbers (1-4), never a human score.
    expect(JSON.stringify(body.questions.map((q: { rubric: unknown }) => ({ ...q, rubric: null })))).not.toMatch(/score/i);

    // Score (all 2), note, finish.
    await addNote(page, 'NOTE-SECRET-1234 on question one');
    await scoreAllWithKeys(page, 2, 4);
    await finishInterview(page, { rating: 2, recommendation: 'Lean no hire', rationale: 'RATIONALE-SECRET-77' });
    expect(bodies).toHaveLength(1);

    // AI-11: the labelled section beside the human figures.
    const humanFigures = async () => ({
      overall: await page.locator('.sc-summary .sc-big').innerText(),
      band: await page.locator('.sc-summary').getByText(/Advisory/).first().innerText(),
      decision: await page.locator('.sc-decision').innerText(),
      scores: await page.locator('.sc-questions tbody tr td:nth-child(6)').allInnerTexts(),
    });
    const before = await humanFigures();
    expect(before.scores).toEqual(['2 Partial', '2 Partial', '2 Partial', '2 Partial'].map((s) => expect.stringContaining(s.split(' ')[0])) as unknown as string[]);
    const ai = page.locator('.sc-ai');
    await expect(page.getByRole('heading', { level: 2, name: /AI second opinion\s*not a decision/ })).toBeVisible();
    await expect(ai).toContainText('fake-claude-model');
    await expect(ai).toContainText('not a decision');
    // AI-7: its own overall and band, beside the interviewers' (AI scored 3, 2, 4 and not covered).
    const figures = ai.getByRole('table', { name: /side by side/ });
    // Independent calculation with the SCORE-1/2/3/6 maths from the seed: AI scores 3, 2, 4 and "not covered".
    const qa = seed('qa');
    const w = [1, 2, 3, 4].map((n) => {
      const q = qa.questions.find((x) => x.number === n)!;
      return { core: 1, advanced: 1.5, expert: 2 }[q.difficulty] * qa.categories.find((c) => c.id === q.categoryId)!.weight;
    });
    const v = [2 / 3, 1 / 3, 1];
    const aiPct = Math.round(((w[0] * v[0] + w[1] * v[1] + w[2] * v[2]) / (w[0] + w[1] + w[2])) * 100);
    const aiCoverage = Math.round(((w[0] + w[1] + w[2]) / (w[0] + w[1] + w[2] + w[3])) * 100);
    await expect(figures.getByRole('row', { name: /Overall/ })).toContainText(`${before.overall}${aiPct}%`);
    await expect(figures.getByRole('row', { name: /Coverage/ })).toContainText(`100%${aiCoverage}%`);
    // Per question: human, AI or "Not covered", difference; the AI column on the question table too.
    const perQ = ai.getByRole('table', { name: /score for each question/ });
    await expect(perQ.locator('tbody tr').nth(0)).toContainText('+1');
    await expect(perQ.locator('tbody tr').nth(2)).toContainText('+2');
    await expect(perQ.locator('tbody tr').nth(3)).toContainText('Not covered');
    await expect(page.locator('.sc-questions thead')).toContainText('AI second opinion');
    // Worth discussing (difference >= 2) with the AI's evidence and an amend link (AI-12).
    const discuss = ai.locator('.sc-ai__discuss-item');
    await expect(discuss).toHaveCount(1);
    await expect(discuss).toContainText('Interviewers 2 · AI second opinion 4 (+2)');
    await expect(discuss).toContainText('Fake rationale for question 3.');
    await expect(discuss.getByText('Verified')).toBeVisible();
    await expect(page.getByRole('button', { name: /accept/i })).toHaveCount(0);
    // Verified quotations, whose words, and a jump to the transcript line.
    await ai.locator('details').first().locator('summary').click();
    await expect(ai.locator('details').first()).toContainText('Candidate');
    await ai.locator('details').first().getByRole('button', { name: /^Line \d+$/ }).click();
    await expect(page.locator('.tv-line--focus')).toBeVisible();
    await expect(page.locator('.tv-line--focus')).toBeFocused();
    await shot(page, 'transcripts-scorecard-ai');

    // AI-8, AI-10: running again replaces the result and changes no human figure.
    await page.locator('section[aria-labelledby="sc-transcript-h"]').getByRole('button', { name: 'Run AI second opinion again…' }).click();
    const again = aiDialog(page);
    await again.getByRole('button', { name: /Next: what is sent/ }).click();
    await again.getByRole('button', { name: 'Send and run' }).click();
    await expect(again).toContainText('The AI second opinion is ready.');
    await again.getByRole('button', { name: 'Close' }).last().click();
    expect(await humanFigures()).toEqual(before);
    // A changed transcript marks it out of date.
    const tsec = page.locator('section[aria-labelledby="sc-transcript-h"]');
    await tsec.getByRole('button', { name: 'Replace…' }).click();
    await tsec.getByRole('button', { name: 'Paste text', exact: true }).click();
    await tsec.getByLabel('Transcript text').fill(TRANSCRIPT + '\n[00:04:00] Zed Quinn: One more thing about monitoring.');
    await tsec.getByRole('button', { name: 'Attach pasted text' }).click();
    await page.getByRole('alertdialog', { name: 'Replace the transcript?' }).getByRole('button', { name: 'Replace transcript', exact: true }).click();
    await expect(ai.getByText('Out of date: the transcript has changed since this was run.')).toBeVisible();
    expect(await humanFigures()).toEqual(before);

    // AI-11: exports carry it under the same label; the session file does not.
    const md = await exportFromScorecard(page, 'Markdown');
    expect(md.text).toContain('## AI second opinion (fake-claude-model), not a decision');
    expect(md.text).toContain('**Out of date:**');
    expect(md.text).toContain('Worth discussing');
    const csv = await exportFromScorecard(page, 'CSV, one row per question');
    expect(csv.text.split('\r\n')[0]).toContain('AI second opinion: score');
    const file = await exportFromScorecard(page, 'Interview file for the debrief');
    for (const s of ['fake-claude-model', 'Fake rationale', 'Zed Quinn', 'critical user journeys', '"transcript', 'aiResult']) expect(file.text).not.toContain(s);

    // AI-10: the debrief shows it as its own column; the panel median is the human figure.
    await page.goto(`./#/debrief/${sessionId}`);
    await expect(page.locator('.dbf-figure').first()).toContainText(before.overall);
    await expect(page.locator('.dbf-ai')).toContainText('fake-claude-model');
    await expect(page.locator('.dbf-ai')).toContainText('Not counted in the panel median or spread');
    await expect(page.getByRole('table', { name: /Average score/ }).locator('thead')).toContainText('AI second opinion');
    await shot(page, 'transcripts-debrief');

    // AI-12: "Amend" from a difference opens the usual amend step for that question (reason required).
    await page.goto(`./#/scorecard/${sessionId}`);
    await page.locator('.sc-ai__discuss-item').getByRole('link', { name: /Amend Q3/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'Live interview' })).toBeVisible();
    await expect(page.locator('#question-heading')).toContainText('Question 3');
    await expect(page.locator('.amend-form')).toBeVisible();
    // Nothing is pre-filled from the AI: the interviewers' 2 is still selected.
    await expect(page.locator('.amend-form input[type=radio][value="2"]')).toBeChecked();
    await expect(page.locator('.amend-form input[type=radio][value="4"]')).not.toBeChecked();

    // AI-3: each run is in the audit log, with the model and number of questions, never the content.
    await page.goto('./#/admin?tab=audit');
    const log = await downloadText(page, () => page.getByRole('button', { name: 'Export CSV' }).click());
    const runs = log.text.split('\r\n').filter((l) => l.includes(',ai.run,'));
    expect(runs).toHaveLength(2);
    expect(runs[0]).toContain('fake-claude-model');
    expect(runs[0]).toMatch(/""questions"":4/);
    for (const s of ['Fake rationale', 'Zed', 'critical user journeys', 'I start from risk']) expect(log.text).not.toContain(s);
  });

  test('TR-3 PRIV-6 PRIV-5: a deletion request and the retention purge remove the transcript, recording and AI result; the access request includes the transcript and offers the recording', async ({ page }) => {
    await openApp(page, 'Pat Privacy');
    await enableAi(page);
    const today = await page.evaluate(() => {
      const d = new Date();
      const p = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
    });
    const attachAll = async (initials: string, retentionUntil?: string) => {
      await page.goto('./');
      await setupInterview(page, { pick: [1, 2, 3, 4], recording: true, candidate: { initials, requisitionId: `R-${initials}`, retentionUntil } });
      const dlg = await openAttachments(page);
      await pasteTranscript(dlg);
      await dlg.getByLabel('Recording file').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: silentWav(1) });
      await expect(dlg.locator('audio')).toBeVisible();
      await runAi(page);
      await aiDialog(page).getByRole('button', { name: 'Close' }).last().click();
      await page.keyboard.press('Escape');
    };
    await attachAll('DL');
    await attachAll('PU', today);
    expect(await storedCounts(page)).toEqual({ transcripts: 2, recordings: 2, aiResults: 2 });

    // Access request: the transcript is in the file; the recording is a separate download.
    await page.goto('./#/admin?tab=privacy');
    await page.getByRole('textbox', { name: 'Candidate', exact: true }).fill('DL');
    await page.getByLabel('Requisition id').fill('R-DL');
    const access = await downloadText(page, async () => {
      await page.getByRole('button', { name: 'Export everything (access request)' }).click();
      await modal(page, 'Export everything for this candidate?').getByRole('button', { name: 'Export' }).click();
    });
    const data = JSON.parse(access.text);
    expect(data.sessions[0].transcript.text).toContain('Zed Quinn: I start from risk');
    expect(data.sessions[0].recording).toMatchObject({ held: true, type: 'audio/wav' });
    expect(data.sessions[0].aiSecondOpinion.model).toBe('fake-claude-model');
    const [rec] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download recording 1' }).click()]);
    expect(rec.suggestedFilename()).toMatch(/^interview-recording-[0-9a-f]{8}\.wav$/);

    // Deletion request.
    await page.getByRole('button', { name: 'Delete everything (deletion request)' }).click();
    await modal(page, 'Delete everything for this candidate?').getByRole('button', { name: /^Delete 1 interview/ }).click();
    await expect(page.getByText(/Deletion request: deleted 1 interview/)).toBeVisible();
    expect(await storedCounts(page)).toEqual({ transcripts: 1, recordings: 1, aiResults: 1 });

    // Retention purge two days later.
    const later = new Date(`${today}T12:00:00`);
    later.setDate(later.getDate() + 2);
    await page.clock.install({ time: later });
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: 'Admin' })).toBeVisible();
    await expect.poll(() => storedCounts(page)).toEqual({ transcripts: 0, recordings: 0, aiResults: 0 });
  });

  test('AI-1 OV-1: without the helper the AI controls say why, nothing is requested from the missing API, and everything else works', async ({ page, guard }) => {
    // As on a static copy of the app: the page is served without the helper's marker.
    await page.route(
      (url) => url.pathname === '/',
      (route) => (route.request().method() === 'HEAD' ? route.fulfill({ status: 200, headers: { 'content-type': 'text/html' } }) : route.continue()),
    );
    await openApp(page);
    await enableAi(page);
    await expect(page.getByRole('status').filter({ hasText: 'Unavailable.' })).toContainText('npm start');
    await page.goto('./');
    await startRecordedInterview(page, { initials: 'NH' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await expect(dlg).toContainText('The AI helper is not running. Start the app with npm start on this computer');
    await expect(dlg.getByRole('button', { name: /Run AI second opinion/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await scoreAllWithKeys(page, 3, 4);
    await finishInterview(page, { rating: 3, recommendation: 'Hire', rationale: 'Works without the helper.' });
    await expect(page.locator('section[aria-labelledby="sc-ai-h"]')).toContainText('The AI helper is not running');
    expect(guard.requests.filter((u) => /\/api\//.test(u))).toEqual([]);
  });

  test('A11Y-7 A11Y-6 TR-1 AI-3: the attach panel, transcript viewer, the three run steps, the scorecard AI section, the debrief and Admin AI pass axe in light and dark and fit 390px', async ({ page }) => {
    test.setTimeout(180_000);
    await openApp(page, 'Alex Interviewer');
    await enableAi(page);
    await page.goto('./');
    const sessionId = await startRecordedInterview(page, { initials: 'AX' });
    let dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await dlg.getByLabel('Recording file').setInputFiles({ name: 'a.wav', mimeType: 'audio/wav', buffer: silentWav(2) });
    await page.keyboard.press('Escape');
    await scoreAllWithKeys(page, 2, 4);
    await finishInterview(page, { rating: 2, recommendation: 'No hire', rationale: 'Checked for accessibility.' });
    await page.locator('section[aria-labelledby="sc-transcript-h"]').getByRole('button', { name: 'Run AI second opinion…' }).click();
    dlg = aiDialog(page);
    await dlg.getByRole('button', { name: /Next: what is sent/ }).click();
    await dlg.getByRole('button', { name: 'Send and run' }).click();
    await expect(dlg.getByRole('heading', { name: /Done/ })).toBeVisible({ timeout: 30_000 });
    await dlg.getByRole('button', { name: 'Close' }).last().click();

    const states: Array<{ name: string; path: string; act?: () => Promise<void> }> = [
      { name: 'live-attach-dialog', path: `interview/${sessionId}`, act: async () => void (await openAttachments(page)) },
      {
        name: 'live-attach-paste',
        path: `interview/${sessionId}`,
        act: async () => {
          const d = await openAttachments(page);
          await d.getByRole('button', { name: 'Replace…' }).click();
          await d.getByRole('button', { name: 'Paste text', exact: true }).click();
        },
      },
      {
        name: 'scorecard-ai',
        path: `scorecard/${sessionId}`,
        act: async () => {
          for (const s of await page.locator('.sc-ai details summary').all()) await s.click();
        },
      },
      {
        name: 'ai-step1',
        path: `scorecard/${sessionId}`,
        act: async () => {
          await page.locator('section[aria-labelledby="sc-transcript-h"]').getByRole('button', { name: /Run AI second opinion/ }).click();
          await aiDialog(page).getByRole('button', { name: 'Add a name to replace' }).click();
        },
      },
      {
        name: 'ai-step2',
        path: `scorecard/${sessionId}`,
        act: async () => {
          await page.locator('section[aria-labelledby="sc-transcript-h"]').getByRole('button', { name: /Run AI second opinion/ }).click();
          const d = aiDialog(page);
          await d.getByRole('button', { name: /Next: what is sent/ }).click();
          await d.getByText(/Show exactly the transcript/).click();
          await d.getByText(/Show the questions/).click();
        },
      },
      { name: 'debrief-ai', path: `debrief/${sessionId}` },
      { name: 'admin-ai', path: 'admin?tab=ai' },
    ];
    const failures: string[] = [];
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        for (const s of states) {
          await page.goto('about:blank');
          await page.goto(`./#/${s.path}`);
          await expect(page.locator('h1').first()).toBeVisible();
          await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
          if (s.act) await s.act();
          await page.waitForTimeout(100);
          await axe(page, `${scheme} ${width} ${s.name}`, failures);
          const wide = await page.evaluate(() => {
            const el = document.scrollingElement ?? document.documentElement;
            return el.scrollWidth > el.clientWidth;
          });
          if (wide) failures.push(`${scheme} ${width} ${s.name}: horizontal scroll`);
          await shot(page, `transcripts-${scheme}-${width}-${s.name}`);
        }
      }
    }
    expect(failures).toEqual([]);
  });
});

test.describe('AI second opinion: replies that do not fit', () => {
  test.use({ baseURL: 'http://localhost:4174/' });

  test('AI-6 AI-3: an invalid model reply is shown as an error and nothing is stored; the failed run is audited', async ({ page, guard }) => {
    // The helper answers this error with HTTP 502, which the browser itself logs; the app logs nothing.
    guard.allowErrors(/Failed to load resource: the server responded with a status of 502/);
    await openApp(page);
    await enableAi(page);
    await page.goto('./');
    await startRecordedInterview(page, { initials: 'IV' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await page.getByRole('button', { name: 'Run AI second opinion…' }).click();
    const run = aiDialog(page);
    await run.getByRole('button', { name: /Next: what is sent/ }).click();
    await run.getByRole('button', { name: 'Send and run' }).click();
    await expect(run.getByRole('alert')).toContainText('The AI reply was not in the expected format, so it was discarded.');
    await expect(run.getByRole('alert')).toContainText('Nothing was stored.');
    await run.getByRole('button', { name: 'Close' }).last().click();
    await expect(dlg.getByText('AI second opinion is ready')).toHaveCount(0);
    expect(await storedCounts(page)).toEqual({ transcripts: 1, recordings: 0, aiResults: 0 });
    await page.keyboard.press('Escape');
    await page.goto('./#/admin?tab=audit');
    await expect(page.locator('main')).toContainText('AI second opinion run failed');
  });
});

test.describe('AI second opinion: a slow reply', () => {
  test.use({ baseURL: 'http://localhost:4175/' });

  test('AI-3: a run shows its progress and can be cancelled; nothing is stored', async ({ page }) => {
    await openApp(page);
    await enableAi(page);
    await page.goto('./');
    await startRecordedInterview(page, { initials: 'SL' });
    const dlg = await openAttachments(page);
    await pasteTranscript(dlg);
    await page.getByRole('button', { name: 'Run AI second opinion…' }).click();
    const run = aiDialog(page);
    await run.getByRole('button', { name: /Next: what is sent/ }).click();
    await run.getByRole('button', { name: 'Send and run' }).click();
    await expect(run.getByRole('heading', { name: /Running/ })).toBeVisible();
    await expect(run.locator('progress')).toBeVisible();
    await expect(run.getByText(/0:0[1-9] elapsed/)).toBeVisible();
    await shot(page, 'transcripts-ai-step3-running');
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const failures: string[] = [];
      await axe(page, `${scheme} running`, failures);
      expect(failures).toEqual([]);
    }
    await run.getByRole('button', { name: 'Cancel the run' }).click();
    await expect(run.getByRole('alert')).toContainText('Cancelled. Nothing was stored.');
    expect(await storedCounts(page)).toEqual({ transcripts: 1, recordings: 0, aiResults: 0 });
  });
});

// Keep the fixture import used (the docx fixtures are binary; read here only to check they exist).
test('TR-1: the transcript fixtures used above are present', () => {
  for (const f of ['plain.txt', 'teams.vtt', 'zoom.vtt', 'sample.srt', 'teams-new.docx', 'teams-old.docx', 'teams-paste.txt']) expect(readFileSync(fixture(f)).length).toBeGreaterThan(0);
});
