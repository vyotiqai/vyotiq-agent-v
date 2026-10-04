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
| Saved traces | `userData/traces/` |
| Extensions | `userData/marketplace/` |
| The home workspace | `userData/home/` |
| Workspace memory | `.vyotiq/memory/` inside your project |
| Workspace hooks, rules, skills and commands | `.vyotiq/hooks.json`, `.vyotiq/rules/`, `.vyotiq/skills/`, `.vyotiq/commands/` inside your project |
| Files the agent's browser downloads | `.vyotiq/downloads/` inside your project |
| Personal skills | `~/.vyotiq/skills/` in your home folder |

`<id>` is an id Agent V gives each workspace folder. The items inside your project's `.vyotiq/` folder travel with the folder and can be committed like any other file.

If `settings.json` is not valid JSON, Agent V starts with default settings and keeps the damaged file beside it as `settings.json.corrupt-<time>`, and the inbox says "Settings couldn't be read". If the file is there but can't be read, for example because another program holds it open, Agent V doesn't save any settings until it can read the file again. That way your saved settings are never replaced with defaults.

Settings, "Diagnostics", "Logs" shows the logs path and has "Open folder". Logs are "Written regardless of crash reporting."

### Keys in task records

Task records don't keep keys that have a known shape. Before a message, event or summary is written to disk, anything shaped like a key is replaced with `[redacted:secret]`: provider keys (OpenAI, Anthropic, OpenRouter, Google, xAI, Groq, Bedrock), GitHub, GitLab, Slack and Stripe tokens, AWS access key ids, JSON web tokens, private-key blocks, and the value after `Bearer` or `Basic`. A key in a brief is replaced in the task's title and contract too.

The step that read a key still has it, so a task can use a key you paste into it. Later turns are rebuilt from the record, so they see the placeholder; the agent is told to read the real value from its source again rather than write the placeholder into a file. Undo points are copies of your files and are kept as they are. So are attached images and files, and saved drafts. Other key-like strings (a password in a config file, say) aren't recognized, and are kept as written.

## Settings as a file

Settings, "About", "Settings file" has three actions.

- "Export…" saves your settings to a JSON file. It leaves out API keys and sign-ins (they never leave the key vault), MCP servers, custom endpoint headers, and things that only make sense on this computer: pinned and archived tasks, your microphone, paused index folders, and your custom CSS path.
- "Import…" reads such a file and lists what would change before anything does. Each setting is checked on its own, so one bad value is left out rather than the whole file. Some settings are never taken from a file, because a file someone hands you must not decide them: where your saved keys are sent (the Ollama and Custom base URLs), the proxy, crash reporting, the diagnostics command, what runs without asking, sites the browser opens without asking, and autonomous mode. Custom endpoints in the file are added next to yours; yours keep their URLs and none is removed.
- "Reset all…" puts every setting back to its default after asking. It keeps API keys and sign-ins, custom endpoints, the provider and model tasks use, MCP servers, your rules, and pinned and archived tasks.

## Keeping storage in check

Settings, "Storage" covers "What Agent V keeps on disk, and when it lets go of it." It shows what each workspace uses and has these controls:

| Setting | Default |
| --- | --- |
| "Clean up undo points" | On. A task's undo points are deleted once the task is more than 30 days old ("Keep undo points for") or is not among the newest 20 tasks in its workspace ("Keep undo points of the newest"). Nothing from the last 24 hours, and no running task, is touched. |
| "Delete old tasks" | Off. Nothing is deleted on a schedule. "Free up space now" still applies the limits: a task is deleted once it is past the newest 30 in its workspace or older than 60 days — either one is enough. Nothing from the last 24 hours, no running task, and each workspace's newest task are kept. |
| "Clean up untracked storage" | On. Storage of a workspace that is no longer open, recent or in use becomes cleanable after 30 idle days ("Grace period"), and "Free up space now" offers to delete it. |
| "Delete storage when closing a workspace" | On. Closing a workspace offers to delete its app data too. |
| "Managed size cap" | 5 GB. "Past this, the oldest undo points are evicted until it fits." |

Automatic cleanup of undo points and old tasks, and the size cap, start only after you have opened Settings, "Storage" once. Until then only undo points you already resolved or undid are cleaned.

"Free up space now" runs a cleanup on demand. It "Shows what it would delete first. Nothing from the last 24 hours."

"Delete all my data" empties Agent V's app data folder: tasks and their undo points, keys and sign-ins, settings, extensions, logs, worktree task folders, the home workspace, and the browser's data. First it shows what it would delete: how many tasks (and how many are running and will be stopped), how many worktree folders and how many have uncommitted changes, and how many files are in the home workspace. Then it asks once. Agent V restarts and deletes before it opens anything, because it can't remove files it has open. Your projects stay, along with the branches and commits of worktree tasks; Git is only told that the deleted worktree folders are gone. Personal skills in `~/.vyotiq/skills/` stay too. If a file can't be deleted, the next launch tries that file again, and only that file.

Removing old undo points means you can no longer undo or rewind those tasks' edits. See [Review and rewind](/docs/review-and-rewind).

## Uninstalling

On Windows, uninstalling Agent V also deletes its app data folder, with your settings, keys and task history. It does not ask first, so copy the folder somewhere else before you uninstall if you want to keep it. Updating does not delete it. Uninstalling does not touch your projects, so `.vyotiq/` folders inside them stay. Personal skills in `~/.vyotiq/skills/` stay too.

## What leaves your computer

Nothing is uploaded to a Vyotiq server. The places Agent V connects to are:

- **Your model provider**, with your key, to run tasks. A key goes only to the provider it belongs to.
- **GitHub**, to check for updates (at start and every 6 hours; nothing downloads on its own), and for pull requests once you connect it. Turn the update checks off with Settings, "About", "Check automatically".
- **Hugging Face**, to download a dictation model, and the code index's embedding model, which downloads on its own after a workspace is first indexed. Both then run on your machine.
- **models.dev**, at start, for model details such as context windows and the OpenCode Go model list.
- **Cloudflare (1.1.1.1)**, a small request to check that you are online: every 15 seconds while the Agent V window is visible, and every 2 seconds while a run waits for the network.
- **OpenAI or OpenRouter**, when you dictate with one of them. OpenAI is the default. Pick "This PC" under Settings, "Voice", "Runs on" to keep audio on your computer.
- **MCP servers you add, web pages** the agent opens or fetches, and the search engine set in Settings, "Tools", "Search engine" (DuckDuckGo unless you change it), when the agent searches the web.
- **Whatever a command reaches.** Commands the agent runs in the terminal, such as a package install or a `git push`, use the network like any other program.

"Share crash and error reports" is off by default, and reports go to Sentry only when it is on. "Reports never include task contents, API keys, or file bodies." In a build without crash reporting the switch says "Not available in this build. Local logs are written either way."

Read the full [privacy policy](/privacy), and the [security page](/security) for how the app guards keys and commands.
