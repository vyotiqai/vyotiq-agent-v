---
title: Workspaces
description: How Agent V uses a folder as a workspace, the home workspace, recent folders, and running a task in its own git worktree.
group: Start
order: 3
---

A workspace is a folder on your computer. Every task runs in one, and the agent's file tools stay inside it. You can have several workspaces open at once.

## Opening a folder

- **During setup:** step 2, "Open a workspace", has "Choose a folder…". You can also drop a folder onto it.
- **Later:** open the workspace menu at the top of the navigator and pick "Add workspace…". Settings, "General", has "Add workspace" too.
- **From the command line or Explorer:** start Agent V with a folder, `Vyotiq.exe C:\code\api`, or `.` for the folder you are in, and it opens that folder as a workspace, starting the app if it isn't running. On Windows the installer adds "Open in Agent V" to a folder's right-click menu in Explorer. On macOS, drop a folder on the Dock icon. On Windows, Settings › General › Command line can also put a `vyotiq` command on your PATH, so `vyotiq .` works from any terminal; Remove takes it off again, and so does uninstalling.
- **From a `vyotiq://` link:** a link to a task opens its folder too. A task's "Copy link", in its menu in the navigator, makes one. Other tools can link to `vyotiq://open?ws=<folder>` to open a folder, or to `vyotiq://new?ws=<folder>&brief=<text>` to open New task there with the brief filled in; it is never sent until you start it. For a folder you have never opened, Agent V first asks "Open a folder from a link" and shows the path.

With more than one workspace open, the same menu narrows the navigator to one of them or shows "All workspaces". While it shows one workspace, it also has "Close {workspace}".

With several workspaces open, `Ctrl+1` to `Ctrl+9` (`⌘1` to `⌘9` on macOS) switch between them in the order the workspace menu lists them. These keys can't be rebound.

## Recent folders

Folders you opened before and closed since appear under "Recent" in the workspace menu. One click opens a folder again. The menu and the setup page each show the five most recent.

## The home workspace

Agent V always has a workspace open. When no project folder is open, it opens its own folder, `home`, inside the app's data folder. That lets you start a task, or ask a question, before you pick a project. It is not your system's home folder.

## Branch and "Where it works"

When the workspace is a git repository, the "New task" header reads "New task in {workspace} on {branch}". With more than one workspace open, the workspace name is a menu that moves the brief to another one.

- **The branch menu** checks out another branch. If you have uncommitted changes, Agent V asks first, because git refuses a checkout that would overwrite them.
- **At the right end of the header**, a two-way switch picks where the task works:

| Choice | What happens |
| --- | --- |
| "This folder" | The task edits your working copy directly. |
| "New worktree" | The task gets its own git worktree and branch. |

The switch only shows in a git repository that is on a branch with at least one commit. Otherwise the task works in this folder. In a folder that isn't a git repository, the "Branch" line beside the brief reads "Not a repository" and offers "Initialize".

## Worktree tasks

A worktree task keeps its changes away from your working copy until you decide what to do with them.

- The worktree folder lives under `task-worktrees` in the app's data folder, never inside your project.
- Its branch is named `vyotiq/` plus words from your brief.
- It starts from the branch's last commit. Uncommitted files in your folder stay where they are and are not copied in.
- The worktree opens as its own workspace in the navigator.

Worktrees need git on your PATH. See [Git and GitHub](/docs/git-and-github).

When the run is over, a strip under the record says "Works in its own worktree, from {base}" and how much there is to merge. It has two buttons:

- **"Merge into {base}"** asks first, then merges the worktree's branch into the branch it came from. The folder it came from must be on that branch. If the worktree has uncommitted files, they are committed first, with the task's title as the message. If the merge would conflict, nothing is merged and Agent V tells you how many files conflict.
- **"Discard"** asks first, then deletes the worktree's folder and its branch and closes its workspace. After a merge, the button reads "Remove worktree" instead.

## Finding and tidying tasks

The navigator groups tasks by what they need from you: "Needs you", "Running", "Ready for review", "Pinned", "Drafts", then "Earlier" by day. A task's menu (right-click it) has "Pin", "Archive", "Rename" and "Delete", among others, and also "Open beside" (the task in a second pane next to the one you are in), "Mark as unread" / "Mark as read", "Repeat…" (see [Scheduled tasks](/docs/scheduled-tasks)) and "Show folder in Explorer" ("Reveal folder in Finder" on macOS, "Show folder" on Linux), which opens the task's folder (its worktree, for a worktree task) in your file manager. The view menu (the filter icon) hides groups, shows "Unread only", and lists archived tasks with "Show archived".

The magnifier at the top of the navigator searches your tasks. From two characters, titles match as you type. A moment later the navigator also lists tasks with a match inside them, from you, the agent or a tool, with the matching line under the task. Search covers the workspaces the navigator shows and includes archived tasks. Matches in tasks the list hasn't loaded yet appear under "Older tasks". A very long task is searched from its newest 16 MB, and a search that stops early says "so far".

To tidy several tasks at once, `Ctrl`-click them (`⌘`-click on macOS; `Shift`-click selects a range). A bar at the top says how many are selected and offers "Archive" and "Delete…"; a running task in the selection is left out. The view menu's "Archive all done" archives every task under "Earlier" in the workspaces the navigator shows, including ones the view menu hides. Pinned tasks and tasks waiting for review stay. Archiving shows "Undo"; deleting asks first, then shows "Undo" too.

A deleted task is not gone at once: it waits 30 days in "Recently deleted…", in the view menu. There each one has "Restore", which puts it back where it was, and "Delete now"; "Empty Recently deleted" deletes them all for good. After 30 days a deleted task is removed when the app starts.

`Alt+←` and `Alt+→` (or the mouse's back and forward buttons) move back and forward through the tasks and pages you opened, as in a browser. The archive keeps up to 500 tasks, and archiving past that brings the oldest back into view.

## Opening files in your editor

Agent V opens a file, or a whole folder, in the editor you already use:

| From | What opens |
| --- | --- |
| The Files tab: a tab's or a file's menu, "Open in editor" | That file or folder |
| The Changes tab: the editor button on a file's row | That file |
| A file named in an answer: `Ctrl`-click it (`⌘`-click on macOS) | That file, at the line the answer names |
| A task's menu in the navigator: "Open folder in editor" | The task's folder (its worktree, for a worktree task) |
| `Ctrl+K`: "Open workspace in editor" | The workspace in front |
| An instance's pane: "Open in editor", beside its worktree's branch | The instance's worktree |

Settings, "General", "Editor", "Open files in" picks the editor: VS Code, Cursor, Windsurf, Zed, Sublime Text, WebStorm, IntelliJ IDEA, PyCharm, or "The default app for the file". "Auto", the default, takes the first of them it finds, in the order Cursor, VS Code, Windsurf, Zed, Sublime Text, then the JetBrains IDEs, and says which one in brackets. An editor whose launcher isn't installed reads "(not found)".

Agent V finds an editor by its command-line launcher on your PATH: `code`, `cursor`, `windsurf`, `zed`, `subl`, `webstorm`, `idea` or `pycharm`. Most editors install it from their command palette (VS Code: "Shell Command: Install 'code' command in PATH"). With "Auto" and none found, the file opens in the system's default app; with a named editor that isn't on the PATH, Agent V says so instead.

## Per-workspace settings

Some settings can differ per workspace. To give a workspace its own settings, turn on its switch in Settings, "General", under "Workspaces". Rows that then save for that workspace only are marked "this workspace". The approval mode ("Ask before", in Settings, "Agent") is one of them. See [Approvals](/docs/approvals).

Each workspace also keeps app data: its tasks, undo points and code index. Settings, "Storage", lists what each workspace uses under "Workspaces". With "Delete storage when closing a workspace" on (the default), closing a workspace offers to delete that data too and shows its size first. See [Data and storage](/docs/data-and-storage).
