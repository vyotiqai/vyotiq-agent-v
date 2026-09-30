---
title: Approvals
description: What asks for your OK before it runs, the three approval modes, the approval card, Always allow rules, and unattended runs.
group: Tasks
order: 4
---

Approvals decide which of the agent's tools pause for you before they run. You choose a mode in setup, and change it any time in Settings, "Agent", "Approvals".

## The three modes

Setup's step 3, "Decide what needs your OK", offers three choices. Settings names the same modes under "Ask before" ("The agent pauses for you before these run.").

| Setup | Settings "Ask before" | What asks |
| --- | --- | --- |
| "Edits and commands" | "Edits and commands" | "Recommended. Reading is free; changing things asks first." |
| "Every tool" | "Every tool" | "Even reads and searches ask." |
| "Unattended" | "Nothing" | "For runs nobody is watching. MCP tools, tools the agent writes and risky commands still ask." |

Setup starts on "Edits and commands". The mode can differ per workspace; setup says "You can change this per workspace."

The "New task" page repeats the current mode in a short note, such as "Asks before edits and commands", with "MCP tools ask first" when that applies.

### What "Edits and commands" lets through

These run without asking:

- Reading files, searching, and listing folders
- The code index search
- Reading the workspace's memory
- Loading a skill
- `git status` and `git diff`
- Language-server lookups (a rename still asks)
- Planning and bookkeeping: writing the plan, updating steps, marking Done when checks, and starting or waiting on [instances](/docs/instances)

Everything else asks: file edits and deletes, terminal commands, commits, pull requests and memory writes. Browser tools always ask in this mode.

## The approval card

When a tool needs your OK, a "Needs you" card appears in the record. It shows the file or the full command, whether it "Can change files or run code" or "Reads only", and for a command, its folder and time limit. "Show the full request" reveals every argument.

| Button | Key | Effect |
| --- | --- | --- |
| "Allow once" | `Alt+A` | Runs this call only |
| "Allow for this task" | | "Allowed for the rest of this task, follow-ups included" |
| "Always allow {tool or command}" | | Runs it without asking again: in every workspace, or only in this one when it has its own settings |
| "Deny" | `Alt+D` | Refuses the call |

On macOS the keys are `⌥A` and `⌥D`.

### Always allow rules for commands

For a terminal command, "Always allow" is scoped to the command, not to the whole terminal. A command that chains or redirects is never offered "Always allow", and an allowed command never covers "one that chains or redirects".

Your rules are listed in Settings, "Agent", under "Always allowed": "Commands and tools you allowed for good. Remove one to be asked again."

### Nobody answers

An approval that waits too long is denied. The card counts down ("denied automatically in …") and denies it after 15 minutes.

## What always asks

- **MCP tools.** "MCP tools always ask" is on by default: "Even when approvals are off." You can turn it off in the same group.
- **Tools the agent wrote.** A tool made with `build_tool` asks before it runs, even with approvals set to "Nothing". An allow for it covers only the code you saw, so it asks again whenever that code changes. See [Agent-built tools](/docs/agent-built-tools).
- **Risky commands.** A terminal command asks whatever the mode, Always allow rules, "Allow for this task" or Unattended mode say when it would:
  - delete recursively outside the workspace, the whole workspace, or its `.git` folder, or delete paths it reads from its input
  - force-push, mirror, or delete a branch or tag on a remote
  - run `git reset --hard` or `git clean -f`
  - partition, format or overwrite a disk
  - pipe a download straight into a shell (`curl … | sh`, `iwr … | iex`)

  A path it cannot know before the command runs, such as `$BUILD_DIR`, counts as outside the workspace. The card says what the command would do and offers only "Allow once" and "Deny": nothing about it is remembered.

## Unattended mode

Settings, "Agent", has a separate switch, "Unattended mode": "Approve gated tools automatically, except high-risk ones. For runs nobody is watching." It applies to every workspace.

High-risk tools still ask with it on:

- File edits and deletes, and applying patches
- Terminal commands
- Commits, pull requests, pull request reviews and GitHub issues
- Merging an instance
- Building a tool, and any agent-built tool
- Screen snips
- MCP tools
- A language-server rename

"Questions while unattended" decides what happens when the agent asks you something: "Wait for an answer" or "Skip the question".

## Home: "Needs you"

Home collects everything waiting on you under "Needs you":

- Approvals, with "Deny" and "Allow once" right there
- Questions from the agent, with "Answer", which opens the task
- A provider with no key, and MCP servers that need a sign-in or cannot connect

When there is nothing: "Nothing is waiting on you. Approvals and questions from running tasks land here."

`Ctrl+J` jumps to the next task that needs you.
