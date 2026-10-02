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
| Ollama | No, unless you use Ollama Cloud |
| DeepSeek | Yes |
| Groq | Yes |
| OpenRouter | Yes |
| xAI | Yes |
| Mistral | Yes |
| Custom OpenAI-compatible | Only for public hosts |
| OpenCode Go | Yes |
| Amazon Bedrock | An API key or AWS access keys |
| Google Vertex AI | A service-account key or this computer's gcloud login |
| Azure OpenAI | Yes (added as a custom endpoint) |

The "Model" group at the top of the Providers section sets the "Provider for new tasks", the "Model" and the "Effort". The provider menu lists only providers that have a key or need none. The refresh button reloads the model list. Each provider row also has "Use for new tasks", and the one in use is marked "In use". A workspace can run its own model: Settings, "General", "Workspaces" ("Override gives a workspace its own model and agent settings."). The brief on the "New task" page also has a model and effort menu; see [Writing a task](/docs/writing-a-task).

## Adding a key

1. Open Settings, "Providers", and find the provider under "API keys", or under "Custom endpoints" for your own servers.
2. Click "Add key", or "Manage" when the row has a key or needs none.
3. Paste the key into the "Paste a {provider} API key" field and click "Save key".

"Get a key" links to the provider's key page until a key is saved. "Clear" removes a saved key; for Bedrock and Vertex AI the button is "Sign out". Each row says where it stands: "Key saved", "Local · no key needed", "No key", or "Can’t save keys". Dictation's cloud engines (Settings, "Voice") use the OpenAI or OpenRouter key saved here.

### Where keys are stored

Keys are encrypted with your operating system's secure storage and written to `secrets.json` in the app's data folder. A key is sent only to the provider it belongs to.

If your system has no secure storage, keys cannot be saved at all: the field reads "Secure storage unavailable" and the page says "OS secure storage is unavailable on this system, so API keys cannot be saved." On Linux, Agent V also refuses the insecure `basic_text` backend. Set up a real password store (for example `--password-store=gnome-libsecret`) to save keys there.

## Custom OpenAI-compatible endpoints

With no endpoints added, "Custom endpoints" reads "Any OpenAI-compatible server: vLLM, llama.cpp, LM Studio, a hosted gateway".

- Click "Add endpoint", pick "OpenAI-compatible" or "Azure OpenAI", give it a name ("Name, such as Home GPU") and a base URL, then click "Add".
- You can save up to 20 endpoints. Each one appears as its own provider. "Remove" deletes one, but not while it is the provider for new tasks.
- The base URL should contain `/v1`, or a vendor's mount such as `/v1/openai`. If it has no `/v1`, Agent V adds it.
- The built-in "Custom OpenAI-compatible" row starts at `http://127.0.0.1:8080/v1`. An added endpoint needs its own URL.
- "Public hosts need a key; loopback and a private LAN can go without."

Agent V has no price table for custom endpoints. Their tasks show tokens, and a cost only when the server reports one. See [Usage and cost](/docs/usage-and-cost).

### Azure OpenAI

In "Add endpoint", pick "Azure OpenAI" and paste the resource endpoint from the Azure portal, like `https://my-resource.openai.azure.com`. A deployment URL works too; Agent V keeps only the resource and uses Azure's v1 API (`/openai/v1`), which needs no `api-version`. The key goes in an `api-key` header. Pick models by their deployment names.

### Extra headers

An endpoint you added has an extra headers box, one `Name: value` per line and up to 16, for gateways that route on a header or want an organisation id. Headers the request owns (`Host`, `Content-Type`, `Content-Length` and the like) can't be set. The headers are stored in settings, not the key vault, so put secrets in the API key.

### Tool calls written as text

Some local models write a tool call as text in their own template syntax (`<tool_call>…`, `[TOOL_CALLS]…`, `<|python_tag|>…`) instead of as a real tool call. Agent V recognises these, `<function=…>` and a reply that is only a JSON call, and runs the call, but only for tools the model was offered. JSON shown inside a longer explanation is left as a reply.

## Amazon Bedrock

Open the "Amazon Bedrock" row and set the "AWS region". Tasks call `bedrock-runtime.<region>.amazonaws.com`, and the model list comes from `bedrock.<region>.amazonaws.com`. Then sign in one of two ways:

- "API key": a Bedrock API key, sent as a bearer token.
- "Access keys": an access key ID, a secret access key and, for temporary keys, a session token. Requests are signed with AWS Signature Version 4.

Every model goes through Bedrock's Converse API. The model list shows your account's system inference profiles (the `global.` and `us.` ids newer Claude models require) and the on-demand text models. Claude gets thinking and prompt caching, Amazon Nova gets prompt caching, and other models get what Converse supports.

## Google Vertex AI

Open the "Google Vertex AI" row and set the "Google Cloud project" and the "Vertex location": `global`, `us`, `eu`, or a region like `us-east5`. Then sign in:

- "Key file": paste a service-account key (the whole JSON file).
- "gcloud login": use the login `gcloud auth application-default login` wrote on this computer. "Check this computer" shows what it found. Then click "Use this login". Nothing is copied; the file is read when a task starts.

Gemini models go through `streamGenerateContent`, Claude models through `streamRawPredict`. Models from other publishers on Vertex are not supported yet. Vertex has no endpoint that lists the models a project can use, so the list comes from the models.dev registry, after Agent V checks your sign-in works.

Agent V has no price table for Bedrock, Vertex AI or Azure, so their tasks show tokens but no cost, and the per-task spend limit can't count them.

## Claude through OpenRouter

For Claude models through OpenRouter, or through a custom endpoint pointed at `openrouter.ai`, Agent V marks where the provider may cache the prompt.

## Helper and utility models

Settings, "Agent" has two more model choices. Both start as "Same as the task".

| Setting | What it runs |
| --- | --- |
| "Helper model" | [Instances](/docs/instances). "Same as the task" runs each instance on the model its task was started with. |
| "Utility model" | Compaction summaries and commit messages. A cheaper model is enough for these. Compaction still decides what to keep by the task's model. If this provider has no key, the task's model is used. |

Pick a provider, then one of its models. Choosing a provider alone saves nothing.

## Ollama: local or cloud

Ollama is the default provider. It points at `http://127.0.0.1:11434`, the local Ollama daemon, and needs no key. Open the Ollama row to point it at another host.

If you save an Ollama API key, the provider moves to Ollama Cloud at `https://ollama.com`. In the app's words: "Saving an API key moves this to Ollama Cloud (https://ollama.com); a local host never needs one."

## OpenCode Go

"OpenCode Go is a $10/month subscription. Subscribe, then paste the API key from its console." The "Subscribe" link opens the OpenCode Go page. Its model list is not fixed in the app: Agent V reads the current list from the public models.dev registry.

## Behind a proxy

Settings, "General", "Network" sets the proxy for everything the app sends: provider calls, MCP servers, updates, downloads, the agent's browser, and the `git`, `npm` and other commands the agent runs.

| "Proxy" | What it does |
| --- | --- |
| "System" | Uses `HTTPS_PROXY` or `HTTP_PROXY`, with `NO_PROXY`, when set. Otherwise it uses the operating system's proxy. |
| "Manual" | Uses the "Proxy address" for everything except the hosts in "Skip the proxy for". This computer is always skipped. |
| "None" | Connects directly. |

The line under the choice shows the proxy in use and where it came from. A proxy that needs a password can't be typed in; set `HTTPS_PROXY=http://user:password@host:port` before starting the app instead. A SOCKS system proxy reaches the agent's browser and updates, but not provider calls. With a PAC file, provider calls follow the proxy it picks for `https://api.openai.com`.

## If the provider does not connect

The first-run setup checks the provider by reading its model list, and shows the reason if that fails. Home also lists a missing key under "Needs you": "Tasks can’t start until a key is saved for it", with an "Add key" button that opens this page.
