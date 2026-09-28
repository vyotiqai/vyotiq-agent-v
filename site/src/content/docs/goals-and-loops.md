---
title: Goals and loops
description: Keep a task working toward an objective across turns with /goal, and repeat an instruction on a timer with /loop.
group: Tasks
order: 5
---

Two slash commands let a task carry on without you typing the next instruction. A goal keeps a task going until an objective is met. A loop runs the same instruction again at an interval.

## Goals

Type `/goal` followed by the objective, for example `/goal Get the e2e suite to pass three runs in a row`. It works on the "New task" page and in the instruction line of an open task. The goal is active straight away.

A bar above the instruction line shows the objective and its state:

| Bar | Buttons |
| --- | --- |
| "Goal" | "Pause", "Mark complete" |
| "Goal paused" | "Resume", "Mark complete" |
| "Suggested goal" | "Start goal", "Dismiss" |

"Suggested goal" is a goal the agent proposed. It only runs once you click "Start goal".

### How a goal keeps going

When a turn ends and the goal is not complete, the task starts the next turn by itself. The agent ends the goal when the work is done. It never pauses its own goal; only you do, or one of these limits:

- After 25 turns that continue on their own without finishing, the goal pauses and the navigator shows "Goal paused". Click "Resume" to give it another 25.
- If two turns in a row end without using a tool, the run stops and waits for you. The goal stays active.
- A goal never continues on its own in Ask mode.
- After the app restarts, an active goal picks up again once by itself. If the app restarts again before you send anything, it waits for "Resume".

The same controls are commands: `/goal pause`, `/goal resume` and `/goal complete`. `/goal` on its own shows how to use it.

A goal does not approve anything. Every tool that asks still asks, and an approval nobody answers is denied after 15 minutes. See [Approvals](/docs/approvals) for running with fewer prompts.

## Loops

Type `/loop`, an interval and the instruction in the instruction line of an open task, for example `/loop 30m check the nightly build and report the cause if it failed`. A loop needs a task, so it does not work on the "New task" page.

| Command | What it does |
| --- | --- |
| `/loop 30m <instruction>` | Runs the instruction every 30 minutes |
| `/loop` | Shows the current timer |
| `/loop stop` | Turns the loop off |

The interval is a number with `s`, `m`, `h` or `d`: from `30s` up to `24h`.

While a loop is on, the navigator lists the task as "Scheduled" with the time to the next run, and the task header reads "Scheduled · in 30m". When the task also has a goal, the goal bar shows the loop and a "Stop loop" button.

Each run is a normal turn in the same task, so the record keeps every result.

### When a loop waits

- The timer runs inside Agent V. It fires while the app is open and is set again when you open it.
- While the task's goal is paused, the loop skips its runs and carries on once the goal is resumed.
- When the task's goal is complete, the loop ends.
- If your provider reports that its usage quota is used up, the loop waits for the next interval instead of starting a run.

## Related

- [The task record](/docs/the-task-record)
- [Approvals](/docs/approvals)
- Use cases: [Keep it going until it is done](/use-cases/keep-going-until-done) and [Check on something on a schedule](/use-cases/check-on-a-schedule)
