# Vyotiq

Vyotiq ("Agent V") is an Electron desktop app: a coding workspace for real repositories. It pairs a chat interface with multiple model providers with an agent that can act directly on your checked-out code — terminal, files, and repository tools — instead of only working from pasted snippets. Local voice dictation is built in via a Whisper model shipped with the app.

## Quick start

Prerequisites:

- Node.js `>=22.18.0` (see `engines` in `package.json`)
- pnpm 11.25.0, pinned by the `packageManager` field — enable it once with `corepack enable`

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
pnpm start   # preview the production build
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

## Landing site

The Astro marketing site in `landing/` is a separate pnpm workspace package:

```bash
pnpm landing:dev
pnpm landing:build
```

## Project layout

- `src/main` — Electron main process
- `src/preload` — preload bridge
- `src/renderer` — React UI
- `src/shared` — code shared between main and renderer
- `landing/` — Astro marketing site (separate workspace package)
- `tests/` — vitest unit/e2e suites plus Playwright GUI e2e
- `scripts/` — sync and build helper scripts wired into the package scripts

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the dev workflow and the standard gates (`pnpm typecheck && pnpm test && pnpm lint`). See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the code of conduct.

## Security

See [SECURITY.md](SECURITY.md) for how to report vulnerabilities.

## License

GPL-3.0-or-later — see [LICENSE](LICENSE). Third-party notices are in [NOTICE](NOTICE).

Maintainers: the release procedure is documented in [RELEASE-RUNBOOK.md](RELEASE-RUNBOOK.md).
