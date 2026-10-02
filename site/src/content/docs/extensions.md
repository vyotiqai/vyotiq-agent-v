---
title: Extensions
description: Add MCP servers, skills, rules and packages from the Extensions page, choose where each one runs, and how MCP tools load.
group: Extend
order: 1
---

Extensions add tools and know-how to the agent. Open Extensions with its icon at the bottom of the navigator, between Inbox and Usage. You can also choose "Extensions" in the command palette or type `/marketplace` in the composer. The [extensions page](/extensions) on this site lists what ships with the app.

## The tabs

| Tab | What it holds |
| --- | --- |
| "All" | Everything below, in one list |
| "MCP servers" | Servers that give the agent extra tools |
| "Skills" | Instructions the agent loads when a task calls for them |
| "Rules" | Instructions added to the agent's context |
| "Packages" | Bundles of skills and rules, and sometimes MCP servers |

Each tab groups its list into "Needs you", "Installed" and "Discover". "Discover" holds catalog entries you have not added yet, each with "Add". An added row has an on/off switch, and a server that needs an account has "Sign in". Select a row to see its detail pane on the right.

The app ships with a catalog of 29 MCP servers, 9 skills and 4 packages. The "Design level-up" skill is added for you on first launch. Skills and rules are covered in [Rules and skills](/docs/rules-and-skills).

## Adding an MCP server

1. Click "Add MCP server" at the top right of Extensions. It is there on every tab except "Skills" and "Rules". The dialog is titled "Add an MCP server".
2. Paste into the field labelled "Paste a URL, npm package, npx command or JSON". The dialog says what it found, for example "Detected a remote HTTP server" or "Detected an npm package". A git URL waits until you click "Detect", because detecting clones it.
3. Check the name and the details. A remote server has a "URL" and a "Transport" of "HTTP" or "SSE"; a local one has a "Command", "Arguments" and "Env".
4. Tick "Available in this workspace only" if it should not reach your other workspaces.
5. Click "Add and connect". When the JSON holds several servers, the button reads "Import 2", "Import 3" and so on.

The first time you add something that is not bundled, a dialog titled "Acknowledge marketplace risk" asks you to confirm that packages and MCP endpoints are unsigned.

Already set up servers in another app? "Import from Cursor or Claude…" reads the Cursor and Claude Desktop config files on this machine and lets you pick which servers to bring over. Imported servers are added to every workspace.

A server that needs an account asks you to sign in after you add it. Its detail pane shows "Sign in with GitHub", "Sign in with Google", "Add token" or "Sign in", depending on the server.

### What local servers need

A local server runs a command, and that command must be on your PATH. The catalog's local servers use these:

| Command | Comes with | Used by |
| --- | --- | --- |
| `npx` | Node.js | Filesystem, Memory, Sequential thinking, Playwright, Chrome DevTools |
| `uvx` | uv | Fetch, Time, Git |
| `git` | Git | Git, alongside `uvx` |

A server you add yourself needs whatever command it runs, such as `docker`.

If that command is missing, the server shows under "Needs you", and its detail pane says it "was not found on PATH, so this server cannot start", with "Locate binary…" and "Retry". A catalog server also gets an install button, such as "Install uvx".

## Where it can run

Select an added MCP server, skill or package, and its detail pane shows "Where it can run". With a workspace open, the choices are:

| Choice | Effect |
| --- | --- |
| "All workspaces" | On everywhere |
| "This workspace" | On only in the workspace you are in |
| "Off here" | Off in this workspace |

With no workspace open, the choices are "All workspaces" and "Off". A user rule offers only those two. A server that comes inside a package follows the package: its choices are "With" plus the package's name, or "Off here". Skill folders and workspace rule files have no such choice. Each row's ⋯ menu has the same choices, with the middle one reading "This workspace only".

## MCP tools load on demand

Tool definitions take room in every request. So by default a step lists each connected server's tool names without their definitions, and the agent loads the definitions when it needs them:

- `request_mcp_tools` loads a server's tools, or single tools, from the next step on.
- `release_mcp_tools` drops them again, which frees that space.

Calling a listed tool directly also loads it, one step later.

You can change this in two places:

- **One server:** turn on "Every step" under "Configuration" in the server's detail pane.
- **All servers:** Settings, "Tools", "Preload every MCP tool": "Send every connected tool's schema on every step." It is off by default.

Under "Configuration", "Never allow" blocks tools by name and "Allow only" limits the server to the tools you list, one name per line.

## MCP tools ask by default

MCP tools come from outside Agent V, so they ask before they run. "MCP tools always ask" in Settings, "Agent", is on by default; its note reads "Even when approvals are off." An MCP tool you allow with "Always allow" stops asking. "Unattended mode" does not approve MCP tools: they count as high-risk, so they still ask. See [Approvals](/docs/approvals).

## Registry and trust

The gear button at the end of the tab row opens "Registry and trust":

- **"Package registry":** a "Registry URL" whose packages are listed beside the bundled ones. They are unsigned, so add only from sources you trust.
- **"Trust":** "I understand packages and MCP endpoints are unsigned". You tick it once before installing anything that is not bundled.
- **"MCP servers":** "Reconnect all MCP servers" stops every running server and starts it again.
- **"Install from source":** install a package from a "Folder or zip", "Git", "npm" or a "Remote MCP" URL with an optional "Token".

## Packages

A package bundles skills and rules, and sometimes MCP servers, for one kind of work. Its rules are not added on every step: the agent sees each rule's first line and loads the rule with the `Skill` tool when it applies. The four in the catalog:

| Package | What it bundles |
| --- | --- |
| Devtools | A debug-checklist skill and a workspace conventions rule |
| Electron app | A workflow skill and main/renderer conventions for Electron and Vite apps |
| Quality | Skills for code and security review, plus quality conventions |
| Shipping | Skills for commits, pull requests and tests, plus shipping conventions |
