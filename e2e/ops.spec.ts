// HOST-2, HOST-4, HOST-7, SEC-1, DB-2, DB-3: the running server as operations see it.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ADMIN, expect, signIn, test, uniqueEmail } from './fixtures';

const cli = (...args: string[]) => execFileSync(process.execPath, ['dist/server/cli.js', ...args], { env: { ...process.env, DATABASE_URL: process.env.E2E_DATABASE_URL }, encoding: 'utf8' });

test('HOST-7: the health check reports that the database answers', async ({ request }) => {
  const r = await request.get('/healthz');
  expect(r.status()).toBe(200);
  expect(await r.json()).toEqual({ status: 'ok', database: 'ok' });
});

test('SEC-1 HOST-2 HOST-1 PRIV-2: the app and the API come from one origin with a strict Content Security Policy header and no CORS', async ({ request, page }) => {
  const r = await request.get('/');
  const csp = r.headers()['content-security-policy'];
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(r.headers()['x-content-type-options']).toBe('nosniff');
  expect(r.headers()['x-frame-options']).toBe('DENY');
  expect(await r.text()).not.toMatch(/<script>(?!<\/script>)|http-equiv/); // no inline scripts, no meta policy
  const api = await request.get('/api/auth/options', { headers: { origin: 'https://evil.example' } });
  expect(api.headers()['access-control-allow-origin']).toBeUndefined();
  expect(api.headers()['cache-control']).toBe('no-store');
  // The real page runs under that policy without a single violation (the guard fails on console errors).
  await signIn(page, ADMIN, '/bank');
  await expect(page.getByRole('table')).toBeVisible();
});

test('DB-3 HOST-4 MVP-4: running migrate and seed again on the running installation changes nothing', () => {
  expect(cli('migrate')).toMatch(/Nothing to apply: all 2 migrations are already applied\./);
  const out = cli('seed');
  expect(out).toMatch(/Total: 0 added, 0 changed, \d+ unchanged\./);
  expect(out).toMatch(/Nothing to change\.$/m);
});

test('DB-2: db:import-questions --dry-run prints the report and writes nothing', () => {
  const out = cli('import-questions', 'seed/aks.json', 'seed/qa.json', '--dry-run');
  expect(out).toMatch(/^aks — Senior Platform Engineer \(AKS with Azure\) \(aks\.json\)/m);
  expect(out).toMatch(/^qa — Senior QA Engineer \(qa\.json\)/m);
  expect(out).toMatch(/Dry run: nothing was written\./);
});

test('HOST-7 PRIV-3: the server logs carry no emails, names, search text, question text or session tokens', async ({ page }) => {
  const email = uniqueEmail('logcheck');
  await signIn(page, ADMIN, '/users');
  await page.getByRole('button', { name: 'Add people' }).click();
  await page.getByLabel('Email addresses').fill(email);
  await page.getByRole('button', { name: 'Add person' }).click();
  await expect(page.getByRole('row').filter({ hasText: email })).toBeVisible();
  await page.getByPlaceholder('Find by name or email').fill('Jane Candidate');
  await expect(page.getByText('Nobody matches that search.')).toBeVisible();
  const token = (await page.context().cookies()).find((c) => c.name === 'ia_session')!.value;
  await page.waitForTimeout(500);
  const log = readFileSync('test-results/e2e-server.log', 'utf8');
  expect(log).toMatch(/"path":"\/api\/users"/); // the requests are logged…
  expect(log).not.toContain(email); // …without who was added,
  expect(log).not.toMatch(/Jane|Candidate/); // what was searched for,
  expect(log).not.toContain(token); // or the session.
  expect(log).not.toMatch(/@example\.test|ia_session|"cookie"|"authorization"/i);
});
