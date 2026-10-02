# Rail — the same workflow, a new feel

Mockups of the whole window rebuilt around two ideas. The workflow doesn't
change: tasks grouped by status, the record (brief → work → result), and
changes, files and terminal beside it. Built on the renderer's own stack:
React 19, Tailwind v4, the real `--vy-*` tokens and all five skins, and the
real primitives from `src/renderer/src/lib/ui` (Button, IconButton, Segmented,
Switch, RadioList, Checkbox, Menu, FormGroup/FormRow, StatusGlyph, StepMarker,
DiffStat, ProgressBar, Keys, Tooltip), imported rather than copied.

```sh
pnpm redesign:rail      # http://localhost:5203
```

`?scene=running|wide|needs|review|new|home|usage&skin=<skin>&theme=<light|dark>&size=<1024|1280|1440|1920>&bare=1`

## 1. The rail: panes become sheets that never get lost

- The record, Changes, Files, a file, the Terminal, Browser, Pull request,
  Plan and Settings are all **sheets** standing side by side. Each one is ⅓,
  ½, ⅔ or the full width of the work area, and never narrower than 320px.
- Opening something (a file name in the record, a command, a diff, a shelf
  icon, a palette row) **slides a sheet in beside the one you're in**.
- A sheet that doesn't fit **folds into a spine**: a 36px column at the edge
  with its name running up it, plus a live dot if it's working. Nothing
  scrolls off-screen, and one click on the spine brings it back.
- **The shelf** on the right edge replaces the old inspector's tabs: Changes,
  Files, Terminal, Browser, Pull request, Plan. Open sheets carry a bar; the
  lit one's bar is accent.
- **Drag the edge between two sheets** and it snaps to ⅓ · ½ · ⅔ · full, with
  guides while you drag. The width gauge in the lit sheet's header does the
  same in one click; double-click a header to toggle full width.
- The **lit sheet** sits on `bg` with an accent top edge. The rest recede to
  `chrome`, so emphasis comes from the neighbours.

## 2. The lens: one composer that follows your eyes

- It floats under the **lit sheet**, slides along when focus moves, and names
  what it's looking at (Record, `MentionMenu.tsx`, Terminal, Plan…). The
  placeholder changes with the target.
- **Its top edge is the run**, one segment per step with the live step
  breathing. Type while the run works and a `you` marker shows exactly where
  your words will land. Hover Queue and the marker moves to the end.
- **Steer** (↵) lands between steps. **Queue** (Ctrl+↵) runs after the task.
- **Start with `?`** to ask without changes. **Start with `$`** while looking
  at the Terminal to run a command in the task's shell.
- **Context is a tray of real objects.** `@` picks files and folders.
  **Select text** anywhere (record, diff, file, terminal, plan), and "Ask about
  this" (Alt+A) pins those exact lines, with their line numbers. The pin on a
  terminal card pins its output.
- **Model and effort are one control**: drag, scroll or arrow across five bars,
  and the time estimate follows.
- It fits any sheet. Below 700px the hint, context meter and attach button
  drop out. Below 460px (a ⅓ sheet) it keeps the effort bars and a single
  Steer.

## Every surface

| Surface | Where | What's in it |
| --- | --- | --- |
| Record | task, first sheet | Brief, done-when with evidence, steps with their work (bordered terminal and diff cards), the approval frame, result and receipt |
| Changes | shelf | Files with status and ±, the selected diff, a real commit message, Undo all · Keep all · Commit (disabled while running, with the reason) |
| Files | shelf | Filterable tree with compact folders; changed files marked M / A; opens files as sheets |
| File | any file name | Source with line numbers and the agent's edits on the + gutter |
| Terminal | shelf | Every command the task ran, the live one with a cursor, and `$` runs from the lens |
| Browser | shelf | The page the task is checking, at the 800 / 1600px viewport its check names |
| Pull request | shelf | Draft PR with branch → base and its checks, or an empty state that opens one |
| Plan | shelf | Goal, scope in and out, steps and risks |
| New task | navigator + | Brief in the big lens, done-when checks, what the agent will see |
| Home | navigator | Needs you, running (with step bars), ready for review, workspaces (with the error state), the week |
| Usage | navigator | Stat strip, tasks and tokens per day (7 or 30 days), model mix, tool failures, unchecked edits |
| Extensions | navigator | Installed skills and MCP servers with switches; one that needs sign-in |
| Settings | navigator gear, a sheet | Appearance (skin and theme, live), sheets and lens, agent approvals, models, keys |
| Palette | Ctrl K or the title bar | Tasks, sheets, places, commands, files; `>` for commands only |

## Responsive

- **≥ 1200px**: the full navigator (264px).
- **< 1200px**: the navigator folds to a 56px column of status glyphs, in the
  same groups and with the same peek. Ctrl+B pins either one.
- Sheets never go below 320px; what doesn't fit becomes a spine.
- Wide places (Home, Usage, New task) use container queries, one column to
  two or three, rather than stretching.

## The grid

One gutter (16px, the header's text edge) for every sheet. Sections open with
a 32px caps label. List rows are 32px and bleed their hover fill 8px past the
gutter, so text stays on the edge. Checks and steps share an 18px glyph column
and a 12px gap, so their text lines up. Headers are 40px (`h-10`, `pl-4 pr-2`).
All of this lives in `src/rail/parts.tsx`.

## Keys

| Keys | What |
| --- | --- |
| Ctrl+K | Search tasks, sheets, commands and files |
| Alt+← / → | Previous / next sheet (the lens follows) |
| Alt+Shift+← / → | Move the sheet |
| Alt+[ / ] | Narrower / wider (⅓ · ½ · ⅔ · full) |
| Alt+W | Close the sheet |
| Ctrl+L | Focus the lens |
| Alt+A | Ask about the selection |
| Ctrl+B | Navigator: full or compact |

In the app Ctrl+W would be the natural close. The mockup uses Alt+W because a
browser tab can't intercept Ctrl+W.

## Porting notes

- New CSS is limited to what's in `src/styles.css` under "Proposed
  additions": slot and lens transitions (on only after first paint, off under
  reduced motion), `sheet-recessed`, the breathing segment and the marker.
  Everything reads existing tokens.
- No new icons. No hex values. `cn()` is only ever given ternaries; section
  spacing uses a `flush` prop, never an override.
- The lens replaces the dock's tabs and the per-pane composer. The Terminal
  sheet has no input of its own, because the lens with `$` covers it.
- Charts follow the dataviz rules: one series, no legend, 4px rounded tops on
  the baseline, a stub for zero days, a tooltip on every bar, labels only on
  the peak and today.
- `pnpm exec tsc -p src/redesign/rail/tsconfig.json` and
  `eslint src/redesign/rail` are both clean.
