---
title: Models and keys
description: The model providers Agent V supports, how to add an API key, where keys are kept, and how to use local or custom endpoints.
group: Start
order: 2
---

Agent V does not ship its own model. You connect a provider, and the agent sends its requests there with your key. Everything on this page lives in Settings, "Providers": "Model providers and their keys. Keys are encrypted on this device and sent only to their provider."

## Providers

| Provider | Key needed |
| --- | --- |
| OpenAI | Yes |
| Anthropic | Yes |
| Gemini | Yes |
| Ollama | No, when it runs on your machine |
| DeepSeek | Yes |
| Groq | Yes |
| OpenRouter | Yes |
| xAI | Yes |
| Mistral | Yes |
| Custom OpenAI-compatible | Only for public hosts |
| OpenCode Go | Yes |

The "Model" group at the top of the page sets the "Provider for new tasks" and the "Model". You can refresh the model list from there. The brief on the "New task" page also has a model and effort menu; see [Writing a task](/docs/writing-a-task).

## Adding a key

1. Open Settings, "Providers", and find the provider under "API keys".
2. Click "Add key" ("Manage" once a key is saved, and always for local Ollama).
3. Paste the key into the "Paste a {provider} API key" field and click "Save key".

"Get a key" links to the provider's own key page. "Clear" removes a saved key. Each row says where it stands: "Key saved", "Local · no key needed", "No key", or "Can’t save keys".

### Where keys are stored

Keys are encrypted with your operating system's secure storage and written to `secrets.json` in the app's data folder. A key is sent only to the provider it belongs to.

If your system has no secure storage, keys cannot be saved at all: the field reads "Secure storage unavailable" and the page says "OS secure storage is unavailable on this system, so API keys cannot be saved." On Linux, Agent V also refuses the insecure `basic_text` backend. Set up a real password store (for example `--password-store=gnome-libsecret`) to save keys there.

## Custom OpenAI-compatible endpoints

"Custom endpoints" takes "Any OpenAI-compatible server: vLLM, llama.cpp, LM Studio, a hosted gateway".

- Click "Add endpoint", give it a name ("Name, such as Home GPU") and a base URL.
- You can save up to 20 endpoints. Each one appears as its own provider.
- The base URL should end in `/v1`. If it has no `/v1`, Agent V adds it.
- The default base is `http://127.0.0.1:8080/v1`.
- "Public hosts need a key; loopback and a private LAN can go without."

Agent V has no price table for custom endpoints, so their tasks show tokens but no cost. See [Usage and cost](/docs/usage-and-cost).

## Ollama: local or cloud

Ollama is the default provider. It points at `http://127.0.0.1:11434`, the local Ollama daemon, and needs no key.

If you save an Ollama API key, the provider moves to Ollama Cloud at `https://ollama.com`. In the app's words: "Saving an API key moves this to Ollama Cloud (https://ollama.com); a local host never needs one."

## OpenCode Go

"OpenCode Go is a $10/month subscription. Subscribe, then paste the API key from its console." The "Subscribe" link opens the OpenCode Go page. Its model list is not fixed in the app: Agent V reads the current list from the public models.dev registry.

## If the provider does not connect

The first-run setup checks the provider by reading its model list, and shows the reason if that fails. Home also lists a missing key under "Needs you": "Tasks can’t start until a key is saved for it", with an "Add key" button that opens this page.
