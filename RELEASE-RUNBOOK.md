# RELEASE-RUNBOOK — Vyotiq (Agent V)

Operating manual for cutting a release. Every job/step name below is quoted
verbatim from `.github/workflows/release.yml`, with the line numbers that define
them (tree at `a848f70`). Versioning rules live in
`.github/AGENT-CHECKLIST.md` §0, in full in `.github/RELEASE-AGENT-PROMPT.md`
§4; the project follows semantic versioning from `1.0.0` onward. The release
flow is **tag-only**: there is no `CHANGELOG.md` and no changelog gate in the
pipeline. The release body *is* the changelog, and it is **authored** — the
stub body `release.yml` writes is a starting point to replace, never the
notes that ship. See `.github/RELEASE-AGENT-PROMPT.md` §5 for the format the
update panel can actually parse.

## 1. Purpose

A tag push is the only thing that produces a release. Nothing else — no
changelog file, no manual asset upload — is part of the flow. This runbook
describes what a release engineer does by hand, what the Release workflow
does automatically, and how to confirm a release actually works.

## 2. Prerequisites

- Node 24 and pnpm 12.4.2 (the workflows activate it via
  `corepack prepare pnpm@12.4.2 --activate`, release.yml:32-35).
- `gh` CLI authenticated against `vyotiqai/vyotiq-agent-v` (for
  `gh run watch` and release inspection).
- Repo secret `RELEASES_TOKEN` on the source repo — the draft, asset
  uploads, publish, and pointer all target the public releases repo
  `vyotiqai/vyotiq-agent-v-releases` with it (release.yml:105, 210, 277, 294,
  323). `GITHUB_TOKEN` only covers this private repo.
- Repo secret `SENTRY_DSN` — inlined at build time; without it the packaged
  app ships without crash reporting (release.yml:190-194).
- Signing secrets are optional: unset `CSC_LINK` keeps the unsigned pack so
  the macOS DMG still builds (release.yml:13-15, 225); `APPLE_ID` /
  `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` enable notarization when
  all three are set (release.yml:211-213, 226).

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
(`--publish never`, release.yml:219-224) and no updater manifests are
emitted (release.yml:235-248); publishing happens only on real tag pushes.

- **`verify` — "Verify (typecheck + tests)"** (release.yml:18-68):
  "Verify tag matches package.json version" (:42-48) fails the run unless
  the tag minus `v` equals the package.json version; "Wait for CI to pass on
  the tagged commit" (:53-57) holds a tag push until a `ci.yml` run on the
  same commit has succeeded — lint, build, audit, packaging smoke and GUI e2e
  on all three platforms — and fails if CI failed or was cancelled there, or
  if no CI run exists (tag a commit on main; `scripts/release-wait-for-ci.mjs`);
  then `pnpm install --frozen-lockfile` (:60), `pnpm typecheck` (:63), and
  `pnpm test` (:68) —
  a red tree cannot be tagged.
- **`create-release` — "Create release"** (release.yml:70-125): creates the
  **draft** release in `vyotiqai/vyotiq-agent-v-releases` with title
  `Vyotiq v$VERSION` (:120-124), skipping creation when a release for the
  tag already exists (:110-111). Draft-first so the in-app updater can never
  see a half-uploaded release, and so every matrix job uploads into this
  draft instead of racing to create the release (:113-119).
- **`package` — one job per matrix name** (release.yml:127-248):
  `windows-x64` (`--win`; `*.exe`), `linux-x64` (`--linux`; AppImage/deb/
  rpm), and `macOS` (`--mac --arm64 --x64`; dmg/zip — both arches in one
  electron-builder invocation so a single `latest-mac.yml` lists both zips,
  :150-156). Steps: tag/version gate again (:179-185), "Build bundles"
  (`pnpm build:vite` with `SENTRY_DSN`, :190-194), "Package installers"
  runs `electron-builder --publish always` on real tag pushes (:205-226),
  then "Upload artifacts" (:228-233) and "Upload updater metadata
  artifacts" — the `latest*.yml` manifests and blockmaps, emitted only on
  tag pushes (:235-248).
- **`finalize-release` — "Finalize release"** (release.yml:250-362, tag
  pushes only): "Ensure release notes are populated" (:275-290) backfills
  the body when it is empty or the pre-automation stub
  `Vyotiq v$VERSION installers and update metadata.` (:283); "Verify
  installers and updater manifests" (:292-315) requires all three manifests
  `latest.yml`, `latest-linux.yml`, `latest-mac.yml` (:303-308) plus the
  installers — Windows NSIS `*-setup.exe`, `.AppImage`, `.deb`, `.rpm`,
  at least 2 `.dmg` and 2 `mac.zip` (:309-314); "Publish the draft release"
  (:317-325) flips `--draft=false` — the moment the updater can see the
  release, safe on re-runs; "Mirror a release pointer on the
  source repo" (:327-351) keeps a pointer release `v$VERSION` on
  `vyotiqai/vyotiq-agent-v`, marked Latest, linking to the real installers;
  "Rebuild the website" (:353-362) dispatches `deploy-site.yml` and may fail
  without failing the release.

Publishing is automatic: there is no separate manual publish step. If any
finalize check fails, the release stays a draft — fix and re-run the failed
jobs rather than re-tagging.

## 6. How to verify a release

1. `gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases` shows a
   published (non-draft) release with a body.
2. Assets include all three manifests — `latest.yml`, `latest-linux.yml`,
   `latest-mac.yml` — plus blockmaps (mandatory; a missing one silently
   kills that OS's auto-update, with no error in the release or the updater
   log; enforced by finalize-release, release.yml:303-308).
3. Installers present: `Vyotiq-X.Y.Z-setup.exe`, `.AppImage`, `.deb`,
   `.rpm`, both `-arm64`/`-x64` `.dmg`, both `mac.zip` (release.yml:309-314).
4. Updater version bump: the manifest's version field equals `X.Y.Z` and a
   running older app offers the new version.
5. Pointer release `vX.Y.Z` on the source repo, marked Latest
   (release.yml:327-351).
6. Verify the released artifact **without running it**: SHA512 of the
   downloaded file matches `latest.yml` (`certutil -hashfile <file> SHA512`
   against the manifest's base64 value), and unpacking it with 7z shows the
   expected `X.Y.Z` payload. The launch smoke test is the unpacked build
   (`dist-package*/win-unpacked/Vyotiq.exe`), which touches no installed state.
   **Do not silent-install on a machine that has a real install** — it replaces
   someone's working app with no prompt and rewrites the shared per-user
   uninstall entry. An install test needs an explicit human yes, ideally on a
   clean VM.

## 7. Known-allowed test failures

None are documented. The Release pipeline gates on a green `ci.yml` run on
the tagged commit and on a green `pnpm test` (release.yml:53-57, 67-68), so treat every failure as blocking. Historical
test-pool flakiness was fixed by capping concurrent sessions — do not
re-introduce it.

## 8. Troubleshooting

- **Auto-update silently dead on one OS**: that OS's `latest*.yml` is
  missing from the release (release.yml:235-248, 303-308). The release looks
  healthy and the updater says nothing — only that OS stops updating.
  Never fix by re-tagging; ship the next version.
- **Re-tagging a published tag**: electron-updater compares versions, not
  commits. A same-version tag produces no user update, and the re-push
  collides with identically-named assets already on the release
  (AGENT-CHECKLIST §0). Never re-tag; ship the next version.
- **Tag does not match package.json version**: the `verify` and `package`
  gates fail before anything is uploaded (release.yml:42-48, 179-185).
  Bump `package.json` to the tag, or move the unpublished tag — never
  re-tag after assets exist.

## Note (transitional)

The changelog-coupled release steps have been removed from `release.yml`:
create-release writes the stub body directly, and finalize-release only
backfills that stub when the release body came up empty. No `CHANGELOG.md`
file is needed at any point of the flow.
