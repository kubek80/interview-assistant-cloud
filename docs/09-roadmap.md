# Roadmap

## Hosted version (being built)

The hosted version ([Hosted version](#/docs/13-hosted-version)) replaces the v1 plan below. It is built in three steps:

1. **Foundation (built):** the server, the PostgreSQL database and its migrations, Google sign-in, users and roles with the Users page, the question bank in the database with its import scripts, deployment to Google Cloud, and the test set-up.
2. **Rounds and interviews (being built):** hiring rounds and their teams, planning, interviewing together live and scorecards are built; the debrief and panel decision, and the summary, are next.
3. **The rest:** transcripts, recordings and the AI second opinion on the server, importing local-app files, the retention job, privacy requests, and a final verification pass.

Until a step is built, its screens say "Coming in the next step", and the [Verification](#/docs/10-verification) page lists its requirements as not built yet.

## MVP pilot (the local app)

Vite + React + TypeScript, IndexedDB (Dexie), JSON seed files, static hosting. Pilot for two weeks, recording candidate initials only.

Done when:

- `MVP-1` an interview with two panel members works end to end against a real database;
- `MVP-2` a reload or a brief disconnection loses nothing;
- `MVP-3` the score maths matches the worked example in [Scoring](#/docs/04-scoring);
- `MVP-4` all bundled questions import cleanly into the database (`DB-3`).

## v1: team version (replaced by the hosted version)

Next.js + TypeScript, Azure Database for PostgreSQL, Entra ID single sign-on (MSAL/Auth.js or Container Apps built-in authentication), Azure Container Apps, Key Vault, Application Insights. App roles: Interviewer, HiringManager, BankEditor, Admin.

Adds: server-side blind panels; comparison across interviewers' devices; PDF export; a server audit log; scheduled retention purge; access limited by requisition; candidate name and email.

Done when: scores stay hidden until each panelist submits; edits after submission are logged with a reason; the purge is verified; automated (axe) and manual accessibility checks pass; the privacy impact assessment is approved.

Security targets for v1: OWASP ASVS Level 2, encryption at rest and in transit, no candidate data in logs, Entra Conditional Access.

## v2

Versioning screen; calibration analytics; GitHub sync of the bank from tagged releases; SuccessFactors Recruiting and Confluence integration; ServiceNow access requests; AI drafting behind a feature flag.

Done when: every interview is pinned to a question version; any interviewer whose average differs from the panel average by more than 0.5 is flagged; integrations are tested in a sandbox.

AI assists may suggest probes and draft summaries from notes. They never score. AI output is labelled, uses an approved enterprise model, and a person edits the draft before it is saved.

## Not included, and why

- Panels across devices use exported files in the pilot, because there is no server. The hosted version shares one database instead.
- A "rapid N-1" AKS upgrade channel and third-party prices for the AKS Premium tier were left out of the bank because they could not be confirmed.
