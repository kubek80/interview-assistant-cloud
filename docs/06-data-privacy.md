# Data and privacy

This guidance is general. Privacy/Legal and HR must approve retention, consent wording and any automated recommendation before the tool is used with real candidates.

## What is collected

- `PRIV-1` A candidate is identified by a name or initials, whichever the team prefers (up to 60 characters), plus an optional requisition id. The app does not collect a candidate's email, phone number or address. The app makes no recordings itself; a transcript or recording made elsewhere can be attached when the candidate has been told (`TR-4`). Using initials keeps less personal information in the database; using names is easier across many interviews. That choice, like the retention period, belongs to the team and its Privacy/Legal advisers.
- `PRIV-2` Data lives in the organisation's database and is reached only through the app's server (`HOST-1`, `HPRIV-1`). Nothing is sent anywhere else, with one exception: when a person runs the optional AI second opinion, the data listed in `AI-5` goes from the server to the configured AI provider (`HPRIV-6`). The app loads no third-party scripts, fonts or analytics; signing in visits Google's sign-in page and nothing else (`AUTH-1`).
- `PRIV-3` Candidate data never appears in the browser console or in URLs. Session URLs use random ids.

## Consent

- `PRIV-4` The consent text is shown on the ready screen, and the interviewer confirms the candidate has been told before the interview can be started (`FLOW-7`). The time of confirmation is stored. The text:

> Notes and ratings from this interview are recorded by your interviewers to support a fair, structured hiring decision. They are kept only for the period set by HR and are seen only by people involved in this hiring decision. Ratings are made by people; the tool's summary is advisory. You can ask to see or delete your interview record.

## Retention and deletion

- `PRIV-5` Every round and interview has a retention date (by default 90 days after creation, an organisation setting; HR sets the real period). The retention date is the last day it is kept. A scheduled job on the server deletes what is past its retention date every day, and records each purge in the audit log without candidate details (`HPRIV-2`).
- `PRIV-6` From the Admin screen an administrator can: export everything held about one candidate across all rounds (an access request); and delete everything held about one candidate, including candidate details typed on plans that were never fixed (a deletion request) (`HPRIV-3`). Each asks for confirmation and is recorded in the audit log.

## Audit log

- `AUD-1` The audit log is kept in the database and is append-only: the app offers no way to edit or delete individual entries (`HPRIV-4`). When an interview is deleted by a deletion request or the retention purge, candidate text in its entries (before and after values and reasons) is redacted; the entries themselves are kept. Each entry has a time, the actor (the signed-in person), an action, the entity affected, and where relevant the before and after values and a reason.
- `AUD-2` Logged actions: plan locked; consent confirmed; an interview discarded before it started; session started; session submitted; any edit after submission (reason required, with before and after); exports of any kind; imports; bank reloads; retention purges; access and deletion requests.
- `AUD-3` The audit log can be viewed and filtered in the Admin screen and exported as CSV.
- `AUD-4` Edits after submission: a submitted session opens read-only. "Amend" asks for a reason before it accepts a change to a score, note, overall rating, recommendation or rationale.

## Security

- `SEC-1` The server sends a Content Security Policy header with every response that allows only the app's own scripts, styles and connections, and no framing. Google sign-in is a redirect to Google and back, so it needs no exception.
- `SEC-2` Imported files (plans, sessions, tracks) are validated before use and treated as data. Text from files and notes is always rendered as text, never as HTML.

## Legal context

Comply with the Australian Privacy Principles, and with GDPR for EU candidates.

**From 10 December 2026**, APP 1.7-1.9 apply (Privacy and Other Legislation Amendment Act 2024). Organisations must state in their privacy policy when "they have arranged for a computer program to make or inform decisions that significantly affect individuals' rights or interests." That is why the band stays advisory (`OV-4`, `SCORE-9`). Involve Privacy/Legal before adding any AI scoring.

## Where the data is

In the hosted version data sits in the organisation's database on Google Cloud, behind sign-in and per-round access, encrypted in transit and at rest (`HPRIV-1`), and retention is enforced by the server (`HPRIV-2`). See [Hosted version](#/docs/13-hosted-version).
