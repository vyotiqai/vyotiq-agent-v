---
title: Scheduled tasks
description: Run a brief or an earlier task again on a schedule, as a new task each time, and how that differs from /loop.
group: Tasks
order: 6
---

A schedule starts a task for you at the times you choose: every morning, on weekdays at five, every 30 minutes, or on a cron expression. Each run is a new task with its own record, so one run's result never crowds the next.

## Making one

There are two ways in:

- **From a task:** "Repeat…" in its menu, in the navigator or in the task header. The schedule repeats what you typed in that task's brief, not its title.
- **From the New task page:** "Schedule…" beside "Start task" schedules the brief you are writing, with its Done when checks, instead of starting it now.

The dialog ("Repeat task" or "Schedule task") sets:

| Field | Choices |
| --- | --- |
| "Repeat" | "Daily" at a time, "Weekly" on the days you tick, "Every" so many minutes, or "Cron" (`min hour day month weekday`) |
| "Mode" | "Agent" or "Ask" |
| "Model" | The workspace's model, or another one for this schedule |
| "Run each time in a new worktree" | Each run works in a worktree of its own ([Workspaces](/docs/workspaces#worktree-tasks)) |

The dialog says when it will run next. A cron expression that can never fire says "It never runs again".

## Seeing and changing them

"Scheduled tasks…" in the navigator's view menu lists every schedule in the workspace: its brief, when it runs next and how its last run went. Each row has a switch to pause or resume it, "Run now", "Edit" and "Delete".

Home's "Coming up" lists the next few runs across your open workspaces, with a "Scheduled tasks" link.

## When they run

Schedules run inside Agent V, so they fire while the app is open and the computer is awake. Times missed while the app was closed or the computer slept are made up **once** when the app starts or the computer wakes, not once per missed time, and that run's record says "Catching up a missed run from …".

A scheduled run asks for approvals like any task. To let it run without anyone watching, see [Approvals](/docs/approvals), or keep the app in the tray (Settings, "General", "Closing") so it keeps going when the window is closed.

## Scheduled tasks or /loop

[`/loop`](/docs/goals-and-loops#loops) and schedules both repeat work, with different rules:

| | `/loop` | A schedule |
| --- | --- | --- |
| Where each run goes | The same task, one turn after another | A new task each time |
| How you set it | `/loop 30m …` in an open task | "Repeat…" or "Schedule…" |
| When | Every 30 seconds to 24 hours | Daily, weekly, every N minutes, or cron |
| Missed while closed | Not made up | Made up once on start or wake |
| Good for | Watching something within one conversation | Routine work that should start fresh |

## Related

- [Goals and loops](/docs/goals-and-loops)
- [Headless runs](/docs/headless) for running a task from a script or CI instead
