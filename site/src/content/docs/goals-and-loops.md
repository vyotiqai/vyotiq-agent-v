---
title: Goals and loops
description: Keep a task working toward an objective across turns with /goal, and repeat an instruction on a timer with /loop.
group: Tasks
order: 5
---

Two slash commands let a task carry on without you typing the next instruction. A goal keeps a task going until an objective is met. A loop runs the same instruction again at an interval.

## Goals

Type `/goal` followed by the objective, for example `/goal Get the e2e suite to pass three runs in a row`. It works on the "New task" page and in the instruction line of an open task. The goal is active straight away, and `/goal` switches the task to Agent mode if it is not running.

A bar above the instruction line shows the objective and its state:

| Bar | Buttons |
| --- | --- |
| "Goal" | "Pause", "Mark complete" |
| "Goal paused" | "Resume", "Mark complete" |
| "Suggested goal" | "Start goal", "Dismiss" |

"Suggested goal" is a goal the agent proposed. It only runs once you click "Start goal".

A task's menu in the navigator has "Pause goal" while its goal is active, and "Stop loop" while a loop is on.

### How a goal keeps going

When a turn ends and the goal is not complete, the task starts the next turn by itself. The agent ends the goal when the work is done. It never pauses its own goal. It stops on its own only in these cases:

- After 25 turns that continue on their own since you started or last resumed it, the goal pauses and the goal bar reads "Goal paused". Click "Resume" to give it another 25.
- If two turns in a row end without using a tool, the run stops and waits for you. The goal stays active.
- A goal never starts the next turn on its own in Ask mode.
- After the app restarts, an active goal in an open workspace picks up again once by itself. If the app restarts again before you send anything, it waits. Send an instruction or type `/goal resume` to continue.

If a goal's run stops on a network or provider error, the task starts it again by itself. It does not when your provider reports that its usage quota is used up.

`/goal resume` and `/goal complete` work like the buttons. `/goal pause` pauses an idle goal; while the task is running it only stops the run, so use "Pause" instead. `/goal` on its own shows how to use it.

A goal does not approve anything. Every tool that asks still asks, and an approval nobody answers is denied after 15 minutes. See [Approvals](/docs/approvals) for running with fewer prompts.

## Loops

Type `/loop`, an interval and the instruction in the instruction line of an open task, for example `/loop 30m check the nightly build and report the cause if it failed`. A loop needs a task, so it does not work on the "New task" page.

| Command | What it does |
| --- | --- |
| `/loop 30m <instruction>` | Runs the instruction every 30 minutes, the first time 30 minutes from now |
| `/loop` | Shows the current timer |
| `/loop stop` | Turns the loop off |

The interval is a whole number with `s`, `m`, `h` or `d`: from `30s` up to `24h`. A task has one loop, so a new `/loop` replaces the old one.

While a loop is on and the task is idle, the navigator lists it under "Running" with the time to its next run, such as "in 30m", and its hover card says "Scheduled". Hover the state mark in the task header to see "Scheduled · in 30m". When the task also has a goal, the goal bar shows the loop, such as "Loop 30m · in 29m", and a "Stop loop" button.

Each run is a normal turn in the same task, so the record keeps every result.

### When a loop waits

- The timer runs inside Agent V. It fires while the app is open and is set again when you open it, for workspaces that are open. Runs missed while the app was closed are not made up.
- While the task's goal is paused, the loop skips its runs and carries on once the goal is resumed. Resuming the goal does not start an extra run.
- When the task's goal is complete, the loop ends.
- If your provider reports that its usage quota is used up, the loop skips its runs until you continue the task.

## Related

- [The task record](/docs/the-task-record)
- [Approvals](/docs/approvals)
- Use cases: [Keep it going until it is done](/use-cases/keep-going-until-done) and [Check on something on a schedule](/use-cases/check-on-a-schedule)
