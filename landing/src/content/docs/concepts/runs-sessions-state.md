---
title: Runs, sessions, and state
description: How chats, invocations, run artifacts, child instances, and interruption map to on-disk state.
section: concepts
order: 2
type: concept
audience: Users and support
related:
  - agent/workspaces-sessions
  - agent/background-runs
  - reference/storage
---

Agent V tracks state at four levels: workspace, chat, run, and invocation.

## Workspace record

The app derives a stable workspace ID from the canonical project path, so the same folder always maps to the same record. Under app data, each workspace record holds its metadata, sessions, and code indexes.

## Chat and run

A chat points at one persisted run directory. Its transcript and status survive pane switches and app restarts. The run status records one of running, cancelled, error, or done, plus the current step, the last update time, the mode, the workspace, and whether an interruption is resumable.

## Invocation

Every send starts a new invocation inside the existing run. The invocation ID separates live events from late events that still belong to the previous turn. Continue starts a new invocation from persisted state; it never rewrites the earlier transcript.

## Run artifacts

A run directory can contain:

- the transcript (`messages.jsonl`) and event history (`events.jsonl`);
- run status;
- `contract.md` and `plan.md`;
- todo state;
- `goal.json` and `loop.json` for long-lived goals and prompt timers;
- checkpoint records;
- tool outputs and summaries;
- `receipt.json` with structured activity and write information.

The renderer may show shortened tool output while the full output stays in run storage.

## Child instances

An inline Agent instance gets its own run ID and a parent run ID. It can also record a path scope, a worktree path, and a worktree branch. Child runs are hidden from the top-level list and appear under the parent workflow.

## Interruption and cleanup

An orphaned or interrupted run can be marked resumable with an interruption timestamp. Opening that chat shows a Continue button, or the configured auto-resume picks it up.

Deleting or cleaning a run is a data operation, not closing a tab. Before cleanup, make sure the run does not hold the only copy of a plan, transcript, receipt, or evidence you need for support.
