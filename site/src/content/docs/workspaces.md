---
title: Workspaces
description: How Agent V uses a folder as a workspace, the home workspace, recent folders, and running a task in its own git worktree.
group: Start
order: 3
---

A workspace is a folder on your computer. Every task runs in one, and the agent's file tools stay inside it. You can have several workspaces open at once.

## Opening a folder

- **During setup:** step 2, "Open a workspace", has "Choose a folder…". You can also drop a folder onto it.
- **Later:** open the workspace menu at the top of the navigator and pick "Add workspace…".
- **From a `vyotiq://` link:** a link to a task opens its folder too. For a folder you have never opened, Agent V first asks "Open a folder from a link" and shows the path.

The same menu lists your open workspaces, so you can narrow the navigator to one of them or show "All workspaces". It also has "Close {workspace}" for the one you are looking at.

With several workspaces open, `Ctrl+1` to `Ctrl+9` switch between them in the order the navigator lists them.

## Recent folders

Folders you opened before and closed since appear under "Recent" in the workspace menu. One click opens a folder again. The setup page shows up to five of them.

## The home workspace

Agent V always has a workspace open. When no project folder is open, it opens its own folder, `home`, inside the app's data folder. That lets you start a task, or ask a question, before you pick a project. It is not your system's home folder.

## Branch and "Where it works"

When the workspace is a git repository, the "New task" header reads "New task in {workspace} on {branch}".

- **The branch menu** checks out another branch. If you have uncommitted changes, Agent V asks first, because git refuses a checkout that would overwrite them.
- **A "This folder" / "New worktree" menu** sits next to it:

| Choice | What happens |
| --- | --- |
| "This folder" | The task edits your working copy directly. |
| "New worktree" | The task gets its own git worktree and branch. |

"New worktree" is only offered when the branch has at least one commit to branch from.

## Worktree tasks

A worktree task keeps its changes away from your working copy until you decide what to do with them.

- The worktree folder lives under `task-worktrees` in the app's data folder, never inside your project.
- Its branch is named `vyotiq/` plus words from your brief.
- It starts from the branch's last commit. Uncommitted files in your folder stay where they are and are not copied in.

When the run is over, a strip under the record says "Works in its own worktree, from {base}" and how much there is to merge. It has two buttons:

- **"Merge into {base}"** merges the worktree's branch into the branch it came from. If the worktree has uncommitted files, they are committed first, with the task's title as the message. If the merge would conflict, nothing is merged and Agent V tells you how many files conflict.
- **"Discard"** deletes the worktree's folder and its branch. After a merge, the button reads "Remove worktree" instead.

The navigator's view menu has "In place" and "In a worktree" entries, so you can show or hide either kind of task.

Worktrees need git on your PATH. See [Git and GitHub](/docs/git-and-github).

## Per-workspace settings

Some settings can differ per workspace. The approval mode is one of them: setup says "You can change this per workspace." See [Approvals](/docs/approvals).

Each workspace also keeps app data: its tasks, undo points and code index. Settings, "Storage", lists what each workspace uses. With "Delete storage when closing a workspace" on, closing a workspace offers to delete that data too. See [Data and storage](/docs/data-and-storage).
