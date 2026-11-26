# Interview flow

An interview moves through eight steps. Each step lists the requirements the app must meet.

## 1. Choose a track

- `FLOW-1` The Dashboard lists the tracks and all sessions on this device with their state (ready to start, in progress, paused, submitted). A new interview starts by choosing a track.
- `FLOW-33` New interview: one screen sets up an interview. It asks for the role (track) and the candidate's initials, and arrives with a question set already drawn from the default quotas and time budget (preferring a draw whose time estimates fit the budget). The set is shown as a summary (number of questions, estimated time, mix) and can be shuffled or edited in place (step 2). Everything else is optional and out of the way under "More options": requisition id, more interviewers, recording or transcription, how long to keep the record, and category weights. One button, "Continue", pins the plan (`FLOW-8`) and opens the ready screen (step 3). The interviewer name comes from this device's settings and is asked for only the first time.
- `FLOW-34` When there is an unfinished interview on this device, the Dashboard's most prominent action is to continue it. Interviews planned for later are listed under Upcoming instead (`TEAM-2`).

## 2. Configure the plan

- `FLOW-2` Questions can be filtered by category, difficulty and type.
- `FLOW-3` Questions can be picked by hand, or drawn at random using quotas per type. Default quotas: 9 knowledge ("technical", allowed range 8-10), 2 scenario, 1 design, 2 behavioural. A random draw spreads its picks across categories and never exceeds what the filters allow; if a quota cannot be met the app says so.
- `FLOW-4` A time budget is set (default 60 minutes). A time meter compares the sum of the selected questions' time estimates to the budget and warns when it is over.
- `FLOW-5` A category coverage view shows how many selected questions fall in each category.
- `FLOW-6` Each category's weight (default from the seed, normally 1.0) and "must-have" flag can be adjusted for the plan before it is locked.
- `FLOW-7` Candidate and interviewer details are captured: candidate initials, requisition id (optional), interviewer name, and a retention date (default 90 days ahead; the default period can be changed for this device in the Admin screen). More interviewers can be named (`PANEL-1`). Consent is confirmed on the ready screen, with the candidate present: the consent text is shown to be read out, and the interview cannot be started until the interviewer confirms the candidate has been told. See [Data and privacy](#/docs/06-data-privacy).
- `FLOW-8` When "Continue" is pressed the plan is **locked** (the screens say the questions are "fixed for this interview"). A locked plan's questions, order, weights and time budget cannot be changed. The plan stores a snapshot of each question as it was when locked, so later edits to the bank never alter the interview (version pinning). There is no separate locking step or confirmation; until the interview is started it can be discarded and set up again.
- `FLOW-9` Every plan has a *plan fingerprint* (shown on screens as the comparison code): a hash of the track, the ordered question ids and versions, the category weights and must-have flags. Two sessions are comparable only when their fingerprints match. A locked plan can be reused for another candidate ("New interview with these questions", or "Use the same questions as…" on the New interview screen) and can be exported and imported as a file so that panelists share the same plan.

## 3. Start

- `FLOW-10` The ready screen shows who is being interviewed, the consent text to read to the candidate with its confirmation, and one "Start interview" button. Starting the interview starts the overall timer, counting against the time budget.
- `FLOW-11` One question shows per screen. The question text is large. The **candidate view** shows only the question number and text: nothing about what to look for, red flags, probes, scores or notes. It is available as a toggle (key `C`) and as a separate window that follows the current question, for sharing on a second screen.
- `FLOW-12` The interviewer's part of the screen shows the question's description (`BANK-8`) and probes (P) with the question, and what to look for (L) and red flags (R) beside it. The description is for the interviewer to read out or paraphrase; like the rest of the interviewer's part it is not shown in the candidate view.

## 4. Mark

- `FLOW-13` The interviewer ticks the key points the candidate covered, ticks any red flags observed, and can tick "handled the probe without help".
- `FLOW-14` The app suggests a score from the ticks (rule in [Rubric](#/docs/03-rubric)). The interviewer chooses the score, 1-4; the suggestion is never applied automatically.
- `FLOW-15` Notes can be added. Each note entry is timestamped with the elapsed interview time.
- `FLOW-16` A score of 1 or 4 requires a note for that question. The interview cannot be finished while any 1 or 4 lacks a note, and the question is marked as needing one.
- `FLOW-17` A question can be skipped; a reason is required. A skipped question has no score. Skipping can be undone before finishing.
- `FLOW-18` A question can be flagged for follow-up in the debrief.
- `FLOW-19` A soft per-question timer shows time spent on the current question and turns amber when the question's time estimate is reached. It never blocks anything. The overall timer turns amber at 80% of the budget and red when the budget is exceeded.
- `FLOW-20` The interviewer can move to the next or previous question, or jump to any question from a progress list showing each question's status (unanswered, scored, skipped, flagged).
- `FLOW-21` The interview can be paused and resumed; timers stop while paused.

## 5. Finish

- `FLOW-22` To finish, the interviewer must give an overall rating (1-4), a recommendation (Strong hire, Hire, Lean no hire, No hire) and a written rationale. Every question must be either scored or skipped.
- `FLOW-23` Finishing **submits and locks** the record. After that, any change requires a reason and is written to the audit log.

## 6. Scorecard

- `FLOW-24` The scorecard shows: the overall percentage; a per-category chart with percentages and average scores; strengths (categories averaging 3.0 or more); concerns (categories averaging 2.0 or less); skipped questions listed separately with their reasons; flagged questions; the advisory band; and the interviewer's own overall rating, recommendation and rationale. The maths is in [Scoring](#/docs/04-scoring).
- `FLOW-25` The advisory band is always labelled as advisory and shown next to the recommendation the interviewer recorded.

## 7. Debrief

Several interviewers at one machine share one scorecard (see [Interviewers, transcripts and AI](#/docs/11-interviewers-transcripts-ai)). Interviewers who score on their own devices have their files merged here.

- `FLOW-26` A submitted session can be exported as a session file (JSON). Other panelists' session files can be imported into the Debrief screen.
- `FLOW-27` Other interviewers' judgements are shown as soon as they are imported. Independent scoring is optional: a device setting, "Hide other people's scores until I have submitted mine", is off by default. When it is on, an imported judgement for an interview shows only the interviewer's name and "submitted" until your own record for that interview is submitted. Only submitted interviews can be imported.
- `FLOW-28` The debrief shows each panelist's percentage and band, per-category averages side by side, the panel score (the median of the percentages) and a warning when the spread (highest minus lowest) is above 20 points.
- `FLOW-29` Interviews are grouped into a panel only when the candidate (name or initials plus requisition id, ignoring case and extra spaces) and the plan fingerprint both match.
- `FLOW-30` The Comparison screen shows a matrix of candidates against categories. Candidates can be compared only if they had the same plan (same fingerprint); the screen makes you choose a plan first and shows only that plan's submitted sessions.

## 8. Export

- `FLOW-31` A scorecard can be exported as Markdown and as CSV (one row per question). PDF is produced with the browser's print dialog ("Save as PDF") from a print-friendly scorecard layout.
- `FLOW-32` Every export is recorded in the audit log.

## Ease of use

These hold at a laptop-sized window (1280 by 800) and are checked like any other requirement.

- `UX-1` Setting up a typical interview takes one screen and two inputs (role and initials). In its default state the New interview screen shows its "Continue" button without scrolling.
- `UX-2` Nothing has to be built before it can be used: the New interview screen arrives with a balanced question set already selected (`FLOW-33`).
- `UX-3` Editing the question set happens in place, without leaving the New interview screen: the selected questions are the main list, in interview order, easy to reorder and remove; adding from the bank (with search and the filters of `FLOW-2`) and changing the mix (`FLOW-3`) are secondary actions.
- `UX-4` In the live interview the question, what to look for and the score control with "Next" are all visible without scrolling. The score control and "Next" stay in view at all times.
- `UX-5` During a live interview the app's main navigation is reduced to a single way out, so a stray click cannot leave the interview. Help opens without leaving the interview. Secondary actions (pause, candidate view, candidate window, interviewers, transcript, shortcuts) sit in one compact bar or menu.
- `UX-6` Finishing never shows a long list of the same problem. Unanswered questions are summarised, with "go to the first one" and "skip the rest with one reason".
- `UX-7` Requirement ids are for this documentation. Screens do not show them; where help is offered it is a plain "?" control that opens the relevant section here.
- `UX-8` Screens use the words an interviewer would use (role, questions, start), not the app's internal ones (plan, lock, quota, fingerprint), except in Admin and in this documentation. Helper text appears only where a field is not self-explanatory.
- `UX-9` Every screen has one obvious primary action and the same page width, alignment and spacing.

## Resilience

- `RES-1` Every change is saved automatically to IndexedDB as it is made. Reloading or closing the page at any point loses nothing: the session reopens at the same question with the same ticks, score, notes and flags.
- `RES-2` Timers survive a reload. They are derived from stored timestamps, not from in-memory counters.
- `RES-3` An offline banner is shown when the browser is offline, saying that work continues to be saved on this device.
