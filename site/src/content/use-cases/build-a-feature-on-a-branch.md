---
title: Build a feature on its own branch
description: Run a bigger task in its own git worktree, so your folder stays as it is until you merge.
stage: Bigger jobs
order: 8
teaches: [New worktree, Plan, Questions]
mode: Agent
brief: |-
  Add CSV export to reports: GET /reports/:id.csv returns the report's rows as CSV, with a header row and the same columns as the JSON response. Ask me before you pick a CSV library.
checks:
  - GET /reports/:id.csv responds with text/csv
  - A test compares the CSV columns with the JSON response
  - pnpm test passes
docs:
  - { label: Workspaces, href: /docs/workspaces }
  - { label: The task record, href: /docs/the-task-record }
  - { label: Git and GitHub, href: /docs/git-and-github }
---

## When to use it

Work that takes more than one sitting, or that you want to keep apart from what you are doing in the same folder. A worktree is a second checkout of your repository on its own branch, so the task can edit and run tests without touching your working copy.

In the header of the "New task" page, switch "This folder" to "New worktree" before you start. It is offered once the branch has at least one commit.

## What you will see

The agent writes a plan first, as it does for every Agent task. Its steps show in the record and tick off as they finish; the full plan is in the inspector's "Plan" tab. Because the brief asks it to, the agent stops at the library choice and asks you with a small form in the record. The run waits for your answer.

When the run is over, a strip under the record says it "Works in its own worktree" and how much there is to merge.

## What to check

- Review the changes as usual, then choose "Merge into" the branch it came from, or "Discard" to delete the worktree and its branch. "Merge into" commits anything uncommitted under the task's title first. After a merge, "Remove worktree" deletes it.
- Uncommitted files in your folder are not copied into the worktree. Commit what the task needs to see first.
- The worktree lives in Agent V's data folder, never inside your project.
