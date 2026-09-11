---
title: Agent instances
description: Delegate independent work to depth-one child runs, inspect their progress, and merge isolated work deliberately.
section: agent
order: 7
type: guide
audience: Advanced agent users
related:
  - agent/workspaces-sessions
  - reference/tools
  - tools/changes-git
---

An agent instance is a child Agent V run created by a root Agent run. It has its own run state and transcript. It is not a split pane and it does not inherit the parent's transcript automatically.

## When instances help

Use instances for independent workstreams that can be described completely and verified separately, such as researching two subsystems or implementing changes in disjoint path scopes. Keep dependent steps in one instance goal.

Instances are depth one: a child cannot spawn another child.

## Isolation choices

`spawn_agent_instance` supports two write boundaries:

- A Git worktree and branch isolate the child's checkout.
- Without a worktree, a required `path_scope` limits writes in the shared parent workspace.

Shared-path instances write directly into the parent's tree; there is nothing to merge afterward. Worktree instances require an explicit merge-back step.

## Typical workflow

1. Give the child a complete goal: outcome, constraints, dependent steps, verification, and path boundary.
1. Spawn independent instances.
1. Use `await_agent_instance` for the run IDs together instead of repeatedly polling.
1. Use `pull_agent_instance` when you need the outline or recent transcript.
1. Review the child's status and changed files.
1. For a completed worktree child, use `merge_agent_instance` one at a time while the parent tree is clean.

The Agent Instance pane exposes child status in the parent transcript.

## Safety boundaries

Do not merge merely because a child stopped running. Confirm its done state and test evidence. A worktree merge can fail when the parent is dirty or branches conflict; resolve that state explicitly rather than bypassing it.

The five instance tools (`spawn_agent_instance`, `await_agent_instance`, `pull_agent_instance`, `merge_agent_instance`, and `cancel_agent_instance`) are root-Agent-only.
