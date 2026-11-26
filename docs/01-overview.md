# Overview

Interview Assistant runs structured interviews: vetted questions, one 1-4 rating scale, key-point checkboxes, independent scoring by each interviewer and a weighted scorecard.

This documentation is the specification of the app. Every numbered requirement (for example `FLOW-3`) is something the app must do, and the [Verification](#/docs/10-verification) page records how each one is checked. If the app and this documentation disagree, that is a bug in one of them.

## Why structured interviews

- **Structure is the biggest lever.** Sackett, Zhang, Berry and Lievens (*Journal of Applied Psychology* 107(11), 2022) report "mean validity estimates of .42 for structured interviews and .19 for unstructured interviews". The same authors' 2023 focal article says the figure "should really be viewed as '.42, plus or minus .24'", so how well an interview is designed still matters.
- **Google re:Work's four elements:** vetted, role-relevant questions; comprehensive written feedback; standardized rubrics describing poor, borderline, solid and outstanding answers; interviewer training and calibration.
- **Concrete descriptions at each rating level (BARS).** Kell et al. (ETS Research Report RR-17-28, 2017) found that "use of BARS to evaluate interviewees' performance is associated with greater predictive validity and reliability and less bias."
- **Rate independently, then discuss (optional in the app).** The US OPM's *Structured Interviews: A Practical Guide* (2008): "Each panel member should independently review his/her notes… and rate the candidate." Only then do panel members compare notes.
- **Evidence before rating.** A score of 1 or 4 requires a note of what the candidate said.

The app enforces these; it does not just store notes.

## What this version is

This is the **MVP pilot** (Option A of the build plan): a single-page app with no backend.

- `OV-1` The app works fully offline after first load, except the optional AI second opinion. All data is stored in the browser (IndexedDB) on this device.
- `OV-2` The question bank is seeded from one JSON file per track. It ships with four senior tracks of about 50 questions each, and can then be changed in the app (see [Question bank](#/docs/05-question-bank)).
- `OV-3` This documentation is available inside the app from the main navigation ("Docs"), and works offline.
- `OV-4` A person records every score and the final decision. The suggested score, the recommendation band and the optional AI second opinion are advisory: none of them is ever applied to, or changes, a human score or decision (`AI-10`).

What it deliberately does not do yet (single sign-on, server-side panels, server audit, scheduled retention) is listed in the [Roadmap](#/docs/09-roadmap).

## The four tracks

| Track id | Name |
|---|---|
| `qa` | Senior QA Engineer |
| `web` | Senior Software Engineer (Web Applications) |
| `edge` | Senior Platform Engineer (Akamai & Apigee) |
| `aks` | Senior Platform Engineer (AKS with Azure) |
