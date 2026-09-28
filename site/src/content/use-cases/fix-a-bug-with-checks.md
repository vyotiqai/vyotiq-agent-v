---
title: Fix a small bug, with checks
description: Hand over a bug you can describe in two sentences, and say how you will know it is fixed.
stage: First steps
order: 2
teaches: [Agent mode, Done when, Approvals]
mode: Agent
brief: |-
  GET /invoices returns 500 when an invoice has no due_date. Treat a missing due_date as "no due date" instead of failing, and add a test for it.
checks:
  - pnpm test src/invoices passes
  - A test covers an invoice with no due_date
  - No files outside src/invoices change
docs:
  - { label: Writing a task, href: /docs/writing-a-task }
  - { label: Approvals, href: /docs/approvals }
  - { label: The task record, href: /docs/the-task-record }
---

## When to use it

A bug you could fix yourself in half an hour, where you already know what "fixed" looks like. This is the job to learn Agent mode on: it is small enough to follow every step, and the checks tell you whether it worked without reading every line.

Pick "Agent", paste the brief, and add each Done when line with "Add a check". The checks are the most important part. Write them as things that can be shown: a command that passes, a file that exists, something that did not change.

## What you will see

The agent reads the invoice code, edits a file and runs the tests. With approvals on "Edits and commands", each edit and each command waits for you on an approval card that shows exactly what will run. "Allow once" is the safe answer while you are learning.

Before it can finish, the agent marks each check met or not met, with its evidence: the command it ran and what came back. The receipt at the end counts them, for example "3/3 checks met".

## What to check

- Read the evidence under each check, not only the tick. "Not met" is an honest result, not an error, and it tells you exactly what is left.
- A check left open counts as not checked. If that happens often, make your checks more concrete.
- The next use case covers what to do with the changes themselves.
