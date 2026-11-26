# Data and privacy

This guidance is general. Privacy/Legal and HR must approve retention, consent wording and any automated recommendation before the tool is used with real candidates.

## What is collected

- `PRIV-1` A candidate is identified by a name or initials, whichever the team prefers (up to 60 characters), plus an optional requisition id. The app does not collect a candidate's email, phone number or address. The app makes no recordings itself; a transcript or recording made elsewhere can be attached when the candidate has been told (`TR-4`). Using initials keeps less personal information on laptops; using names is easier across many interviews. That choice, like the retention period, belongs to the team and its Privacy/Legal advisers.
- `PRIV-2` All data stays in this browser on this device. Nothing is sent anywhere, with one exception: when a person runs the optional AI second opinion, the data listed in `AI-5` goes through the local helper on this computer to the AI provider. The app loads no third-party scripts, fonts or analytics.
- `PRIV-3` Candidate data never appears in the browser console or in URLs. Session URLs use random ids.

## Consent

- `PRIV-4` The consent text is shown on the ready screen, and the interviewer confirms the candidate has been told before the interview can be started (`FLOW-7`). The time of confirmation is stored. The text:

> Notes and ratings from this interview are recorded by your interviewers to support a fair, structured hiring decision. They are kept only for the period set by HR and are seen only by people involved in this hiring decision. Ratings are made by people; the tool's summary is advisory. You can ask to see or delete your interview record.

## Retention and deletion

- `PRIV-5` Every session has a retention date (default 90 days after creation; HR sets the real period). The retention date is the last day a session is kept. Each time the app opens, sessions past their retention date are purged, and each purge is recorded in the audit log without candidate details.
- `PRIV-6` From the Admin screen you can: export everything held about one candidate key (an access request); delete everything held about one candidate key, including candidate details typed on plans that were never locked (a deletion request); and erase all data on this device. Each asks for confirmation and is recorded in the audit log.

## Audit log

- `AUD-1` The audit log is append-only: the app offers no way to edit or delete individual entries. When a session is deleted by a deletion request or the retention purge, candidate text in its entries (before and after values and reasons) is redacted; the entries themselves are kept. Each entry has a time, the actor (the interviewer name set on this device), an action, the entity affected, and where relevant the before and after values and a reason.
- `AUD-2` Logged actions: plan locked; consent confirmed; an interview discarded before it started; session started; session submitted; any edit after submission (reason required, with before and after); exports of any kind; imports; bank reloads; retention purges; access and deletion requests.
- `AUD-3` The audit log can be viewed and filtered in the Admin screen and exported as CSV.
- `AUD-4` Edits after submission: a submitted session opens read-only. "Amend" asks for a reason before it accepts a change to a score, note, overall rating, recommendation or rationale.

## Security

- `SEC-1` The app ships a Content Security Policy that allows only its own scripts and styles, and no connections to other origins.
- `SEC-2` Imported files (plans, sessions, tracks) are validated before use and treated as data. Text from files and notes is always rendered as text, never as HTML.

## Legal context

Comply with the Australian Privacy Principles, and with GDPR for EU candidates.

**From 10 December 2026**, APP 1.7-1.9 apply (Privacy and Other Legislation Amendment Act 2024). Organisations must state in their privacy policy when "they have arranged for a computer program to make or inform decisions that significantly affect individuals' rights or interests." That is why the band stays advisory (`OV-4`, `SCORE-9`). Involve Privacy/Legal before adding any AI scoring.

## Limits of the pilot

Data sits on laptops: there is no central access control, no encryption beyond what the device provides, and retention is only enforced when the app is opened. Use a managed, disk-encrypted device. These limits are why initials are worth considering, and why the team version in the [Roadmap](#/docs/09-roadmap) exists.
