# Question bank

## Contents

- `BANK-1` The bank ships with four tracks of about 50 questions each. Every question has: a number, text, a description, a category, a difficulty, a type, what to look for (key points), red flags, at least one probe and a time estimate.
- `BANK-2` The Question bank screen lets you browse a track, filter by category, difficulty and type, search the text, and open a question to see its description, its L, R and P lists and the rubric.
- `BANK-8` The **description** is a short plain-language explanation of what the question is asking, written for the interviewer. When a candidate has not understood a question, the interviewer reads it out or paraphrases it to steer them. It restates the question and its scope; it never gives away the key points.

- `BANK-15` Key points and red flags are written for an interviewer who is not a specialist in that topic: each is a full sentence, or a short label followed by what you would actually hear, describing something observable in an answer. The bundled questions have five key points and four red flags each. In the live interview the leading label of a key point or red flag (a short phrase before the first colon), when it has one, is emphasised so the list can be scanned at a glance.

## Managing the bank in the app

The Question bank screen is also the editor. Changes are saved on this device straight away.

- `BANK-9` Questions can be added, edited, duplicated, retired and restored. Every field can be edited: text, description, category, difficulty, type, time estimate, key points, red flags, probes and the optional per-level rubric descriptions (`RUB-2`). Key points, red flags and probes are edited as lists: add, remove and reorder items. The form shows problems next to the field they concern and does not save an invalid question.
- `BANK-10` New questions get the next free number in their track; numbers and ids are never reused. The time estimate is filled in from the table below when the type or difficulty is chosen, and can be changed. Questions are retired, not deleted, so past interviews keep their meaning; a retired question is not offered when building a plan.
- `BANK-11` When a saved edit changes a question's text, description, difficulty, type, key points, red flags, probes or rubric descriptions, its `version` goes up by one. Locked plans keep their own snapshot (`FLOW-8`), so editing the bank never changes an existing interview, and a plan built after the edit has a different fingerprint (`FLOW-9`).
- `BANK-12` Categories can be added and renamed, and their default weight and must-have flag changed. Category ids are made from the name when the category is created and do not change when it is renamed. A category that still has questions cannot be removed. New tracks can be created.
- `BANK-13` Many questions can be added at once by pasting rows from a spreadsheet or importing a CSV file. The app shows a preview with any problems row by row, and imports nothing until the preview is accepted. A track's active questions can be exported as CSV in the same layout.
- `BANK-14` Every bank change is recorded in the audit log with the values before and after. Each track shows whether it has changes that have not been exported.

## Seed files

- `BANK-3` There is one seed file per track in `seed/`. Each is validated against the JSON Schema in `schema/track.schema.json`. Validation runs with `npm run validate:seed` and in CI on every push and pull request; it also checks that question ids and numbers are unique, that every question's `categoryId` exists and that every category is used. It warns when a time estimate differs from the table below, and when a question does not have five key points and four red flags (`BANK-15`).
- `BANK-4` The seed files are the bank's source of truth for a team. To share changes made in the app: export the track from the Question bank screen (the export asks for the new track version), replace the file in `seed/`, and review the diff in a pull request. Seed files can also be edited by hand; when doing so, raise a question's `version` when its meaning changes, and the track `version` so that devices reload it.

Shape of a seed file:

```json
{
  "track": { "id": "aks", "name": "Senior Platform Engineer (AKS with Azure)", "version": "2026.11" },
  "categories": [
    { "id": "aks-networking", "name": "Networking", "weight": 1.0, "mustHave": false }
  ],
  "questions": [
    {
      "id": "aks-11",
      "number": 11,
      "categoryId": "aks-networking",
      "text": "Compare Azure CNI Overlay, Pod Subnet, legacy Node Subnet and kubenet.",
      "description": "We want to hear how the AKS networking models differ, mainly in how pods get IP addresses, and which you would choose today.",
      "difficulty": "advanced",
      "type": "knowledge",
      "timeMin": 4,
      "lookFor": ["Overlay uses private pod CIDR so only nodes consume VNet IPs"],
      "redFlags": ["kubenet for new clusters"],
      "probes": ["Migrating a kubenet cluster?"],
      "version": 1,
      "status": "active",
      "rubricOverride": null
    }
  ]
}
```

- `difficulty` is `core`, `advanced` or `expert`. `type` is `knowledge`, `scenario`, `design` or `behavioural`.
- `status` is `active` or `retired`. Retired questions are not offered when building a plan.
- `rubricOverride` is `null` or an object with optional keys `"1"`, `"2"`, `"3"`, `"4"`, each a replacement description for that level (`RUB-2`).
- Category ids are `<trackId>-<slug of the category name>`. Question ids are `<trackId>-<number>`.
- Key points and red flags are written as full sentences an interviewer can recognise in an answer (`BANK-15`).

## Time estimates

- `BANK-5` Time estimates are assigned by type and difficulty:

| Type | Core | Advanced | Expert |
|---|---|---|---|
| Knowledge | 3 min | 4 min | 5 min |
| Scenario | 5 min | 5 min | 6 min |
| Design | 7 min | 7 min | 8 min |
| Behavioural | 4 min | - | - |

## Loading and versions

- `BANK-6` On first load, and whenever a seed file's track `version` is newer than the one stored, the app loads the seed into the local database. A track that has been changed on this device is never overwritten automatically: the app says a newer bundled version is available and lets you export your changes first, then replace. Locked plans keep their own snapshot of each question (`FLOW-8`), so reloading the bank never changes an existing interview.
- `BANK-7` A track file can be imported (validated against the same schema before it is accepted) and any track can be exported as a track file, from the Question bank screen and the Admin screen. Both are recorded in the audit log.

## Re-check every quarter

The content reflects late-2026 facts. Re-check: AKS ingress (NGINX app routing patches end November 2026); kubenet retirement (31 March 2028); Azure NPM on Linux (September 2028); AKS versions, LTS and upgrade channels; Apigee environment types; Playwright agents; Akamai product names.

Each question has one probe and is scored on the shared scale, made specific by its own L and R lists. Question-specific level descriptions can be added in `rubricOverride` through pull-request review.
