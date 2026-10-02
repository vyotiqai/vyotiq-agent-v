---
title: Keep it going until it is done
description: Give a task a standing goal, so it keeps working across turns, and set it up for a run nobody is watching.
stage: Hands off
order: 11
teaches: [/goal, Approvals]
mode: Agent
kind: command
brief: |-
  /goal Upgrade the dependencies in acme-api one at a time, running the tests after each. Leave any upgrade that breaks the tests out, and list those separately with the error.
checks: []
docs:
  - { label: Goals and loops, href: /docs/goals-and-loops }
  - { label: Approvals, href: /docs/approvals }
---

## When to use it

A long job made of many similar steps, where you would otherwise keep typing "carry on": upgrades one at a time, a migration file by file, getting a test suite from red to green.

Type the command on the New task page, or in the instruction line of a task you already have open. `/goal` followed by an objective makes it the task's goal straight away.

## What you will see

A "Goal" bar sits above the instruction line with the objective, and "Pause" and "Mark complete" buttons. When a turn ends, the task continues on its own until the agent marks the goal complete. After 25 automatic continues without finishing it pauses, and the navigator shows "Goal paused" until you click "Resume". The limits, and what happens after a restart, are in [Goals and loops](/docs/goals-and-loops).

## What to check

- A goal does not approve anything. While you are away, every edit and command that asks is denied if nobody answers within 15 minutes. Decide before you leave what may run without asking: [Approvals](/docs/approvals) covers "Always allow", setting "Ask before" to "Nothing", and "Unattended mode", which still asks before edits, commands and commits.
- A question from the agent waits for your answer unless "Unattended mode" is on and "Questions while unattended" is set to "Skip the question".
- Review the result the next morning like any other task: the record shows every step it took.
