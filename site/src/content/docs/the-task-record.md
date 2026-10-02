---
title: The task record
description: How to read a task's record, its plan and steps, the receipt line, and how to add instructions to or stop a live run.
group: Tasks
order: 2
---

Once a task starts, its page becomes a record: your brief at the top, then the work, then the result. The record is written as the run happens, so you can read it live or come back to it later.

## Work rows

Most of what the agent does is a row that starts with a verb. The verb tells you the kind of action before you read the rest of the row. Lookups in a row share one line, and file edits and commands that change things get a card of their own.

| Row | What happened |
| --- | --- |
| "Read" / "Searched" / "Listed" / "Explored" | Read files, searched the workspace or listed folders. A line that mixes three or more kinds of lookup reads "Explored" |
| File card | An edit: the file's path, "new" for a created file, and the lines added and removed |
| "Deleted" | Removed a file |
| Command card | A command that changes things: `$` and the command, its exit code and its time. Read-only commands join the lookup line as "Ran" |
| "Browsed" | Used the agent's browser |
| "Wrote memory" | Saved a note to the workspace's memory |
| "Loaded skill" | Loaded a skill ([Rules and skills](/docs/rules-and-skills)) |
| "Git commit" / "Created PR" | Committed, or opened a pull request |
| "Running instance" / "Instance finished" | A sub-agent it started, with an "Open" link. Several started together share one block ([Instances](/docs/instances)) |
| "Built a tool" | Wrote a tool of its own ([Agent-built tools](/docs/agent-built-tools)) |

While a row is still running, its verb is in the present tense ("Reading", "Running"). The same call repeated three or more times in a row folds its earlier runs into one line above the last one.

Marking the Done when checks is not a row of its own. The verdicts show with the checks ([Writing a task](/docs/writing-a-task)).

## Plan and steps

When the agent writes a plan, it shows as a "Wrote the plan" row with an "Open plan" button, which opens the plan in the inspector's "Plan" tab.

The plan's steps then appear as a list. The agent updates them as it goes. The bottom edge of the task header becomes a plan bar with one segment per step: hover a segment to see its step, and click it to go there.

- Only the step the agent is working on is open. The others are one line each, with their time on the right. Click a step to open it.
- A step a later plan dropped or renamed is tagged "replaced".
- A step waiting on an approval or a question stays open with the card inside it. If you fold it, it shows "Waiting for you", which opens it again.
- Work done while no step was in progress sits after the step it followed.

While the run is live, a "Now" row shows what the agent is doing at that moment. If you scroll up, "Jump to now" (or `End`) brings you back.

## The result

When the run ends, the agent's closing answer appears under "Result", with the files it changed. Each file opens in Changes. Until you review them, the edits are counted as "{N} files changed, not kept yet" with "Review changes". After review the line says what happened, for example "Kept, not committed yet" with "Commit…".

Each instruction you send after the brief starts a new run under a "Run {n}" divider, and earlier runs fold into "History". Hover a brief for "Edit and rerun" and for rewinding to before it ([Review and rewind](/docs/review-and-rewind)).

## The receipt

When a run ends, a receipt line sums it up. While the run is live, the same line fills in as it goes; its tooltip reads "So far". It can include:

| Part | What it is |
| --- | --- |
| Time | Wall time for the run |
| "{met}/{total} checks met" | Done-when checks the agent marked met, counted once the run has ended |
| Tokens | Fresh input plus output tokens |
| Speed | Output speed |
| Cache | Prompt cache hits |
| Cost | "Billed by the provider", or with a `~` in front when "Estimated from published prices" |

A part is left out when there is nothing to show. [Usage and cost](/docs/usage-and-cost) explains how cost is worked out. You can also mark the result helpful or unhelpful from the receipt. A stopped run's receipt starts with "Stopped" and can offer "Undo its changes" and "Resume".

## Adding instructions while a run is live

The instruction line at the bottom stays open during a run. `Ctrl+L` puts the cursor there. While a run is live, its placeholder reads "Steer it, or queue what comes next…".

| Key | Button | What happens |
| --- | --- | --- |
| `Enter` | "Queue" | "Queue it — it starts when this run ends" |
| `Shift+Enter` | "Send now" | Sends it into the live run now, instead of when this turn ends |

Use "Queue" for the next thing to do. Use "Send now" to correct the agent while it works, for example when it has taken a wrong turn. Queued instructions wait above the line, each with "Edit", "Send now" and a button to remove it.

## Stopping a run

"Stop" in the task header ends the run ("Stop the run (Esc)"). You can also press `Esc`. What the agent already changed stays in place; review it in the inspector, keep or undo each file, or rewind. See [Review and rewind](/docs/review-and-rewind).

## Finding things

`Ctrl+F` finds text in the record, the changes, or the pull request, depending on where you are. In the record, find opens the folded steps and earlier runs that hold a match, and `Enter` / `Shift+Enter` move between matches. Tool output is not searched. The approval cards that appear in the record are covered in [Approvals](/docs/approvals).
