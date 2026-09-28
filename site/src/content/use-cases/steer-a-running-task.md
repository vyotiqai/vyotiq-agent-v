---
title: Change course while it works
description: Correct the agent mid-run, or line up the next job, without stopping and starting over.
stage: Everyday work
order: 4
teaches: [Send now, Queue, Stop]
mode: Agent
brief: |-
  Rename the userId field to accountId across src/billing, including the types, the queries and the tests.
checks:
  - pnpm typecheck passes
  - No file in src/billing still mentions userId
docs:
  - { label: The task record, href: /docs/the-task-record }
  - { label: Keyboard shortcuts, href: /docs/keyboard-shortcuts }
---

## When to use it

Any run longer than a minute. You will often notice something while it works: it is about to touch a folder it should leave alone, or you think of the next step. You do not need to wait for it to finish, and you do not need to stop it.

## What you will see

The instruction line at the bottom stays open during a run. `Shift+Enter` ("Send now") puts an instruction into the live run straight away, to correct course: "Leave src/billing/migrations alone, those are applied already." `Enter` ("Queue") holds it until this run ends, for the next job: "Then add an entry to CHANGELOG.md."

## What to check

- If the run has gone somewhere you do not want at all, press `Esc` to stop it. What it already changed stays in place for you to keep, undo or rewind.
