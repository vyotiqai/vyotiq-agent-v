---
title: Extensions
description: Add MCP servers, skills, rules and packages from the Extensions page, choose where each one runs, and how MCP tools load.
group: Extend
order: 1
---

Extensions add tools and know-how to the agent. Open "Extensions" from the top of the navigator. The [extensions page](/extensions) on this site lists what ships with the app.

## The tabs

| Tab | What it holds |
| --- | --- |
| "All" | Everything below, in one list |
| "MCP servers" | Servers that give the agent extra tools |
| "Skills" | Instructions the agent loads when a task calls for them |
| "Rules" | Instructions added to the agent's context |
| "Packages" | Bundles of skills and rules |

The app ships with a catalog of 29 MCP servers, 48 skills and 4 packages. Skills and rules are covered in [Rules and skills](/docs/rules-and-skills).

## Adding an MCP server

1. On the "All" or "MCP servers" tab, click "Add MCP server". The dialog is titled "Add an MCP server".
2. "Paste a URL, npm package, npx command or JSON". The dialog recognises what you pasted, for example "Detected a remote HTTP server" or "Detected an npm package".
3. Check the name and the details. A remote server uses "HTTP" or "SSE"; a local one has a command, arguments and environment variables.
4. Tick "Available in this workspace only" if it should not reach your other workspaces.
5. Click "Add and connect".

Already set up servers in another app? "Import from Cursor or Claude…" reads their config files and lets you pick which servers to bring over.

### What local servers need

Local servers are started with a launcher, which must be on your PATH:

| Launcher | Comes with |
| --- | --- |
| `npx` | Node.js |
| `uvx` | uv |
| `git` | Git |

If the launcher is missing, the server's page says it "was not found on PATH, so this server cannot start", with "Locate binary…" and "Retry".

## Where it can run

Each extension's page has "Where it can run":

| Choice | Effect |
| --- | --- |
| "All workspaces" | On everywhere |
| "This workspace" | On only in the workspace you are in |
| "Off here" | Off in this workspace |

## MCP tools load on demand

Tool definitions take room in every request. So by default a step lists the connected MCP servers by name only, and the agent loads a server's tools when it needs them:

- `request_mcp_tools` loads a server's tools, or single tools, from the next step on.
- `release_mcp_tools` drops them again, which frees that space.

You can change this in two places:

- **One server:** its "Every step" switch in Extensions keeps its tools loaded on every step.
- **All servers:** Settings, "Tools", "Preload every MCP tool": "Send every connected tool's schema on every step." It is off by default.

A server's page can also list tools to deny, one per line.

## MCP tools ask by default

MCP tools come from outside Agent V, so they ask before they run. "MCP tools always ask" in Settings, "Agent", is on by default and holds "Even when approvals are off." See [Approvals](/docs/approvals).

## Packages

A package bundles skills and rules for one kind of work. The four in the catalog:

| Package | What it bundles |
| --- | --- |
| Devtools | A debug-checklist skill and a workspace conventions rule |
| Electron app | A workflow skill and main/renderer conventions for Electron and Vite apps |
| Quality | Skills for code and security review, plus quality conventions |
| Shipping | Skills for commits, pull requests and tests, plus shipping conventions |
