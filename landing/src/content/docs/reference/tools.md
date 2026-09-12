---
title: Built-in tools reference
description: "The built-in tool catalog: 60 registered tools grouped by job, with mode, approval, and output boundaries."
section: reference
order: 2
type: reference
audience: Advanced users
related:
  - agent/modes
  - concepts/security
  - customize/mcp
---

Names are the tool registry keys. Ask mode hides mutating tools; Plan mode allows only plan writes. Tool approval applies on top of mode filtering, so a tool that a mode hides cannot be enabled by an approval. MCP server tools are extra and appear in Agent runs only. `web_fetch` and `web_search` are not in the catalog: they exist only as legacy transcript bodies.

Every call is schema-validated against the registered tool schema before it runs.

## Files

- `read`: file or shallow directory listing under the workspace root (text). Windowless reads are capped at 2000 lines; zoom via startLine/endLine.
- `edit`: create/overwrite with contents, or apply a unified diff
- `list_dir`: one directory level with sizes
- `str_replace`: replace exact text in one file
- `delete`: delete a workspace file or directory (recursive for a non-empty directory)
- `edit_notebook`: insert or uniquely replace one cell in a nbformat v4 .ipynb (no kernel)
- `lsp`: language-server hover, completions, diagnostics, definition, or rename when a server is on PATH

## Search

- `search`: filename or content substring (first hit per file). Defaults to 40 hits; pass maxResults to widen.
- `glob`: workspace-relative glob paths. Defaults to 100 paths; pass maxResults to widen.
- `grep`: regex with matching lines. Defaults to 60 results; pass maxResults to widen.
- `codebase_search`: ranked search over the local code index (hybrid, semantic, or lexical) — not memory RAG

## Browser

Embedded agent browser. Page text is untrusted. After navigate/search/mutations, snapshot before using @eN refs.

- `browser_search`
- `browser_navigate`
- `browser_snapshot`
- `browser_click`
- `browser_type`
- `browser_scroll`
- `browser_fill`
- `browser_tabs`
- `browser_back`
- `browser_forward`
- `browser_wait_for_selector`
- `browser_wait_for_url`
- `browser_press_key`
- `browser_select_option`
- `browser_hover`
- `browser_wait_for_text`
- `browser_handle_dialog`

## Terminal and diagnostics

- `terminal`: shell command (builds/CLI, not file inspection)
- `diagnostics`: typecheck or lint (configured command, package script, or tsc/eslint)
- `run_tests`: workspace test script or an optional sandboxed command

## Git

- `git_status`
- `git_diff`
- `git_commit`: Agent-only; optional push; stages files this run changed
- `git_apply`: apply a unified diff with git apply
- `github_pr_create`: Agent-only; gh pr create (draft default)
- `github_pr_review`: Agent-only; approve / request-changes / comment
- `github_issue`: Agent-only; list or create

## Memory

- `memory_list`
- `memory_read`
- `memory_write`

See [Memory files](/docs/tools/memory).

## Skill

- `Skill`: load an enabled Marketplace skill (SKILL.md) or a plugin-rule id, or a relative file under a skill

## MCP meta

These are built-ins about connected servers, not the servers' own tools.

- `mcp_list_tools`
- `request_mcp_tools`
- `release_mcp_tools`
- `mcp_list_resources`
- `mcp_read_resource`
- `mcp_list_prompts`
- `mcp_get_prompt`

## Questions, todos, plans, and goals

- `ask_question`: typed form in the transcript; blocks until answer, skip, or timeout
- `todo_write`: this run's task list
- `create_plan`: publish plan.md (and the contract copy) for this run
- `create_goal`: start or replace this chat's long-lived goal (`goal.json`)
- `update_goal`: mark the goal complete or resume it after a user pause
- `switch_mode`: only present when Automatic mode switching is on

## Instances

Root runs only (depth 1). Git worktrees isolate writes; without a worktree, `path_scope` is required.

- `spawn_agent_instance`
- `await_agent_instance`
- `pull_agent_instance`
- `merge_agent_instance`
- `cancel_agent_instance`
