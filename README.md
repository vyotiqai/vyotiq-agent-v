# Agent V

[![CI](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml/badge.svg)](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml)
[![Release](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/release.yml/badge.svg)](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/release.yml)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)
[![Website](https://img.shields.io/website?url=https%3A%2F%2Fvyotiq.com)](https://vyotiq.com)

Agent V is a free, open-source coding workspace for real repositories by [Vyotiq](https://vyotiq.com). It pairs a natural-language agent harness with workspace tools, multi-provider chat, live context management, and file-backed long-term memory.

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

Download the installer for Windows, macOS, or Linux from [https://vyotiq.com](https://vyotiq.com) or directly from [GitHub Releases](https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/latest).

The app checks for updates automatically; when a new version is available it shows a card with the release notes, downloads on your click, and installs on restart.

## Build from source

Prerequisites: Node.js `>=22.18.0` and pnpm `11.25.0` (`corepack enable && corepack prepare pnpm@11.25.0 --activate`).

```bash
git clone https://github.com/vyotiqai/vyotiq-agent-v.git
cd vyotiq-agent-v
pnpm install
pnpm dev        # development with hot reload
```

Production build and packaging for all platforms:

```bash
pnpm build
pnpm pack:win   # Windows NSIS installer
pnpm pack:mac   # macOS DMG
pnpm pack:linux # Linux AppImage
```

The full contribution workflow (typecheck, lint, tests, landing site) is described in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Contributions are welcome — bug reports, feature ideas, docs, and code. Start with [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). Security vulnerabilities are reported privately per [SECURITY.md](SECURITY.md).

## Support

For support, visit [https://vyotiq.com](https://vyotiq.com) or write to [support@vyotiq.com](mailto:support@vyotiq.com). Product documentation is available at https://vyotiq.com/docs.

## Security

Agent V runs with `contextIsolation: true`, `sandbox: true`, and `nodeIntegration: false`; paths are sandboxed to the workspace root, secrets use OS `safeStorage`, and the window carries CSP plus navigation locks. Structured logs record telemetry only - never workspace paths, file names, or chat payloads. See [SECURITY.md](SECURITY.md) for reporting policy.

## License

Copyright (c) 2026 Vyotiq.

Agent V is free and open-source software licensed under the [GNU GPL v3.0](LICENSE) or, at your option, any later version — SPDX `GPL-3.0-or-later`.
