---
title: Terminal
description: The Terminal tab — your own shells beside the agent's commands, find, copy, clear, rename, other shells, and handing output to the agent.
group: Reference
order: 7
---

The "Terminal" tab in the inspector holds your own shells, opened in the workspace folder, beside a read-only view of the commands the agent runs. With a task open, its first tab is "This task": the list of every command the task ran, with its output.

## Tabs

The row at the top lists the tabs: "This task", the agent's session ("Agent", read-only, with the program it is running), then your shells. "+" opens a new shell, and the split button shows two side by side. A tab closes with its × or a middle click.

## The ⋯ menu

The ⋯ at the end of the row has:

| Item | What it does |
| --- | --- |
| "New terminal" · PowerShell, Command Prompt, Git Bash, WSL | A tab with that shell (on macOS and Linux, PowerShell and bash) |
| "Find" | A find row over the tab's output, also `Ctrl+F` in the terminal. It starts at the newest match; `Enter` and `Shift+Enter` step through, `Esc` closes it |
| "Copy all output" | The tab's whole output, as text |
| "Clear" | Clears the screen; the shell keeps running |
| "Rename…" | Names the tab. The agent's session keeps its name |
| "Ask the agent about this output" | Hands the selected text, or the end of the output, to the agent as an instruction you can edit before sending |

## Which shell

"+" opens the shell set in Settings, "Tools", "Terminal": "Shell" (also the agent's) or, when set, "Shell program", which is for your own tabs only, such as `zsh`, `fish` or `nu`, by name or full path. The agent keeps its "Shell".

## Commands from the record

A command card's menu in the record has "Run in my terminal": it opens (or uses) one of your shells, types the command and runs it. See [The task record](/docs/the-task-record).

`@Terminal output` in an instruction hands the agent the last lines of your newest tab. See [Writing a task](/docs/writing-a-task#mentions).
