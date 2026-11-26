# Hosted version

This repository is the **hosted version** of Interview Assistant: the same structured interviews, rubric, scoring and question bank as the local app, but running on a server with a shared database, so a company can use it together. The local app lives in its own repository and is unchanged.

This page is the specification for what is different in the hosted version. Where it conflicts with another page, this page wins, and the other page is corrected to match (see "What this replaces" at the end).

## How it is built and hosted

- `HOST-1` The app is a web application with three parts: the browser app (React), a server (Node.js, TypeScript) that provides the API, and a PostgreSQL database. All data lives in the database. The browser keeps no interview data of its own beyond what is needed to survive a short loss of connection (`HOST-6`).
- `HOST-2` It is packaged as one container image that serves both the browser app and the API. It is designed for Google Cloud: Cloud Run for the container, Cloud SQL for PostgreSQL, Secret Manager for secrets, and Cloud Storage for recordings. The repository contains everything needed to deploy it: a Dockerfile, a deployment guide with the exact commands, and the configuration it expects. Nothing in the app depends on a particular Google Cloud project; all of that comes from configuration.
- `HOST-3` Configuration comes from environment variables, documented in one place with an example file. Secrets (database password, Google sign-in client secret, session secret, AI key) are never committed and never logged. The server refuses to start with a clear message when a required setting is missing.
- `HOST-4` The database schema is created and changed only by numbered migration files in the repository, applied by one command (`npm run db:migrate`), which is safe to run repeatedly and is run before each deployment.
- `HOST-5` The server can run as several instances at once. It keeps no state in memory that another instance would need; live updates between instances go through the database.
- `HOST-6` A short loss of connection during an interview loses nothing: changes made while disconnected are kept in the browser and sent when the connection returns, the screen says plainly that it is offline or reconnecting, and timers keep running from server timestamps (`RES-2`).
- `HOST-7` The server exposes a health check that reports whether it can reach the database. Server logs never contain candidate data, notes, scores or tokens (`PRIV-3`).
- `HOST-8` Everything runs locally for development and tests with one command each, against a local PostgreSQL, with no Google account needed (`AUTH-6`). Continuous integration runs the unit tests, the server tests against a real PostgreSQL, and the end-to-end tests.

## Signing in

- `AUTH-1` People sign in with Google. There are no passwords in the app.
- `AUTH-2` Only invited people can sign in. An administrator adds a person by email address on the Users page; anyone whose Google account email is not on that list is refused with a plain message, and nothing about the app's data is shown to them. The email must be verified by Google.
- `AUTH-3` The first administrator is named in configuration (one or more email addresses). They can always sign in, so the app cannot be locked out of.
- `AUTH-4` After sign-in the server keeps the session in a secure, HTTP-only cookie; no token is readable by the page's scripts. Sessions end after a period of inactivity set in configuration (default 12 hours) and on sign-out. Removing or deactivating a user ends their sessions straight away.
- `AUTH-5` Every API request is checked on the server: signed in, active, and allowed to do that particular thing to that particular round or interview (`USER-3`, `ROUND-2`). Hiding a button in the browser is never the control. Requests that change data are protected against cross-site request forgery.
- `AUTH-6` For local development and automated tests only, a development sign-in lets you choose a test user without Google. It exists only when explicitly enabled in configuration and the server refuses to start with it enabled in production mode.

## Users and access

- `USER-1` The Users page, for administrators, lists everyone with access: name, email, role, whether active, when they last signed in, and the rounds they are on. It can add a person by email, change their role, deactivate and reactivate them, and remove someone who has never signed in. Many people can be added at once by pasting a list of email addresses.
- `USER-2` Roles:

| Role | Can do |
|---|---|
| Administrator | Everything: users, settings, the audit log, privacy requests, every round, the question bank. |
| Organiser | Create and run hiring rounds they own or are on: plan interviews, choose the team, record panel decisions, see the round's summary. Edit the question bank. |
| Interviewer | Take part in interviews in the rounds they are on: score, take notes, see the round's interviews and summary. Read the question bank. |

- `USER-3` A person who is deactivated or removed can do nothing, immediately. Their past judgements stay, shown under their name. An administrator cannot remove or demote the last active administrator.
- `USER-4` Every change on the Users page is recorded in the audit log: who did what to whom, and when.

## Hiring rounds

Several rounds run at the same time, each with its own people.

- `ROUND-1` A hiring round is a group of interviews for one role, usually one requisition. It has a name, a role (track), an optional requisition id, a question set, a team, a retention date and a state (open or closed). Organisers and administrators create rounds.
- `ROUND-2` People see only the rounds they are on. A round's team is chosen from the users with access; each member is an organiser of that round or an interviewer in it. Administrators see every round. Everything inside a round (its candidates, interviews, judgements, decisions, summary and exports) is visible only to its team and administrators.
- `ROUND-3` A round has a default question set, built the same way as in the local app (`FLOW-33`, `UX-2`, `UX-3`): drawn from the bank, shuffled or edited, then fixed. Interviews planned in the round use it, so the round's candidates can be compared (`FLOW-9`). An individual interview can be given a different set when needed.
- `ROUND-4` Interviews are planned inside a round, one at a time or many at once (`TEAM-1`, `TEAM-15`): candidate, date and time, and the panel — the members of the round who will take part. The Dashboard shows each person their own upcoming interviews first, then the rest of their rounds (`TEAM-2`, `TEAM-16`).
- `ROUND-5` Closing a round makes it read-only: no new interviews and no changes to judgements or decisions except by an organiser or administrator, with a reason (`AUD-4`). A closed round can be reopened.
- `ROUND-6` The Summary screen (`SUM-1` to `SUM-6`) works per round, and for people on several rounds across the rounds they can see.

## Interviewing together

Several panel members can be in the same interview at the same time, each signed in on their own computer.

- `LIVE-1` Each panel member has their own record for the interview: their own ticks, scores, notes, flags, skips and overall assessment (`FLOW-13` to `FLOW-18`, `FLOW-22`). Nobody edits anyone else's record.
- `LIVE-2` The interview itself is shared and stays in step for everyone within about a second: the current question, the overall and per-question timers, started, paused and resumed. One panel member leads at a time: the lead's Next, Previous, Pause and Resume move everyone. Any panel member can take the lead with one click, and everyone can see who is leading. A panel member can look at another question on their own without moving the others, and return to "follow the lead".
- `LIVE-3` The screen shows who is in the interview right now, and for each panel member whether they have scored the current question. Other members' scores and notes for a question can be shown beside your own; this is on by default and can be turned off for a round by its organiser ("Hide other people's scores until they have submitted", the hosted form of `FLOW-27`).
- `LIVE-4` Each panel member finishes and submits their own record (`FLOW-22`, `FLOW-23`). The interview is complete when every panel member who joined has submitted. A panel member who did not take part is shown as "did not take part", not as missing forever; an organiser can mark that.
- `LIVE-5` One person can still run an interview alone, or several people can share one screen and one record with their names on it (`PANEL-1` to `PANEL-4`): the panel is whoever the plan names, and a record can name more than one person.
- `LIVE-6` The consent step (`FLOW-7`, `FLOW-10`) is confirmed once for the interview, by whoever starts it; the others see that it has been confirmed and by whom.
- `LIVE-7` The candidate window (`FLOW-11`) follows the shared current question for everyone and never shows anything else.
- `LIVE-8` Joining late, reloading, or losing the connection briefly brings a panel member back to the shared current state with their own record intact (`HOST-6`, `RES-1`).
- `LIVE-9` After the interview the debrief shows every panel member's judgement side by side with the panel score and spread, and the panel decision is recorded there (`TEAM-9` to `TEAM-12`). A judgement can still be entered on someone's behalf (`TEAM-7`, `TEAM-8`).

## The question bank in the database

- `DB-1` The question bank lives in the database: tracks, categories and questions, with versions and the audit trail of changes (`BANK-9` to `BANK-14`). It is shared by everyone; organisers and administrators edit it, interviewers read it.
- `DB-2` Questions are loaded into the database by a script, `npm run db:import-questions`, which takes one or more track files (the JSON format of `BANK-3`) or CSV files (the layout of `BANK-13`), validates them completely before changing anything, and reports what it would add, change and leave alone. `--dry-run` shows the report without writing. Running it again with the same files changes nothing. A changed question gets a new version (`BANK-11`); interviews already planned keep the wording they were planned with (`FLOW-8`).
- `DB-3` The bundled track files in `seed/` (the four roles, 207 questions) are imported by `npm run db:seed`, which a fresh installation runs once. The same import is available to administrators in the app (upload a track or CSV file, see the same report, then confirm).
- `DB-4` A track can be exported from the app as a track file or CSV at any time (`BANK-7`, `BANK-13`), so the bank is never locked into the database.
- `DB-5` Interview data created in the local app can be brought in: an administrator or a round's organiser can import the local app's interview files and panel files into a round, where they appear as judgements entered from a file, labelled as such.

## Data, privacy and audit in the hosted version

- `HPRIV-1` Candidate data is stored in the database and is visible only to the round's team and administrators (`ROUND-2`). Data is encrypted in transit; encryption at rest is provided by the database and storage services.
- `HPRIV-2` Retention is enforced on the server: a scheduled job, run daily, deletes rounds and interviews past their retention date together with everything attached to them, and records the purge in the audit log without candidate details (`PRIV-5`). The same job can be run by hand.
- `HPRIV-3` Access requests and deletion requests (`PRIV-6`) are handled by administrators and cover everything held about a candidate across all rounds.
- `HPRIV-4` The audit log is kept in the database and cannot be changed or deleted through the app (`AUD-1` to `AUD-4`). The actor is always the signed-in user. Administrators can view and export it; organisers can view the entries for their own rounds.
- `HPRIV-5` Recordings are stored in private file storage (Cloud Storage in production, a local folder in development), never in the database and never publicly reachable; they are served only to signed-in members of the round. Transcripts are stored in the database (`TR-1` to `TR-4`).
- `HPRIV-6` The AI second opinion and AI summary drafts (`AI-1` to `AI-12`, `SUM-4`) run on the server through a configured AI provider, using a key held in Secret Manager. They are off unless an administrator turns them on for the organisation, and can then be turned off for any round by its organiser. What is sent, and the rule that AI never changes a human score or decision, are unchanged (`AI-5`, `AI-10`).

## What this replaces

The hosted version has a server, so some local-only requirements are replaced. The pages listed are corrected to say what the hosted version does; their requirement ids are kept where the intent is the same and removed where the feature no longer exists.

| Local requirement | In the hosted version |
|---|---|
| `OV-1`, `PRIV-2`: works offline, data only in this browser, nothing sent anywhere | Data lives in the database (`HOST-1`). The app needs a connection; a short loss of connection loses nothing (`HOST-6`). |
| `RES-1`, `RES-3`: autosave to IndexedDB, offline banner | Autosave to the server; offline and reconnecting states (`HOST-6`). |
| `BANK-3`, `BANK-4`, `BANK-6`: seed files are the source of truth and are loaded into each browser | The database is the source of truth (`DB-1` to `DB-4`); track files remain the import and export format and are still validated. |
| `FLOW-26` to `FLOW-29`, `TEAM-3`, `TEAM-4`, `TEAM-5`, `TEAM-13`: invitation, interview and panel files exchanged between computers | Not needed: everyone works in the same database (`ROUND-1` to `ROUND-4`, `LIVE-1` to `LIVE-9`). Files from the local app can still be imported (`DB-5`), and reports are still exported (`FLOW-31`, `SUM-5`). |
| `FLOW-27`: device setting to hide other people's scores | A setting per round (`LIVE-3`). |
| `TEAM-6`: expected, submitted, still to come | Kept, driven by the interview's panel and live records (`LIVE-3`, `LIVE-4`). |
| `PRIV-5`, `PRIV-6`, `AUD-1`: purge when the app opens, per-device audit log and requests | Server-side (`HPRIV-2` to `HPRIV-4`). |
| `AI-1`, `AI-4`: local helper using the Claude Code sign-in on this computer | A server-side AI provider with a key in Secret Manager (`HPRIV-6`). |
| "This device" settings: interviewer name, default retention | The interviewer is the signed-in user; defaults are organisation settings managed by administrators. |
| `SEC-1`: Content Security Policy | Kept, sent as a response header by the server, allowing only the app's own origin plus Google sign-in. |
| `MVP-1`, `MVP-2`, `MVP-4` | Replaced by the hosted checks: an interview with two panel members works end to end against a real database; a reload or a brief disconnection loses nothing; all bundled questions import cleanly. |
