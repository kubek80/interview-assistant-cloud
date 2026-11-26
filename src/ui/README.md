# UI primitives (for screen authors)

Import from `src/ui` (barrel) and `src/db` (data). Screens never write to IndexedDB directly and never `console.log` candidate data (PRIV-3).

## Page rules
- Render exactly one `<h1>` per screen, immediately (even while loading): use `<PageHeader title actions subtitle />`. The layout focuses it on route change (A11Y-2).
- Colour is never the only signal (A11Y-3): badges, meters and statuses always carry text or an icon.
- Text from notes/files is rendered as React text, never as HTML (SEC-2).
- No inline `<style>`/`style="..."` strings and no `eval` (CSP, SEC-1). The React `style={{...}}` prop is fine (it uses CSSOM), but prefer classes.
- Use `.no-print` / `.print-only` for the print layout (FLOW-31).

## Components
| Name | Notes |
|---|---|
| `Button` | `variant: default/primary/danger/ghost`, `size: sm/md/lg`, `icon`, `shortcut="N"` (shows `<kbd>`, sets aria-keyshortcuts). `aria-pressed` styles as toggled. |
| `IconButton` | `icon`, `label` (required accessible name). |
| `Field` | Wraps one control: `label`, `hint`, `error`, `required`, `hideLabel`; wires id/aria-describedby/aria-invalid. |
| `TextInput`, `TextArea`, `Select` (`options`, `placeholder`), `Checkbox` (`label`, `description`) | Plain controls with styles. |
| `Dialog` | Native `<dialog>`: focus trap, Esc, focus return (A11Y-1). `open`, `onClose`, `title`, `footer`, `wide`. `data-autofocus` marks the first focus. |
| `ConfirmDialog` | `onConfirm` (may be async), `danger`. |
| `ReasonDialog` | Required reason text (FLOW-17 skip, AUD-4 amend). `onSubmit(reason)`; thrown errors are shown in the dialog. |
| `Card`, `Alert`, `EmptyState`, `PageHeader` | Layout blocks. `Alert tone=info/success/warning/danger`. |
| `Badge`, `Tag`, `QuestionTags` | `QuestionTags` shows RUB-6 letters. |
| `BandBadge` | `band`, `insufficientEvidence`, `capped`; always says "Advisory" (FLOW-25). |
| `SessionStateBadge`, `QuestionStatusBadge` + `answerStatus(answer)` | FLOW-1, FLOW-20 statuses (`unanswered/scored/skipped/flagged/needs-note`). |
| `Meter` | `label`, `value`, `max`, `valueText`, `tone`, `status` (visible text). |
| `useToast()` | `{ toast(message, tone), announce(message) }`. `announce` is screen-reader only (A11Y-4: announce timer state changes once). |
| `DocLink req="SCORE-6"`, `HelpLink slug="04-scoring" section="bands"` | Contextual help into the in-app docs. |
| `Icon name=...` | Inline SVG set (see `Icon.tsx`). |

## Hooks and helpers
- `useHotkeys({ '1': fn, n: fn, '?': fn, Escape: fn }, { enabled, allowInText: ['Escape'] })` – KEY-2 rules built in; suppressed while a dialog is open.
- `useNow(intervalMs = 1000, enabled = true)` – epoch ms for timers; combine with `elapsedMs(timer, now)` from `domain/timer`.
- `useOnline()`, `useDocumentTitle(title)` (no candidate data in titles).
- `downloadFile(name, mime, text)`; `readJsonFile(file)` (result is untrusted; pass to the db import functions, which validate).
- Formatters: `formatPct`, `formatAverage`, `formatCoverage` (SCORE-10), `formatDuration(ms)` (mm:ss), `formatSeconds`, `formatDurationLong`, `formatDate`, `formatDateTime`, `formatMinutes`.

## Tokens (`src/styles/tokens.css`)
- Colour: `--color-bg/surface/surface-2/border/border-strong/text/text-muted/heading`, one accent `--color-accent(-hover/-contrast/-soft)`, `--color-focus`, `--color-highlight`, status `--color-{success,warning,danger,info}` + `-bg` + `-solid` (bars), bands `--band-{strong-hire,hire,lean-no-hire,no-hire}(-bg)`. Light and dark themes are automatic.
- Type: `--text-xs … --text-2xl`, `--text-question` (live question, class `.question-text`), `--text-question-candidate` (`.question-text--candidate`).
- Space: `--space-1 … --space-7`; radius `--radius-sm/--radius/--radius-lg`; `--target-min: 24px`.
- Utility classes: `.stack(-sm/-lg)`, `.cluster(-lg)`, `.spread`, `.grid-2`, `.grid-3`, `.grow`, `.muted`, `.small`, `.mono`, `.tabular`, `.pre-wrap`, `.visually-hidden`, `.table-wrap` + `.table` (`.num` cells, `.table--compact`), `.segmented`, `.kbd`.
