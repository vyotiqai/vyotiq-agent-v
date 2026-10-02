---
title: Split a job into parallel parts
description: When a job has parts that do not depend on each other, the agent can run them at the same time as instances.
stage: Bigger jobs
order: 9
teaches: [Instances, Merge]
mode: Agent
brief: |-
  Add rate limiting to the auth, billing and search routers: 100 requests a minute per API key, answering 429 with a Retry-After header. The three routers are independent of each other. Share one limiter module between them.
checks:
  - Each router has a test that gets 429 after 100 requests
  - pnpm test passes
docs:
  - { label: Instances, href: /docs/instances }
  - { label: Workspaces, href: /docs/workspaces }
---

## When to use it

A job with two or more separate workstreams: the same change in several services, or a feature with a back end, a front end and tests that can be written apart. Saying in the brief that the parts are independent helps the agent split them cleanly.

## What you will see

Under the plan step, a block lists the instances, one row each with a short id and what it is doing. An instance is a sub-agent with its own brief: a goal, the outcome wanted, its steps and its own Done when checks. It never sees your conversation, only that brief. An instance that writes normally works in its own git worktree, on its own branch under `vyotiq/instance/`, so the parallel edits do not collide in your folder.

Click a row to open that instance and watch it. When they finish, the parent reads their reports and merges their branches one at a time. Each merge is a git merge into your current branch.

## What to check

- Open the instances' briefs. A clear brief per instance is what makes parallel work land; a vague one comes back vague.
- A task runs up to 16 instances at once by default ("Instances at once" in Settings, "Agent", can lower it), and instances cannot start instances of their own, so the work stays a tree you can follow.
