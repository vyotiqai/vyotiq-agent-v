---
title: Chase a flaky test with a skill
description: Add a skill from Extensions and let it bring a proven method to a job, here a test that fails one run in five.
stage: Everyday work
order: 7
teaches: [Skills, Extensions]
mode: Agent
brief: |-
  The test "applies proration on upgrade" in test/invoices.spec.ts fails about one run in five on CI. Find out why and fix the cause. Do not add retries or longer timeouts.
checks:
  - The test passes 20 runs in a row
  - The fix changes the cause, not the retry count or a timeout
docs:
  - { label: Extensions, href: /docs/extensions }
  - { label: Rules and skills, href: /docs/rules-and-skills }
---

## When to use it

A job that has a known good method, where an agent left to itself might take a shortcut. A flaky test is the classic case: the easy fix is a retry, which hides the problem instead of solving it.

Open Extensions (or type `/marketplace`), search for "Flake hunter" and click "Add". It is a skill: a written method the agent follows when a task calls for it.

## What you will see

Skills load on demand. With Flake hunter added, the agent recognises the job and pulls the skill in; you can also start it by name with `/flake-hunter`. The method is to rerun the test to measure how often it fails, find where the nondeterminism comes from, fix that, and measure again.

## What to check

- The failure rate before and after. A fix without a before-and-after rate is a guess.
- The diff should change the cause, such as a shared clock, test order or a race, not the test's patience.
- Other skills in Extensions work the same way. "Quality" is a good one to add next: its code-review skill gives a diff a second look before you commit it.
