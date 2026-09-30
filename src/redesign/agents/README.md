# Agents: Cursor's agent window, rebuilt for Agent V

These mockups rebuild the whole window in the register of Cursor's agent window (cursor.com, Sept 2026): tasks by status on the left, the task in the middle, and the inspector's six tabs on the right. The look is quiet and typographic, with one accent. They run on the renderer's own stack: React 19, TypeScript, Tailwind v4 CSS-first, and the real `--vy-*` tokens in all five skins × light/dark. Components are the real primitives from `src/renderer/src/lib/ui` (Button, IconButton, ActionMenu, Tabs, Segmented, Switch, Checkbox, RadioList, StatusGlyph, StepMarker, DiffStat, Pie, Keys, Tooltip, ToastHost) and icons from `lib/icons`, all imported, not copied.

Every control does something. The mockup holds live state, so an approval, an answer, a stop or a commit moves the task everywhere at once: in the list, the record, the header, the side pane, Home and the Inbox.

```sh
pnpm redesign:agents      # http://localhost:5207
```

`?scene=<id>&skin=<skin>&theme=<light|dark>&size=<1024|1280|1440|1920>&bare=1`

## Scenes

| Scene | Shows |
| --- | --- |
| `running` | Step 2 of 4 live. Tests stream in a bordered card, the diff grows in Review, and one follow-up is queued |
| `needs` | An approval in the record, which is the one accent block. The same Allow is in the list row and the Inbox |
| `question` | Two questions before it builds: 1–3 picks, Enter continues, Skip, or type your own answer |
| `review` | A finished task: summary, files, checks with evidence, receipt, rating. Review leads with the check still open |
| `commit` | The commit message drafted when Review opens. Edit it, or commit and open a draft PR |
| `browser` | The page it checked at 800 / 1600px. Pick an element with the mouse or keyboard and it lands in the box as a chip |
| `instances` | A task split across three instances. Each one hangs under its task in the list and opens in place of the record; Back or Esc returns |
| `failed` | What broke, in words, where it broke, with Retry and "Ask it to mock Redis" |
| `new` | Where it runs in the header, the brief with done-when checks inside it, Start task with how it asks, and what the agent will see as a column on the right |
| `home` | All tasks across workspaces, grouped by status or by workspace, with Allow, Answer, Review and Retry in place. The task list steps aside to a rail of places, so the tasks are shown once |
| `inbox` | Asks first, then finished work, then everything else, all answered in place |
| `usage` | Spend, tokens or tasks by day over 7 or 30 days, the model mix, and what failed most |
| `extensions` | MCP servers, skills and rules, each with the one control it needs (a switch, or Sign in) |
| `settings` | One scrolling column; the header follows the section. Defaults are quiet, and changed values are in ink with Reset |
| `palette` | Ctrl K: tasks, then actions, then files. `>` narrows to actions |
| `models` | Model and effort in one popover. Effort says what it costs before you pick it |

## What it takes from Cursor

- **Three flush columns** with one hairline between each.
- **Rows with a live second line**: "Running pnpm test --filter api", in the shimmer the app already uses for live labels. A group says its state once, on its heading; a row wears a glyph only when it stands some other way (queued, failed, stopped), in the same right-hand column.
- **The brief in a quiet box, work as verb-first lines**: "Read src/server.ts", "Thought 4s", and "Explored 6 files, 2 searches", which folds open.
- **Edits as file chips** with ±; each opens its file in the Files tab, with Back to the tree.
- **Numbered answers** to a question.
- **One composer box** in the app's anatomy: mode, model · effort, then a labelled `Send ↵` (`Queue ↵` while it works, plus `Send now ⇧↵` once there is text). Stop is in the task header. `@` mentions a file and `/` runs a skill.
- **The inspector's six tabs**, always there in one order (Review, Files, Terminal, Browser, PR, Plan), saying what waits in them (Review's count) or that the task works there now (a live dot). The Browser picks elements.

## Where it goes further

- **Needs you is its own group, first.** A waiting command can be allowed from the row, the Inbox or Home, and the task moves to In progress on the spot.
- **The plan is the header's bottom hairline**: one segment per step. Done steps are quiet ink, the live step breathes, a step that needs you is solid accent, and a failed one is red. Rows say `2/4`.
- **Instances hang under their task** with their own live verbs, and each opens in place of the record with its own work. The task's second line ("2 of 3 instances working") is also what folds them.
- **Done-when checks** sit under the brief while it works and come back with evidence. Review leads with the unmet one; the met ones fold to a count there, because the record already lists them.
- **Settling is reversible.** Keep all, Undo all, Commit, Stop and Archive each say so in a toast with Undo or Resume.
- **Edit and rerun** rewinds to the brief: the task's edits are undone, so Review empties, and it plans again.
- **A new file drops the diff's green wash.** Every row is an addition, so the tint says nothing. It keeps the `+` gutter and one line-number column. Excerpts say how many changed lines they leave out.
- **Once a task stops working, nothing in its record still moves.** A running command becomes "Stopped · 15s" and live lines go.

## Keys

| Keys | What |
| --- | --- |
| Ctrl K | Search tasks, files and commands |
| Ctrl N | New task (Ctrl Enter starts it) |
| Ctrl I / Ctrl Shift I | Side pane: show or hide / full width |
| Ctrl B | Show or hide the task list |
| Alt 1–6 | Review, Files, Terminal, Browser, PR, Plan |
| Alt ↑ / ↓ | Previous or next task |
| Ctrl . | Stop the task (the header's Stop) |
| Enter / Shift Enter | Send; while it runs, Queue / Send now |
| Shift Tab | Agent or Ask |
| 1–3, Enter | Answer a question |
| Esc | Close a popover, stop picking, leave full width, back from an instance |

## How it is built

- `data.ts`: 14 sample tasks across two workspaces. Each has its own record, diffs, terminal history and commit draft, and none borrows another's.
- `store.tsx`: one reducer holds everything that happens in a session. `useActions` wraps the settling actions so their toasts fire once under StrictMode.
- `runtime.ts`: derives what every surface shows (record, status, diffs, terminal, tree) from base data plus session state.
- Menus are the app's `ActionMenu`, and toasts are the app's `ToastHost`.

## Rules kept

- No hex values. Every colour is a token, and all 5 skins × 2 themes render.
- `cn()` only ever gets ternaries, and no class is appended to override another.
- Icons come only from `lib/icons`; no new icons were needed.
- Terminal and diff output stay in bordered cards.
- The 36px title band holds only the mark, the list toggle, search and window controls.
- Radios and checks are `RadioList` / `CheckMark` / `Checkbox`. Focus rings are on everything, and picked elements are keyboard-reachable.
- Type sizes come only from the scale (`2xs` keycaps, `caption` → `display`).

New CSS is only what `src/styles.css` lists under "Proposed additions": the breathing segment, a 4px rise, the terminal caret, a height fold, the picker outline, and "mono text is literal" (no ligatures).

## Earlier picks this keeps

An earlier pass departed from four of your picks; all four are back, matching the app:

- **Group headings carry the state glyph once**; rows show one only for an exception, hung before the age ([navigator pass](../../renderer/src/app/navigator/Navigator.tsx)).
- **The composer's action is a word**: `Send ↵`, `Queue ↵`, `Send now ⇧↵`, and `Start task` on New task; Stop is in the header.
- **The side pane is the inspector's six fixed tabs**, in the inspector's order. A file opens inside Files; an instance opens in place of the record.
- **"What the agent will see" is New task's right-hand column** (under the brief when the column is narrow), each fact a way to where you change it.

**Vocabulary stays "task"** rather than Cursor's "agent", so it never collides with the Agent mode.

## Checks

`tsc -p src/redesign/agents/tsconfig.json` and `eslint src/redesign/agents` are clean. Every scene is captured in dark and light at 1440, plus 1024 and two other skins. 28 scripted flows pass against a production build with no console errors: allow from the list, answer both questions, Keep all, Commit, Stop, start a task, hover card, row menu, `@` and `/` pickers, hide list + full width, split diff, Retry, dictation, follow-up, palette, all workspaces, archive, edit and rerun, Alt ↓, allow from the Inbox, Always allow, Send now, an instance and back, a file in Files and back, Alt 5/6, the New task facts, and the Home rail.
