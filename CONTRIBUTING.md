# Contributing

## Setup

- Node >= 24.14, the line Electron 44 ships (see `engines` in `package.json`)
- pnpm is pinned by `packageManager` — enable corepack once: `corepack enable`
- `pnpm install` (postinstall fetches Electron, rebuilds native deps, and runs the sync scripts)

## Standard gates

Run all three before pushing:

```
pnpm typecheck && pnpm test && pnpm lint
```

Single test file (skips the suite wrapper):

```
pnpm exec vitest run tests/main/unit/loopPolicy.test.ts
```

Watch mode: `pnpm test:watch`. Coverage gate: `pnpm test:coverage`.

### Typechecking the tests

`pnpm typecheck` covers `src/main`, `src/preload` and `src/renderer` only — **test
files are not typechecked by the standard gate**, so a type error in a test
surfaces as a runtime failure, or not at all.

`pnpm typecheck:tests` checks them:

```
pnpm typecheck:tests
```

It is not part of `pnpm typecheck`: as of 2026-09-30 the suites carry **581
pre-existing type errors across 135 files**, none of them in production `src/`.
CI runs a ratchet instead, so the count can only go down:

```
node scripts/typecheck-tests-ratchet.mjs            # fails if any file gained errors
node scripts/typecheck-tests-ratchet.mjs --update   # after fixing some, lower the baseline
```

The per-file baseline is `scripts/typecheck-tests-baseline.json`. A syntax error
fails it outright, because TypeScript 7 then skips type checking for the whole
program. Treat the list as a burn-down: when you touch a test file, leave it
clean and run `--update`. Fold `typecheck:tests` into `pnpm typecheck` once the
count reaches zero.

## Dev and build

- Dev app: `pnpm dev`
- Production build (typecheck + electron-vite build): `pnpm build`
- Packaged installers: `pnpm pack:win` / `pnpm pack:mac` / `pnpm pack:linux`

## Releases

- Releases are tag-driven: push an annotated `vX.Y.Z` tag (matching `package.json`'s `version`) and the Release workflow (`.github/workflows/release.yml`) builds and publishes the installers.
- The workflow verifies that the tag matches `package.json`'s version and fails the release on mismatch.
- Releases and installer assets live in the public `vyotiqai/vyotiq-agent-v-releases` repository; the in-app updater points there.

## Notes

- `AGENTS.md` is local-only (agent harness docs) and intentionally not committed — do not link to it from committed files.
- Build/runtime env vars (`SENTRY_DSN`, `VITE_SENTRY_DSN`) are documented in `.env.example`.
- Coverage thresholds live in `vitest.config.ts`; do not lower them to make a suite pass.
- Dependency audit gate: `pnpm audit --audit-level high` (enforced in CI; treat findings as release blockers).
