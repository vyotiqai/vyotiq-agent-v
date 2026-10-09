---
title: Agent types
description: Define a helper once, as a markdown file with a name, a one-line purpose, the tools it may use and its model, and the agent can start instances of it.
group: Tasks
order: 3.5
---

An agent type is a kind of [instance](/docs/instances) you define once. It's a markdown file: a name, one line saying when to use it, the tools it may use, the model it runs on, and its instructions. When a task starts an instance, the agent can pick one of your types for it. With no type, the instance is a general helper.

## Where the files go

| Folder | Applies to |
| --- | --- |
| `.vyotiq/agent-types/` in the workspace | that workspace |
| `.claude/agents/` in the workspace | that workspace. Claude Code's subagent files are read as they are. |
| `agent-types/` in the app data folder (`%APPDATA%\vyotiq\agent-types` on Windows) | every workspace |

When two files use the same name, the first one in that order wins, so a workspace's type replaces yours. Case is ignored.

## An example

`.vyotiq/agent-types/reviewer.md`:

```markdown
---
name: reviewer
description: Reviews a change for bugs and missing tests. Use after code is written.
tools: Read, Grep, Glob
model: inherit
---

You review; you never edit. For each finding give the file and line, why it
is wrong, and the smallest fix. Say "no findings" rather than inventing one.
```

| Field | What it does |
| --- | --- |
| `name` | Required. Letters, digits, `-` and `_`, up to 64 characters. |
| `description` | Required. The agent reads this line when it picks a helper, so say when to use it. |
| `tools` | Optional. A comma list, `[a, b]`, or a list of `- a` lines. Left out, the instance gets every tool its mode allows. |
| `model` | Optional. `inherit`, `sonnet`, `opus` or `haiku`, `provider:model`, or a model id. |
| The text below | The helper's instructions. They go in the instance's first message, after its brief. |

Other fields, such as Claude Code's `color`, are ignored.

## Tools

Name tools the way Agent V does (`read`, `str_replace`, `terminal`) or the way Claude Code does. Claude Code's names are mapped: `Bash` is `terminal`, `Edit` is `edit` and `str_replace`, `Write` is `edit`, `LS` is `list_dir`, `WebFetch` is `web_fetch` with the browser's `browser_navigate` and `browser_snapshot`, `WebSearch` is `web_search` with `browser_search`, and `TodoWrite` is `todo_write`. For an MCP server's tools, write `mcp__<server>__<tool>`, or `mcp__<server>` for all of them.

The list only narrows. An instance never gets a tool its mode doesn't allow, and if every tool you list only reads, the instance runs read-only, with no worktree of its own. Unknown names are skipped, and so is `Task`, because an instance can't start instances. A file with no usable tool left is skipped whole.

## Model

| Value | Runs on |
| --- | --- |
| `inherit` | The task's model. |
| `sonnet`, `opus`, `haiku` | The first model of that family on a provider you have a key for. |
| `provider:model` | That model, if you have a key for the provider. |
| A model id | The first provider that lists it. |

If the model can't run here, the instance runs on the helper model from Settings, "Agent", and the task is told.

## Where you see it

The type's name is a muted label on the instance's row, in the task and in the navigator.

## When a file is wrong

A file that can't be read as a type is skipped, and the others still load. The reason is in the log. If the agent asks for a type that didn't load, it's told the valid names. Agent V reads a file again when it changes, so an edit counts from the next step.
