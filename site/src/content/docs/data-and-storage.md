---
title: Data and storage
description: Where Agent V keeps settings, keys, task records, undo points, logs, worktrees and memory, and what leaves your computer.
group: Reference
order: 3
---

Agent V keeps its data on your computer. Nearly all of it lives in one app data folder, called `userData` below. On Windows that folder is `%APPDATA%\vyotiq`.

## What is stored where

| What | Where |
| --- | --- |
| Settings | `userData/settings.json` |
| Repositories allowed to run their git programs | `userData/git-command-trust.json` |
| Your hooks, and which workspace hooks you allowed | `userData/hooks.json`, `userData/hook-trust.json` |
| API keys and the GitHub sign-in | `userData/secrets.json`, each value encrypted with your system's secure storage |
| Task records | `userData/workspaces/<id>/sessions/<runId>/`, one folder per task |
| Undo points (checkpoints) | `checkpoints/` inside the task's folder |
| "Allow for this task" grants | `approvals.json` inside the task's folder |
| Where the task went on the network | `egress.json` inside the task's folder |
| Drafts | `userData/workspaces/<id>/drafts.json` |
| Code index | `userData/workspaces/<id>/codeindex/` |
| Instance worktrees | `userData/workspaces/<id>/instance-worktrees/` |
| Worktree tasks | `userData/task-worktrees/` |
| Agent-built tools | `userData/agent-tools/` |
| Dictation models | `userData/dictation/models/` |
| Code index embedding model | `userData/embed/models/` |
| Logs | `userData/logs/` |
| The home workspace | `userData/home/` |
| Workspace memory | `.vyotiq/memory/` inside your project |

`<id>` is an id Agent V gives each workspace folder. Workspace memory is the one item in your project rather than in `userData`, so it travels with the folder and can be committed like any other file.

If `settings.json` is damaged, Agent V starts with default settings and keeps the damaged file beside it as `settings.json.corrupt-<time>`, and the inbox says "Settings couldn't be read". If the file is there but can't be read, for example because another program holds it open, Agent V doesn't save any settings until it can read the file again. That way your saved settings are never replaced with defaults.

Settings, "Diagnostics", shows the logs path and has "Open folder". Logs are "always written locally", whether or not crash reporting is on.

## Settings as a file

Settings, "About", "Settings file" has three actions.

- "Export…" saves your settings to a JSON file. It leaves out API keys and sign-ins (they never leave the key vault), MCP servers, custom endpoint headers, and things that only make sense on this computer: pinned and archived tasks, your microphone, paused index folders, and your custom CSS path.
- "Import…" reads such a file and lists what would change before anything does. Each setting is checked on its own, so one bad value is left out rather than the whole file. Some settings are never taken from a file, because a file someone hands you must not decide them: where your saved keys are sent (the Ollama and Custom base URLs), the proxy, crash reporting, the diagnostics command, what runs without asking, sites the browser opens without asking, and autonomous mode. Custom endpoints in the file are added next to yours; yours keep their URLs and none is removed.
- "Reset all…" puts every setting back to its default after asking. It keeps API keys and sign-ins, custom endpoints, the provider and model tasks use, MCP servers, your rules, and pinned and archived tasks.

## Keeping storage in check

Settings, "Storage" covers "What Agent V keeps on disk, and when it lets go of it." It shows what each workspace uses and has these controls:

| Setting | Default |
| --- | --- |
| "Clean up undo points" | On. Undo points are kept for 30 days, and those of the newest 20 tasks per workspace are always kept. |
| "Delete old tasks" | Off. Nothing is deleted on a schedule. |
| "Clean up untracked storage" | On, after a 30-day "Grace period" |
| "Delete storage when closing a workspace" | On. Closing a workspace offers to delete its app data too. |
| "Managed size cap" | 5 GB. "Past this, the oldest undo points are evicted until it fits." |

"Free up space now" runs a cleanup on demand. It "Shows what it would delete first. Nothing from the last 24 hours."

Removing old undo points means you can no longer undo or rewind those tasks' edits. See [Review and rewind](/docs/review-and-rewind).

## Uninstalling

On Windows, uninstalling Agent V also deletes its app data folder, with your settings, keys and task history. It does not ask first, so copy the folder somewhere else before you uninstall if you want to keep it. Updating does not delete it. Uninstalling does not touch your projects, so `.vyotiq/` folders inside them stay.

## What leaves your computer

Nothing is uploaded to a Vyotiq server. The places Agent V connects to are:

- **Your model provider**, with your key, to run tasks. A key goes only to the provider it belongs to.
- **GitHub**, to check for updates (at start and every 6 hours; nothing downloads on its own), and for pull requests once you connect it.
- **Hugging Face**, to download a dictation model or the code index's embedding model. Both then run on your machine.
- **models.dev**, at start, for model details such as context windows and the OpenCode Go model list.
- **Cloudflare (1.1.1.1)**, a small request to see whether you are back online, only while a run waits for the network.
- **OpenAI or OpenRouter**, for dictation, if you pick one of them. The default is OpenAI. Pick "This PC" to keep audio local.
- **MCP servers you add, web pages** the agent opens or fetches, and the search engine set in Settings, "Tools", when the agent searches the web.

"Share crash and error reports" is off by default. When on, "Reports never include task contents, API keys, or file bodies."

Read the full [privacy policy](/privacy), and the [security page](/security) for how the app guards keys and commands.
