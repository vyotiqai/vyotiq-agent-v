# Agent V

Agent V is a proprietary coding workspace for real repositories by [Vyotiq](https://vyotiq.com). It pairs a natural-language agent harness with workspace tools, multi-provider chat, live context management, and file-backed long-term memory.

## Highlights

- **Workspace tools** - **60** tools for read/edit/search, glob, grep, codebase_search, list_dir, and terminal access, all sandboxed to the workspace root.
- **Live agent browser** — navigate, snapshot, click, type, and wait on any page from inside a run.
- **Interactive terminal dock** — xterm-based terminal (real PTY via node-pty when available).
- **Git integration** — Changes panel, commits, and optional GitHub pull-request panel.
- **Multi-provider chat** — OpenAI, Anthropic, Gemini, Ollama, DeepSeek, Groq, OpenRouter, xAI, Modal, Mistral, and any OpenAI-compatible endpoint.
- **Context management** — budget layers, tool-result trimming, structured compaction, and a live context-window meter.
- **Long-term memory** — plain markdown memory under `{workspace}/.vyotiq/memory/`, injected into every run.
- **Marketplace** — install **MCPs**, **Skills**, **Rules**, and **Packages**.

## Install

Download the installer for Windows, macOS, or Linux from [https://vyotiq.pages.dev](https://vyotiq.pages.dev) or [https://vyotiq.com](https://vyotiq.com).

## Support

For support, visit [https://vyotiq.com](https://vyotiq.com). Product documentation is available at https://vyotiq.com/docs.

## Security

Agent V runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`; paths are sandboxed to the workspace root, secrets use OS `safeStorage`, and the window carries CSP plus navigation locks. Structured logs record telemetry only - never workspace paths, file names, or chat payloads.

---

Copyright (c) 2026 Vyotiq. All rights reserved. Agent V is proprietary Vyotiq software.
