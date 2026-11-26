# Data model

The local database (IndexedDB) holds these records. Field names are the ones used in code and in exported files.

- `DATA-1` Entities:

| Entity | Fields |
|---|---|
| Track | `id`, `name`, `version` |
| Category | `id`, `trackId`, `name`, `weight`, `mustHave` |
| Question | `id`, `trackId`, `categoryId`, `number`, `text`, `description`, `difficulty`, `type`, `lookFor[]`, `redFlags[]`, `probes[]`, `timeMin`, `version`, `status`, `rubricOverride` |
| InterviewPlan | `id`, `trackId`, `trackVersion`, `name`, `questions[]` (ordered snapshots of the questions), `categories[]` (snapshot with the plan's weights and must-have flags), `timeBudgetMin`, `locked`, `lockedAt`, `fingerprint`, `createdAt` |
| Session | `id`, `planId`, `candidate` (`initials`, `requisitionId`, `consentAt`, `retentionUntil`), `interviewer` (`name`), `state`, `currentQuestionId`, `timer`, `overall` (`rating`, `recommendation`, `rationale`), `createdAt`, `startedAt`, `submittedAt`, `origin` |
| Answer | `sessionId`, `questionId`, `score` (1-4 or `null`), `coveredKeyPoints[]` (indexes), `redFlagsSeen[]` (indexes), `probeHandled`, `notes[]` (`atSec`, `text`), `flagged`, `skipped`, `skipReason`, `elapsedSec` |
| AuditEvent | `id`, `ts`, `actor`, `action`, `entity`, `entityId`, `before`, `after`, `reason` |

- `DATA-5` A session has `interviewers[]` (names, the first being this device's interviewer; `interviewer.name` stays as that first name for older files). A note may carry `by` (an interviewer's name). Transcripts, recordings and AI results are stored against the session.
- `DATA-6` `consentAt` is empty until consent is confirmed on the ready screen. The candidate record also holds `recordingNotice` (whether the interview is to be recorded or transcribed) and, once confirmed, `recordingConsent`.
- Planning and panels (see [Planning ahead and working as a panel](#/docs/12-planning-and-panels)): a planned interview has an `invitationId`, a date and time, the interviewers expected, a note and the organiser's name. A judgement entered by hand is a submitted record with `origin` `entered`, `enteredBy` and `enteredAt`. Each panel (candidate plus question set) has one panel record holding the panel decision, the written summary and anything received in a panel file.
- `DATA-2` Session `state` is one of `planned`, `in_progress`, `paused`, `submitted`. `origin` is `local` for sessions made on this device and `imported` for panelist files.
- `DATA-3` The session `timer` stores `accumulatedMs` and `runningSince` (a timestamp or `null`), so elapsed time is `accumulatedMs + (now - runningSince)`. Per-question time is stored the same way in the answer (`RES-2`).
- `DATA-4` Exported plan and session files carry a `kind` (`interview-plan` or `interview-session`) and a `formatVersion`. A session file embeds its plan, so it can be imported on a device that has never seen the plan.

The team version (see [Roadmap](#/docs/09-roadmap)) adds Interviewer (`id`, `entraOid`, `role`), a full Candidate record (`name`, `email`) and server-side panels.
