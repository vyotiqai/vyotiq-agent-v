---
title: Instances
description: How a task splits work across sub-agents called instances, what each one is told, how they are isolated, and what the parent gets back.
group: Tasks
order: 3
---

An instance is a sub-agent that a task starts for one small, independent piece of the work. In Agent mode, the agent is told to plan first and give each step to its own instance, even for a small request. Independent instances run in parallel, and the task collects and merges the results.

You do not start instances yourself. The agent decides to use them, in Agent mode, with these tools:

| Tool | What it does |
| --- | --- |
| `spawn_agent_instance` | Starts an instance with a brief |
| `await_agent_instance` | Waits for an instance to finish. The agent can wait on several at once. |
| `pull_agent_instance` | Reads an instance's report, outline or latest messages |
| `merge_agent_instance` | Merges the branch of an instance that finished successfully into the parent |
| `cancel_agent_instance` | Stops an instance that is stuck or no longer needed |

Starting, waiting on, reading and cancelling instances never ask for approval. The instance's own tool calls ask as usual.

In the record, each instance has a row that follows it, such as "Running instance" and then "Instance finished", "Instance failed" or "Instance cancelled", with its short id and an "Open" button. Instances started together share one block headed by their count, such as "3 instances". Each instance's short id also appears on the plan step it carries out. Click the id to open that instance.

While a task runs, the navigator lists its instances in a fold under it, such as "3 instances · 2 going". When an instance needs your approval or has a question, the parent's record shows "Needs you" with an "Open instance" button. You answer in the instance's own record.

## The brief an instance gets

An instance never sees the parent's conversation. Everything it knows comes from its brief:

| Field | Purpose |
| --- | --- |
| `goal` | The background the workstream needs |
| `outcome` | The single thing it should deliver |
| `sub_tasks` | Ordered steps, each one checkable on its own |
| `done_when` | Tests, commands or files that prove it is done |
| `path_scope` | Optional. The workspace paths it may write under |
| `isolation` | Optional. `shared` runs it directly in the workspace instead of a worktree |
| `read_only` | Optional. `true` for an instance that only reads and reports |
| `step_id` | Optional. The plan step it carries out |

## Limits

- **How many at once.** Settings, "Agent", "Instances at once": "Sub-agents a task may run in parallel. One more is refused until one finishes." The default is 16, and you can set it from 1 to 16.
- **Which model.** Settings, "Agent", "Helper model": "What instances run on." Left unset, each instance runs on the model its task was started with.
- **Spend.** "Spend limit per task" counts what the task's instances spend.
- **No nested instances.** Only a top-level task can start instances. An instance's page says it "Reports back to its parent · cannot start instances of its own".
- **Instructions come from the parent.** An instance's page has no instruction line of its own: "Instances take instructions from their parent task." "Add an instruction to the parent" takes you back to the parent's instruction line. The page has a "Stop" button while the instance runs.
- **No restarts.** An instance does not keep running after the app restarts.

## Isolation

How an instance is kept apart from other work depends on what it may do.

| Kind | Where it works |
| --- | --- |
| Can write (default) | Its own git worktree, on a branch under `vyotiq/instance/` |
| Shared | Directly in the workspace. Needs a `path_scope`. It cannot use the terminal, `git_commit`, MCP tools or [agent-built tools](/docs/agent-built-tools). |
| Read only | Directly in the workspace, in Ask mode, with no worktree |

- A worktree starts from the parent's current commit plus its uncommitted changes to tracked files. With a `path_scope`, only those folders are checked out. The parent's `node_modules` is linked in.
- If git is missing, the workspace is not a git repository, or it has no commit yet, an instance that writes needs a `path_scope` and works directly in the workspace.
- With a `path_scope`, a write outside those paths is refused. The instance's page lists those paths under "Scope", with the note "Writes only under these paths".
- The instance's page shows its branch under "Scope": "Works in its own worktree", then the branch name.
- An instance cannot push. Its work reaches the parent through a merge.

When an instance finishes or fails, its branch is kept; a cancelled instance's branch is deleted. A merged branch is deleted after the merge. When the app starts or you open a workspace, Agent V deletes kept branches whose last commit is 14 days old, and any branch whose commits are already on another branch.

Worktrees need git on your PATH. See [Git and GitHub](/docs/git-and-github).

## What the parent gets back

- **Await** returns the instance's phase, its summary and the files it wrote, plus whether a check passed after its last code change. The summary is cut at about 20,000 characters. One await waits at most 15 minutes. If the instance is still running then, it keeps going, and the parent can wait again, pull its output, or cancel it.
- **Pull** reads more: the final report (up to about 60,000 characters), an outline, or the newest messages.
- **Merge** brings the branch of an instance that finished successfully into the parent, one branch at a time. It is refused before it starts when the parent has uncommitted or untracked changes to files the branch also changed. A merge that conflicts is undone and fails. Resolve the conflict in the parent, then merge again. Merged files can be rewound like any other edit of that turn.

With "Unattended mode" on, merging an instance still asks for your approval, unless "Ask before" is "Nothing" or you chose "Always allow" for it. See [Approvals](/docs/approvals).

For a worked example, see [Split a job into parallel parts](/use-cases/split-a-job-across-instances).
