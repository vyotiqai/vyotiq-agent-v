---
title: Provider and model issues
description: Recover from missing keys, inactive providers, empty catalogs, refresh errors, and unsupported model capabilities.
section: troubleshooting
order: 1
type: troubleshooting
audience: Users blocked from chat
related:
  - customize/providers
  - customize/models
  - start/quickstart
---

## No providers appear in the composer

Likely cause: no provider is configured.

1. Open [Settings → Providers](/docs/customize/providers).
1. Save the required key, or confirm a keyless local Ollama/private Custom host.
1. Set **Active provider**. Saving a key alone does not switch it.
1. Return to chat and reopen the model picker.

Expected empty-state text is No providers configured — open [Settings → Providers](/docs/customize/providers).

## Active provider is empty

The `Active menu` lists configured hosts only. If it says No providers configured yet. Add an API key below or use local Ollama, confirm secure storage accepted the key. For Ollama, confirm whether the host is local or Ollama Cloud; Cloud requires a key.

## Refresh models fails

Check in this order:

1. Provider key status.
1. Ollama base URL or Custom **OpenAI** base URL.
1. Network reachability to the configured host.
1. Provider response or rate-limit text.
1. Retry `Refresh models` once.

Seed model names can remain visible when the live catalog fails. They are fallback metadata, not proof that chat will succeed.

Some Custom hosts serve chat but no model list (HTTP 405 or 501 on `GET /models` — e.g. Cloudflare Workers AI compat). The catalog then shows a "does not serve a model list" notice instead of an error: the host is reachable and chat connects. Type the model ID in the composer model picker search and press Enter to use it manually; a wrong ID surfaces as the host's own HTTP error during the run. HTTP 404 usually means the base URL is wrong — fix it in Settings, then refresh.

## A model cannot use an attachment or control

The selected model metadata may not advertise image, native file, audio, tools, thinking, structured output, or a service tier. Choose a model with the required capability. Do not force a provider-specific parameter by changing unrelated settings.

## Secure storage reports a failure

Agent V refuses plaintext fallback for provider and MCP secrets. Fix operating-system keychain or secure-storage availability, then save again. Do not place the key in a rule, skill, prompt, or workspace file.

If a provider request still fails, preserve provider ID, model ID, base URL host without credentials, exact error, and app version.
