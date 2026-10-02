---
title: Teach it your conventions
description: Write down the rules of your project once, so every task follows them without being told.
stage: Everyday work
order: 5
teaches: [Rules, Memory]
mode: Agent
brief: |-
  Write a project rule in .vyotiq/rules/api-conventions.md for the code in src/routes: requests go through src/http/client.ts, never axios; every request body is validated with zod; errors are thrown as AppError. Set globs so it applies to src/routes/** only.
checks:
  - .vyotiq/rules/api-conventions.md exists
  - Its frontmatter has globs set to src/routes/**
docs:
  - { label: Rules and skills, href: /docs/rules-and-skills }
  - { label: Data and storage, href: /docs/data-and-storage }
---

## When to use it

The second time you correct the agent for the same thing. If you find yourself adding "and use our HTTP client" to every brief, that sentence belongs in a rule.

## What you will see

A rule is a markdown file. Agent V already reads the ones your project may have, such as `AGENTS.md`, `CLAUDE.md` and `.cursorrules`, and the files in `.vyotiq/rules/` and `.cursor/rules/`. Its frontmatter decides when it is used; this one, with `globs`, applies only to work under `src/routes`: when a file there is open, or once the agent reads or edits one. Extensions, "Rules" lists it as "Matching files". The brief has the agent write the rule for you; `/create-rule`, or "New rule" in Extensions, "Rules", starts one by hand.

Under "What the agent will see", the "Rules" line on the "New task" page names the rule files that apply to every step, such as `AGENTS.md`, and counts the others. A rule with `globs` is not counted there, because it applies only to matching files.

## What to check

- Keep rules short and concrete. A rule that reads like a style guide gets followed less than three lines of do and do not.
- For facts rather than rules, such as "the staging database is reset every night", ask the agent to note them in memory. Its notes live in `.vyotiq/memory/` in the project, and `index.md` and `state.md` there are read on every step.
- Rules and memory are files in your project, so you can review them in git like any other change.
