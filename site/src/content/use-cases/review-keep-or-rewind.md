---
title: Review, keep or rewind
description: Decide what stays. Keep or undo each file the task wrote, or take the whole task back to an earlier instruction.
stage: First steps
order: 3
teaches: [Changes, Keep and Undo, Rewind]
mode: Agent
brief: |-
  Rename the helper formatMoney to formatCurrency everywhere in src, and update its tests.
checks:
  - pnpm typecheck passes
  - pnpm test passes
  - No file in src still mentions formatMoney
docs:
  - { label: Review and rewind, href: /docs/review-and-rewind }
  - { label: The task record, href: /docs/the-task-record }
---

## When to use it

After every task that changed files. A rename across a project is a good one to practise on, because it touches many files and some of them may not be ones you wanted changed.

## What you will see

Press `Ctrl+E` to open "Changes" in the inspector. Under "This task" each file the task wrote has its diff and two buttons: "Keep" accepts it, "Undo" puts it back.

If the whole direction was wrong, not one file, rewind instead: hover your instruction in the record and click "Rewind files and record to before this instruction". The dialog lists what happens to each file before anything changes.

## What to check

- Files you edited yourself after the agent wrote them are marked "Edited since" in Changes and "changed since" in the rewind dialog. Undo and rewind leave those alone, so your own work is not overwritten.
- Keep what is right and undo the rest; you do not have to take a task's work all or nothing.
- Rewinding removes everything after that instruction from the record too, so you can give a better instruction and run it again.
