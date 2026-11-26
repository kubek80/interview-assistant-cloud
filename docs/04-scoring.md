# Scoring

All score maths lives in one pure module and is covered by unit tests that reproduce the worked example on this page.

## Per-question value and weight

- `SCORE-1` Each score becomes a value from 0 to 1: `v = (score - 1) / 3`. So 1 → 0, 2 → 0.333, 3 → 0.667, 4 → 1.
- `SCORE-2` Each question has a weight `w = difficulty weight × category weight`. Difficulty weights: core 1.0, advanced 1.5, expert 2.0. Category weight defaults to 1.0 and can be raised for must-have categories (`FLOW-6`).

## Overall and category percentages

- `SCORE-3` `Overall % = sum(w × v) / sum(w) × 100`, counting **answered** questions only. Skipped questions are excluded and listed separately.
- `SCORE-4` A category's percentage uses the same formula over that category's answered questions. A category's *average* is the plain mean of its answered questions' 1-4 scores. A category with no answered questions has no percentage and no average.
- `SCORE-5` Strengths are categories averaging 3.0 or more; concerns are categories averaging 2.0 or less.

## Insufficient evidence

- `SCORE-6` Coverage is `sum(w of answered questions) / sum(w of all planned questions)`. If coverage is below 70%, the scorecard shows **Insufficient evidence** in place of a band. The percentage is still shown, with the coverage figure.

## Bands

- `SCORE-7` Bands, applied to the unrounded overall percentage:

| Band | Overall % |
|---|---|
| Strong hire | 80 or more |
| Hire | 65 to under 80 |
| Lean no hire | 50 to under 65 |
| No hire | below 50 |

- `SCORE-8` Must-have cap: if any must-have category averages below 2.0, the band is capped at Lean no hire (a Strong hire or Hire becomes Lean no hire; lower bands are unchanged). The scorecard says when the cap was applied and which category caused it. A must-have category with no answered questions does not trigger the cap but is shown as a concern ("no evidence").
- `SCORE-9` The band is advisory. A person records the final decision (`FLOW-22`, `FLOW-25`).
- `SCORE-10` Percentages are displayed rounded to the nearest whole number; averages to one decimal place. Band thresholds, the cap and the 70% coverage rule use unrounded values.

## Panel score

- `SCORE-11` The panel score is the median of the panelists' overall percentages (for an even number, the mean of the middle two). A spread (highest minus lowest) above 20 points is flagged.

## Worked example

Four planned questions:

| Question | Difficulty | Category (weight) | w | Score | v | w × v |
|---|---|---|---|---|---|---|
| Q1 | core | Strategy (1.0) | 1.0 | 4 | 1.000 | 1.000 |
| Q2 | advanced | Networking (1.2) | 1.8 | 3 | 0.667 | 1.200 |
| Q3 | expert | Strategy (1.0) | 2.0 | 2 | 0.333 | 0.667 |
| Q4 | advanced | Strategy (1.0) | 1.5 | skipped | - | - |

- Answered: `sum(w) = 4.8`, `sum(w × v) = 2.8667`. **Overall = 59.72%**, displayed as 60%.
- Coverage: `4.8 / 6.3 = 76.2%`, which is at least 70%, so a band is shown.
- Band: **Lean no hire** (50 to under 65).
- Strategy: percentage `(1.000 + 0.667) / 3.0 = 55.56%`, average `(4 + 2) / 2 = 3.0`, so it is a strength. Networking: 66.67%, average 3.0, also a strength.
- If Q3 were also skipped, coverage would be `2.8 / 6.3 = 44.4%`: Insufficient evidence.
- If Q1 scored 4, Q2 scored 4 and Q3 scored 4, the overall would be 100% (Strong hire). If Networking were must-have and Q2 scored 1 with Q1 and Q3 scoring 4, the overall would be 62.5% (Lean no hire already). With Q1 = 4, Q3 = 4, Q4 = 4 and Q2 = 1 with Networking must-have: `sum(w) = 6.3`, `sum(w × v) = 4.5`, overall 71.43% → Hire, capped to **Lean no hire** because Networking averages 1.0.

## Recalibration

Recalibrate the bands and weights after about 10 candidates per track. The .42 validity figure is an average across many settings; these numbers are starting points.
