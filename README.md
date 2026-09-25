# Vyotiq

[![CI](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml/badge.svg)](https://github.com/vyotiqai/vyotiq-agent-v/actions/workflows/ci.yml)
[![License: GPL-3.0-or-later](https://img.shields.io/badge/license-GPL--3.0--or--later-blue.svg)](LICENSE)

Vyotiq ("Agent V") is an Electron desktop app for handing real work on a real repository to a coding agent. You give it a task; it works in your checkout with terminal, file, git and browser tools, and the app keeps a record of the work — every step, every change, the checks it was held to and whether they held — beside the files, terminal, browser and pull request it worked in. It works with many model providers, and voice dictation transcribes on-device with Whisper.

This is version 1.0.0, the rebuilt app. Release notes: [release-notes/v1.0.0.md](release-notes/v1.0.0.md).

## Features

- **Tasks, sorted by what they need** — the navigator groups every task in your open workspaces as Needs you, Running, Ready for review and Done. A task is a record of the work, not a chat: the instruction, then each step the agent took, with terminal and diff output kept whole.
- **Done-when checks** — a task can carry the conditions that mean it is finished; the agent marks each met or not met with evidence before it stops, and the record shows every verdict.
- **The inspector** — Changes, Files, Terminal, Browser, Pull request and Plan beside the task. Changes is a review: keep or undo each file, mark files viewed, ask about a line, and commit with a message drafted once per change set.
- **Rewind and Redo** — go back to an earlier instruction; the dialog says which files go back and which stop at a change you made, and a rewind can be brought back until you send a new instruction.
- **Worktrees** — start a task on its own branch in its own folder, then merge it back or discard it.
- **Multiple model providers** — OpenAI, Anthropic, Google Gemini, Ollama (local models), DeepSeek, Groq, OpenRouter, xAI, Mistral, or any custom OpenAI-compatible endpoint, plus an OpenCode provider. Model lists are fetched per provider where the API supports it.
- **An agent that acts on your checkout** — two modes, Ask (reads and answers) and Agent (plans, edits and runs commands). The built-in tool catalog includes a terminal, file tools (read, edit, search, glob, grep, codebase search), git tools (status, diff, commit, apply patch), GitHub tools (pull requests, issues), typecheck/lint/test runners, browser automation, notebook editing, and language-server queries.
- **Helper instances** — a task can fan work out to helper instances, each on its own git worktree branch, merged back into the task's branch. Settings caps how many run at once.
- **Local Whisper dictation** — voice dictation is transcribed entirely on your machine (Whisper via transformers.js with the onnxruntime-node backend) in the Electron main process / a utility process. No audio leaves the app. The model weights are fetched from Hugging Face into the app's user data directory the first time you use dictation, so the feature needs one download before it works offline.
- **Skills and marketplace** — skills ship with the app as marketplace resources and can be loaded into a run; plugin rules are supported alongside skill files.
- **MCP client** — connect Model Context Protocol servers, list their tools/resources/prompts, and pin their tools into the agent's catalog. Connection attempts widen Node's 250ms per-address window, so a reachable host that publishes several A/AAAA records is not reported as unreachable.
- **Long-term workspace memory** — the agent keeps notes under `.vyotiq/memory/` in the workspace and re-reads them on later runs.
- **Verification gate** — the run loop tracks whether a check actually ran, and reported clean, after the last file the agent changed, so a turn that edited code without verifying it is caught while it can still act rather than at teardown.
- **Run feedback** — each workspace remembers how its runs went under `runFeedback.json`, and messages can be rated in place. Receipts are per-run and pruned with their session, so this is what makes recurring trouble visible across runs.

## Documentation

- [Outbound network egress — what the gate covers, and what it deliberately does not](docs/egress.md)
- [Agent-built tools — what `build_tool` permits, and the four things that bound it](docs/agent-tools.md)

## Platforms

Vyotiq builds for **Windows** (NSIS installer), **macOS** (dmg and zip), and **Linux** (AppImage, deb, rpm). Target definitions are in `electron-builder.yml`.

## Downloads

Installers are published to the companion repository [vyotiqai/vyotiq-agent-v-releases](https://github.com/vyotiqai/vyotiq-agent-v-releases). Grab the latest release there, or use the download UI on [vyotiq.com/download](https://vyotiq.com/download). You can still build from source as described below.

## Quick start

Prerequisites:

- Node.js `>=22.18.0` (see `engines` in `package.json`)
- pnpm 12.4.2, pinned by the `packageManager` field — enable it once with `corepack enable`

```bash
git clone https://github.com/vyotiqai/vyotiq-agent-v.git
cd vyotiq-agent-v
pnpm install
```

`pnpm install` runs a postinstall step that fetches Electron, rebuilds native modules, and runs the asset sync scripts.

## Environment setup

Copy `.env.example` to `.env`. Both variables are optional and only enable Sentry crash reporting — leave them blank for local development:

- `SENTRY_DSN`
- `VITE_SENTRY_DSN`

## Development

```bash
pnpm dev     # launch the Electron app in dev mode
pnpm build   # typecheck, sync assets, and build the production bundle
pnpm start   # launch that build (it does not rebuild — run pnpm build first)
```

## Verification

```bash
pnpm typecheck     # tsc over the main- and renderer-side configs
pnpm lint          # eslint .
pnpm test          # vitest suite
pnpm test:coverage # vitest with coverage (this is what CI runs)
pnpm test:watch    # vitest in watch mode
```

Targeted suites: `pnpm test:e2e` (main-process e2e) and `pnpm test:gui-e2e` (Playwright GUI e2e; needs the Playwright Chromium browser installed).

CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) runs typecheck, tests with coverage, lint, a production build, a dependency audit (`pnpm audit --audit-level high`), an unpacked packaging smoke test, and GUI e2e on Ubuntu, Windows, and macOS.

## Build and packaging

```bash
pnpm build        # typecheck + electron-vite production build
pnpm pack         # installers for Windows, macOS, and Linux
pnpm pack:win     # Windows NSIS installer
pnpm pack:mac     # macOS dmg
pnpm pack:linux   # Linux AppImage
pnpm pack:dir:win # unpacked Windows build (packaging smoke test)
```

Artifacts are written to `dist-package/` (see `electron-builder.yml`: appId `com.vyotiq.agent`, product name "Vyotiq") — an NSIS setup exe on Windows, dmg/zip on macOS, and AppImage/deb/rpm on Linux.

## Project layout

- `src/main` — Electron main process
- `src/preload` — preload bridge
- `src/renderer` — React UI
- `src/shared` — code shared between main and renderer
- `tests/` — vitest unit/e2e suites plus Playwright GUI e2e
- `scripts/` — sync and build helper scripts wired into the package scripts
- `landing/` — the [vyotiq.com](https://vyotiq.com) website, a workspace package

## Website

The website is a static Astro site in `landing/`, built from this repository's own data rather than restated prose — the tool names come from the tool registry, the providers from the provider defaults, the extensions from the bundled marketplace catalog, and the legal pages render the repository's own Markdown verbatim.

```bash
pnpm site:dev     # dev server
pnpm site:build   # static build into landing/dist
pnpm site:capture # re-capture the application screenshots
pnpm site:verify  # post-build assertions over landing/dist
```

Which capabilities the site may name is gated by `landing/src/lib/showcase.ts`: adding a tool, provider, or marketplace package to the app fails `pnpm site:build` until it is approved there.

## Documentation

- [CONTRIBUTING.md](CONTRIBUTING.md) — development workflow and the standard gates
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — code of conduct
- [SECURITY.md](SECURITY.md) — how to report vulnerabilities
- [PRIVACY.md](PRIVACY.md) — what the app stores and what leaves your machine
- [TERMS.md](TERMS.md) — terms of use
- [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md) — maintainer release procedure
- [NOTICE](NOTICE) — third-party notices

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow and the standard gates (`pnpm typecheck && pnpm test && pnpm lint`). See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the code of conduct.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

Maintainers: the release procedure is documented in [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md).
