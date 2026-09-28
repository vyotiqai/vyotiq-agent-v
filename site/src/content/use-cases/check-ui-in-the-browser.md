---
title: Let it check its own UI
description: For front-end work, have the agent start your dev server and look at the page in its own browser before it calls the job done.
stage: Everyday work
order: 6
teaches: [Terminal, Browser, Done when]
mode: Agent
brief: |-
  When the sign-up form is submitted empty, the error text overlaps the Create account button. Fix the layout. Start the dev server with pnpm dev, open the sign-up page, submit the form empty, and look at the result before you finish.
checks:
  - After an empty submit, the error text and the button do not overlap
  - pnpm test passes
docs:
  - { label: The task record, href: /docs/the-task-record }
  - { label: Approvals, href: /docs/approvals }
  - { label: Extensions, href: /docs/extensions }
---

## When to use it

Any change you would otherwise check by opening the page yourself: layout, a form, a flow through two or three screens. A test suite rarely catches an overlap; a look does.

## What you will see

The agent starts the dev server in a terminal, then opens the page in its own browser. You can watch it in the inspector's "Browser" tab: it navigates, clicks, types and takes snapshots of the page to see what it built. In Agent mode that browser can reach `localhost`, so it can test your local server.

Each command still asks first under "Edits and commands", including starting the server.

## What to check

- Look at the last snapshot yourself in the record. If the agent says the overlap is gone, the snapshot should show it.
- Name the state to look at in the brief ("submit it empty", "signed out"). The agent checks what you name.
- The agent's browser does not change its window size. For a check at a fixed width, or a flow you want to keep as a test, add the Playwright MCP server from Extensions.
