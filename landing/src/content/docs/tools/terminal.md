---
title: Terminal
description: Distinguish interactive terminal sessions from agent commands, choose a shell, and recover from PTY fallback.
section: tools
order: 3
type: guide
audience: CLI users
related:
  - troubleshooting/browser-terminal
  - reference/settings
  - reference/tools
---

Agent V has two command surfaces with different lifecycles.

## Interactive Terminal panel

The Terminal dock hosts interactive sessions backed by a pseudo-terminal when available. Sessions can have their own shell and current working directory. The session bar lets you create and switch terminal sessions; layout support can split the interactive surface.

Closing a chat view and interrupting an agent run do not mean the same thing as ending every interactive terminal process. Read the terminal session state before assuming a command stopped.

## Agent terminal tool

The terminal built-in runs a command for the agent and returns captured output. It is Agent-only and can require approval. Repository rules can further constrain command use.

Use this tool for builds, tests, package managers, and CLI workflows. File inspection should use read and search tools so path guards and output limits remain clear.

## Select a shell

Open [Settings → Tools](/docs/reference/settings#tools) → Terminal shell:

- Auto (PowerShell on Windows when available)
- Windows cmd.exe
- PowerShell
- Bash

Auto prefers PowerShell on Windows. Explicitly selecting a shell does not install it. If Bash is not available on the machine, choose an installed shell.

## Working directory

Agent commands and newly created terminal sessions start from the active workspace context unless the command or session changes directory. Always confirm the active workspace before running a destructive command.

## PTY fallback

The package can fall back when the native PTY module is unavailable. A fallback may not reproduce every interactive terminal feature. Preserve the exact message, selected shell, workspace path, and command when diagnosing it.

Do not kill broad Node, Electron, or pnpm process groups to clear a terminal problem. Close the named session or stop the specific command through its own control. See [Browser and terminal issues](/docs/troubleshooting/browser-terminal) for ordered checks.
