# Planning ahead and working as a panel

Several people can use the app at the same time, each on their own computer. There is no server, so they exchange small files. This page covers planning interviews in advance, sharing them, collecting everyone's judgement, recording a group decision, and summarising a round of interviews.

Nothing here is compulsory. One person can plan, interview, and decide alone; a panel can each score separately and then agree; or a group can record only a joint decision. The app supports each without forcing the others.

## Plan ahead

- `TEAM-1` An interview can be planned for later. On the New interview screen, "Save for later" is offered beside "Continue". A planned interview has its questions fixed (`FLOW-8`), the candidate's name or initials, and optionally a requisition id, a date and time, the interviewers expected, whether it will be recorded or transcribed, and a short note for the interviewers.
- `TEAM-2` Planned interviews are listed on the Dashboard under "Upcoming", soonest first, with the date, the candidate, the role and the interviewers. From there one can be started (which opens the ready screen, where consent is confirmed as usual), changed (date, interviewers, note) or cancelled; until it starts it can also be discarded and set up again with different questions. Several can be planned for the same candidate or the same day.
- `TEAM-15` Many interviews can be planned in one go. "Plan several" takes a list of candidates, typed or pasted from a spreadsheet (candidate, and optionally date, time, requisition id and interviewers on each line), shows a preview with any problems line by line, and creates one planned interview per line for the chosen role. By default they all use the same question set, so the candidates can be compared; a separate draw for each is the alternative.
- `TEAM-16` The Dashboard stays usable with thirty or more interviews: upcoming interviews are grouped by day, the lists can be searched by candidate and filtered by role, requisition and state, and a line at the top counts how many are upcoming, in progress, waiting for other interviewers, and finished.

## Share the plan

- `TEAM-3` One or more planned interviews can be exported as an **invitation file**. It holds the questions, the candidate's name or initials and requisition id, the date and time, the expected interviewers, the recording option, the note and the organiser's name. It holds no scores. Exporting is recorded in the audit log.
- `TEAM-4` Importing an invitation file on another computer adds its interviews to "Upcoming" there, ready to start. The file is validated before anything is added. Importing the same invitation again does not create a duplicate: an interview not yet started is updated, and one already started is left alone and reported. Because the questions are the same on every computer, the results belong to the same panel (`FLOW-29`).

## Collect everyone's judgement

- `TEAM-5` Interview files from other interviewers (`FLOW-26`) can be imported from the Dashboard or the debrief, several at once. Each is matched automatically to its interview. A file that matches nothing is still kept and shown as an interview from another device, with an explanation.
- `TEAM-6` For each interview the Dashboard and the debrief show who is expected, who has submitted and who is still to come (names are compared ignoring case and spaces). Other people's judgements are shown as soon as they are imported, unless independent scoring has been turned on for this device (`FLOW-27`).

## Enter someone else's judgement by hand

For an interviewer who took notes on paper or did not use the app.

- `TEAM-7` From the debrief, "Add another interviewer's judgement" records a judgement on their behalf: their name; their overall rating, recommendation and rationale; and, if they gave them, their score and notes for each question. Questions they did not score are left out, exactly like skipped questions (`SCORE-3`, `SCORE-6`). A judgement with no question scores at all is allowed: it shows the recommendation and rationale but has no percentage, and is not counted in the panel score. A score of 1 or 4 entered on someone's behalf does not need a note.
- `TEAM-8` A judgement entered by hand is always labelled "entered by … on behalf of …" with the time, wherever it is shown or exported. It can be corrected later, with a reason, like any submitted record (`AUD-4`). Entering and correcting are recorded in the audit log.

## Group judgement

- `TEAM-9` A **panel decision** can be recorded for an interview from the debrief: the agreed recommendation and its rationale (both required), who took part, and optionally an agreed overall rating and agreed scores for individual questions. Agreed question scores start empty; "Start from the panel's median" fills them in with the median of the scores given for each question (halves rounded up) for the panel to adjust, and is never applied without that click.
- `TEAM-10` A panel decision does not need individual judgements behind it. It can be recorded for a planned or finished interview that has none, when the group only wants to record a joint view.
- `TEAM-11` There is one panel decision per interview. Changing it after it is saved needs a reason and is recorded in the audit log with the values before and after. It never changes anyone's individual scores.
- `TEAM-12` Where a panel decision exists it is shown as the outcome for that candidate, next to and never instead of the individual figures, the panel score and spread (`SCORE-11`) and the advisory band: on the debrief, on each scorecard, and on the Comparison screen. The Comparison screen says for each candidate whether its figures are agreed scores, the panel's median, or a single interviewer's.

## Share the result

- `TEAM-13` The whole panel for an interview (every judgement held on this device, plus the panel decision) can be exported as one **panel file** and imported on another computer, for example the hiring manager's. The export offers to include the transcript and the AI second opinion; recordings are never included because of their size. On import, new judgements are added, identical ones are skipped, and a decision or written summary that differs from the one already here is never overwritten silently: the app asks whether to keep yours or take theirs. A panel summary can also be exported as Markdown or printed.

## Summarising many interviews

After a round of interviews the app helps turn twenty or thirty records into something a hiring manager can read.

- `SUM-1` The Summary screen lists every candidate for a chosen role, requisition or date range, one row each: candidate, date, interviewers, the outcome (the panel decision where there is one, otherwise the recorded recommendation), the score and advisory band, strengths and concerns, and whether anything is still missing (not interviewed yet, judgements still to come from the interviewers expected, no decision). It can be sorted by any column and filtered by outcome.
- `SUM-2` Candidates who had different question sets can be listed together. Their scores are marked as not directly comparable (`FLOW-9`); rows that share a question set are grouped so that like can be compared with like.
- `SUM-3` Opening a row shows the candidate's summary on one page: outcome and rationale, each interviewer's recommendation, scores by category, strongest and weakest answers with the notes taken, flagged questions, and the AI second opinion where there is one.
- `SUM-4` Each candidate has a short written summary that a person can write or edit at any time. "Draft with AI" writes a first draft from the scores, notes and rationales, through the same local helper and with the same switch as the AI second opinion (`AI-1`, `AI-2`). Before it runs the app shows what will be sent; the candidate's name is replaced with "the candidate" and interviewers' names with "Interviewer 1" and so on. A draft is labelled "AI draft" until a person has edited or accepted it, and it never changes a score, a recommendation or a decision.
- `SUM-5` The whole round can be exported as one report: an overview table of all candidates followed by each candidate's summary, as Markdown, as a printable page (PDF through the browser) and as CSV for the table. Each export is recorded in the audit log.
- `SUM-6` The Summary screen opens quickly and stays responsive with at least fifty interviews on the device.

## Privacy

- `TEAM-14` Invitation files carry the candidate's name or initials and requisition id, and no scores. Planned interviews, judgements entered by hand, panel decisions and summaries follow the interview's retention date and are removed by the retention purge, a deletion request and "erase all data"; an access request includes them.

The files are ordinary files: send them the way your organisation allows for candidate information, and delete your copy once it has been imported.
