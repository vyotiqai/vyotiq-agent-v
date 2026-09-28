---
title: Instances
description: How a task splits work across sub-agents called instances, what each one is told, how they are isolated, and what the parent gets back.
group: Tasks
order: 3
---

An instance is a sub-agent that a task starts for one small, independent piece of the work. A task that has two or more separate workstreams can run them in parallel as instances, then collect and merge the results.

You do not start instances yourself. The agent decides to use them, in Agent mode, with these tools:

| Tool | What it does |
| --- | --- |
| `spawn_agent_instance` | Starts an instance with a brief |
| `await_agent_instance` | Waits for one or more instances to finish |
| `pull_agent_instance` | Reads an instance's report, outline or latest messages |
| `merge_agent_instance` | Merges a finished instance's branch into the parent |
| `cancel_agent_instance` | Stops an instance that is stuck or no longer needed |

In the record, starting one shows as "Spawned instance". Each instance also appears as a short id on the plan step it carries out. Click the id to open that instance.

## The brief an instance gets

An instance never sees the parent's conversation. Everything it knows comes from its brief:

| Field | Purpose |
| --- | --- |
| `goal` | The background the workstream needs |
| `outcome` | The single thing it should deliver |
| `sub_tasks` | Ordered steps, each one checkable on its own |
| `done_when` | Tests, commands or files that prove it is done |
| `path_scope` | Optional. The workspace paths it may write under |

## Limits

- **How many at once.** Settings, "Agent", "Instances at once": "Sub-agents a task may run in parallel. One more is refused until one finishes." The default is 16, and you can set it from 1 to 16.
- **No nested instances.** Only a top-level task can start instances. An instance's page says it "Reports back to its parent · cannot start instances of its own".
- **Instructions come from the parent.** An instance's page has no instruction line of its own: "Instances take instructions from their parent task." "Add an instruction to the parent" takes you back to the parent's instruction line.

## Isolation

How an instance is kept apart from other work depends on what it may do.

| Kind | Where it works |
| --- | --- |
| Can write (default) | Its own git worktree, on a branch under `vyotiq/instance/` |
| Shared | Directly in the workspace. Needs a `path_scope`. |
| Read only | Directly in the workspace, in Ask mode, with no worktree |

- A worktree starts from the parent's current commit plus its uncommitted changes to tracked files.
- If the workspace is not a git repository, an instance that writes must have a `path_scope`.
- With a `path_scope`, a write outside those paths is refused. The instance's page lists the paths under "Writes only under these paths".
- The instance's page shows its branch under "Scope": "Works in its own worktree {branch}".

After an instance finishes, its branch is kept so the parent can merge it. Kept branches are pruned once their last commit is 14 days old. A branch with nothing that other branches do not already have goes at once.

Worktrees need git on your PATH. See [Git and GitHub](/docs/git-and-github).

## What the parent gets back

- **Await** returns the instance's phase, its summary and the files it wrote. The summary is cut at about 20,000 characters. One await waits at most 15 minutes. If the instance is still running then, it keeps going, and the parent can wait again, pull its output, or cancel it.
- **Pull** reads more: the final report (up to about 60,000 characters), an outline, or the newest messages.
- **Merge** brings a finished instance's branch into the parent, one branch at a time. It is refused before it starts when the parent has uncommitted or untracked changes to files the branch also changed. A merge that conflicts fails, and you resolve it in the parent.

Merging an instance is one of the actions that still asks for your approval in unattended runs. See [Approvals](/docs/approvals).
