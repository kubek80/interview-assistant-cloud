# Interviewers, transcripts and AI second opinion

This page covers three things added after the first pilot build: several interviewers running an interview together on one machine, attaching a transcript or recording, and an optional AI second opinion alongside the human scores.

## Several interviewers on one machine

An interview can be run by several interviewers sitting together at one machine. They fill in **one shared scorecard**.

- `PANEL-1` Interviewers are named when the interview is set up (New interview, under "More options"). The first is this device's interviewer; more can be added with one click. Names must be different from each other. Interviewers can be added or removed in the live interview until it is submitted (at least one remains); every change is recorded in the audit log.
- `PANEL-2` There is one record for the interview: one set of ticked key points and red flags, scores, notes, flags and skips, and one overall rating, recommendation and rationale, agreed by the interviewers present. There are no separate records per interviewer on one machine and nothing to switch between.
- `PANEL-3` When more than one interviewer is named, a note can be marked with who made it. The note field offers the interviewers' names and remembers the last choice; the name is shown with the note and in exports. Marking is optional.
- `PANEL-4` The interviewers' names are shown wherever the interviewer is shown: the live interview, the Dashboard, the scorecard, the debrief, the Comparison screen and exports. The finish step lists the names and says the rating and recommendation are recorded on behalf of all of them.
- `PANEL-5` In a debrief with session files from other devices (`FLOW-26` to `FLOW-29`), a shared scorecard counts as one entry in the panel, labelled with all its interviewers' names.

A shared scorecard is quick, but the interviewers do not rate independently, which is one of the things that makes structured interviews reliable (see [Overview](#/docs/01-overview)). When independent ratings matter, each interviewer scores on their own device and the files are merged in the debrief.

## Transcripts and recordings

- `TR-1` A transcript can be attached to an interview once it has started, including after submission. Paste the text, or choose a `.txt`, `.vtt`, `.srt` or `.docx` file (the formats Teams and Zoom export). The app keeps the plain text with speaker names and timestamps where the file has them, and shows it read-only with search. Transcripts can be up to 500,000 characters (about eight hours of speech).
- `TR-2` A recording (an audio or video file) can be attached for playback. It is stored on this device only. The app never sends a recording anywhere and does not transcribe it. The app shows its size and warns before storing a file larger than 200 MB.
- `TR-3` Attachments belong to the interview's record. They follow its retention date and are removed by the retention purge, a deletion request and "erase all data". An access request includes the transcript and says whether a recording is held. Attaching, replacing and removing are recorded in the audit log without the content. An interview file never includes the transcript, the recording or the AI result; a panel file includes the transcript and the AI result only when that is chosen at export (`TEAM-13`).
- `TR-4` A transcript or recording can be attached only if the candidate was told. Setup has a "This interview will be recorded or transcribed" option; when it is on, the consent text gains the sentence below and the confirmation covers it. If the option was off, attaching asks the interviewer to confirm that the candidate has since been told, and stores the time.

> This interview is being recorded or transcribed. The transcript may be analysed by an AI tool to give your interviewers a second opinion; people still make every rating and the decision.

## AI second opinion

The AI second opinion scores the candidate's answers from the transcript, using the same questions and rubric as the interviewers. It sits on top of the human scoring; it never replaces it.

### How it runs

- `AI-1` The AI runs through a local helper on your computer, started together with the app by `npm start`. The helper uses the Claude Code command-line tool that is signed in on this computer, so it uses that subscription and the app stores no API key. Open the app at the address `npm start` prints; the browser keeps data separately for each address. When the helper is not running (for example on a static copy of the app, or offline), the AI features say they are unavailable and why; everything else works as before.
- `AI-2` The AI second opinion is off until it is turned on for this device in the Admin screen, which shows the privacy notice on this page first. Turning it off stops new runs; results already stored remain.
- `AI-3` It runs only when a person chooses "Run AI second opinion". Before it runs, the app shows what will be sent (the app's fixed scoring instructions are added to it) and where. Each run is recorded in the audit log (who, when, the model, and the number of questions; never the content).
- `AI-4` The helper accepts requests only from this computer and only from the app's own page, and limits the size of what it accepts. It runs the model with no tools and no access to files. The transcript is treated as data: instructions that appear inside a transcript are not followed.

### What is sent

- `AI-5` Sent: the transcript text and, for each question in the plan, its text, description, key points, red flags, probes and rubric. Not sent: the candidate's initials, the requisition id, the interviewers' names, any human score, tick or note, and any recording. Before sending, the app lists the speaker names found in the transcript and replaces them with "Interviewer 1", "Candidate" and so on, as chosen by the person running it. Those names are also replaced, as whole words, wherever they are spoken; name parts that are also ordinary words are replaced only when capitalised. The person running it can add other names to replace.

### What comes back

- `AI-6` For each question the result has: a score from 1 to 4, or "not covered in the transcript"; the key points it judged covered; the red flags it judged present; a short rationale; and quotations from the transcript as evidence. The app checks every quotation against the transcript, shows whose words it is, and marks any it cannot find as unverified. A reply that does not fit the expected format is rejected with an error and never shown as scores.
- `AI-7` The AI's overall percentage and band are worked out from its scores with the same maths as a human scorecard (`SCORE-1` to `SCORE-8`). "Not covered" counts as a skipped question: it is left out of the percentage and lowers coverage.
- `AI-8` Each result records the model that produced it, when, and a fingerprint (SHA-256) of the transcript text it was based on. Running again replaces the result; if the transcript has changed since, the result is marked out of date.

### How it is shown

- `AI-9` The result is hidden until the interview's record has been submitted, so it cannot influence the human scores. It can be run earlier; the app then says only that it is ready, when, and with which model. A panelist's file imported from another device never reveals it early (`FLOW-27`).
- `AI-10` The AI second opinion never changes a human score, the panel score, the advisory band or the recorded recommendation. It is not counted in the panel median or spread.
- `AI-11` It is always shown separately and labelled "AI second opinion", with the model name and the words "not a decision": on each scorecard as a column next to the interviewer's scores, and in the debrief as its own column. Questions where the AI and the interviewers differ by two points or more are listed as worth discussing, with the AI's evidence. Exports include it under the same label.
- `AI-12` Interviewers who change their mind after reading it amend the score through the usual amend step, with a reason (`AUD-4`).

## Privacy notice for AI and transcripts

Turning these features on changes what the pilot does with candidate data.

- The transcript leaves this device when the AI second opinion is run: it goes through Claude Code on this computer to Anthropic, under the terms of the subscription signed in there. Check that those terms and your organisation's rules allow candidate interview content to be processed this way.
- A transcript can contain far more personal information than initials: names, employers, voices in a recording. Attach only what you need and keep the retention period short.
- From 10 December 2026, APP 1.7-1.9 require an organisation's privacy policy to say when a computer program is used to make or inform decisions that significantly affect individuals. An AI second opinion on a hiring decision is that kind of use. Privacy/Legal and HR must approve it, and the candidate must be told (`TR-4`), before it is used with real candidates.
