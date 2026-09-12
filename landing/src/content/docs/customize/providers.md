---
title: Providers and API keys
description: Configure one of eleven provider hosts, store credentials securely, and make a configured provider active.
section: customize
order: 1
type: guide
audience: Everyone configuring models
related:
  - customize/models
  - troubleshooting/providers-models
  - start/quickstart
---

Open [Settings → Providers](/docs/reference/settings#providers). Agent V supports eleven provider IDs:

| Provider | ID | Credential rule |
| --- | --- | --- |
| **OpenAI** | `openai` | API key |
| Anthropic | `anthropic` | API key |
| Gemini | `gemini` | API key |
| Ollama | `ollama` | Key only for Ollama Cloud; local host is keyless |
| DeepSeek | `deepseek` | API key |
| Groq | `groq` | API key |
| **OpenRouter** | `openrouter` | API key |
| xAI | `xai` | API key |
| Mistral | `mistral` | API key |
| Custom OpenAI-compatible | `custom` | Key required for public hosts; private and loopback hosts can be keyless |
| OpenCode Go | `opencode` | API key |

Before you change provider settings, **Active provider** shows local Ollama and the selected model is `qwen2.5`. This initial active selection does not install or start Ollama, and it does not prove that the local endpoint is reachable.

## Configure a cloud provider

1. Expand the host under API keys.
1. Enter and save the key. Credentials use Electron safeStorage; they are not written into workspace files.
1. Set **Active provider**. Saving a key does not switch Active automatically.
1. Return to the composer, open the model picker, and select a model.
1. Use `Refresh models` to query the provider's current catalog.

The `Active provider` menu lists configured providers and always retains the current active provider. A provider counts as configured when it has a saved key or its current Ollama/Custom host is allowed to be keyless.

## Configure Ollama

Set Ollama base URL. The local default is `http://127.0.0.1:11434`. A saved Ollama key with the local URL routes to Ollama Cloud; an explicit remote host remains explicit.

## Configure an OpenAI-compatible host

Set the Custom OpenAI base URL. The default is `http://127.0.0.1:8080/v1`. The app normalizes the scheme and /v1 path and preserves vendor suffixes that already include a v1 mount.

If the host has no model-list endpoint (for example, the Cloudflare Workers AI compatible API), the live catalog cannot load. Type the model ID into the composer model picker search box and press Enter to use it directly; the typed ID is sent to the host as the model name.

## Troubleshoot activation

If a saved provider does not appear, confirm the key or keyless-host rule, then refresh Settings. If the live model catalog fails, fallback seed names can still appear; that does not prove the remote endpoint accepted a chat request.
