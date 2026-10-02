---
title: Git and GitHub
description: What needs git, committing from the Changes tab, connecting GitHub, and working with pull requests and failing checks in the PR tab.
group: Review and ship
order: 2
---

Agent V works in any folder, but its review and shipping features are built on git, and its pull request features on GitHub.

## What needs git

These need Git installed. On Windows, Agent V also finds Git in its usual install folders when it is not on your PATH:

- Worktree tasks ([Workspaces](/docs/workspaces))
- Instances that work in their own worktree ([Instances](/docs/instances))
- The git scopes in "Changes" and committing from there

Without git, the "New task" page does not offer "New worktree", and the git scopes in "Changes" show "Git not found": "Git is not installed or not on PATH". An instance then works in your folder, limited to the paths it was given, or does not start.

If the workspace is not a repository yet, the "New task" page shows "Not a repository" beside "Branch", with an "Initialize" button that runs `git init` there. "Changes" shows "Not a git repository" with an "Initialise repository" button.

## Programs a repository's settings name

A repository's own git settings (its `.git/config`, and a worktree's `config.worktree`) can name programs that git runs during ordinary reads such as `git status`: `core.fsmonitor` when it names a program, the `clean`, `smudge` and `process` commands of a filter, `diff.external`, a diff driver's `textconv` or `command`, and a merge driver. That file comes along with any folder someone hands you.

Agent V's own git switches these off. The "Changes" tab says "This repository's git settings run programs. Vyotiq's git skips them." and lists each one. Diffs and merges fall back to git's built-in ones.

If you set these up yourself, for example with `git-crypt unlock` or `git lfs install --local`, click "Allow for this repo", then "Allow". The allowance covers exactly the settings listed, in this repository and its worktrees. If they change, they are switched off again until you allow them again. Settings in your own global git config are never switched off. The agent's terminal commands are not affected; [Approvals](/docs/approvals) cover those.

## Committing

The "Commit" button in the "Changes" tab opens a menu:

| Item | What it does |
| --- | --- |
| "Commit…" | Commits |
| "Commit & Push…" | Commits, then pushes |
| "Commit & Create PR…" | Commits, pushes and opens a draft pull request. On the default branch it first makes a new `vyotiq/` branch. If the branch already has a pull request, the commit updates it. |

The push and pull request items appear only when the repository has a remote. In the "Staged" scope only staged files are committed; elsewhere every change is.

Each item opens a message box. The agent drafts the message from the diff ("Drafted from the diff · edit freely"), "Rewrite" asks for a new one, `Ctrl+Enter` commits and `Esc` cancels. After a commit, a short message has an "Undo" button that takes the commit back while it is not pushed.

While a run is live, the tab says "Commit and Keep/Undo unlock when the run stops." and offers "Stop run". In the "Unstaged" scope the panel menu also has "Stage all".

The agent can commit and open pull requests too. Those actions ask for your approval unless you have set approvals to "Nothing". See [Approvals](/docs/approvals).

## Connecting GitHub

GitHub features use a sign-in to your GitHub account. There is no token to paste.

1. Open the "PR" tab (`Ctrl+Shift+G`) and click "Connect GitHub".
2. Agent V shows a one-time code and opens GitHub in your browser: "Enter the one-time code on GitHub".
3. Approve the sign-in on GitHub. The tab shows "Waiting for authorisation…" until you do.

This is GitHub's device sign-in. Agent V asks for the `repo`, `read:org` and `gist` scopes. The token is saved encrypted on your machine, like your API keys, and is also handed to the GitHub CLI. If the GitHub CLI is already signed in, Agent V uses that sign-in and skips the code. "Disconnect GitHub" in the PR menu signs out Agent V and the GitHub CLI. It is listed while a pull request is showing and Agent V holds its own sign-in.

### The GitHub CLI

The "PR" tab also uses the GitHub CLI, `gh`. If it is missing, the tab offers "Install GitHub CLI". "Agent V uses winget or Homebrew when available, otherwise downloads gh into app data."

With no remote yet, the "PR" tab says "Agent V will connect the matching GitHub repository or create a private one when you create a pull request." Its "Create a draft PR" button connects a GitHub repository named after the folder, or creates a private one.

## The PR tab

The "PR" tab shows the pull request for the current branch. `Ctrl+R` refreshes it, and it refreshes itself while checks are running. With no pull request yet, it offers "Create a draft PR". When the task has a result, a "New pull request" form comes first, its title and description written from the task's name, result and done-when checks.

| Section | What it shows |
| --- | --- |
| "Checks" | CI checks and their state |
| "Files" | The changed files, as diffs, each of which you can mark as viewed |
| "Commits" | The pull request's commits |
| "Reviews" | Reviews, and a form to submit your own |
| "About" | The description |

The "PR actions" menu has "Copy URL", "Edit title", "Issues", "Close pull request" and "Hide panel", plus "Word wrap", "Ignore whitespace", "Filter files" and "Refresh".

### Merging

The merge button has three methods:

- "Squash and merge"
- "Create a merge commit"
- "Rebase and merge"

Each asks you to confirm. It is disabled, with the reason on hover, when GitHub would not allow the merge. A draft shows "Mark ready for review" instead.

### Reviews

Under "Submit a review", pick "Comment", "Approve" or "Request changes", write your note, and submit.

### "Hand to the agent" for failing checks

A failed check has a "Hand to the agent" button. It sends the task an instruction to fix it right away, in this form: the check failed on the pull request, "Read its log", "find the cause and fix it". The log's link is included when GitHub provides one.

## Worktree tasks: Merge or Discard

A task that ran in its own worktree ends with a strip under its record: "Merge into {base}" and "Discard" (or "Remove worktree" after a merge). See [Workspaces](/docs/workspaces#worktree-tasks).
