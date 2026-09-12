---
title: What Agent V is
description: A coding workspace that runs an agent inside your repository, with enforced modes, local-first storage, and explicit memory.
section: concepts
order: 1
type: concept
audience: Evaluators and users
related:
  - concepts/runs-sessions-state
  - concepts/security
---

Agent V is a coding workspace for working through real repositories. It combines a natural-language harness, workspace tools, provider-hosted models, live context management, and explicit file-backed memory.

The app and your workspaces stay on this machine. Model requests go to the provider you configure. New installs default to a local Ollama server, but Ollama still has to be installed and running before it can serve a request.

## Product surfaces

Three top-level views organize the product: chat, Settings, and Marketplace. Chat includes workspace and chat navigation, a persisted transcript, the composer, and six dock panels: Files, Browser, Terminal, Changes, Pull Request, and Plan.

Ask, Plan, and Agent are enforced interaction modes. The built-in tool catalog has 60 tools, including Skill. Connected MCP servers can add separate Agent-only tools.

## Local and remote boundaries

Workspace files, run records, indexes, logs, settings, notifications, and local model caches are stored locally. Content leaves the machine only when a configured model provider, remote MCP server, remote Ollama host, GitHub, or a website receives it.

API keys use operating-system secure storage. That protects keys at rest; it does not change the fact that a provider receives the prompts and attached content you send it.

## Explicit non-goals

- Agent V is not a hosted cloud IDE; the repository stays a local folder.
- Memory is not automatic retrieval-augmented generation. It is markdown under `.vyotiq/memory/`.
- Semantic code search is a derived local index, not memory.
- Marketplace is not one undifferentiated bucket. Manage separates **MCPs**, **Skills**, **Rules**, and **Packages**.
- Composer @ Docs means project documentation, not this product manual.

## Run model

A chat stores an evolving run history, and each send starts a new invocation in that run. /clear creates a fresh chat. Child agent instances get their own run and transcript; they are not another desktop window or a UI split.
