---
title: Built-in tools
description: Web reading and search without the browser, reading the browser's console, the workspace's memory, and tools that load only when a task needs them.
group: Extend
order: 5
---

Settings, "Tools", "Catalog" lists every tool the agent has: the built-in ones, the ones runs wrote ([Agent-built tools](/docs/agent-built-tools)), and each MCP server's. This page covers the built-in tools that need a word of their own.

## Reading and searching the web

- **`web_fetch`** reads one web page as text (HTML becomes Markdown) without opening the agent's browser. It reads `http` and `https` only, follows the browser's site allowlist (Settings, "Tools", "Browser"), and cuts long pages. What it reads is marked as untrusted content.
- **`web_search`** returns titles, links and snippets. Where it asks is Settings, "Tools", "Web search", "web_search asks":

| Engine | Needs |
| --- | --- |
| DuckDuckGo (no key) | Nothing. It can ask for a check the agent cannot pass; then the agent falls back to `browser_search` |
| Brave Search API | An API key |
| Tavily API | An API key |
| SearXNG (your own) | Its address, with its JSON output on |

Keys go to the key vault, never settings.json. Both tools ask before they run in the default approval mode, like the browser: a URL can carry data out. See [Approvals](/docs/approvals).

## The browser's console

`browser_console` reads the open page's console messages and the requests that failed (an error status, or no answer), newest last, for front-end debugging. It can filter by level and clear what it read. It only reads, so it does not ask.

## The workspace's memory

The agent keeps notes for a workspace in `.vyotiq/memory/` inside the project, with `index.md` pointing at them. It can list, read, write and delete notes (`memory_delete`); writing and deleting ask in the default mode.

Settings, "Agent", "Rules and memory", "Memory" lists the notes: click one to read it, and use its trash button to delete it. A note `index.md` does not point at is marked, since tasks may not find it.

## Tools that load when needed

Every tool's definition takes room in every request. MCP servers' tools wait until a task asks for them ([Extensions](/docs/extensions#mcp-tools-load-on-demand)), and so do the less-used built-ins: most `browser_*` tools beyond navigate, snapshot, click, type, fill, scroll and tabs, and `merge_agent_instance`. The agent sees their names and loads one with `request_mcp_tools`, or by calling it, which runs it and keeps it loaded for the rest of the run.

Settings, "Tools", "Preload every MCP tool" sends all of them every step instead.
