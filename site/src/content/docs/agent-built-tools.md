---
title: Agent-built tools
description: How the agent writes its own tools with build_tool, where they live, why they are not sandboxed, and how their approvals work.
group: Extend
order: 3
---

The agent can write a tool for itself. When a run keeps repeating the same mechanical job that no built-in tool covers, it can turn that job into a tool with `build_tool`. From the next step on, the new tool is in the catalog like any other, and it stays there for later runs.

This is the most capable thing in the tool list, so read this page before you approve one.

## How a tool is made

`build_tool` takes four things, plus an optional `overwrite`:

| Argument | What it is |
| --- | --- |
| `name` | The tool's name: lowercase letters, digits, `_` and `-`, up to 32 characters |
| `description` | What it does, as the model will read it, up to 500 characters |
| `schema` | A JSON Schema for its arguments |
| `code` | A JavaScript module that exports `async function handler(args, ctx)`. It can import Node built-in modules only. |

Agent V writes the module as `<name>.mjs`. A header comment at the top of the file holds the name, description and schema. Agent V reads that header as text to list the tool, and never runs the module just to list it.

`build_tool` checks the schema's shape and refuses a name that is already taken. With `overwrite: true`, the agent can replace a tool it wrote earlier.

In the record, this shows as a "Built a tool" row. Each call to the tool later shows as a row with its name and "agent-built".

### Names it cannot use

`build_tool` refuses the name of a built-in tool or one of its aliases, such as `read`, `terminal` or `write`. It also refuses names starting with `mcp__`. A written tool can never stand in for a tool the agent already relies on.

## Where tools live

Tools are saved in the `agent-tools` folder inside the app's data folder, as `<userData>/agent-tools/<name>.mjs`. They are not in your project, and tasks in every workspace can use them.

Nothing expires. A tool stays in the catalog for every later run until you delete its file by hand.

Settings, "Tools", lists them in "Catalog" under "Agent-built tools", once at least one exists: "Written by a run — each call asks you, and asks again whenever the code changes". That list shows each tool's name and description. To read the code, open the `.mjs` file.

## Not sandboxed

Each call runs the module in a separate process with full Node.js access. It can read and write files anywhere your user account can, start other programs, and use the network. It does not get the app's own environment variables: like the terminal, it sees only the basics such as `PATH` and your home folder, so tokens the app was started with stay out of it. The only other built-in limit is a 30-second timeout per call. A module that fails, times out or exits without answering becomes a failed tool call, not a crashed run.

Approval is the control. There is no other fence around the code.

## Approvals

Agent-built tools are gated more tightly than anything else:

- **Building one asks**, unless "Ask before" is "Nothing" or you allowed `build_tool` for the task or always. The card's "Show the full request" holds the `code` as raw JSON, cut after 4,000 characters, so read a long module in its file before you allow its first call. With "Nothing" the build goes through without asking, but every call to the new tool still asks.
- **Every call asks, even with approvals off**, until you allow that exact code for the task or always. Setting "Ask before" to "Nothing" covers the tools that ship with the app, not code a run wrote minutes ago.
- **Unattended mode does not approve them.** Both `build_tool` and every agent-built tool are high-risk, so they still ask.
- **An allow is tied to the file's contents.** "Allow for this task" and "Always allow" for an agent-built tool are saved against a hash of its code, not just its name. If the module changes, even with the same name, the old allow no longer matches and the tool asks again. "Always allow" applies to the workspace you are in, and removing the tool from Settings, "Agent", "Always allowed" makes it ask again.

See [Approvals](/docs/approvals) for the modes and the card.

## Other limits

- Only Agent mode can build or use these tools. Ask mode cannot.
- An [instance](/docs/instances) that shares the workspace under a `path_scope`, with no worktree of its own, cannot use them. The module has no path scope, so it could write past that boundary.

## Related

- [Data and storage](/docs/data-and-storage) for where the app's data folder is
- [The task record](/docs/the-task-record) for the "Built a tool" row
