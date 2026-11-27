# Interview Assistant (hosted)

Interview Assistant runs structured interviews: vetted questions, one 1-4 rating scale, key-point checkboxes, independent scoring by each interviewer and a weighted scorecard. This repository is the **hosted version**: a web application with a server and a PostgreSQL database on Google Cloud, so a company can use it together. People sign in with Google (invited people only); hiring rounds have their own teams; panel members interview together, each scoring their own record live.

The **local app** (the MVP pilot: a single-page app with no server, data in the browser, panels exchanging files) lives in its own repository, `interview-assistant`, and is unchanged. This repository started as a copy of it.

**Status: step 1, step 2a and the first part of step 2b are built.**

1. **Foundation (built):** server, database schema and migrations for the whole data model, Google sign-in and sessions, users and roles with the Users page, the question bank in the database (API, import scripts, the bank screens), **question reviewers and the review workflow** (proposals, comments, review requests: `REVIEW-1` to `REVIEW-7`), the audit log, configuration, Dockerfile, CI, deployment guide, development and test tooling.
2. **Step 2a (built):** hiring rounds with their teams, settings, closing and reopening (`ROUND-1` to `ROUND-5`); each round's question set, drawn when the round is created and edited in place, fixed when its first interview is planned (`FLOW-2` to `FLOW-9`); planning interviews one at a time or by pasting a list, changing and cancelling them (`TEAM-1`, `TEAM-2`, `TEAM-15`); the Dashboard (`FLOW-1`, `FLOW-34`, `TEAM-16`); the ready screen. **Step 2b, first part (built):** interviewing together live (`LIVE-1` to `LIVE-8`): starting with consent, the shared question and timers with one lead, each panel member's own record, presence and other people's marks (hidden when the round says so), working through a lost connection, finishing and amending, the candidate window, and each record's scorecard with its exports. **Step 2b, second part (next):** the debrief side by side with the panel score, the panel decision, judgements entered on someone's behalf, the Comparison screen and the Summary. Until then those screens say "Coming in the next step".
3. **Later:** transcripts, recordings and AI on the server, importing local-app files, the retention job, privacy requests, final verification.

## Documentation is the specification

The pages in [`docs/`](docs/) are the specification; each numbered requirement (for example `AUTH-2`) is something the app must do. [`docs/13-hosted-version.md`](docs/13-hosted-version.md) specifies what is different in the hosted version and wins where pages disagree. The pages are bundled into the app under **Docs**.

[`docs/10-verification.md`](docs/10-verification.md) lists every requirement id with how it is checked and its status. A unit test (`src/docs/traceability.test.ts`) fails if an id is missing from that page, if the page names an id that does not exist, or if it cites a test file that does not exist or has no test mentioning the id. Ids for steps 2 and 3 are on that test's `NOT_BUILT_YET` list; remove an id from the list when you build it.

## Architecture

```
browser (React, Vite build, hash routes)  ──HTTPS, same origin──▶  server (Node 22, Fastify, TypeScript)  ──▶  PostgreSQL 16
  src/db: typed API client, TanStack Query cache, live updates      auth/   Google OIDC (openid-client), sessions in PostgreSQL
                                                                     authz/  policy.ts: every permission, in one place
  src/domain, src/shared: pure code used by both  ◀────────────────  users/, bank/, audit/, settings/, rounds/, interviews/: JSON API (zod)
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
| `server/` | `main.ts` (start), `cli.ts` (migrate, seed, import), `app.ts`, `config.ts`, `auth/`, `authz/`, `users/`, `bank/`, `review/`, `rounds/` (rounds, teams, question sets, planned interviews), `interviews/` (the running interview, records, scorecards), `audit/`, `settings/`, `live/`, `http/`, `db/` (pool, Kysely types, migration runner, `migrations/*.sql`), `test/` |
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

### (e) How interviews hang off rounds

Tables (migrations 0002 and 0004; Kysely types in `server/db/schema.ts`; logic in `server/rounds/service.ts`):

- `rounds` → `round_members` (the team: `organiser` or `interviewer`), `default_question_set_id` (the round's current set), `hide_others_scores` (`LIVE-3`, applied by the server, see (f)), `state` and `retention_until`.
- `question_sets` (`round_id`): `questions` (full question snapshots, `src/domain/types` `Question[]`), `categories` (weights and must-have), `time_budget_min`, `fingerprint` (the comparison code, `planFingerprint`), `fixed_at` (null while the round's set is still being edited; set by `fixSet` when the first interview using it is planned; never changes afterwards), `version`.
- `candidates` (`round_id`, `display_name`, `requisition_id`, `key` = `candidateKey()`, unique per round): one candidate can have several interviews.
- `interviews` (`round_id`, `candidate_id`, `question_set_id`, `state` planned → in_progress/paused → completed, or cancelled; `scheduled_date` and `scheduled_time` as typed; `note`, `recording_notice`, `retention_until`; the shared live state is already there: `consent_at`/`consent_by`, `lead_user_id`, `current_question_id`, `timer_accumulated_ms`/`timer_running_since`, `question_timers`, `started_at`, `completed_at`, `version`).
- `interview_panel` (`interview_id`, `user_id`, `status` expected/joined/submitted/did_not_take_part): who takes part. `src/domain/rounds.ts` `interviewStatus()` turns state + panel statuses into upcoming / in progress / waiting for judgements / finished for every list and count.
- Per-person records, the shared live state and presence: see (f). The panel decision goes in `panel_decisions`; written summaries in `written_summaries` (per candidate).

API (all in `server/rounds/routes.ts`): `GET/POST /api/rounds`, `GET/PATCH /api/rounds/:roundId`, `POST …/close`, `POST …/reopen`, `GET …/audit`, `GET …/team-options`, `PUT/DELETE …/members/:userId`, `GET/PUT …/question-set`, `GET /api/question-sets/:id`, `GET/POST …/interviews`, `POST …/interviews/bulk`, `GET/PATCH /api/interviews/:id`, `POST /api/interviews/:id/cancel`, `GET /api/my/interviews`. The round of an interview or set is looked up from the database (`roundOfInterview`, `roundOfSet`); cancelled interviews answer 404.

Browser (`src/db/rounds.ts`): query keys all start with `'round'` (listed at the top of that file), so any `round:<id>` event, the admin-only `rounds` topic, and the person's own `user:<id>` "rounds" event (added to or removed from a round) refetch them. Screens: `src/pages/Rounds.tsx`, `src/pages/round/*` (round page, `InterviewList`, `QuestionSetPanel`, `PanelPicker`), `src/pages/NewInterview.tsx`, `src/pages/PlanSeveral.tsx`, `src/pages/Dashboard.tsx`, `src/pages/interview/PreStart.tsx` (the ready screen).

### (f) Interviewing together (step 2b, first part) and what the debrief builds on

**Tables** (migrations 0002 and 0005; Kysely types in `server/db/schema.ts`):

- `interviews`: the shared state. `state` planned → in_progress ⇄ paused → completed; `current_question_id`, `lead_user_id`, the timers as `timer_accumulated_ms` + `timer_running_since` and `question_timers` (`{ [questionId]: { accumulatedMs, runningSince } }`, epoch ms of the **database's** clock), `consent_at`/`consent_by`/`recording_consent_at`, `started_at`, `completed_at`, `version` (raised on every change).
- `interview_panel`: `status` expected → joined → submitted, or did_not_take_part (an organiser's mark, only for someone who never joined). Someone sharing another member's screen follows that record.
- `records` (`origin = 'live'`, one per panel member who joined, unique per interview and owner): `names` (owner first), `shared_with` (panel members on the owner's screen, `LIVE-5`), `state` draft/submitted, `overall_rating`, `recommendation`, `rationale`, `submitted_at`, `version`. `answers` (one row per record and question: score, `covered_key_points`, `red_flags_seen`, `probe_handled`, `flagged`, `skipped`, `skip_reason`, `version`) and `notes` (one row each; the id is chosen by the browser; `at_sec`, `by_name`).
- `interview_presence`: the last heartbeat of each panel member with the interview open (`LIVE-3`).
- `origin = 'entered'` and `'imported'` records (hand-entered judgements, `TEAM-7`; local-app files, `DB-5`) and `panel_decisions` are in the schema and unused: the next part writes them.

**Code:** `server/interviews/service.ts` (every rule, explained in comments) and `routes.ts`; the pure rules shared with the browser in `src/domain/live.ts` (`applyRecordOp`, the timers, `moveOutcome`, `isComplete`, presence, `clockOffset`, and `toDomainAnswers`, which turns a record into the scoring module's `Answer`s); the API shapes in `src/shared/api.ts` ("Interviewing together"); the browser in `src/db/interview.ts` (queries, commands, presence, the server's clock) and `src/db/outbox.ts` (the queue of unsent record changes, `HOST-6`); the screens `src/pages/LiveInterview.tsx`, `src/pages/interview/*` (`PreStart.tsx` is the interview's page before and after the start), `src/pages/CandidateWindow.tsx` and `src/pages/Scorecard.tsx`.

**API:** `GET /api/interviews/:id/live` (shared state, panel, presence, what I may do), `GET …/records` (my record; the others' as I may see them), `GET …/present` (the candidate window), `POST …/start` (consent), `POST …/join`, `POST …/command` (`move` from→to, `pause`, `resume`, `lead`), `POST …/presence`, `PUT …/panel/:userId` (did not take part); `POST /api/records/:id/ops` (batched RecordOps, owner only), `POST …/submit`, `POST …/amend` (reason; before and after audited), `GET /api/records/:id` (a scorecard), `POST …/exported`. Everything is round-scoped (404 off the round); ownership, panel membership and the hide rule are checked in the service. Live events: `interview:<id>` with kind `state`, `records` or `presence` (ids only, no data); start, join, submit, pause, resume and completion also publish `round:<roundId>` for the lists.

**For the debrief, the panel decision, hand-entered judgements and the summary (next part):**

- Every submitted record of an interview: `records WHERE interview_id = $1 AND state = 'submitted'` with its `answers` and `notes`. `loadScorecard(db, actor, recordId)` already returns one record with the interview, its question set and the time per question, and enforces visibility; `toDomainAnswers(record, recordId, elapsedSec)` then `computeScorecard(plan, answers)` gives each scorecard, and `computePanel` (unchanged) the panel score and spread.
- **Visibility:** `othersHidden(db, actor, interviewId)` in the service is the one rule for "hide other people's scores until you have submitted yours" (`LIVE-3`, `FLOW-27`). Reuse it for the debrief: a reader sees others' judgements once their own record (or the one they share) is submitted, or the interview is complete.
- **Expected, submitted, still to come (`TEAM-6`):** `interview_panel.status` per member, `LiveState.panel` (with `recordId`, `recordState`, `onRecordOf`), `waitingFor()` in `src/domain/live.ts`, `interviewStatus()` in `src/domain/rounds.ts`.
- **Hand-entered judgements (`TEAM-7`, `TEAM-8`):** insert `records` with `origin = 'entered'`, `entered_by`, `entered_at`, `owner_user_id` null and `names` = the person on whose behalf; `answers` and `notes` as for live records (a 1 or 4 needs no note). Corrections can reuse `amendRecord`'s audit shape, but its ownership check is for live records only: add an `entered` branch under `round.decide`.
- **Panel decision (`TEAM-9` to `TEAM-11`):** `panel_decisions` (one per interview, `version`), `round.decide` (allowed in a closed round, with a reason). "Start from the panel's median" reads the submitted records' answers per question.
- The interview's page (`/interviews/:id`) links each scorecard the reader may see and has a "Debrief" link to `/debrief/:interviewId` (a "Coming in the next step" page now, in `src/app/App.tsx`). Scorecards are `/scorecard/:recordId`.

**Limits to know:** presence is a heartbeat every 15 s with a 45 s window; the browser's queue lives in `localStorage`, one key per person (`ia.outbox.v1.<userId>`), holds only unsent changes and drops leftovers after 7 days; moving everyone, pausing and taking the lead are never queued; submitting needs a connection.

## Security notes

Google OpenID Connect with PKCE, state and nonce, handled on the server; the ID token's claims are checked again by the app (issuer, audience, expiry, nonce, verified email); only invited, active people get in; bootstrap administrators come from configuration. Sessions: 32 random bytes in an HttpOnly, SameSite=Lax cookie (`Secure` and `__Host-` over https), stored only as an HMAC, with an idle timeout, ended at once on deactivation. CSRF: SameSite cookie plus a required `X-IA-Request` header and an Origin check on every change. Permissions live in one policy file, deny by default, and are tested for every route and role. Queries are parameterised (Kysely); inputs are validated with zod; request sizes are limited; errors have one shape without internals; sign-in is rate limited (per instance). Security headers include the CSP, and HSTS in production. Logs carry no personal data. The audit table refuses updates and deletes in the database itself.
