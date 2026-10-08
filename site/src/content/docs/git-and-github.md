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
| "Amend last commit…" | Folds the changes into the last commit, with its message in the box to edit. Listed only while that commit is not pushed and is not a merge, so it never needs a force push. |

The push and pull request items appear only when the repository has a remote. In the "Staged" scope only staged files are committed; elsewhere every change is.

Each item opens a message box. The agent drafts the message from the diff ("Drafted from the diff · edit freely"), "Rewrite" asks for a new one, `Ctrl+Enter` commits and `Esc` cancels. After a commit, a short message has an "Undo" button that takes the commit back while it is not pushed.

While a run is live, the tab says "Commit and Keep/Undo unlock when the run stops." and offers "Stop run". In the "Unstaged" scope the panel menu also has "Stage all".

### Staging part of a file

In the "Unstaged" scope each hunk of a file's diff has a "Stage" button on its header, and in "Staged" an "Unstage" one. Only git's index changes; the file stays as it is. If the file changed after its diff was shown, nothing is staged and the tab asks you to look again. The buttons are not offered while "Ignore whitespace" is on, because those hunks are not git's.

### Switching branches

The branch menu in the "Changes" tab switches to another local branch. With uncommitted changes it asks first:

- "Bring them along" switches and keeps your changes in the files. Git refuses when one would be overwritten on the other branch.
- "Leave them on {branch}" puts your changes, untracked files included, in `git stash` on the branch you are leaving, then switches.

Back on that branch, the tab shows "Changes you left on {branch}" with a "Restore" button. Restoring puts them back, staged changes staged, and drops the stash. If they now conflict with the branch, the files get conflict markers and the stash is kept until you resolve them. Switching waits while a task is running in the workspace.

### Keeping up with the remote

While the "Changes" tab is open and the window has focus, Agent V fetches from the remote every few minutes, so the ↑ and ↓ counts beside the branch stay true. A fetch never changes your files. One that fails (no network, or no saved sign-in) is retried quietly later. "Fetch" in the sync menu fetches at once and says what it found.

### Discarding your own changes

In the "Uncommitted" and "Unstaged" scopes each file has a "Discard changes" button, and the panel menu has "Discard all changes…". Each asks you to confirm first.

- In "Uncommitted", a file goes back to its last commit, staged and unstaged changes alike.
- In "Unstaged", only the changes that are not staged go. What is staged stays.
- A file git does not track is moved to the trash.

Before git overwrites a file, a copy of it as it was goes to the trash (the Recycle Bin on Windows), so a discard can be taken back from there. A file in conflict is left for the conflict resolver.

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
| "Reviews" | Reviews, who a review is requested from, and a form to submit your own |
| "About" | The description, which you can edit, and the conversation, where you can comment |

The "PR actions" menu has "Copy URL", "Edit title", "Issues", "Close pull request" and "Hide panel", plus "Word wrap", "Ignore whitespace", "Filter files" and "Refresh".

### Merging

The merge button has three methods:

- "Squash and merge"
- "Create a merge commit"
- "Rebase and merge"

Each asks you to confirm. It is disabled, with the reason on hover, when GitHub would not allow the merge. A draft shows "Mark ready for review" instead.

Once the pull request is merged, here or on GitHub, the tab offers "Clean up {branch}". It switches the workspace to the base branch and pulls it, then deletes the merged branch here and on GitHub. Nothing is lost on the way:

- The local branch is kept if it has commits that are not in the pull request.
- The GitHub branch is kept if commits were pushed to it after the merge.
- A branch on someone else's fork is never touched.
- The switch is refused while tracked files have uncommitted changes, or while a task is running in the workspace.

GitHub can restore a deleted branch from the pull request page.

When the pull request still waits on something, such as required checks or reviews, and the repository allows auto-merge, "Merge when ready" sits beside the merge button. Pick a method and GitHub merges the pull request by itself once its requirements are met; the branch is not deleted. While it is on, the tab says so, with who turned it on, and "Turn off" cancels it. Where the repository does not allow auto-merge, the button is not shown.

### Reviews

Under "Review requested from", type a GitHub login or an `org/team` and click "Request"; the field suggests people who can be asked in this repository. The × beside a name withdraws the request. The list shown afterwards is the one GitHub reports.

Under "Submit a review", pick "Comment", "Approve" or "Request changes", write your note, and submit.

### The conversation

"About" shows the description and the pull request's conversation: its comments, oldest first, the latest 50 when there are more. A comment GitHub has hidden is folded. Write in the box and click "Comment" to post (`Ctrl+Enter` works too).

The pencil beside "Description" edits the description. "Save" is refused when someone changed the description on GitHub after you started, so nothing they wrote is lost; your text stays in the box.

### Failing checks

A failed GitHub Actions check has three controls:

| Control | What it does |
| --- | --- |
| Log | Shows the step that failed, read from the job's log: the step's own output up to the error, without timestamps. |
| "Re-run" | Runs that job again on GitHub, then reads the checks again. While they run, the tab refreshes itself. |
| "Hand to the agent" | Sends the task an instruction to fix it right away, in this form: the check failed on the pull request, "Read its log", "find the cause and fix it". The failing step's lines go with it. |

A check from another CI service has "Hand to the agent" only, with its link. Logs and re-runs need GitHub Actions.

The agent can also read a pull request's checks and their failing steps itself, without asking. Ask it "why is CI red?".

### Issues

"Issues" in the PR menu lists the repository's open issues and has a form to create one. Click an issue to read it in full, with its labels and latest comments.

"Start a task" opens New task with a brief written from the issue: its title, link and description, ending in `Fixes #{number}`. Edit it, choose whether it runs in a worktree, and start it. A pull request drafted from that task ends with the same `Fixes #{number}` line, so merging it closes the issue.

The agent can list and read issues without asking. Creating one asks for your approval.

## Worktree tasks: Merge or Discard

A task that ran in its own worktree ends with a strip under its record: "Merge into {base}" and "Discard" (or "Remove worktree" after a merge). See [Workspaces](/docs/workspaces#worktree-tasks).
