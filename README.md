# Agent V

[![CI](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml/badge.svg)](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-111111.svg)](LICENSE)

Coding workspace for real repositories: natural-language harness, workspace tools, multi-provider chat, live context management, and file-backed long-term memory. Includes a live agent browser (navigate, snapshot, click, type), interactive terminal dock (xterm + node-pty when available), git Changes panel, and optional GitHub pull-request panel via the gh CLI (`gh auth login` required). Memory is plain markdown — no embedding RAG for memory; `codebase_search` may use a local embedding model for semantic code search when configured.

## Stack

- Electron 43.2.0 · pnpm · electron-vite · React 19 · TypeScript · Tailwind CSS 4
- Zod-validated IPC · `safeStorage` for API keys
- Plus Jakarta Sans + JetBrains Mono · AAA neutral grayscale (light/dark)
- Frameless window (`titleBarStyle: hidden` / overlay)

Installers: [GitHub Releases](https://github.com/vyotiqai/vyotiq-agent-v/releases/latest). Website: [vyotiq.com](https://vyotiq.com).

## Setup

```bash
pnpm install
pnpm dev
```

Copy `.env.example` → `.env` only if you want an optional Sentry DSN (gitignored).

### Interactive terminal (node-pty)

The Terminal panel prefers a real PTY via optional `node-pty` (matched to Electron’s ABI via postinstall / `@electron/rebuild`). If the native module cannot load, a pipe-shell fallback is used (line editing / resize degraded).

On Windows, a full source rebuild needs Visual Studio Build Tools with Spectre-mitigated libraries. Prebuilds for Electron often work without a local compile — do not force `npm_config_build_from_source`. To rebuild explicitly:

```bash
npx @electron/rebuild -f -w node-pty
```

Project paths with spaces are fine when using prebuilds; if a source rebuild fails, rebuild once via a junction (`mklink /J C:\vyotiq-dev "<repo>"`) without renaming the project.

## Scripts

| Script | Purpose |
| --- | --- |
| `pnpm dev` | Dev app with HMR |
| `pnpm typecheck` | tsc for main + renderer |
| `pnpm test` | Unit, integration, and renderer tests |
| `pnpm build` | Production bundle → `out/` |
| `pnpm pack:win` / `pnpm pack:mac` / `pnpm pack:linux` | Platform installers |

## Smoke test

1. Start Ollama and `ollama pull qwen2.5`, or set the Ollama base URL to `https://ollama.com` and save an Ollama Cloud API key in Settings (or use another provider’s API key).
2. `pnpm dev` → pick a workspace → send a message.
3. Confirm tool rows (`read` / `search` / `memory_*` / …), streaming text, and Stop cancels the run.

## Providers (12)

OpenAI · Anthropic · Gemini · Ollama · DeepSeek · Groq · OpenRouter · xAI · Modal · Mistral · OpenCode Go · Custom (OpenAI-compatible)

- **Ollama:** Local daemon by default (no key). Saving an Ollama API key automatically uses Ollama Cloud (`https://ollama.com`).
- **Custom:** Any OpenAI-compatible `/v1` host (Cerebras, Fireworks, Together, vLLM, …). Set the base URL in Settings; local hosts need no key.
- **Modal:** OpenAI-compatible Shared Endpoints (`https://inference.<region>.modal.direct/v1`). The API key is the Modal proxy token in its combined form (`wk-<id>.ws-<secret>`); model IDs are endpoint hostnames returned by `/v1/models`.
- **Extended thinking:** Reasoning-capable models stream a separate thinking channel (collapsed in chat). Configure in the composer model picker (thinking on/off, effort, show/hide), along with compaction.
- OpenAI GPT-5 / o-series models use the Responses API (`/v1/responses`) by default (thinking off still uses Responses without reasoning). GPT-5.6+ sends explicit prompt-cache breakpoints on the system prefix.
- Gemini thinking models use the Interactions API (`/v1beta/interactions`) with stateful `previous_interaction_id`.
- Anthropic uses Messages API extended/adaptive thinking; DeepSeek and OpenRouter use Chat Completions with `reasoning_content` / reasoning replay on tool steps.
- Non-thinking models keep Chat Completions / Messages / `streamGenerateContent` paths.

Composer and Settings load live models via `models:list` (5-minute cache). Seed catalogs are offline fallbacks only — the bundled seed model IDs are illustrative placeholders and are superseded by the live catalog whenever the provider is reachable.

Image attach on user turns (data URLs). Ollama accepts base64 only (no remote image URLs).

Non-vision models strip image parts to a text marker before the provider call; Composer prefers a vision-capable model when images are attached.

## Context + memory

Universal client context pipeline: budget layers, tool-result trimming, structured compaction, workspace snapshot, memory tools (`memory_list` / `memory_read` / `memory_write`) for long-term memory, live context-window meter in the composer.

Read-only built-in tools may run in parallel when the model requests multiple calls in one step (that includes built-in MCP meta tools like `mcp_list_tools`). Dynamic `mcp__<server>__<tool>` calls always run serially and are not auto-exempt from approval via `readOnlyHint` (session/workspace allowlists can still skip prompts).

Marketplace (sidebar): **MCPs**, **Skills**, **Rules**, and **Packages**. Discover / Featured catalog for MCP servers, skills, and plugins; Manage installs and configures them (stdio / HTTP / SSE). Marketplace → Manage → Registry holds the optional remote catalog URL. Enabled skills contribute name/description metadata to the system prompt (full `SKILL.md` loads via the Skill tool or `/slash`); plugins expand nested MCP + skills + rules.

Anthropic also sends server `cache_control` when available. (Server-side `context_management` — `clear_tool_uses` / `compact` — is not sent; LLM summarization is the only context-shrink path.)

Long-term memory lives at `{workspace}/.vyotiq/memory/` (`index.md`, `notes/*.md`, optional `state.md`) with tools `memory_list` / `memory_read` / `memory_write`.

Memory is not RAG — no embeddings or vector search. Agents write and read explicit markdown files.

## Layout

Process boundaries: renderer must not import `@main/*`; main/preload must not import `@renderer/*`. Aliases: `@shared` → `src/shared`, `@main` → `src/main`, `@renderer` → `src/renderer/src`.

```text
src/main/          # window, security, IPC, secrets, agent loop / tools / providers / context / logging
src/preload/       # contextBridge API (+ optional Sentry renderer bridge)
src/shared/        # Zod IPC contracts, channels, AppError, logger facade, scrubber
src/renderer/      # React UI (sidebar + chat + settings + ErrorBoundary)
resources/harness/ # system agent harness (default.md — behavioral policy; per-tool how-to lives in tool defs)
```

Run state (chat sessions) lives under AppData, not in the project folder:

```text
%APPDATA%/vyotiq/          # or platform userData equivalent
  workspaces.json          # open tabs, UI state, settings overrides
  settings.json
  secrets.json
  logs/
  workspaces/
    {workspaceId}/         # stable UUID from canonical workspace path
      meta.json
      sessions/
        {runId}/
          contract.md
          plan.md
          status.json
          messages.jsonl
          events.jsonl
          receipt.json
```

Project-local agent memory stays at `{workspace}/.vyotiq/memory/` only and is accessed through memory tools; it is not injected automatically. `resources/harness/default.md` is the canonical bundled system harness and `/harness-apply` target. A well-formed workspace copy is appended as capped, untrusted preferences; it never replaces the bundled security spine. Built-in tool details live in `src/main/agent/schemas/tools.ts`, not in a duplicated harness catalog.

When adding or changing a built-in tool, update its argument schema, handler, and runtime limits/classification together. Keep the tool description as a short capability blurb; `tests/main/unit/toolsSchema.test.ts` checks registry/handler parity and the harness boundary.

Run file contract: `messages.jsonl` is the canonical chat transcript (one JSON object per line: user/assistant/tool messages). `events.jsonl` is an append-only ops log (status, step_usage, context_usage, etc. with ISO `at` timestamps); full tool output is stored only in `messages.jsonl`. The UI rebuilds the chat timeline from `messages.jsonl` on reload and shows run telemetry in the composer context meter. Legacy session-only runs under `{userData}/sessions/` are migrated into the workspace AppData sessions folder on first startup.

See [SECURITY.md](SECURITY.md) for vulnerability reporting. Product docs for the public site live under `landing/` (Word sources; Markdown is generated on `pnpm install`).

## Security

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`
- Paths sandboxed to the workspace root; memory tools stay under `.vyotiq/memory/`; secrets via OS `safeStorage`
- CSP + navigation locks on the BrowserWindow

## Logging & telemetry

Always on: structured rotating logs under `{userData}/logs/` (`vyotiq.log`), via electron-log across main + renderer. Logs record Vyotiq system telemetry only (error codes, tool names, run IDs, opaque workspace IDs) — never workspace paths, file names, search queries, terminal commands, or chat/tool payloads.

Open the folder from Settings → General → Open logs folder.

Optional Sentry: only when both a build-time DSN and Settings → “Share crash & error reports” are enabled (default off). No Session Replay; the same no-user-data policy applies (allowlisted fields + secret scrubbing).

Set either env var before `pnpm dev` / pack (do not commit secrets):

```bash
# Main process
SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>

# Renderer (same value is fine; electron-vite also maps SENTRY_DSN → VITE_SENTRY_DSN)
VITE_SENTRY_DSN=https://<key>@o<org>.ingest.sentry.io/<project>
```

## Scope (kept lean)

The built-in catalog has up to **61** tools (mode and code-indexing settings hide some at runtime; see `src/main/agent/schemas/tools.ts` for the canonical registry).

Core tools: `read` · `edit` · `search` · `glob` · `grep` · `codebase_search` · `list_dir` · `str_replace` · `delete` · `todo_write` · `create_plan` · `browser_search` · `browser_navigate` · `browser_snapshot` · `browser_click` · `browser_type` · `browser_scroll` · `browser_fill` · `browser_tabs` · `browser_back` · `browser_forward` · `browser_wait_for_selector` · `browser_wait_for_url` · `browser_press_key` · `browser_select_option` · `browser_hover` · `browser_wait_for_text` · `browser_handle_dialog` · `mcp_list_tools` · `request_mcp_tools` · `release_mcp_tools` · `mcp_list_resources` · `mcp_read_resource` · `mcp_list_prompts` · `mcp_get_prompt` · `ask_question` · `switch_mode` · `terminal` · `memory_list` · `memory_read` · `memory_write` · `Skill` · `git_status` · `git_diff` · `git_commit` · `git_apply` · `github_pr_create` · `github_pr_review` · `github_issue` · `lsp` · `edit_notebook` · `run_tests` · `spawn_agent_instance` · `await_agent_instance` · `pull_agent_instance` · `merge_agent_instance` · `cancel_agent_instance` · `diagnostics`. Side rail: Browser / Terminal / Changes / Plan panels. Agent browser tools allow unrestricted URLs (localhost, LAN, public).
