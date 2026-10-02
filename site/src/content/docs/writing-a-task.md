---
title: Writing a task
description: The New task page, writing a brief, Done when checks, Agent and Ask modes, model and effort, drafts, and dictation.
group: Tasks
order: 1
---

Every task starts on the "New task" page. Open it with `Ctrl+N`. The header says where the task will run: "New task in {workspace}", then "on {branch}" in a git repository. With more than one workspace open, the workspace name is a menu that moves the brief to another one. The branch name is a menu that checks out another branch. Once the branch has a commit, a "This folder" / "New worktree" switch at the right of the header picks where it works (see [Workspaces](/docs/workspaces)).

## The brief

The large box is the brief. Its placeholder says what the agent does with it: "Describe the task — the agent plans it, does it, and shows you the result".

A good brief names the result you want and anything the agent cannot guess: the files involved, the command that runs the tests, what must not change. You can drop or paste files onto the brief to attach them, or use the paperclip. Type `@` to mention a file and `/` to run a skill or command, as on the instruction line.

Beside the brief, "What the agent will see" lists the context this workspace gives the agent before it starts. Rules, Memory, Index and Tools each open the place where you change them.

| Row | What it shows |
| --- | --- |
| Branch | The branch, or "New worktree", or "Not a repository" with an "Initialize" button that runs `git init` |
| Rules | Rule files found, such as `AGENTS.md` or `CLAUDE.md` ([Rules and skills](/docs/rules-and-skills)) |
| Memory | How many notes the workspace's memory holds |
| Index | The state of the code index: "Ready", "Building", "Degraded", "Off" or "Paused" |
| Tools | How many built-in tools and MCP servers are available, and any server that "needs sign-in" or "can’t connect" |

## Done when

Done when checks go inside the brief box, under your text. They are what the run is judged against.

Type a check in the field that reads "Done when… a command passes, a file exists" and press `Enter` to add it. You can add up to 20 checks of up to 500 characters each. The agent's plan can add checks of its own.

How the checks are checked:

1. Before it finishes, the agent marks each check met or not met, with the evidence it saw: the command and its result, the file, or why the check is not met.
2. In Agent mode, if it is about to finish with checks unmarked, it gets one reminder.
3. A check still unmarked after that stays open, counted as not checked.

While the run is live, the checks sit under the brief and open ones say "checked at the end". When the run ends with a result, the checks move under it as "Checked · {met} of {total} done-when checks met". Each check shows a met, not met or open mark, with the agent's evidence under it. The receipt then counts them as "{met}/{total} checks met".

In the Changes tab, "Ask it to cover this" (or "Ask it to check" for an unmarked check) drafts a follow-up about that check into the task's instruction line. See [Review and rewind](/docs/review-and-rewind).

## Agent or Ask

The Agent / Ask switch at the bottom of the brief picks the mode. `Ctrl+.` flips it, and so does `Shift+Tab` in an empty box. Hover a mode to see what it does:

| Mode | What it does |
| --- | --- |
| "Agent" | "Plans, edits files and runs commands" |
| "Ask" | "Reads and answers — changes nothing" |

In Ask mode the placeholder changes to "Ask about this workspace — the agent reads and answers, and changes nothing".

## Model and effort

The model menu beside Agent / Ask picks the model and, for models that reason, the effort. The effort levels are "Minimal", "Low", "Medium", "High", "Extra high" and "Max". Each model offers only the levels it supports. Some can also be turned off, and some offer only "Off" and "On". See [Models and keys](/docs/models-and-keys).

## Start, or save a draft

- "Start task" starts the run. The shortcut is `Ctrl+Enter` (`⌘↵` on macOS).
- "Save as draft" puts the brief, its checks and its attachments aside, and empties the page. When you continue a draft, the button reads "Update draft".

Beside "Start task", one line says how tools ask before they run, for example "Asks before edits and commands · MCP tools ask first". "Change" opens Settings, "Agent", which also has "New tasks start in a worktree".

Drafts are kept per workspace in the app's data, not in your project, up to 50 per workspace. They appear in the navigator under "Drafts". A draft's menu has "Continue on New task" and "Delete draft". Starting a task from a draft removes the draft.

## Dictation

You can speak a brief or an instruction instead of typing it. Press `Ctrl+M` to start a take and press it again to insert the words at the cursor. `Esc` discards a take. You can also hold `Ctrl+M` while you speak and let go to insert: that is "Hold to talk", on by default in Settings, "Voice".

"Runs on" decides where your audio goes:

| Choice | Privacy |
| --- | --- |
| "This PC" | "Audio stays on this PC" |
| "OpenAI" | "Audio is sent to OpenAI with your key" |
| "OpenRouter" | "Audio is sent to OpenRouter with your key" |

The default is OpenAI, which uses your OpenAI key. Without that key, "the mic cannot start". If the chosen engine is not ready, pressing the mic opens "Dictate with", where you can install a model for this PC or pick OpenAI or OpenRouter.

For "This PC", install a model first. Models download from Hugging Face once and then run offline. Dictation on this PC understands English only.

| Model | Download |
| --- | --- |
| Whisper Tiny | ~41 MB |
| Whisper Small | ~249 MB |
| Moonshine Base | ~123 MB |

The model that suits your PC's memory is marked "Best for this PC": Whisper Small with 8 GB of RAM or more, Whisper Tiny below that.

With OpenAI, "Words as you speak" writes each word as you say it instead of each phrase after you pause. It costs "About 4× the price a minute".
