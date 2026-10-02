---
title: Check on something on a schedule
description: Repeat an instruction on a timer, such as looking at a nightly build every half hour, and act when something changes.
stage: Hands off
order: 12
teaches: [/loop]
mode: Agent
kind: command
brief: |-
  /loop 30m Check the latest run of the nightly-build workflow. If it failed, read its log and tell me the cause in two lines. If it passed, say so in one line.
checks: []
docs:
  - { label: Goals and loops, href: /docs/goals-and-loops }
  - { label: The task record, href: /docs/the-task-record }
---

## When to use it

Anything you would otherwise check by hand at intervals: a CI workflow, a deploy that takes a while, a queue that should drain. The agent looks, reports, and waits for the next tick.

Type the command in the instruction line of a task you already have open; a loop needs a task, so it does not work on the "New task" page. The interval comes first, from `30s` up to `24h`.

## What you will see

The navigator lists the task as "Scheduled", with the time to the next run. The first check runs one interval after you set the loop. Each run is a normal turn in the same task, so the record builds a history of every check. `/loop` on its own shows the timer, and `/loop stop` turns it off.

## What to check

- The timer runs inside Agent V: it fires while the app is open, and is set again when you open it, for the workspaces you have open.
- Each tick's commands ask like any others. Use "Always allow" on the read-only command it runs, such as `gh run list`, or each tick waits on you.
- Keep the instruction's output short. Every tick is a model call, and the task's receipts show what the checks cost over a day.
- Combine it with a goal for jobs that should end: the loop stops once the task's goal is complete.
