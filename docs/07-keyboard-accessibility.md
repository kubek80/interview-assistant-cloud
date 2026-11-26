# Keyboard and accessibility

## Shortcuts in the live interview

- `KEY-1` Shortcuts, active when focus is not in a text field:

| Key | Action |
|---|---|
| `1` `2` `3` `4` | Set the score |
| `N` | Next question |
| `P` | Previous question |
| `F` | Flag or unflag the question |
| `S` | Skip the question (asks for a reason) |
| `C` | Toggle the candidate view |
| `/` | Focus the notes field |
| `Esc` | Leave the notes field or close a dialog |
| `?` | Show this list |

- `KEY-2` Shortcuts never fire while typing in a text field, and never when a modifier key (Ctrl, Alt, Cmd) is held.

## Accessibility

The target is WCAG 2.2 AA.

- `A11Y-1` Everything can be done with the keyboard alone. Focus is always visible. Dialogs trap focus, close with `Esc`, and return focus to the control that opened them.
- `A11Y-2` Pages use semantic HTML: one `h1` per screen, landmarks, real buttons and links, and labelled form fields. Screen changes move focus to the new screen's heading, or to its single primary action when the screen exists only to confirm one step (the ready screen).
- `A11Y-3` Colour is never the only signal: timer states, question statuses, bands and chart bars also carry text or an icon. Text and controls meet AA contrast in both the light and the dark theme.
- `A11Y-4` Timers do not announce every second to screen readers. The change to amber or red is announced once.
- `A11Y-5` Charts have a text alternative: the same figures are available as a table.
- `A11Y-6` The app respects the system light or dark preference and the reduced-motion preference. Interactive targets are at least 24 by 24 CSS pixels.
- `A11Y-7` An automated axe scan of every screen reports no serious or critical violations. Automated scans catch only part of the problems; a manual keyboard and screen-reader check is still needed before wider use.
