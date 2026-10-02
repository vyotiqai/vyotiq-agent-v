---
title: Review and rewind
description: Review what a task changed in the inspector, keep or undo each file, rewind a task to an earlier instruction, and redo or rerun it.
group: Review and ship
order: 1
---

Agent V records the files the agent changes, so you can look at each change, keep it, or usually take it back.

## The inspector

The inspector is the panel beside the record. `Ctrl+I` shows or hides it, and `Ctrl+Shift+I` expands it to full width. It has six tabs:

| Tab | Key | What it holds |
| --- | --- | --- |
| "Changes" | `Alt+1` | What changed, as diffs |
| "Files" | `Alt+2` | The workspace's files |
| "Terminal" | `Alt+3` | What this task ran ("This task"), your own shells, and the run's read-only session |
| "Browser" | `Alt+4` | The agent's browser |
| "PR" | `Alt+5` | The pull request for this branch ([Git and GitHub](/docs/git-and-github)) |
| "Plan" | `Alt+6` | The task's plan |

On macOS use `⌘` for `Ctrl` and `⌥` for `Alt`. These are the default keys; see [Keyboard shortcuts](/docs/keyboard-shortcuts).

## Changes

"Changes" can show five scopes:

| Scope | What it lists |
| --- | --- |
| "This task" | Files this task wrote, compared with how they were before it first touched them |
| "Uncommitted" | Everything git sees as changed |
| "Staged" | What is staged for the next commit |
| "Unstaged" | Changes not staged yet |
| "Commits" | Recent commits; pick one to see its files |

The panel menu has "Word wrap", "Find in changes", "Refresh" and "View pull request". In the git scopes it also has "Ignore whitespace". `Ctrl+E` opens the tab, or hides the inspector when the tab is already showing. In the tab, `Ctrl+F` opens "Find in changes" and `Ctrl+R` refreshes.

In the git scopes, hovering a file shows buttons to stage or unstage it, and the branch name beside the scope switches branch. A conflicted file shows "Both sides changed this file", with "Keep ours", "Keep theirs" and "Save working".

To ask the agent about one line of a diff (outside "Commits"), click its line number and type in the box that opens: "Ask about or change this line — goes to the agent as a follow-up".

### Done-when checks

Once the run has stopped, "This task" starts with the task's done-when checks that are still open. Each says "Not met" or "Not checked before the run ended" and has a button, "Ask it to cover this" or "Ask it to check", that puts an instruction in the task's box for you to send. The checks that passed fold into a line such as "3 of 4 checks met".

### Keep or undo each file

In "This task", hovering a file's row shows two icon buttons in place of its line counts. They wait until the run stops.

- **Keep** ("Keep this file as the agent wrote it") accepts the change.
- **Undo** ("Restore this file to its state before the agent wrote it") puts the file back.

"Keep all" and "Undo all" at the bottom of the tab act on every file not decided yet. In the full-width review they are in the panel menu. Each shows a short message with an "Undo" button. Decided files are marked "Kept" or "Undone". A kept file can go back to review ("Return this file to review"), and an undone one can come back ("Put the agent's version back; it waits on review again").

### The full-width review

`Ctrl+Shift+I` on "Changes" turns the tab into a review of the task: a file list on the left and one file's diff on the right, side by side by default. Tick "Viewed" on each file as you read it; the list counts how many are viewed. A file the agent changes again comes back unviewed. "Back to the record" returns.

## Checkpoints and your own edits

Before the agent's edit tools write a file, Agent V saves a copy of what was there (a checkpoint). It also records a SHA-256 hash of what the agent wrote. A file changed another way, such as by a terminal command, may have no copy.

If you edit a file after the agent wrote it, the hashes no longer match, and Undo and rewind leave that file alone instead of overwriting your work. If an Undo finds the file changed since, "Changes" marks it "Edited since". The rewind dialog lists such a file as "changed since · left as is".

## Rewind

Rewind puts the files back as they were before one of your instructions and removes everything after that instruction from the record. The instruction itself stays.

1. Hover the instruction (or tab to it) and click the rewind icon, "Rewind files and record to before this instruction". It appears once the run has stopped and something follows the instruction.
2. A dialog asks "Rewind to before run {N}?" and lists each file with a letter (A, M or D). Its tooltip says what rewinding does: an added file is removed, a changed file is put back, a deleted file is brought back. A file it will not put back says why, such as "changed since · left as is".
3. The dialog notes: "Your own edits since then are left alone."
4. Click "Rewind {n} files" (or "Rewind" when no file changes).

A short message then says how many files were restored and how many were left as you changed them. It has a "Redo" button.

## Redo

A rewind is not thrown away. The rewind dialog says so: "It’s kept, so you can redo it until you send a new instruction or change those files."

After a rewind the record shows "Rewound to here. Redo brings back the runs after this instruction", with a "Redo" button. Redo works only while nothing has changed since. A new instruction, an edit to those files, or a Keep or Undo ends it.

## Edit and rerun

To change an instruction and run it again, hover it and click "Edit and rerun". The instruction opens in a box where it was. Edit it, then click "Rerun" ("Rerun with the edited instruction") or press `Enter`. `Esc` cancels.

Rerun puts the files and the record back to before that instruction, as Rewind does but without the dialog, then runs the edited instruction. If the task is still running, it stops first.

## Related

- Commit and open a pull request from "Changes": [Git and GitHub](/docs/git-and-github)
- Where checkpoints are stored and how long they are kept: [Data and storage](/docs/data-and-storage)
