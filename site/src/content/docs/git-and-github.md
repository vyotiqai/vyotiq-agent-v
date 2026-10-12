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

Agent V's own git switches these off. The "Changes" tab says "This repository's git settings run programs. Agent V's git skips them." and lists each one. Diffs and merges fall back to git's built-in ones.

If you set these up yourself, for example with `git-crypt unlock` or `git lfs install --local`, click "Allow for this repo", then "Allow". The allowance covers exactly the settings listed, in this repository and its worktrees. If they change, they are switched off again until you allow them again. Settings in your own global git config are never switched off. The agent's terminal commands are not affected; [Approvals](/docs/approvals) cover those.

## Committing

The "Commit" button in the "Changes" tab opens a menu:

| Item | What it does |
| --- | --- |
| "Commit…" | Commits |
| "Commit & Push…" | Commits, then pushes |
| "Commit & Create PR…" | Commits, pushes and opens a draft pull request. On the default branch it first makes a new `vyotiq/` branch. If the branch already has a pull request, the commit updates it. |
| "Amend last commit…" | Folds the changes into the last commit, with its message in the box to edit. Listed only while that commit is not pushed, is not a merge and is not the repository's first, so it never needs a force push. If another commit lands before you click "Amend", nothing is amended and the tab says so. |

The push and pull request items appear only when the repository has a remote. In the "Staged" scope only staged files are committed; elsewhere every change is.

Each item opens a message box. The agent drafts the message ("Drafted from the diff · edit freely"): a Conventional Commits subject of at most 72 characters and, when the changes have several parts, a short body of bullets. It reads every file the commit takes, with its line counts, and as much of each diff as fits; lockfiles and generated files are listed but not read, so one large file cannot crowd out the rest. It uses the utility model when one is set, and its spend shows in Usage under "Side calls". The draft is written when you open the box; turn on "Draft commit messages ahead" (Settings, "Agent", "Utility model") to have one ready while the tab shows uncommitted work. "Rewrite" asks for a new one (not when amending: the box keeps the commit's own message), `Ctrl+Enter` commits and `Esc` cancels. Typing your own words stops the wait for the draft.

Under the message, the box says where the commit goes and how many files it takes. On "This task", which lists only the task's files, it says "all {n} uncommitted files": Commit there takes every uncommitted change in the workspace. To commit only some, stage them and commit from "Staged". After a commit, a short message has an "Undo" button that takes the commit back while it is not pushed.

While a run is live, the tab says "Commit and Keep/Undo unlock when the run stops." In the "Unstaged" scope the panel menu also has "Stage all".

### Staging part of a file

In the "Unstaged" scope each hunk of a file's diff has a "Stage" button on its header, and in "Staged" an "Unstage" one, in the panel and in the full-width review alike. Only git's index changes; the file stays as it is. If the file changed after its diff was shown, nothing is staged and the tab asks you to look again. The buttons are not offered while "Ignore whitespace" is on, because those hunks are not git's, nor on a new file (it is one hunk; stage the file) or a diff too large to show whole.

### Switching branches

The branch menu in the "Changes" tab switches to another local branch. With uncommitted changes it asks first:

- "Bring them along" switches and keeps your changes in the files. Git refuses when one would be overwritten on the other branch.
- "Leave them on {branch}" puts your changes, untracked files included, in `git stash` on the branch you are leaving, then switches.

Leaving them is refused during a merge, cherry-pick or revert in progress, since a stash would keep the changes but lose the merge.

Back on that branch, the tab shows "Changes you left on {branch}" with a "Restore" button, in whichever scope it is on. Restoring puts them back, staged changes staged, and drops the stash. If one of their new files has been made here since, nothing is restored and the tab names it, so you can move it aside first. If they now conflict with the branch, the files get conflict markers and the row reads "Restored with conflicts"; resolve them, then click "Drop stash". The trash button beside "Restore" drops the changes without restoring them, after asking.

The branch menu waits while a task is running in the workspace, and while another git action runs.

### More than 200 changed files

The tab lists the first 200 changed files and says "Showing first 200 of {n} changed files". "Show all" lists every one, up to 5,000 ("Show 5,000" past that).

### Branches and stashes

The sync menu also has:

- **"Pull with rebase"**: your commits go on top of what the remote has, instead of a merge commit.
- **"Branches…"**: every local branch. "Rename" renames it in place. "Merge in" merges that branch into the one you are on. "Delete" deletes a merged branch at once; for one with commits merged nowhere it asks "Delete an unmerged branch?" first, since those commits are lost unless another branch or a tag has them. The branch you are on cannot be deleted.
- **"Stashes…"**: every stash in the repository, newest first, with its message, branch and file count. "Apply" puts its changes back and keeps it, "Pop" puts them back and drops it, and "Drop" deletes it after asking.

A merge or stash that conflicts says so and leaves the conflict markers for you. None of these runs while a task is working in the checkout.

### A commit's own actions

In the "Commits" scope, the menu on a commit's header has "Revert this commit…" (a new commit that undoes it), "Branch from here…" (a new branch at that commit) and "Copy commit id".

### Keeping up with the remote

While the "Changes" tab is open and the window has focus, Agent V fetches from the remote every few minutes, and when you come back to the window, so the ↑ and ↓ counts beside the branch stay true. Workspaces in one repository, its worktrees and subfolders included, share one fetch: they share its remote branches. A fetch never changes your files. One that fails (no network, or no saved sign-in) is retried quietly later. "Fetch" in the sync menu fetches at once and says what it found.

### Discarding your own changes

In the "Uncommitted" and "Unstaged" scopes each file has a "Discard changes" button (in the full-width review, on the file's header), and the panel menu has "Discard all changes…" ("Discard changes to shown files…" while a filter is on or the list is cut short). Each asks you to confirm first. None of them is offered while a task is running in the workspace.

- In "Uncommitted", a file goes back to its last commit, staged and unstaged changes alike.
- In "Unstaged", only the changes that are not staged go. What is staged stays.
- A file git does not track is moved to the trash.

Before git overwrites a file, a copy of it as it was goes to the trash (the Recycle Bin on Windows), under the file's name, and Agent V keeps a copy of its own. A notice after the discard has an "Undo" button for a few seconds: it puts every discarded file back as it was. A file you changed again since the discard is left alone and named, so Undo never loses later work, and what was staged comes back as an unstaged change. After that, the copies in the trash are still there. An untracked file goes to the trash itself, so restoring it from there puts it back where it was. A file reached through a link is left alone, and so is a file in conflict, which is for the conflict resolver.

The agent can commit and open pull requests too. Those actions ask for your approval unless you have set approvals to "Nothing". See [Approvals](/docs/approvals).

## Connecting GitHub

GitHub features use a sign-in to your GitHub account. There is no token to paste.

1. Open the "PR" tab (`Ctrl+Shift+G`) and click "Connect GitHub".
2. Agent V shows a one-time code and opens GitHub in your browser: "Enter the one-time code on GitHub".
3. Approve the sign-in on GitHub. The tab shows "Waiting for authorisation…" until you do.

This is GitHub's device sign-in. Agent V asks for the `repo` and `read:org` scopes, the two the GitHub CLI needs. The token is saved encrypted on your machine, like your API keys, and is also handed to the GitHub CLI. If the GitHub CLI is already signed in, Agent V uses that sign-in and skips the code. "Disconnect GitHub" in the PR menu signs out Agent V and the GitHub CLI. It is listed while a pull request is showing and Agent V holds its own sign-in.

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

- The local branch is kept if it has commits that are not in the pull request, or is checked out in another worktree.
- The GitHub branch is kept if commits were pushed to it after the merge.
- A branch on someone else's fork is never touched.
- The repository's default branch is never deleted, and a branch merged into itself (a fork's `main` into `main`) is not offered.
- The switch is refused while tracked files have uncommitted changes, or while a task is running in the workspace.

GitHub can restore a deleted branch from the pull request page.

When the base branch merges through a GitHub merge queue, the merge button reads "Add to merge queue" and has no methods: the queue's own settings decide how it merges. It is offered while checks or reviews are still pending too; GitHub then adds the pull request to the queue once they are met, and the tab says "Auto-merge is on: it joins the merge queue once its requirements are met". Once queued, the tab shows "In the merge queue for {base}" with its position, and GitHub merges it when the queue's checks pass. "Leave the queue" takes it out; the tab reads GitHub back afterwards to show where it stands.

When the pull request still waits on something, such as required checks or reviews, and the repository allows auto-merge, "Merge when ready" sits beside the merge button. Pick a method and GitHub merges the pull request by itself once its requirements are met; the branch is not deleted. While it is on, the tab says so, with who turned it on, and "Turn off" cancels it. Where the repository does not allow auto-merge, the pull request is a draft, or the branch has a merge queue, the button is not shown.

### Reviews

Under "Review requested from", type a GitHub login or an `org/team` and click "Request"; the field suggests people who can be asked in this repository. The × beside a name withdraws the request. The list shown afterwards is the one GitHub reports; a request it does not list back, such as one for `@copilot`, is named in the notice; withdraw that one on GitHub.

Under "Submit a review", pick "Comment", "Approve" or "Request changes", write your note, and submit.

### The conversation

"About" shows the description and the pull request's conversation: its comments, oldest first, the latest 50 when there are more. Then a line says "The latest 50 of {n}", with "Show all {n}" to read every comment (up to 1,000) and a link to the conversation on GitHub. A comment GitHub has hidden is folded. Write in the box and click "Comment" to post (`Ctrl+Enter` works too).

The pencil beside "Description" edits the description, with "Write" and "Preview" to see the Markdown as it will read. "Save" is refused when someone changed the description on GitHub after you started, so nothing they wrote is lost; your text stays in the box.

### Failing checks

A failed GitHub Actions check has three controls:

| Control | What it does |
| --- | --- |
| Log | Shows the step that failed, read from that job's own log as soon as the job ends, even while the rest of its workflow runs: the step's output up to the error, without timestamps. |
| "Re-run" | Runs that job again on GitHub, then reads the checks again over the next minute until it shows as queued. While they run, the tab refreshes itself. |
| "Hand to the agent" | Sends the task an instruction to fix it right away, in this form: the check failed on the pull request, "Read its log", "find the cause and fix it". The failing step's lines go with it, marked as CI output and not instructions: a pull request can print anything in its log. |

A check from another CI service has "Hand to the agent" only, with its link. Logs and re-runs need GitHub Actions.

The agent can also read a pull request's checks and their failing steps itself, without asking. Ask it "why is CI red?".

### Review comments for the agent

The agent can read a pull request's discussion itself, without asking: its description, each reviewer's latest review, the review threads still unresolved with their file, line and comments, and the conversation's latest comments. Resolved threads are listed by place only. Ask it to "address the review comments". It reads; it does not reply or resolve threads. Those stay yours, in the "Reviews" section.

### Batched review comments

In a diff, click a line number to comment on that line, or click one and Shift+click another to comment on the range between them. The field takes several lines: Enter sends the comment to the agent at once, as before; Ctrl+Enter (or "Add to review") keeps it instead. Kept comments collect, across files, in a bar above the list, "{n} review comments", which opens to show each with its file and line. "Send to the agent" sends them all as one instruction; "Discard" drops them. A line with a kept comment is marked in the gutter.

### Issues

"Issues" in the PR menu lists the repository's open issues and has a form to create one. Click an issue to read it in full, with its labels and latest comments.

"Start a task" opens New task with a brief written from the issue: its title, link and description (set apart as the author's words), ending in `Fixes #{number}`. Edit it, choose whether it runs in a worktree, and start it. A pull request drafted from that task ends with the same `Fixes #{number}` line, so merging it closes the issue. A closing line on a line of its own in what you write to the task, such as `Closes #7` or `- Fixes: #7.`, is carried too; one inside quoted or fenced text, like the issue's own description, is not.

The agent can list and read issues without asking. Creating one asks for your approval.

## Worktree tasks: Merge or Discard

A task that ran in its own worktree ends with a strip under its record: "Merge into {base}" and "Discard" (or "Remove worktree" after a merge). See [Workspaces](/docs/workspaces#worktree-tasks).
