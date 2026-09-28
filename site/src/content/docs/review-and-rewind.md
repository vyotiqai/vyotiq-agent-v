---
title: Review and rewind
description: Review what a task changed in the inspector, keep or undo each file, rewind a task to an earlier instruction, and redo or rerun it.
group: Review and ship
order: 1
---

Every change the agent makes is recorded, so you can look at it, keep it, or take it back.

## The inspector

The inspector is the panel beside the record. `Ctrl+I` shows or hides it, and `Ctrl+Shift+I` expands it to full width. It has six tabs:

| Tab | Key | What it holds |
| --- | --- | --- |
| "Changes" | `Alt+1` | What changed, as diffs |
| "Files" | `Alt+2` | The workspace's files |
| "Terminal" | `Alt+3` | Your shells and the run's own terminal |
| "Browser" | `Alt+4` | The agent's browser |
| "PR" | `Alt+5` | The pull request for this branch ([Git and GitHub](/docs/git-and-github)) |
| "Plan" | `Alt+6` | The task's plan |

On macOS use `⌥` instead of `Alt`.

## Changes

"Changes" can show five scopes:

| Scope | What it lists |
| --- | --- |
| "This task" | Files this task wrote, compared with how they were before it first touched them |
| "Uncommitted" | Everything git sees as changed |
| "Staged" | What is staged for the next commit |
| "Unstaged" | Changes not staged yet |
| "Commits" | Recent commits; pick one to see its files |

The panel menu has "Word wrap", "Ignore whitespace", "Find in changes" and "Refresh". `Ctrl+E` opens the tab.

### Keep or undo each file

In "This task", each file has two buttons:

- **Keep** ("Keep this file as the agent wrote it") accepts the change.
- **Undo** ("Restore this file to its state before the agent wrote it") puts the file back.

The panel menu has "Keep all" and "Undo all" for every file not decided yet. Decided files are marked "Kept" or "Undone".

## Checkpoints and your own edits

Before the agent writes a file, Agent V saves a checkpoint of what was there. It also records a SHA-256 hash of what the agent wrote.

If you edit a file after the agent wrote it, the hashes no longer match. Undo and rewind then leave that file alone instead of overwriting your work. In "Changes" such a file is marked "Edited since".

## Rewind

Rewind takes a task back to before one of your instructions: the record and the files.

1. Hover the instruction in the record and click "Rewind files and record to before this instruction".
2. A dialog asks "Rewind to before run {N}?" and lists each file with what rewinding does to it: an added file is removed, a changed file is put back, a deleted file is brought back.
3. The dialog notes: "Your own edits since then are left alone."
4. Click "Rewind {n} files" (or "Rewind" when no file changes).

Everything after that instruction leaves the record. A short message then says how many files were restored and how many were left as you changed them.

## Redo

A rewind is not thrown away. "It’s kept, so you can redo it until you send a new instruction or change those files."

After a rewind the record shows "Rewound to here. Redo brings back the runs after this instruction", with a "Redo" button. Redo only works while nothing has changed since: once you send a new instruction or edit those files, the rewound runs are gone.

## Edit and rerun

To change an instruction instead of removing it, hover it and click "Edit and rerun". The instruction opens in a box where it was. Edit it, then click "Rerun" ("Rerun with the edited instruction") or press `Enter`. `Esc` cancels.

## Related

- Commit and open a pull request from "Changes": [Git and GitHub](/docs/git-and-github)
- Where checkpoints are stored and how long they are kept: [Data and storage](/docs/data-and-storage)
