# Agent types

An agent type is a helper you define once, as a markdown file. A task spawns it
with `spawn_agent_instance` and `agent_type: "<name>"`. The child runs with the
file's instructions, its tool list and its model. Without `agent_type`, the
child is a general helper, as before.

## Where the files go

The first file to claim a name wins. Names are matched ignoring case.

| Where | Scope |
| --- | --- |
| `<workspace>/.vyotiq/agent-types/*.md` | this workspace |
| `<workspace>/.claude/agents/*.md` | this workspace (Claude Code's subagent files, read as they are) |
| `<userData>/agent-types/*.md` | every workspace |

A workspace file overrides a user file with the same name. The directory is
`agent-types`, not `agents`: `.vyotiq/agents/` belongs to the retired profiles
feature, and `writeGuard.assertNotRetiredAgentDataPath` keeps runs out of it.

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

| Field | Meaning |
| --- | --- |
| `name` | Required. Letters, digits, `-` and `_`, up to 64 characters. |
| `description` | Required. The parent reads this line when it picks a helper. |
| `tools` | Optional. Accepts a comma list, `[a, b]` or a `- a` block list. If you leave it out, the child gets every tool its mode allows. |
| `model` | Optional. Accepts `inherit`, `sonnet`/`opus`/`haiku`, `provider:model` (e.g. `anthropic:claude-opus-5`), or a model id. |
| body | The helper's instructions. |

Other keys, such as Claude Code's `color`, are ignored.

### `tools`

Tools can be named in VYOTIQ's builtin form (`read`, `str_replace`, `terminal`)
or in Claude Code's form. Claude Code names are mapped:

| Claude Code | Maps to |
| --- | --- |
| `Bash` | `terminal` |
| `Edit` | `edit` and `str_replace` |
| `Write` | `edit` |
| `LS` | `list_dir` |
| `WebFetch` | `browser_navigate` and `browser_snapshot` |
| `WebSearch` | `browser_search` |
| `TodoWrite` | `todo_write` |

MCP tools are named as `mcp__<server>__<tool>`. To grant a whole server, use
`mcp__<server>` or `mcp__<server>__*`. Granting any MCP tool also grants the
MCP loading tools.

Some names are dropped with a warning instead of being granted:

- unknown names
- `Task` and the rest of the spawn/await family, because a helper cannot spawn
  helpers

If no usable name is left, the file is invalid. A typed child always keeps
`todo_write`, `create_plan` and `check_done_when`. These are its own
bookkeeping, not capabilities.

The list narrows what the child's mode already allows and never widens it:

- `read_only: true` still runs the child in Ask mode.
- If every tool a type declares is read-only, the child runs read-only on its
  own, with no worktree.

The list is saved in the child's `status.json` when it is spawned. It filters
the child's tool catalog and is checked again by the tool gate.

### `model`

| Value | Model used |
| --- | --- |
| `inherit` | The task's model. |
| `sonnet` / `opus` / `haiku` | The first model in that family on a provider with credentials. Providers are tried in this order: the task's, the helper model's, then Anthropic. If the task's model is already in that family, its exact id is kept. |
| `provider:model` | That exact model, if the provider has credentials. |
| A bare model id | The first of those providers that lists it. Otherwise, the helper's provider. |

If the named model can't run here, the child falls back to the helper model.
The spawn result notes the fallback, and it's logged.

## How it reaches the prompt

- **Parent.** A root run in Agent mode gets an `<agent_types>` list, with each
  type's name, description and tools. The list sits beside `<available_skills>`
  in the stable system zone. It changes only when a type file changes, so the
  cached prefix holds between steps. The `spawn_agent_instance` schema stays
  static.
- **Child.** The type's body goes in the child's first message, inside an
  `<agent_type>` block after the brief. It does not go in the system prompt,
  which every helper shares and the provider caches. It is also left out of
  `contract.md`, which keeps the brief only.

## When a file is wrong

A file that fails validation is skipped. The rest still load. Each skipped
file is reported in three places:

- in a log warning, once per file version
- in the spawn error for an unknown `agent_type`, which also lists the valid
  names
- in the loader's `issues`

Files are re-read when their mtime or size changes, so a new or edited type is
picked up on the next step.

## Where it is shown

The task record and the navigator show the type's name as a muted label on
the instance row.

## Code and tests

- Code: `src/main/agent/agentTypes.ts`. The tool gate is
  `toolAllowlist` in `tools/modePolicy.ts`.
- Tests: `tests/main/unit/agentTypes.test.ts` and
  `tests/main/unit/agentInstances.test.ts`.
