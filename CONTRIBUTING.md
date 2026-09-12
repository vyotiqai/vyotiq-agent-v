# Contributing to Agent V

Thank you for considering a contribution to Agent V, the coding workspace for
real repositories by [Vyotiq](https://vyotiq.com). Agent V is GPL-3.0 open
source, and contributions of code, docs, and bug reports are welcome.

## Report bugs and request features

- Open a [bug report](https://github.com/vyotiqai/vyotiq-agent-v/issues/new?template=bug_report.yml)
  or a [feature request](https://github.com/vyotiqai/vyotiq-agent-v/issues/new?template=feature_request.yml).
- For security vulnerabilities, **do not open a public issue** — see
  [SECURITY.md](SECURITY.md) for private reporting.

## Development setup

Prerequisites:

- Node.js `>=22.18.0`
- pnpm `11.25.0` (corepack: `corepack enable && corepack prepare pnpm@11.25.0 --activate`)
- A supported OS: Windows 10/11, macOS 12+, or a modern Linux distribution

Then from the repo root:

```bash
pnpm install          # installs deps, rebuilds native modules, syncs generated assets
pnpm dev              # electron-vite dev server with hot reload
```

The `postinstall` hook runs asset syncs (file icons, harness
docs, brand marks); they are re-run automatically by the build scripts, so you
only touch canonical sources under `resources/` and `scripts/`.

## Verify your change

CI runs all of this; run it locally before pushing:

```bash
pnpm typecheck        # tsc over node + web tsconfigs
pnpm lint             # eslint
pnpm test             # unit suite (vitest)
pnpm build:vite       # full electron-vite production build
pnpm landing:build    # landing site build (fetches the latest GitHub release)
pnpm landing:check    # astro check for the landing site
```

GUI end-to-end tests (Playwright) run via `pnpm test:gui-e2e` and need the
packaged app; CI covers them, so a local run is optional.

## Pull requests

1. Fork the repo and create a topic branch from `main`.
2. Keep the change focused; unrelated refactors belong in their own PR.
3. Follow the existing code style — the repo is TypeScript, React 19,
   Tailwind v4, with zod-validated IPC contracts between main and renderer.
4. Add or update tests for behavior changes.
5. Write commit messages in the Conventional Commits style
   (`feat:`, `fix:`, `docs:`, `test:`, `chore:`, optionally scoped:
   `fix(updater): ...`).
6. Make sure `pnpm typecheck`, `pnpm lint`, and `pnpm test` pass and the CI
   workflow is green on your PR.

AI agents (and anyone driving one) must also follow
[.github/AGENT-CHECKLIST.md](.github/AGENT-CHECKLIST.md) — it encodes the
packaging, release, and verification gates this repo enforces, including the
launch-the-packaged-app rule that prevents broken installers.

## Licensing

By contributing, you agree that your contributions are licensed under the
[GNU GPL v3.0](LICENSE) (or, at the maintainers' option, any later version
published by the Free Software Foundation), matching the `GPL-3.0-or-later`
SPDX identifier of this project.
