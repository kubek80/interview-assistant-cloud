# Interview Assistant

Interview Assistant runs structured interviews: vetted questions, one 1-4 rating scale, key-point checkboxes, independent scoring by each interviewer and a weighted scorecard. This is the **MVP pilot**: a single-page app (Vite, React, TypeScript) with no backend. All data is stored in the browser's IndexedDB on the device, and the app works offline after the first load.

## Pilot limits

- The pilot identifies a candidate by **name or initials** (up to 60 characters, whichever the team prefers) and an optional requisition id (no e-mail, phone or address), and makes no recordings itself. A transcript or recording made elsewhere (Teams, Zoom) can be attached to an interview when the candidate has been told (`TR-1` to `TR-4`); it stays on the device and is deleted with the interview.
- Data sits on the interviewer's device. There is no central access control, no encryption beyond what the device provides, and retention is enforced only when the app is opened. Use a managed, disk-encrypted device.
- **Privacy/Legal and HR must sign off** on retention, the consent wording and the advisory band before the tool is used with real candidates. See `docs/06-data-privacy.md`.

## Documentation is the specification

The pages in [`docs/`](docs/) are the specification. Every numbered requirement (for example `FLOW-3`) is something the app must do. The same pages are bundled into the app and shown under **Docs** in the main navigation, offline too.

[`docs/10-verification.md`](docs/10-verification.md) lists every requirement id with how it is checked and its status. A unit test (`src/docs/traceability.test.ts`) fails if a requirement id in docs 01-09, 11 or 12 is missing from that page, if the page names an id that no longer exists, or if it cites an automated test file that does not exist or has no test mentioning the id. Change the docs and the verification page together.

## Running an interview

1. **Dashboard › New interview.** One screen: choose the role and type the candidate's name or initials (the first time, also your name). A balanced question set is already drawn (`FLOW-33`, `UX-2`): **Shuffle** draws another, **Edit questions** opens the list in place to reorder (drag or arrow buttons), remove, add from the bank, change the mix or check coverage (`UX-3`). Requisition id, more interviewers, recording or transcription, how long to keep the record, weights and the set's name are under **More options**; reusing an earlier interview's questions is one link away. Everything is saved as you type.
2. **Continue** fixes the questions for this interview (`FLOW-8`) and opens the **ready screen**. With the candidate present, read the consent text, tick the box and press **Start interview** (`FLOW-7`, `FLOW-10`). Until then the interview can be discarded and set up again.
3. Interview, finish, and compare in the scorecard and debrief (`docs/02-interview-flow.md`).

## Working as a team

There is no server: people on different computers exchange small files (`docs/12-planning-and-panels.md`).

1. **Plan.** The organiser plans interviews ahead: **New interview › Save for later** for one (date, time, interviewers, a note), or **Dashboard › Plan several** to paste a list from a spreadsheet (candidate, date, time, requisition id, interviewers; one per line) and plan them all with the same questions in one go. They wait under **Upcoming**, grouped by day (`TEAM-1`, `TEAM-2`, `TEAM-15`).
2. **Send invitations.** Export an **invitation file** for one interview, a selection, a day, or all of them, and send it to the interviewers the way your organisation allows for candidate information (`TEAM-3`).
3. **Everyone imports and interviews.** Each interviewer opens **Import files** on their own Dashboard and chooses the invitation: the interviews appear under Upcoming with the same questions. **Start** opens the ready screen with the consent text as usual. Importing a changed invitation updates what has not started (`TEAM-4`).
4. **Send back interview files.** After submitting, each interviewer exports their **interview file** from the scorecard or debrief and sends it to the organiser (`FLOW-26`).
5. **The organiser imports them.** **Import files** takes several files at once and of any kind (invitations, interview files, question sets); each interview file is matched to its interview, and the Dashboard shows who has submitted and who is still to come (`TEAM-5`, `TEAM-6`).
6. **Debrief.** The debrief shows everyone's figures side by side with the panel's median and spread. Other people's scores show as soon as they are imported; to score independently, turn on **Admin › This device › Hide other people's scores until I have submitted mine** (`FLOW-27`).

7. **Fill the gaps.** Someone scored on paper or sent their view by e-mail? On the candidate's page (or in the debrief) choose **Add another interviewer's judgement**: their name (those still to come are suggested), overall rating, recommendation and a sentence of rationale; question scores are optional, in a grid where typing 1–4 moves to the next question. It is labelled "entered by you on behalf of …" everywhere and can be corrected later with a reason (`TEAM-7`, `TEAM-8`).
8. **Decide.** **Record panel decision** (debrief or candidate page): pick the agreed recommendation, write one sentence, save. Who took part defaults to the panel; an agreed rating and agreed question scores are optional ("Start from the panel's median" fills them only when pressed). A decision needs no judgements behind it, and changing it later asks for a reason (`TEAM-9` to `TEAM-12`).
9. **Summarise.** **Summary** (main navigation) lists every candidate: outcome (the panel decision, else each recommendation with a count, split or agreed), score with where it comes from (agreed scores, panel median, one interviewer) and the advisory band, strengths and concerns, and what is still missing. Click a state in the count line to chase it (for example "waiting for judgements"); sort any column; filter by role, requisition, outcome and dates; search by name. Candidates asked different questions are grouped by question set; "Compare by category" opens the category matrix for one set. Each candidate's page has the details and a **written summary** for the hiring manager, saved as you type (`SUM-1` to `SUM-4`, `SUM-6`).
10. **Hand over.** **Summary › Export** gives the round report as Markdown, a printable page (save as PDF) or the table as CSV, and **Panel file for everyone shown**: one file with every judgement, decision and written summary, which the hiring manager imports with **Import files** to see the same Summary. Transcripts and AI second opinions are included only when ticked; recordings never. If a decision or summary in the file differs from the one on that computer, nothing is overwritten: the import asks "Keep mine" or "Take theirs" (`SUM-5`, `TEAM-13`).

With thirty or more interviews, the Dashboard's count line, search by candidate and filters by role, requisition and state keep it manageable (`TEAM-16`). Interviews an organiser planned for others leave Upcoming once someone has submitted, and the organiser is never counted as a missing judgement unless named as an interviewer. "Draft with AI" for the written summary (`SUM-4`) is not built yet.

## Run, build and test

Requires Node 22.

```sh
npm ci
npm run dev            # development server
npm start              # build if needed, then serve the app with the local AI helper (see below)
npm run build          # type-check and build the static app into dist/
npm run preview        # serve dist/ locally
npm run typecheck
npm test               # unit tests (Vitest)
npm run test:server    # local AI helper tests (Node test runner)
npm run validate:seed  # check seed/*.json against the schema and the BANK-3 checks
npm run e2e            # end-to-end tests (Playwright) against the production build
```

`npm run e2e` builds the app and serves it with the local helper (`server/index.mjs`, as `npm start` does) on port 4173, with the helper pointed at the fake Claude Code CLI (`server/test/fake-claude.mjs`), so the AI second opinion runs end to end with no network and no real model call. Two more helper instances on ports 4174 and 4175 answer with output that does not fit and slowly (for the error and cancel tests); stop anything else using ports 4173-4175 first. It needs a Chromium that matches the pinned `@playwright/test` version; on a new machine run `npx playwright install chromium` once (CI runs `npx playwright install --with-deps chromium`). Set `E2E_SCREENSHOT_DIR=<folder>` to save screenshots of every screen from the accessibility tests.

CI (`.github/workflows/ci.yml`) runs the seed validation, type check, unit tests, build and end-to-end tests on every push and pull request.

## AI second opinion (optional)

The app can score an interview transcript with AI **on top of** the human scoring (`docs/11-interviewers-transcripts-ai.md`, `AI-1` to `AI-12`). It never changes a human score, the panel score or the decision. Read the privacy notice on that page, and get Privacy/Legal and HR approval, before using it with real candidates.

**How it works.** The AI runs through a small local helper (`server/`, plain Node, no dependencies) that uses the **Claude Code command-line tool (`claude`) signed in on this computer**, so it uses that Claude subscription and the app stores no API key. Install Claude Code and sign in once (run `claude` in a terminal), then:

```sh
npm start              # builds dist/ if it is missing or out of date, then serves the app and the helper
```

Open the address it prints (`http://localhost:4173/`). The helper serves the built app and the AI endpoints from that one origin, listens on 127.0.0.1 only, accepts requests only for `localhost`/`127.0.0.1` on its port and only from the app's own origin, limits request size, and runs one AI request at a time. Without the helper (a static copy of the app, `npm run preview`, offline) the AI features say they are unavailable; everything else works as before.

For each run the helper starts `claude -p` in an empty temporary folder with no tools (`--tools ""`), no MCP servers, no user or project settings, no saved session, a fixed system prompt that treats the transcript as untrusted data, and a JSON Schema for the reply. The prompt goes on standard input, never through a shell. The helper logs only timing, sizes and status codes, never the transcript, questions or the AI's reply.

| Setting | Default | Meaning |
|---|---|---|
| `PORT` | `4173` | Port of the app and helper (`0` picks a free one). The browser keeps the app's data per address, so keep using the same one. |
| `AI_MODEL` | Claude Code's default | Model name or alias passed to `claude --model`, e.g. `AI_MODEL=sonnet npm start`. |
| `AI_TIMEOUT_MS` | `300000` | A run that takes longer is stopped. |
| `CLAUDE_BIN` | `claude` on `PATH` | Path to the CLI. On Windows use the native `claude.exe` (a `.cmd` shim is refused because it would need a shell). |
| `SKIP_BUILD=1` | off | `npm start` serves `dist/` as it is. |

**What is sent** (shown to the person before every run, `AI-3`): the transcript, with speaker names replaced by "Candidate", "Interviewer 1" and so on and those names also scrubbed from what was said (`AI-5`); and for each planned question its text, description, key points, red flags, probes and rubric. **Not sent:** the candidate's name or initials, the requisition id, the interviewers' names, any human score, tick or note, and any recording. The transcript goes from the helper to Claude Code, which sends it to Anthropic under the subscription signed in on this computer.

**What comes back** (`AI-6`): per question a score from 1 to 4 or "not covered in the transcript", the key points and red flags it judged present, a short rationale and verbatim quotations. The app rejects any reply that does not fit the expected format and checks every quotation against the transcript; quotations it cannot find are marked unverified. The AI's percentage and band use the same maths as a human scorecard, with "not covered" counted like a skipped question (`AI-7`).

**Development.** `npm run dev` does not include the helper. Run it in a second terminal with `npm run helper` (it serves the API on port 4173, and `dist/` if built); the Vite dev server forwards `/api` to it (`AI_HELPER_PORT` changes the port). To try the flow without a Claude sign-in, point the helper at the fake CLI used by the tests: `CLAUDE_BIN=server/test/fake-claude.mjs npm run helper` (`FAKE_CLAUDE_MODE=invalid|hang|not_signed_in|...` exercises the error paths). `npm run test:server` runs the helper's tests (CI runs them too).

**Using it.** Turn it on for the device in **Admin › AI second opinion** (off by default; the privacy notice from `docs/11` is shown and must be acknowledged). The admin page shows whether the helper is ready (Claude Code version and model) or why not. A static copy of the app makes no request to the helper at all: the app first checks, with a `HEAD` request for its own page, for the `X-Interview-Assistant-Helper` header that only the helper sends.

Set up an interview with **"This interview will be recorded or transcribed"** ticked (New interview › More options; the choice is remembered per device) so the consent text on the ready screen includes the recording sentence (`TR-4`). If it was not ticked, attaching asks you to confirm the candidate has since been told. Then attach the transcript under **Transcript & recording**: in the live interview (a button in the header) or on the scorecard (its own section). Paste text or choose/drop a `.txt`, `.vtt`, `.srt` or `.docx`; a recording (audio or video) can be attached for playback only, and clicking a timestamp in the transcript plays it from there. **Run AI second opinion…** goes through three steps: who is speaking (names become "Candidate", "Interviewer 1", …; you can add other names to replace), exactly what is sent and where, then the run (with cancel). It can be run during the interview, but the result stays hidden until the interview is submitted (`AI-9`); the scorecard then shows it in its own "AI second opinion" section and column, beside the human figures, with a "worth discussing" list for differences of two points or more and a link to the usual amend step (`AI-12`). The debrief shows it as its own column, outside the panel median and spread. Markdown, CSV and print exports include it under the same label; **session files for the panel never include the transcript, the recording or the AI result**.

Storage: transcripts, recordings and AI results are kept in IndexedDB against the interview (Dexie schema version 4) and are removed by the retention purge, a deletion request and erase-all. An access request includes the transcript and the AI result and says whether a recording is held; Admin then offers each recording as a separate download. The audit log records attaching, replacing and removing (type and size only, never the content or file name) and every run (model, number of questions; never the content).

Code: transcript import in `src/domain/transcript/` (`.txt`, `.vtt` including Teams and Zoom, `.srt`, Teams `.docx`), the AI logic in `src/domain/ai/`, the browser client in `src/ai/client.ts`, storage in `src/db/attachments.ts`, the screens in `src/pages/transcript/` and `src/pages/scorecard/AiSection.tsx`, and the helper in `server/`.

## Hosting

`npm run build` produces a static site in `dist/` with relative paths and hash routing, so it can be served from any static host or sub-path (for example an internal web server or Azure Static Web Apps). Serve it over HTTPS (or `localhost`) so the service worker can install; that is what makes the app work offline. No server-side code or API is needed. The page ships a Content Security Policy that allows only its own scripts and styles and no connections to other origins (`media-src blob:` is allowed so an attached recording can play from the device). On static hosting the AI second opinion says it is unavailable; everything else works.

After a new deploy, the service worker picks up the new version on the next visit and the page after that uses it.

## Changing the question bank

The bank's source of truth is the seed files in [`seed/`](seed/), one per track (`BANK-4`). Each is checked against [`schema/track.schema.json`](schema/track.schema.json).

**In the app (no Git or JSON needed).** Open **Question bank**. Add, edit, duplicate, retire and restore questions, manage categories, create a track, or paste many questions at once from a spreadsheet (**Bulk add**; a CSV template is offered there). Changes are saved on that device straight away and every change is in the audit log. Editing a question's wording, description, difficulty, type or lists raises its version, so new plans get a new fingerprint while existing interviews keep their own copy (`BANK-11`, `FLOW-8`).

To share the changes with the team:

1. On the Question bank screen choose **Export track file…** and accept (or change) the suggested track version, for example `2026.11` to `2026.11.1` or `2026.12`.
2. Replace `seed/<track>.json` with the downloaded file.
3. Run `npm run validate:seed` and open a pull request; review the diff.

**By hand.** Edit `seed/<track>.json` directly, keep the documented key order, raise a question's `version` when its meaning changes, raise the track `version` so devices reload it (`BANK-6`), then run `npm run validate:seed`.

`npm run validate:seed` checks the schema, that question ids and numbers are unique, that every `categoryId` exists and that every category is used (`BANK-3`). It also warns when a time estimate differs from the `BANK-5` table, when a question does not have five key points and four red flags (`BANK-15`), and when a description is still a placeholder.

The bundled bank has 207 questions: QA 50, Web Applications 54, Akamai & Apigee 53, AKS with Azure 50 (track version `2026.11.1`). Key points and red flags are full sentences, often "Short label: what you would hear", written for an interviewer who is not a specialist (`BANK-15`); behavioural questions cover the `RUB-5` themes in their own words (the editor offers the themes as starting items for a new one).

A device that has changed a track itself never has it overwritten by a newer bundled seed: the app says a newer version is available and offers to export the local changes first, then replace.

Question descriptions (`BANK-8`) were merged into the seed files once with `node scripts/merge-descriptions.mjs`, which reads `content/descriptions.json` (question id to description). It can be re-run safely; it only changes descriptions.

The full-sentence key points and red flags, and seven new questions (web 51-54, edge 51-53), were loaded once with `node scripts/apply-rewrites.mjs <exportDir>` from the spreadsheet rewrite's JSON files (the header of the script lists them). It replaces only `lookFor` and `redFlags`, raises each changed question's `version`, appends the new questions and sets the track version to `2026.11.1`; re-running it changes nothing.

Question sets keep their own copy of each question once an interview uses them (locked plans), so a bank change never alters an interview that has already been set up.
