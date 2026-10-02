---
title: Open a pull request and fix CI
description: Commit the work, open a pull request from the task, and hand a failing check back to the agent in one click.
stage: Bigger jobs
order: 10
teaches: [Commit, PR tab, Hand to the agent]
mode: Agent
brief: |-
  Commit the CSV export on this branch, with a commit message that says what changed and how to test it. Then open a draft pull request.
checks:
  - The commit contains only the files this task changed
  - A draft pull request exists for this branch
docs:
  - { label: Git and GitHub, href: /docs/git-and-github }
  - { label: Approvals, href: /docs/approvals }
---

## When to use it

When a task's work is reviewed and ready for your team. It needs git, the GitHub CLI and a GitHub connection. Open the "PR" tab (`Ctrl+Shift+G`): it offers "Install GitHub CLI" if the CLI is missing, and "Connect GitHub" signs you in once with a one-time code you enter on GitHub. There is no token to paste.

Send the brief in the instruction line of the task that did the work, not as a new task: a commit holds only the files its own task changed.

## What you will see

The commit waits for your approval with its message, and opening the pull request asks too. The pull request takes its title and description from the commits, which is why the brief asks for a good commit message. The "PR" tab then shows it under "Checks", "Files", "Commits", "Reviews" and "About".

When a CI check fails, it has a "Hand to the agent" button. That gives the task an instruction to read the check's log, find the cause and fix it, with the log's link when GitHub provides one. The fix is a normal run: review it, then push it the same way.

## What to check

- The commit holds only the files this task changed, not everything in your working copy.
- Read the commit message before you approve it. The pull request is filled from it, and your team reads that.
- Merging stays your call. The "Squash and merge" button in the "PR" tab is disabled, with the reason on hover, when GitHub would not allow it. A draft has "Mark ready for review" beside it.
