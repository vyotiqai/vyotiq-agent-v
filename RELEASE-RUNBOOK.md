# RELEASE-RUNBOOK — Vyotiq (Agent V)

Operating manual for cutting a release. Every job/step name below is quoted
verbatim from `.github/workflows/release.yml`, with the line numbers that define
them (tree at `a848f70`). Versioning rules live in
`.github/AGENT-CHECKLIST.md` §0. The release flow is **tag-only**: no
changelog entry is part of the procedure — the release body set by
`release.yml` is the release notes.

## 1. Purpose

A tag push is the only thing that produces a release. Nothing else — no
changelog file, no manual asset upload — is part of the flow. This runbook
describes what a release engineer does by hand, what the Release workflow
does automatically, and how to confirm a release actually works.

## 2. Prerequisites

- Node 22 and pnpm 12.4.2 (the workflows activate it via
  `corepack prepare pnpm@12.4.2 --activate`, release.yml:30-33).
- `gh` CLI authenticated against `vyotiqai/vyotiq-agent-v` (for
  `gh run watch` and release inspection).
- Repo secret `RELEASES_TOKEN` on the source repo — the draft, asset
  uploads, publish, and pointer all target the public releases repo
  `vyotiqai/vyotiq-agent-v-releases` with it (release.yml:92, 197, 263, 280,
  310). `GITHUB_TOKEN` only covers this private repo.
- Repo secret `SENTRY_DSN` — inlined at build time; without it the packaged
  app ships without crash reporting (release.yml:179-181).
- Signing secrets are optional: unset `CSC_LINK` keeps the unsigned pack so
  the macOS DMG still builds (release.yml:13-15, 212); `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` enable notarization when
  all three are set (release.yml:198-200, 213).

## 3. Release procedure (tag-only)

1. Bump `"version"` in `package.json`. On a dirty tree edit it manually —
   `pnpm version` refuses a dirty tree.
2. Commit: `git add package.json && git commit -m "chore: bump version to
   X.Y.Z"`. No changelog file is involved.
3. Pre-tag gate: `pnpm typecheck` + `pnpm lint` + `pnpm test` (see
   AGENT-CHECKLIST §1), plus the packaged-app launch test if packaging or
   runtime dependencies changed (AGENT-CHECKLIST §2).
4. Annotated tag, then push branch and tag together:
   `git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z"` then
   `git push --follow-tags origin main`. Verify the push actually landed
   (`git status -sb` not ahead) — a swallowed push error leaves the tag
   unpublished. **Never re-tag or re-point a published tag** (see §8).

## 4. What release.yml runs on the tag push

Trigger: push of tags matching `'v*'`, plus manual `workflow_dispatch`
(release.yml:3-7). On a manual dispatch nothing is published
(`--publish never`, release.yml:206-211) and no updater manifests are
emitted (release.yml:222-235); publishing happens only on real tag pushes.

- **`verify` — "Verify (typecheck + tests)"** (release.yml:18-57):
  "Verify tag matches package.json version" (:40-46) fails the run unless
  the tag minus `v` equals the package.json version; then `pnpm install
  --frozen-lockfile` (:49), `pnpm typecheck` (:52), and `pnpm test` (:57) —
  a red tree cannot be tagged.
- **`create-release` — "Create release"** (release.yml:59-112): creates the
  **draft** release in `vyotiqai/vyotiq-agent-v-releases` with title
  `Vyotiq v$VERSION` (:107-111), skipping creation when a release for the
  tag already exists (:97-98). Draft-first so the in-app updater can never
  see a half-uploaded release, and so every matrix job uploads into this
  draft instead of racing to create the release (:100-106).
- **`package` — one job per matrix name** (release.yml:116-235):
  `windows-x64` (`--win`; `*.exe`), `linux-x64` (`--linux`; AppImage/deb/
  rpm), and `macOS` (`--mac --arm64 --x64`; dmg/zip — both arches in one
  electron-builder invocation so a single `latest-mac.yml` lists both zips,
  :139-143). Steps: tag/version gate again (:166-172), "Build bundles"
  (`pnpm build:vite` with `SENTRY_DSN`, :177-182), "Package installers"
  runs `electron-builder --publish always` on real tag pushes (:192-213),
  then "Upload artifacts" (:215-220) and "Upload updater metadata
  artifacts" — the `latest*.yml` manifests and blockmaps, emitted only on
  tag pushes (:222-235).
- **`finalize-release` — "Finalize release"** (release.yml:239-338, tag
  pushes only): "Ensure release notes are populated" (:261-276) backfills
  the body when it is empty or the pre-automation stub
  `Vyotiq v$VERSION installers and update metadata.` (:269); "Verify
  installers and updater manifests" (:278-301) requires all three manifests
  `latest.yml`, `latest-linux.yml`, `latest-mac.yml` (:289-294) plus the
  installers — Windows NSIS `*-setup.exe`, `.AppImage`, `.deb`, `.rpm`,
  at least 2 `.dmg` and 2 `mac.zip` (:295-300); "Publish the draft release"
  (:303-312) flips `--draft=false` — the moment the updater and the website
  can see the release, safe on re-runs; "Mirror a release pointer on the
  source repo" (:314-338) keeps a pointer release `v$VERSION` on
  `vyotiqai/vyotiq-agent-v`, marked Latest, linking to the real installers.

Publishing is automatic: there is no separate manual publish step. If any
finalize check fails, the release stays a draft — fix and re-run the failed
jobs rather than re-tagging.

## 6. How to verify a release

1. `gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases` shows a
   published (non-draft) release with a body.
2. Assets include all three manifests — `latest.yml`, `latest-linux.yml`,
   `latest-mac.yml` — plus blockmaps (mandatory; a missing one silently
   kills that OS's auto-update, the v1.1.0 incident; enforced by
   finalize-release, release.yml:289-294).
3. Installers present: `Vyotiq-X.Y.Z-setup.exe`, `.AppImage`, `.deb`,
   `.rpm`, both `-arm64`/`-x64` `.dmg`, both `mac.zip` (release.yml:295-300).
4. Updater version bump: the manifest's version field equals `X.Y.Z` and a
   running older app offers the new version.
5. Pointer release `vX.Y.Z` on the source repo, marked Latest
   (release.yml:314-338).
6. Install-launch the released artifact: SHA512 of the downloaded file
   matches `latest.yml` (`certutil -hashfile <file> SHA512` against the
   manifest's base64 value), silent install, launch, window title `Vyotiq`,
   `%APPDATA%\Vyotiq\logs\vyotiq.log` gets fresh entries.

## 7. Known-allowed test failures

None are documented. The Release pipeline gates on a green `pnpm test`
(release.yml:54-57), so treat every failure as blocking. Historical
test-pool flakiness was fixed by capping concurrent sessions — do not
re-introduce it.

## 8. Troubleshooting

- **Auto-update silently dead on one OS**: that OS's `latest*.yml` is
  missing from the release (the v1.1.0 incident, release.yml:240-241, 291).
  Never fix by re-tagging; ship the next version.
- **Re-tagging a published tag**: electron-updater compares versions, not
  commits. A same-version tag produces no user update, and the re-push
  collides with identically-named assets already on the release
  (AGENT-CHECKLIST §0). Never re-tag; ship the next version.
- **Tag does not match package.json version**: the `verify` and `package`
  gates fail before anything is uploaded (release.yml:40-46, 166-172).
  Bump `package.json` to the tag, or move the unpublished tag — never
  re-tag after assets exist.

## Note (transitional)

The changelog-coupled release steps have been removed from `release.yml`:
create-release writes the stub body directly, and finalize-release only
backfills that stub when the release body came up empty. No `CHANGELOG.md`
file is needed at any point of the flow.
