---
title: Understand a codebase you don't know
description: Ask how a project works before you change anything. In Ask mode the agent reads and answers.
stage: First steps
order: 1
teaches: [Ask mode, The task record]
mode: Ask
brief: |-
  How does a request get from the routes in src/routes to the database? Name the files involved, in the order a request passes through them, and point out where authentication happens.
checks: []
docs:
  - { label: Writing a task, href: /docs/writing-a-task }
  - { label: The task record, href: /docs/the-task-record }
  - { label: Workspaces, href: /docs/workspaces }
---

## When to use it

You have just joined a team, cloned a project you have never seen, or come back to your own code after months away. Before you hand the agent anything that changes files, have it read the code for you. It is also the quickest way to see how Agent V works, because in Ask mode it reads rather than changes files.

Open the project's folder as a workspace, pick "Ask" in the Agent | Ask switch at the bottom of the brief box (or press `Ctrl+.`), paste the brief and click "Start task".

## What you will see

The record fills with what the agent looks at. Reads, searches and listings in a row fold into one line, such as "Explored", "Read" or "Searched", with a count. Open the line to see each file it looked at. The answer comes last, in plain words, naming the files it found.

## What to check

- Open two or three of the files it names and see whether the answer holds. An answer grounded in the files is one you can trust; a vague one means the brief needs to be more specific.
- Ask a follow-up in the instruction line at the bottom, such as "Where are the rate limits set?". It keeps the context of the first answer.
- By default the agent can switch itself from Ask to Agent when a job needs changes. To keep Ask strictly read-only, turn off "Switch between Ask and Agent on its own" in Settings, "Agent". It applies to every task.
