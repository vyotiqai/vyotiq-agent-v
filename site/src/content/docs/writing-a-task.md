---
title: Writing a task
description: The New task page, writing a brief, Done when checks, Agent and Ask modes, model and effort, drafts, and dictation.
group: Tasks
order: 1
---

Every task starts on the "New task" page. Open it with `Ctrl+N`. The header says where the task will run: "New task in {workspace}", then "on {branch}" in a git repository, and a "This folder" / "New worktree" menu once the branch has a commit (see [Workspaces](/docs/workspaces)).

## The brief

The large box is the brief. Its placeholder says what the agent does with it: "Describe the task — the agent plans it, does it, and shows you the result".

A good brief names the result you want and anything the agent cannot guess: the files involved, the command that runs the tests, what must not change. You can drop files onto the brief to attach them.

Beside the brief, "What the agent will see" lists the context this workspace gives the agent before it starts:

| Row | What it shows |
| --- | --- |
| Branch | The branch, or "New worktree", or "Not a repository" |
| Rules | Rule files found, such as `AGENTS.md` or `CLAUDE.md` ([Rules and skills](/docs/rules-and-skills)) |
| Memory | How many notes the workspace's memory holds |
| Index | The state of the code index: "Ready", "Building", "Degraded", "Off" or "Paused" |
| Tools | How many built-in tools and MCP servers are available |

## Done when

"Done when" holds checks: "The run is checked against these before it can finish".

Click "Add a check" and write "A result you can check — a command that passes, a file that exists". You can add up to 20 checks of up to 500 characters each.

How the checks are checked:

1. Before it finishes, the agent marks each check met or not met, with the evidence it saw: the command and its result, the file, or why the check is not met.
2. If it is about to finish with checks unmarked, it gets one reminder.
3. A check still unmarked after that stays open, counted as not checked.

While the run is live, open checks say "checked at the end". Afterwards each one shows a met, not met or open mark, with the agent's evidence under it. The receipt counts them as "{met}/{total} checks met". "Not met" is an honest result, not an error.

## Agent or Ask

The Agent / Ask switch at the bottom of the brief picks the mode. `Ctrl+.` flips it. Hover a mode to see what it does:

| Mode | What it does |
| --- | --- |
| "Agent" | "Plans, edits files and runs commands" |
| "Ask" | "Reads and answers — changes nothing" |

In Ask mode the placeholder changes to "Ask about this workspace — the agent reads and answers, and changes nothing".

## Model and effort

The model menu under the brief picks the model and, for models that reason, the effort. The effort levels are "Minimal", "Low", "Medium", "High", "Extra high" and "Max". Each model offers only the levels it supports, and some can also be turned off. See [Models and keys](/docs/models-and-keys).

## Start, or save a draft

- "Start task" starts the run. The shortcut is `Ctrl+Enter` (`⌘↵` on macOS).
- "Save as draft" puts the brief and its checks aside. When you continue a draft, the button reads "Update draft".

Drafts are kept per workspace in the app's data, not in your project, up to 50 per workspace. They appear in the navigator. A draft's menu has "Continue on New task" and "Delete draft".

## Dictation

You can speak a brief or an instruction instead of typing it. Press `Ctrl+M` to start a take and press it again to insert the words at the cursor. You can also hold `Ctrl+M` while you speak and let go to insert: that is "Hold to talk", on by default in Settings, "Voice".

"Runs on" decides where your audio goes:

| Choice | Privacy |
| --- | --- |
| "This PC" | "Audio stays on this PC" |
| "OpenAI" | "Audio is sent to OpenAI with your key" |
| "OpenRouter" | "Audio is sent to OpenRouter with your key" |

The default is OpenAI, which uses your OpenAI key. Without that key, "the mic cannot start".

For "This PC", install a model first. Models download from Hugging Face once and then run offline. Dictation on this PC understands English only.

| Model | Download |
| --- | --- |
| Whisper Tiny | ~41 MB |
| Whisper Small | ~249 MB |
| Moonshine Base | ~123 MB |

The model that suits your PC's memory is marked "Best for this PC": Whisper Small with 8 GB of RAM or more, Whisper Tiny below that.

With OpenAI, "Words as you speak" writes each word as you say it instead of each phrase after you pause. It costs "About 4× the price a minute".
