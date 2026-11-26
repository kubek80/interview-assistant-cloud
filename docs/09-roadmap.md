# Roadmap

## MVP pilot (this version)

Vite + React + TypeScript, IndexedDB (Dexie), JSON seed files, static hosting. Pilot for two weeks, recording candidate initials only.

Done when:

- `MVP-1` a 10-question interview works end to end offline;
- `MVP-2` a reload loses nothing;
- `MVP-3` the score maths matches the worked example in [Scoring](#/docs/04-scoring);
- `MVP-4` all bundled questions pass validation.

## v1: team version (not built yet)

Next.js + TypeScript, Azure Database for PostgreSQL, Entra ID single sign-on (MSAL/Auth.js or Container Apps built-in authentication), Azure Container Apps, Key Vault, Application Insights. App roles: Interviewer, HiringManager, BankEditor, Admin.

Adds: server-side blind panels; comparison across interviewers' devices; PDF export; a server audit log; scheduled retention purge; access limited by requisition; candidate name and email.

Done when: scores stay hidden until each panelist submits; edits after submission are logged with a reason; the purge is verified; automated (axe) and manual accessibility checks pass; the privacy impact assessment is approved.

Security targets for v1: OWASP ASVS Level 2, encryption at rest and in transit, no candidate data in logs, Entra Conditional Access.

## v2

Versioning screen; calibration analytics; GitHub sync of the bank from tagged releases; SuccessFactors Recruiting and Confluence integration; ServiceNow access requests; AI drafting behind a feature flag.

Done when: every interview is pinned to a question version; any interviewer whose average differs from the panel average by more than 0.5 is flagged; integrations are tested in a sandbox.

AI assists may suggest probes and draft summaries from notes. They never score. AI output is labelled, uses an approved enterprise model, and a person edits the draft before it is saved.

## Not included, and why

- Panels across devices use exported files in the pilot, because there is no server.
- A "rapid N-1" AKS upgrade channel and third-party prices for the AKS Premium tier were left out of the bank because they could not be confirmed.
