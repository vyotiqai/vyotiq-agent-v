---
title: Keyboard shortcuts
description: Every keyboard shortcut in Agent V, grouped by what it does.
group: Reference
order: 1
---

On macOS, `Ctrl` is `⌘`, `Alt` is `⌥` and `Shift` is `⇧`. Settings, "Shortcuts" lists most of them with the right keys for your system. The keys below are the defaults; you can change most of them.

## Changing a shortcut

In Settings, "Shortcuts", click "Change" beside a shortcut and press the keys you want. `Esc` cancels. A chord needs `Ctrl` or `Alt` (a function key works on its own). The app refuses keys another shortcut already uses, naming it, and keys text fields and the system own: copy, paste and undo, the text-size keys, and on macOS `⌘H`, `⌘Q` and `⌘M`. "Reset" puts one back; "Reset all shortcuts" puts them all back.

`Esc` (stop the run) and the numbered keys for workspaces and inspector tabs can't be changed. Neither can the keys Settings lists for reference only: `Alt+A` and `Alt+D` on an approval, `Shift+Enter`, `↑` in an empty instruction line, `End` and `Home` in the record, and the text-size keys.

## Getting around

| Shortcut | What it does |
| --- | --- |
| `Ctrl+K` | Search and commands |
| `Ctrl+Shift+P` | Search and commands (alternate) |
| `Ctrl+B` | Show or hide the navigator |
| `Ctrl+Shift+H` | Home |
| `Ctrl+,` | Settings |
| `Ctrl+J` | Next task that needs you |
| `Alt+↑` / `Alt+↓` | Previous or next task in the list (not while typing) |
| `Ctrl+1` to `Ctrl+9` | Switch to workspace 1 to 9 |
| `Ctrl+W` | Close task tab |
| `Ctrl+\` | Open a second task pane |

The command palette (`Ctrl+K`) also runs things without a shortcut: "Usage", "Inbox", "Extensions", "Add workspace…", "What’s new", "New task in {workspace}", every theme and skin ("Theme: Dark", "Skin: Proof"), and, with a task open, "Rename task", "Archive or unarchive task", "Fork task", "Show or hide reasoning" and "Delete task…". Type a setting's name to get it as "Settings: {name}". Those act on the task in the focused pane, under the same rules as its menu: a running task can't be archived, forked or deleted until it stops.

## Tasks

| Shortcut | What it does |
| --- | --- |
| `Ctrl+N` | New task |
| `Ctrl+Enter` | Start the task from the "New task" page |
| `Ctrl+.` | Switch between Ask and Agent mode |
| `Shift+Tab` | Switch between Ask and Agent mode (in an empty box) |
| `Ctrl+L` | Focus the instruction line, or the Browser tab's address bar when that tab is open |
| `Enter` | Send, or "Queue" while a run is live |
| `Shift+Enter` | "Send now": send an instruction into the live run |
| `↑` | Edit the last prompt (in an empty instruction line) |
| `Esc` | Stop the run |
| `Ctrl+M` | Dictation |

## Approvals

| Shortcut | What it does |
| --- | --- |
| `Alt+A` | Allow the pending approval once |
| `Alt+D` | Deny the pending approval |

## The record

| Shortcut | What it does |
| --- | --- |
| `Ctrl+F` | Find in the record, changes, or pull request |
| `Enter` / `Shift+Enter`, or `F3` / `Shift+F3` | Next or previous match while find is open |
| `End` | Jump to latest |
| `Home` | Jump to top |

## Inspector and panels

| Shortcut | What it does |
| --- | --- |
| `Ctrl+I` | Show or hide the inspector |
| `Ctrl+Shift+I` | Expand the inspector to full width |
| `Alt+1` to `Alt+6` | Inspector tabs: Changes, Files, Terminal, Browser, PR, Plan |
| `Ctrl+E` | Changes panel, or hide the inspector when Changes is already showing |
| `Ctrl+Shift+E` | Files panel |
| ``Ctrl+` `` | Terminal panel |
| `Ctrl+Shift+B` | Browser panel |
| `Ctrl+Shift+G` | Pull request panel |
| `Ctrl+Shift+D` | Plan panel |
| `Ctrl+R` | Refresh changes or the pull request |
| `Ctrl+Shift+F` | Find in files |

Inside a panel, a few keys work only there and can't be changed:

| Shortcut | Where | What it does |
| --- | --- | --- |
| `Ctrl+S` | Files | Save the open file |
| `Ctrl+W` | Files | Close the open file's tab |
| `Ctrl+Enter` | Commit message | Commit |
| `Esc` | Commit message | Cancel the commit (the run keeps going) |
| `Alt+Shift+T` | PR | Edit the pull request's title |
| `/` | Settings | Go to the settings search |

## Text size

| Shortcut | What it does |
| --- | --- |
| `Ctrl+-` | Smaller text |
| `Ctrl+=` | Larger text |
| `Ctrl+0` | Reset text size |

See [Appearance](/docs/appearance) for the text size setting.

## Dictation keys

`Ctrl+M` starts a take anywhere you can type a brief or an instruction. Press it again to insert the words. With "Hold to talk" on in Settings, "Voice", you hold the shortcut while you speak and let go to insert. See [Writing a task](/docs/writing-a-task#dictation).

## In the navigator

| Keys | What they do |
| --- | --- |
| `Ctrl`-click, or `Ctrl+Space` on a focused task | Add a task to the selection, or take it out |
| `Shift`-click, or `Shift+Space` | Select every task from the last one you picked to this one |
| `↑` / `↓`, `Home` / `End` | Move between rows |
| `F2` | Rename the focused task |
| `Delete` | Delete the focused task (asks first) |
| `Shift+F10` or the menu key | Open the focused task's menu |
| `Esc` | Clear the selection, or close search |
| `↓` in search | Move to the first matching task |

## Screen readers

A screen reader hears when a task finishes, fails, or needs you: a finished task politely, the other two at once. It follows the same switches as the inbox in Settings, "Notifications", and speaks for the task in front of you too.
