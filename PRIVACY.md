# Privacy Policy

**Effective date:** 19 September 2026
**Applies to:** the Vyotiq ("Agent V") desktop application and the website at vyotiq.com
**Publisher:** Vyotiq — GitHub organization [vyotiqai](https://github.com/vyotiqai)

This policy describes how the software behaves as it is built today. Every statement below
points at the code that implements it, in the public repository
[vyotiqai/vyotiq-agent-v](https://github.com/vyotiqai/vyotiq-agent-v). If you find a
discrepancy between this document and the source, the source is authoritative — please
[open an issue](https://github.com/vyotiqai/vyotiq-agent-v/issues).

This is a plain description of data handling written by the maintainers. It is not legal
advice and has not been reviewed by a lawyer.

## 1. Summary

- Agent V is a **local desktop application**. Your repositories, chats, run history, workspace
  memory, and voice audio are processed **on your own machine**.
- There is **no Vyotiq account**, no sign-in, no hosted workspace, and no Vyotiq server that
  your code or prompts pass through.
- Model requests go **directly from your machine to the provider you configured**, using
  **your** API key. Vyotiq does not proxy, observe, or retain them.
- Crash reporting is **off by default** and additionally requires a build-time Sentry DSN.
  Both conditions must be true before anything is sent.
- The website is a **static site with no analytics**, no tracking pixels, and no third-party
  scripts.

## 2. Who this covers

People who download, install, or run Agent V; people who visit vyotiq.com; and people who
contact the project through GitHub or the security address in
[SECURITY.md](./SECURITY.md).

## 3. What the app stores on your device

All of the following stays on your machine. None of it is transmitted to Vyotiq.

| Category | Examples | Where it lives |
| --- | --- | --- |
| Workspace and code | Repository paths, file contents the agent reads or edits | The folders you open |
| Chats and agent runs | Messages, tool calls, run history, checkpoints | Electron `userData` |
| Workspace memory | Notes the agent keeps between runs | `.vyotiq/memory/` in the workspace |
| Provider credentials | API keys for the providers you configure | OS keychain (see §4) |
| Settings | Preferences, including `telemetryEnabled` | `settings.json` in Electron `userData` |
| Code index | Keyword index and local embeddings of your repository | Per-workspace SQLite in `userData` |
| Logs and crash diagnostics | Application logs, crash snapshots | Local log files |

`userData` is the standard per-user Electron application directory for your operating system.

## 4. How API keys are stored

Provider API keys and MCP server secrets are encrypted with Electron `safeStorage`, which is
backed by the operating system keychain — Keychain on macOS, DPAPI on Windows, and libsecret
or kwallet on Linux.

If the OS keychain is unavailable, the app **raises an error rather than writing your key in
plain text** (`src/main/settings/secrets.ts`). On Linux it additionally refuses the
`basic_text` backend, which is Electron's unencrypted fallback, and tells you to configure a
real password store.

Keys are never written to the repository, never included in logs or crash reports, and never
sent to Vyotiq.

## 5. What leaves your machine, and when

Agent V makes network requests only for the things you ask it to do. There is no background
telemetry beyond the optional crash reporting in §6.

**Model providers — your keys, your relationship.** When you send a message, your prompt,
the code context the agent gathered, and tool results go directly to the provider you
selected, authenticated with your own API key. Those requests are governed by that
provider's privacy policy and terms, not this one. The app supports OpenAI, Anthropic,
Gemini, Ollama, DeepSeek, Groq, OpenRouter, xAI, Mistral, any custom OpenAI-compatible
endpoint, and OpenCode Go. Ollama and private or LAN endpoints run without any key at all,
which lets you use the app with no third party involved.

**Model metadata.** The app reads public model catalogues from `models.dev` and, for the
OpenCode provider, `opencode.ai` to show context windows and pricing. These requests contain
no prompt content.

**Model downloads.** The first time you use dictation or semantic code search, the required
model weights are downloaded from `huggingface.co` — the Whisper speech model and the
MiniLM embedding model respectively. These are ordinary file downloads containing none of
your data.

**Updates.** The app checks GitHub for new releases. This is a plain HTTPS request to the
public releases repository; nothing about your workspace is included.

**Tools you invoke.** Git and GitHub tools talk to the remotes you have configured. MCP
servers you install talk to their own vendors under their own terms. The built-in browser
and `browser_search` fetch the pages and search engine you point them at. Each of these runs
because you or the agent explicitly invoked it.

## 6. Crash and error reporting (optional, off by default)

Crash reporting uses Sentry and is disabled unless **both** of the following are true:

1. the build contains a Sentry DSN, and
2. you turn **Share crash & error reports** on in Settings.

The setting defaults to `false`
(`src/shared/ipc/schemas/settings.ts`), and initialization is gated on both conditions
(`src/main/logging/sentry.ts`). Builds without a DSN cannot send anything regardless of the
setting.

When enabled, reports contain error messages, stack traces, and application state relevant
to the fault. They are not designed to carry file contents, prompts, or credentials. You can
turn it off at any time in Settings, which disables it immediately.

## 7. Voice dictation

Transcription runs locally through Whisper on the ONNX runtime inside the app. Your audio is
processed on your machine and is not uploaded.

The model itself is **not bundled with the installer** — on first use the app downloads the
weights you select from Hugging Face into `userData`
(`src/main/dictation/download.ts`). After that download, dictation works offline.

## 8. Code indexing

The code index is built and stored locally per workspace. Semantic search embeddings are
computed on your machine with a local MiniLM model; your code is not sent anywhere to be
embedded. The embedding model is downloaded once from Hugging Face, as in §7.

## 9. The website

vyotiq.com is a static site. It sets no cookies, embeds no analytics or tracking scripts, and
loads no third-party JavaScript — the build asserts this and fails if a third-party script
origin appears. Download links point at GitHub release assets; following one means GitHub
serves that file and applies its own privacy policy.

## 10. Children

Agent V is a developer tool and is not directed at children.

## 11. Your choices

Because the data is on your machine, you control it directly:

- Delete a workspace's `.vyotiq/` directory to remove its memory and rules.
- Use **Settings → Storage** to review and clear local application data.
- Delete stored keys from **Settings → Providers**.
- Turn off crash reporting in Settings.
- Use Ollama or a local OpenAI-compatible endpoint to keep model inference on your machine
  too.

## 12. Changes

Material changes to this policy will be committed to this file in the public repository, so
the full history of what it said and when is visible in git.

## 13. Contact

Security reports: see [SECURITY.md](./SECURITY.md).
Everything else: <https://github.com/vyotiqai/vyotiq-agent-v/issues>.
