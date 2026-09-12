---
title: Security and approval model
description: How mode boundaries, tool approval, path guards, and browser restrictions stack — and what they do not cover.
section: concepts
order: 3
type: concept
audience: Security-conscious users
related:
  - concepts/privacy-data
  - agent/modes
  - tools/browser
---

Agent V stacks layered controls. No single control makes agent output or third-party content trustworthy.

## Mode boundary

Ask mode exposes read-only built-ins and browse-only browser actions. Plan mode adds todos, diagnostics, and run_tests, and writes only to the run's plan.md and contract.md. Agent mode exposes the full built-in catalog. MCP server calls are Agent-only, because server-supplied annotations are not a security gate.

Automatic mode switching is off by default. While it is off, only you can change the mode.

## Tool approval

In [Settings → Tools](/docs/reference/settings#tools), `Tool approval` defaults to Off:

- **Ask for edits and commands** gates mutating tools.
- **Ask for every tool** gates reads as well.
- Allowlisted tool names skip later prompts until you remove them.

Autonomous mode auto-approves tools that are normally gated, but high-risk actions stay gated. Read a prompt's tool name, arguments, workspace, and risk text before accepting.

## Workspace and path guards

File operations resolve against the workspace and reject path escapes. Memory writes have an extra `.vyotiq/memory` boundary. Agent instances without a worktree require an explicit write `path_scope`. Run directories validate IDs and reject symlink escapes.

Terminal commands and external tools can still cause effects no file checkpoint can reverse.

## Browser and network

The embedded browser treats page content as untrusted. The browser domain allowlist can restrict every navigation and redirect to exact hosts or `*.suffix` entries. An empty allowlist skips that host filter, but built-in SSRF checks still apply.

Provider requests, remote MCP calls, GitHub operations, and browser navigation all cross the local boundary. Review the destination and content before approving.

## Secrets and diagnostics

API keys, MCP bearer tokens, and GitHub tokens use Electron safeStorage where available. Local rotating logs are always written. Opt-in crash and error reporting works only when the build has a Sentry DSN, and reports exclude chat contents, keys, and file bodies.

## Residual risk

Models make mistakes, and external pages, packages, skills, rules, prompts, and MCP output can be malicious. Keep credentials least-privilege, keep workspaces narrow, leave approval gates on, review diffs in Git, and keep backups. Keep, Discard, and /undo only cover checkpointed agent writes.
