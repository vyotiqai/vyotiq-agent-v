---
title: Changes and Git
description: Inspect working-tree status and diffs, separate checkpoints from Git history, and commit through the correct boundary.
section: tools
order: 4
type: guide
audience: Version-control users
related:
  - agent/checkpoints
  - tools/pull-requests
  - troubleshooting/git-pull-requests
---

The Changes panel combines repository status and diff review with Agent V checkpoint actions. Git history and checkpoints remain separate systems.

## Prerequisites

Open a workspace inside a Git repository. Without a repository, the panel can show file activity but Git status, diffs, and branch operations are unavailable.

## Review a change

1. Open [Changes](/docs/tools/changes-git).
1. Refresh if the working tree changed outside the app.
1. Select a file and inspect the diff.
1. Distinguish tracked modifications, new files, deletions, and repository-wide pre-existing changes.
1. Run the relevant project verification.

Agent writes do not become safe merely because a diff renders. Review behavior and generated files as well as source text.

## Keep and Discard

Keep and Discard act on an agent write checkpoint. `Keep` accepts that checkpoint state. `Discard` restores it. Neither stages files, creates a commit, or changes a remote.

The Files editor's Discard/Reload applies to one editor buffer and is not this action.

## Built-in Git tools

- `git_status` is read-only and available in Ask, Plan, and Agent.
- `git_diff` is read-only and available in Ask, Plan, and Agent.
- `git_commit` is Agent-only, stages files changed by the current run, and can optionally push when requested.

Before a commit, inspect both staged and unstaged changes. Do not include secrets or unrelated existing work. Git identity must already be configured outside the app; the agent must not invent it.

## Remote work

A local commit does not create a pull request. Use the Pull Request panel or an explicit GitHub CLI workflow after confirming branch, remote, authentication, and commit state. For missing repository, identity, remote, or GitHub errors, see [Git and pull-request issues](/docs/troubleshooting/git-pull-requests).
