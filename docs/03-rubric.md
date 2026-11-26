# Rubric

Every question is scored on the same 1-4 scale. A question's own *look for* (L) and *red flags* (R) lists make each level concrete for that question.

- `RUB-1` The scale. Each level's label is shown wherever a score is chosen, with its description on hover, on focus or in the rubric list:

| Score | Label | Description |
|---|---|---|
| 1 | Poor | Any red flag, or under 25% of the key points. The answer is wrong or memorised. |
| 2 | Partial | Some key points but shallow, with no trade-offs or examples. |
| 3 | Solid senior | Most key points, correct and grounded in experience, covering trade-offs. |
| 4 | Exceptional | All key points plus failure modes, alternatives and quantified outcomes. Handles the probe without help. |

- `RUB-2` A question may carry a `rubricOverride` with its own description for any level. When present it replaces the shared description for that question.

## Suggested score

- `RUB-3` The app suggests a score from the ticks, applying the first rule that matches:

| Condition | Suggestion |
|---|---|
| Any red flag ticked | 1 |
| Fewer than 25% of key points ticked | 1 |
| Fewer than 60% of key points ticked | 2 |
| All key points ticked **and** "handled the probe without help" ticked | 4 |
| Otherwise | 3 |

No suggestion is shown until at least one box has been ticked. The interviewer decides the score (`FLOW-14`).

## Evidence

- `RUB-4` A score of 1 or 4 requires a note of what the candidate said (`FLOW-16`).

## Behavioural questions

- `RUB-5` Every behavioural question's key points cover four things, in words specific to that question: a specific real situation; the candidate's own actions; a measurable result; reflection. Its red flags cover three: hypothetical answers; blaming others; no outcome. When a behavioural question is added in the editor, the app offers these as starting items.

## Tags

- `RUB-6` Difficulty: **C** core, **A** advanced, **E** expert. Type: **K** knowledge, **S** scenario, **D** design, **B** behavioural. Behavioural questions carry no difficulty tag in the bank and are treated as core.
