---
title: Git and GitHub
description: What needs git, committing from the Changes tab, connecting GitHub, and working with pull requests and failing checks in the PR tab.
group: Review and ship
order: 2
---

Agent V works in any folder, but its review and shipping features are built on git, and its pull request features on GitHub.

## What needs git

Git must be installed and on your PATH for:

- Worktree tasks ([Workspaces](/docs/workspaces))
- Instances that work in their own worktree ([Instances](/docs/instances))
- The git scopes in "Changes" and committing from there

Without git these fail with "Git is not installed or not on PATH". If the workspace is not a repository yet, the "New task" page shows "Not a repository" beside "Branch", with a button to run `git init` there.

## Committing

The "Commit" button in the "Changes" tab opens a menu:

| Item | What it does |
| --- | --- |
| "Commit…" | Commits |
| "Commit & Push…" | Commits, then pushes |
| "Commit & Create PR…" | Commits, then creates a pull request |

The push and pull request items appear only when the repository has a remote. While a run is live the button is disabled: "Commit unlocks when the run stops". The panel menu also has "Stage all".

The agent can commit and open pull requests too. Those actions ask for your approval unless you have set approvals to "Nothing". See [Approvals](/docs/approvals).

## Connecting GitHub

GitHub features use a sign-in to your GitHub account. There is no token to paste.

1. Open the "PR" tab (`Ctrl+Shift+G`) and click "Connect GitHub".
2. Agent V shows a one-time code and opens GitHub in your browser: "Enter the one-time code on GitHub".
3. Approve the sign-in on GitHub. The tab shows "Waiting for authorisation…" until you do.

This is GitHub's device sign-in. Agent V asks for the `repo`, `read:org` and `gist` scopes. The token is saved encrypted on your machine, like your API keys, and is also handed to the GitHub CLI. If the GitHub CLI is already signed in, Agent V uses that sign-in and skips the code. "Disconnect GitHub" in the tab's menu signs out.

### The GitHub CLI

The "PR" tab also uses the GitHub CLI, `gh`. If it is missing, the tab offers "Install GitHub CLI". "Agent V uses winget or Homebrew when available, otherwise downloads gh into app data."

When you create a pull request, "Agent V will connect the matching GitHub repository or create a private one" if the workspace has none yet.

## The PR tab

The "PR" tab shows the pull request for the current branch. `Ctrl+R` refreshes it.

| Section | What it shows |
| --- | --- |
| "Checks" | CI checks and their state |
| "Files" | The changed files, as diffs |
| "Commits" | The pull request's commits |
| "Reviews" | Reviews, and a form to submit your own |
| "About" | The description |

The menu adds "Copy URL", "Edit title", "Issues" and "Close pull request".

### Merging

The merge button has three methods:

- "Squash and merge"
- "Create a merge commit"
- "Rebase and merge"

It is disabled, with the reason on hover, when GitHub would not allow the merge.

### Reviews

Under "Submit a review", pick "Comment", "Approve" or "Request changes", write your note, and submit.

### "Hand to the agent" for failing checks

A failed check has a "Hand to the agent" button. It gives the task an instruction to fix it, in this form: the check failed on the pull request, "Read its log", "find the cause and fix it". The log's link is included when GitHub provides one.

## Worktree tasks: Merge or Discard

A task that ran in its own worktree ends with a strip under its record: "Merge into {base}" and "Discard" (or "Remove worktree" after a merge). See [Workspaces](/docs/workspaces#worktree-tasks).
