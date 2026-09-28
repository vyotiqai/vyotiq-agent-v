---
title: Getting started
description: Install Agent V, work through the three setup steps, and hand the agent its first task.
group: Start
order: 1
---

Agent V is a desktop app. You give it a task in a folder on your computer, it plans the work, edits files and runs commands there, and shows you what it did.

## Install

Builds are published on the [releases page](https://github.com/vyotiqai/vyotiq-agent-v-releases/releases). The [download page](/download) links to the latest one.

| System | What to get |
| --- | --- |
| Windows (x64) | The `setup.exe` installer. It installs for your user only, and lets you pick the folder. |
| macOS | The `.dmg` for Apple silicon (`arm64`) or Intel (`x64`). |
| Linux (x64) | An `AppImage`, a `.deb` or an `.rpm`. |

The Windows and macOS builds are not signed yet, so your system warns the first time you open them:

- **Windows:** SmartScreen shows a warning on first run. Choose "More info", then "Run anyway".
- **macOS:** Gatekeeper blocks the first launch. Open the app once, then go to System Settings, Privacy & Security, and choose "Open Anyway".

### Updates

Agent V checks GitHub for a new version when it starts and every 6 hours after that. Nothing downloads or installs on its own. You can turn the check off in Settings, "About", under "Updates": "Check automatically".

## First launch: "Set up Agent V"

The first screen is "Set up Agent V": "Three things, then hand it its first task. Everything here can change later in Settings."

### 1. "Connect a model provider"

Pick a provider and, if it needs one, paste an API key. The step only counts as done after Agent V reads the provider's model list successfully, so a wrong key or an unreachable server shows up here, not in your first task. If the check fails you get the reason, with "Check again" and "Choose a provider".

The default provider is Ollama, which needs no key when it runs on your own machine. See [Models and keys](/docs/models-and-keys) for every provider.

### 2. "Open a workspace"

"The folder the agent works in. Its file tools stay inside it."

Click "Choose a folder…" or drop a folder onto the step. Folders you opened before appear under "Recent" (up to five). See [Workspaces](/docs/workspaces).

### 3. "Decide what needs your OK"

"You can change this per workspace." Pick one:

| Choice | What it means |
| --- | --- |
| "Edits and commands" | "Recommended. Reading is free; changing things asks first." This is selected when setup opens. |
| "Every tool" | "Even reads and searches ask." |
| "Unattended" | "For runs nobody is watching. MCP tools and tools the agent writes still ask." |

[Approvals](/docs/approvals) explains each mode in detail.

When all three steps are done, click "Start your first task".

## Your first task

The button opens the "New task" page for the workspace you chose.

1. Describe what you want in the brief. Write the result you expect, not just the topic.
2. Optionally add a "Done when" check, such as a test command that should pass. The agent marks each check met or not met, with its evidence, before it finishes.
3. Click "Start task" or press `Ctrl+Enter` (`⌘↵` on macOS).

The task opens as a record. You watch each step as it happens: files read, edits made, commands run. When the agent needs your approval, a card appears in the record with the choices. When the run ends, a receipt line shows the time taken, the tokens used and, when it is known, the cost.

Next, follow the [use cases](/use-cases/) in order. The first, [Understand a codebase you don't know](/use-cases/understand-a-codebase), only reads your code, so it is a safe place to start. For the details of each part, read [Writing a task](/docs/writing-a-task) and [The task record](/docs/the-task-record).
