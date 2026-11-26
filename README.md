# Interview Assistant (hosted)

Interview Assistant runs structured interviews: vetted questions, one 1-4 rating scale, key-point checkboxes, independent scoring by each interviewer and a weighted scorecard. This repository is the **hosted version**: a web application with a server and a PostgreSQL database on Google Cloud, so a company can use it together. People sign in with Google (invited people only); hiring rounds have their own teams; panel members interview together, each scoring their own record live.

The **local app** (the MVP pilot: a single-page app with no server, data in the browser, panels exchanging files) lives in its own repository, `interview-assistant`, and is unchanged. This repository started as a copy of it.

**Status: step 1 of 3 is built.**

1. **Foundation (built):** server, database schema and migrations for the whole data model, Google sign-in and sessions, users and roles with the Users page, the question bank in the database (API, import scripts, the bank screens), **question reviewers and the review workflow** (proposals, comments, review requests: `REVIEW-1` to `REVIEW-7`), the audit log, configuration, Dockerfile, CI, deployment guide, development and test tooling.
2. **Next:** hiring rounds, planning, interviewing together live, scorecards, debrief and decision, summary. Until then those screens say "Coming in the next step".
3. **Later:** transcripts, recordings and AI on the server, importing local-app files, the retention job, privacy requests, final verification.

## Documentation is the specification

The pages in [`docs/`](docs/) are the specification; each numbered requirement (for example `AUTH-2`) is something the app must do. [`docs/13-hosted-version.md`](docs/13-hosted-version.md) specifies what is different in the hosted version and wins where pages disagree. The pages are bundled into the app under **Docs**.

[`docs/10-verification.md`](docs/10-verification.md) lists every requirement id with how it is checked and its status. A unit test (`src/docs/traceability.test.ts`) fails if an id is missing from that page, if the page names an id that does not exist, or if it cites a test file that does not exist or has no test mentioning the id. Ids for steps 2 and 3 are on that test's `NOT_BUILT_YET` list; remove an id from the list when you build it.

## Architecture

```
browser (React, Vite build, hash routes)  ──HTTPS, same origin──▶  server (Node 22, Fastify, TypeScript)  ──▶  PostgreSQL 16
  src/db: typed API client, TanStack Query cache, live updates      auth/   Google OIDC (openid-client), sessions in PostgreSQL
                                                                     authz/  policy.ts: every permission, in one place
  src/domain, src/shared: pure code used by both  ◀────────────────  users/, bank/, audit/, settings/: JSON API under /api (zod)
                                                                     live/   Server-Sent Events fed by PostgreSQL LISTEN/NOTIFY
                                                                     db/     Kysely over pg; numbered SQL migrations
```

- **One origin.** The server serves the built browser app and the API, sends the security headers and the Content Security Policy (`SEC-1`), and has no CORS. Sign-in is a server-side redirect to Google; the session is an HttpOnly cookie (`AUTH-4`).
- **Several instances.** Nothing is kept in memory between requests: sessions are looked up in PostgreSQL on every request, and live updates go through `pg_notify`, so any instance can publish and every instance delivers (`HOST-5`).
- **Shared pure code.** `src/domain` (scoring, rubric, plans, validation, bank rules, CSV) and `src/shared` (API types) are imported by the browser and the server with relative paths; Vite bundles them into both builds and Vitest runs them as they are.

## Development quick start

Needs Node.js 22.12 or later and PostgreSQL 16 binaries (no Docker, no Google account).

```sh
npm install                 # .npmrc sets ignore-scripts: dependencies run no install scripts
npm run db:start            # a throwaway local PostgreSQL in .dev-db/ on port 54329 (scripts/dev-db.sh)
cp .env.example .env        # development settings: development sign-in on, admin@example.test is an administrator
export DATABASE_URL=postgres://ia@127.0.0.1:54329/ia_dev
npm run db:migrate          # create the tables
npm run db:seed             # import the four bundled tracks (207 questions)
npm run db:dev-users        # optional: organiser@, interviewer@ and reviewer@example.test
npm run dev                 # API on :8080 and Vite on :5173; open http://localhost:5173
```

Sign in with **Development sign-in** as `admin@example.test` (it is in `BOOTSTRAP_ADMINS`, so it is created on first sign-in), or as anyone on the Users page. `npm run db:stop` stops the database; `sh scripts/dev-db.sh reset` starts again from nothing.

`scripts/dev-db.sh` finds the PostgreSQL binaries on your `PATH`, in `$PG_BIN`, or in `/usr/lib/postgresql/<version>/bin`. Run as root (for example in a container) it runs PostgreSQL as the `postgres` system user, since PostgreSQL refuses to run as root.

### Importing questions

```sh
npm run db:import-questions -- path/to/aks.json path/to/web.json --dry-run   # report only
npm run db:import-questions -- path/to/aks.json                              # import
npm run db:import-questions -- extra.csv --track qa                          # CSV in the bulk-add layout
```

Everything is validated before anything is written; the report lists what would be added, changed (with the version change) and left alone. Running it again changes nothing. Questions edited in the app since the file was made (a higher version in the database) are kept. Administrators can do the same in the app: **Admin › Question files**. `npm run validate:seed` checks the bundled files (`BANK-3`).

## Tests

```sh
npm run typecheck       # browser and server
npm test                # unit tests (Vitest): pure code, client helpers, the traceability check
npm run test:server     # server tests against PostgreSQL (needs npm run db:start, or TEST_DATABASE_URL)
npm run e2e             # builds, creates a fresh database ia_e2e, starts the built server, runs Playwright
npm run validate:seed
```

Server tests: `vitest.server.config.ts` migrates a template database once (`server/test/globalSetup.ts`); each test file clones its own database from it (`server/test/harness.ts`: `createTestDb`, `startApp`, `signIn`, `client`). End-to-end: `scripts/e2e-server.mjs` prepares the database with `dist/server/cli.js migrate` and `seed`, adds three users, and runs `dist/server/main.js` with development sign-in; server output goes to `test-results/e2e-server.log` (a test checks it carries no personal data). `@playwright/test` is pinned to the installed Chromium; do not run `playwright install` locally (CI does).

## Deployment

[`docs/deploy/README.md`](docs/deploy/README.md) is the step-by-step Google Cloud guide (Artifact Registry, Cloud SQL, Secret Manager, a least-privilege service account, the Google OAuth client, the release job for migrations, Cloud Run, domain, backups, rollback). Every setting is in [`.env.example`](.env.example). The `Dockerfile` builds one small, non-root image serving the app and the API on `$PORT`.

## Layout

| Path | What |
|---|---|
| `src/` | The browser app: `app/` shell and routes, `pages/` screens, `ui/` primitives, `db/` the HTTP data layer, `docs/` the in-app docs |
| `src/domain/`, `src/shared/` | Pure code and API types shared with the server |
| `src/db-local/`, `e2e-local/` | The local app's IndexedDB data layer and end-to-end tests, kept for reference while screens are ported; not built, not run |
| `server/` | `main.ts` (start), `cli.ts` (migrate, seed, import), `app.ts`, `config.ts`, `auth/`, `authz/`, `users/`, `bank/`, `audit/`, `settings/`, `live/`, `http/`, `db/` (pool, Kysely types, migration runner, `migrations/*.sql`), `test/` |
| `e2e/` | Playwright tests of the hosted build |
| `seed/`, `schema/` | The bundled track files and their JSON Schema (`npm run gen:schema` regenerates `src/domain/generated/`) |
| `scripts/` | `dev-db.sh`, `dev.mjs`, `e2e-server.mjs`, `validate-seed.mjs`, `gen-track-validator.mjs` |
| `docs/deploy/` | The Google Cloud guide |

## Building on this (steps 2 and 3)

### Conventions

- **API:** JSON under `/api`. Every route is declared with `route(app, ctx, { method, url, access, params?, query?, body?, handler })` (`server/http/route.ts`). `access` is required: `{ public: true }`, `{ signedIn: true }`, `{ action: 'bank.edit' }` (a global permission) or `{ round: 'round.plan', roundOf }` (a permission on one round). A route registered any other way stops the server starting. Inputs are zod schemas; use `.strict()` objects (unknown fields are refused: no mass assignment). Errors: throw `ApiError`, `notFound()`, `invalid()` or `conflict()`; responses are `{ error: { code, message, details? } }`. Lists that grow are paged with `?limit=&cursor=` → `{ items, nextCursor }`.
- **Writes** happen in one transaction with their audit entry (`appendAudit(trx, actor, …)`) and their live event (`publish(trx, …)`, delivered only on commit). Lock the parent row (`forUpdate()`) when numbering or counting.
- **Permissions:** add a permission to `server/authz/policy.ts` and nowhere else. Question reviewers (`REVIEW-1`) hold only the question-bank capability: any permission not listed in `QUESTION_BANK_ACTIONS`, and every round permission, is refused to them automatically, so step-2 routes need nothing extra (`server/authz/authz.test.ts` lists exactly what a reviewer can reach). `server/authz/authz.test.ts` enumerates every route: add the role expectations there.
- **Ids:** random UUIDs for anything that can carry candidate data (`PRIV-3`). No candidate text in URLs, log lines, or audit `before`/`after` beyond what `docs/06` allows.

### (a) Add a round-scoped route

```ts
// server/rounds/routes.ts (step 2)
route(app, ctx, {
  method: 'PATCH',
  url: '/api/interviews/:id/schedule',
  // The round is looked up from the target in the database, never taken from the request body.
  access: {
    round: 'round.plan',
    roundOf: async (req, ctx) =>
      (await ctx.db.selectFrom('interviews').select('round_id').where('id', '=', (req.params as { id: string }).id).executeTakeFirst())?.round_id ?? null,
  },
  params: z.object({ id: z.uuid() }).strict(),
  body: z.object({ scheduledAt: z.iso.datetime({ offset: true }) }).strict(),
  handler: async ({ actor, params, body, round }) =>
    ctx.db.transaction().execute(async (trx) => {
      // … update, then:
      // await appendAudit(trx, actor, { action: 'interview.rescheduled', entity: 'interview', entityId: params.id, roundId: round!.roundId });
      // await publish(trx, { topic: `round:${round!.roundId}`, kind: 'interview', id: params.id });
    }),
});
```

Someone not on the round gets 404 (not 403), so ids cannot be probed; a closed round refuses changes in `canInRound` (`ROUND-5`). Test it like `server/authz/authz.test.ts` "round-scoped permissions": a member, a non-member, the round's organiser, an administrator, a closed round, a malformed id. Add `round:<id>` to `topicAllowed` in `server/live/routes.ts` with a `round.read` check (and re-check membership on the heartbeat).

### (b) Publish and follow a live update

Server, inside the transaction that makes the change: `await publish(trx, { topic: 'round:<id>', kind: 'interview', id })`. Keep events to ids: the browser refetches through the API, so an event never leaks data. Browser: call `useLiveTopics('round:<id>')` in the screen; every query whose key starts with the topic's first part (`['round', …]`) is refetched when an event arrives (`src/db/live.tsx`). For the live interview (`LIVE-2`, within about a second) the same path is quick; if it is not, put the small shared state (current question, timer) in the event too, under 7000 bytes.

### (c) Port a local-app screen to the HTTP data layer

1. Pick the screen (for example `src/pages/Dashboard.tsx`) and list what it imports from `../db`. The local implementation of each function and hook is in `src/db-local/`, with the same names.
2. Add those functions and hooks to `src/db/` with the same names and shapes, backed by new API routes: hooks with `useQuery` (return `undefined` while loading and `null` for 404; the query key starts with its live topic), changes as async functions that call `api.*` and invalidate their topic. For `HOST-6`, use `useMutation` with `networkMode: 'offlineFirst'`, an optimistic `onMutate` and retries.
3. Remove the screen (and its folder) from the `exclude` list in `tsconfig.json`, replace its `ComingNext` route in `src/app/App.tsx`, and run `npm run typecheck` until it is clean.
4. Port its tests from `e2e-local/` and `src/db-local/*.test.ts` to `e2e/` and `server/**/*.test.ts`; then remove its ids from `NOT_BUILT_YET` and give their rows in `docs/10-verification.md` the new tests.

### (d) Run the database and the tests

`npm run db:start` once per machine boot; then `npm run test:server`, `npm test` and `npm run e2e` (it builds first). `TEST_DATABASE_URL` points the server and end-to-end tests at any PostgreSQL 16 whose user may create databases (CI uses a service container).

## Security notes

Google OpenID Connect with PKCE, state and nonce, handled on the server; the ID token's claims are checked again by the app (issuer, audience, expiry, nonce, verified email); only invited, active people get in; bootstrap administrators come from configuration. Sessions: 32 random bytes in an HttpOnly, SameSite=Lax cookie (`Secure` and `__Host-` over https), stored only as an HMAC, with an idle timeout, ended at once on deactivation. CSRF: SameSite cookie plus a required `X-IA-Request` header and an Origin check on every change. Permissions live in one policy file, deny by default, and are tested for every route and role. Queries are parameterised (Kysely); inputs are validated with zod; request sizes are limited; errors have one shape without internals; sign-in is rate limited (per instance). Security headers include the CSP, and HSTS in production. Logs carry no personal data. The audit table refuses updates and deletes in the database itself.
