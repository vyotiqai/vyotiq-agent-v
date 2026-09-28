---
title: The task record
description: How to read a task's record, its plan and steps, the receipt line, and how to add instructions to or stop a live run.
group: Tasks
order: 2
---

Once a task starts, its page becomes a record: your brief at the top, then the work, then the result. The record is written as the run happens, so you can read it live or come back to it later.

## Work rows

Each thing the agent does is one row that starts with a verb. The verb tells you the kind of action before you read the rest of the row.

| Verb | What happened |
| --- | --- |
| "Read" | Read a file |
| "Edited" / "Created" / "Deleted" | Changed, added or removed a file |
| "Ran" | Ran a terminal command |
| "Searched" / "Listed" | Searched the workspace or listed a folder |
| "Browsed" | Used the agent's browser |
| "Wrote memory" | Saved a note to the workspace's memory |
| "Loaded skill" | Loaded a skill ([Rules and skills](/docs/rules-and-skills)) |
| "Git commit" / "Created PR" | Committed, or opened a pull request |
| "Checked done-when" | Marked the task's checks |
| "Spawned instance" | Started a sub-agent ([Instances](/docs/instances)) |
| "Built a tool" | Wrote a tool of its own ([Agent-built tools](/docs/agent-built-tools)) |

While a row is still running, its verb is in the present tense ("Reading", "Running").

## Plan and steps

When the agent writes a plan, it shows as a "Wrote the plan" row with an "Open plan" button, which opens the plan in the inspector's "Plan" tab.

The plan's steps then appear as a list. The agent updates them as it goes.

- Only the step the agent is working on is open. The others are one line each, with their time on the right.
- A step a later plan dropped or renamed is tagged "replaced".
- A step waiting on an approval or a question says "Waiting for you — see above".
- Work done while no step was in progress sits after the step it followed.

## The receipt

When a run ends, a receipt line sums it up. While the run is live, the same line fills in as it goes; its tooltip reads "So far". It can include:

| Part | What it is |
| --- | --- |
| Time | Wall time for the run |
| "{met}/{total} checks met" | Done-when checks the agent marked met, each with its evidence |
| Tokens | Fresh input plus output tokens |
| Speed | Output speed |
| Cache | Prompt cache hits |
| Cost | "Billed by the provider", or with a `~` in front when "Estimated from published prices" |

A part is left out when there is nothing to show. [Usage and cost](/docs/usage-and-cost) explains how cost is worked out. You can also mark the result helpful or unhelpful from the receipt.

## Adding instructions while a run is live

The instruction line at the bottom stays open during a run. `Ctrl+L` puts the cursor there. Its placeholder explains the two ways to send: "Add an instruction — starts when this run ends · Shift+Enter sends it now".

| Key | Button | What happens |
| --- | --- | --- |
| `Enter` | "Queue" | "Queue it — it starts when this run ends" |
| `Shift+Enter` | "Send now" | Sends it into the live run now, instead of when this turn ends |

Use "Queue" for the next thing to do. Use "Send now" to correct the agent while it works, for example when it has taken a wrong turn.

## Stopping a run

"Stop" in the task header ends the run ("Stop the run (Esc)"). You can also press `Esc`. What the agent already changed stays in place; review it in the inspector, keep or undo each file, or rewind. See [Review and rewind](/docs/review-and-rewind).

## Finding things

`Ctrl+F` finds text in the record, the changes, or the pull request, depending on where you are. The approval cards that appear in the record are covered in [Approvals](/docs/approvals).
