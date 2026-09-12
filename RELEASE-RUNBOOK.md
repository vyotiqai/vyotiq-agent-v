# Vyotiq Release Runbook

Release process for **Agent V** (Electron + electron-builder + electron-updater), published to
GitHub Releases at `vyotiqai/vyotiq-agent-v-releases`, with an Astro landing site deployed to
Cloudflare Pages (project `vyotiq`).

Every command, workflow name, secret name, and path below was verified against the actual
`.github/workflows/release.yml`, `.github/workflows/deploy-landing.yml`, `.github/workflows/ci.yml`,
`package.json`, `pnpm-workspace.yaml`, and `electron-builder.yml`. If one of those files changes,
update this runbook first.

> **Why this file lives at repo root:** `/docs/**` is gitignored in this repo (see `.gitignore` —
> only `docs/**/*.docx` is un-ignored), so a runbook under `docs/` would never be committed.

---

## 1. The one rule: version and tag move together

The app version lives **only** in the root `package.json` (`"version"` field). There is no version
constant anywhere else. From that single field, electron-builder derives:

- Windows installer name — `nsis.artifactName: ${productName}-${version}-setup.${ext}` →
  `Vyotiq-<version>-setup.exe`
- macOS DMGs — `dmg.artifactName: ${productName}-${version}-${arch}.${ext}` →
  `Vyotiq-<version>-arm64.dmg` / `Vyotiq-<version>-x64.dmg`
- Linux AppImage — `appImage.artifactName: ${productName}-${version}.${ext}` → `Vyotiq-<version>.AppImage`
- The `latest.yml` / `latest-linux.yml` / `latest-mac.yml` updater metadata, which embed both the
  version and the release URL

The release tag (`vX.Y.Z`) **must** match the `package.json` version. electron-updater compares the
version in the published `latest*.yml` against the installed app's version — if the tag and the
version drift, the release page, the updater metadata, and the landing-site download buttons all
point at inconsistent things.

---

## 2. Standard release flow

The **only** release trigger is pushing a tag matching `v*` (`.github/workflows/release.yml`:
`on.push.tags: ['v*']`; a `workflow_dispatch` on a branch intentionally packages with
`--publish never` and cannot publish to a release).

1. **Write the release notes first.** Add a `## [X.Y.Z] - YYYY-MM-DD` entry to the root
   `CHANGELOG.md` with `### Added` / `### Changed` / `### Fixed` subsections and `- ` bullets.
   The release body — which the in-app update card parses into its "What's new" sections
   (`parseReleaseNotes`, `src/shared/utils/releaseNotes.ts`) and the landing `/changelog` page
   renders — is generated from this entry. The `create-release` job runs
   `scripts/extract-release-notes.mjs` and **fails the release** if the version has no entry or
   the entry has no bullets. Preview locally with:
   ```
   node scripts/extract-release-notes.mjs --version X.Y.Z
   ```
2. **Bump the version** in root `package.json`.
   - On a clean tree: `pnpm version minor` (or `patch` / `major`). This commits and creates the tag
     for you — skip steps 3–4.
   - With in-flight work (this repo almost always has some — other sessions keep uncommitted work):
     `pnpm version` rejects a dirty tree. Bump the `"version"` field **manually** and commit. This
     is exactly what was done for v1.1.0 and v1.1.1. Never bulk-revert the working tree to get a
     clean state — see Troubleshooting (e).
3. **Commit** (only when you bumped manually):
   ```
   git add package.json CHANGELOG.md
   git commit -m "chore: bump version to X.Y.Z"
   ```
4. **Create an annotated tag:**
   ```
   git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z"
   ```
5. **Push the commit and tag together:**
   ```
   git push --follow-tags
   ```

### What the Release workflow does automatically

Pushing the tag starts the `Release` workflow, which now runs, in order:

1. **`verify`** — tag↔version guard, `pnpm typecheck`, `pnpm test` (ubuntu). A red tree cannot be
   tagged into a release. (The full three-OS matrix — lint, e2e, packaging smoke, audit — stays in
   CI on `main`.)
2. **`create-release`** — extracts the notes from `CHANGELOG.md` and creates the release in the
   public releases repo **with those notes as the body** (no more empty bodies, no manual
   `gh release edit`).
3. **`package`** (matrix) — builds and publishes:
   - `windows-x64` (`windows-latest`, `electron-builder --win`) → NSIS setup.exe
   - `linux-x64` (`ubuntu-latest`, `electron-builder --linux`) → AppImage
   - `macOS` (`macos-latest`, `electron-builder --mac --arm64 --x64` — both arches in one job so a
     single `latest-mac.yml` lists both zips) → arm64 + x64 DMGs and zips

   Each job runs `pnpm build:vite` then
   `pnpm exec electron-builder <target> --publish always` with `GH_TOKEN: secrets.RELEASES_TOKEN`,
   publishing installers **plus** the updater metadata (`latest.yml`, `latest-linux.yml`,
   `latest-mac.yml`). The `macOS` job runs unsigned unless `CSC_LINK` is set
   (`--config.mac.identity=null` fallback), so mac packaging does not require a cert.
4. **`finalize-release`** — runs after the matrix and enforces, with the workflow failing on breach:
   - the release body is populated (backfills from `CHANGELOG.md` if a re-run found the old stub);
   - **all three `latest*.yml` files and every platform installer are present** on the release
     (the v1.1.0 silent-mac-update guard — §4 explains why this matters);
   - the landing site is redeployed via `gh workflow run deploy-landing.yml --ref main`, so
     download buttons and `/changelog` refresh on their own.

6. **Verify the release:**
   ```
   gh release view vX.Y.Z
   gh run list --workflow=release.yml
   gh run watch <run-id> --exit-status
   ```
   A green `finalize-release` job means the body and all updater manifests are confirmed; §4 is
   then a spot-check, not a requirement.

---

## 3. Pre-release checklist

Run locally before tagging:

```
pnpm typecheck && pnpm lint
pnpm test                 # full suite via scripts/test-exit-wrapper.cjs
pnpm audit --audit-level high
pnpm build                # = pnpm typecheck && pnpm build:vite
```

Known pre-existing failures as of v1.1.1: **3 appShell tests** expect a sidebar *New Chat* button
that is hidden because `DEFAULT_NAVIGATION_MODE = 'home'`
(`src/shared/ipc/schemas/settings.ts:146`). These are tracked and pre-existing — do not block a
release on them, but confirm the failure set has not *grown*.

**Launch the packaged app once before tagging** (the v1.2.0 incident): CI's build + smoke + e2e
do not catch a runtime file missing from the asar. After `pnpm pack:dir:win`, start
`dist-package/win-unpacked/Vyotiq.exe` and confirm the window opens (not an "Error" dialog) and
`%APPDATA%\Vyotiq\logs\vyotiq.log` is created.

CI (`.github/workflows/ci.yml`, name `CI`) gates on all three OSes (ubuntu/windows/macos):
`pnpm typecheck`, `pnpm test:coverage`, `pnpm lint`, `pnpm build:vite`, `pnpm landing:build`,
`pnpm landing:check` + `pnpm landing:audit` (Linux), `pnpm audit --audit-level high`, an unpacked
smoke package (`electron-builder --<os> dir --publish never`), and GUI e2e. Green CI on main is a
prerequisite for tagging.

---

## 4. Post-release verification

After the `Release` workflow finishes, check the release page:

```
gh release view vX.Y.Z
gh api repos/vyotiqai/vyotiq-agent-v-releases/releases/tags/vX.Y.Z --jq '.assets[] | [.name, .size] | @tsv'
```

**Expected assets** (per `electron-builder.yml` artifact names):

| OS | Assets |
| --- | --- |
| Windows | `Vyotiq-<v>-setup.exe` + `Vyotiq-<v>-setup.exe.blockmap` |
| Linux | `Vyotiq-<v>.AppImage` + `.blockmap` |
| macOS | `Vyotiq-<v>-arm64.dmg`, `Vyotiq-<v>-x64.dmg` (+ `.blockmap`), `Vyotiq-<v>-arm64-mac.zip`, `Vyotiq-<v>-mac.zip` (x64) |
| Updater metadata | `latest.yml`, `latest-linux.yml`, `latest-mac.yml` |

**All three `latest*.yml` files MUST be present.** electron-updater reads only its own OS's file —
a missing one means auto-update **silently fails on that OS**. This bit us on v1.1.0: the macOS job
failed, so v1.1.0 shipped without `latest-mac.yml` and mac users got no update until v1.1.1.
The `finalize-release` job now fails the workflow unless all three are present (plus the
exe/DMG/zip/AppImage installers), so a successful run implies they exist; the commands below are
the manual equivalent.

**Sanity sizes** — measured on real v1.1.1 assets, all ≤ 500 MB (builds since the
v1.2.x indexing migration are smaller still — the embedding stack was removed
and only the dictation ONNX natives remain unpacked):

| Asset | v1.1.1 size |
| --- | --- |
| `Vyotiq-1.1.1-setup.exe` | 172.6 MB |
| `Vyotiq-1.1.1.AppImage` | 303.1 MB |
| `Vyotiq-1.1.1-arm64.dmg` | 168.0 MB |
| `Vyotiq-1.1.1-x64.dmg` | 168.9 MB |

For a local unpacked size audit after packaging, run
`node scripts/bundle-size-report.mjs [--unpacked dist-package/win-unpacked] [--asar resources/app.asar] [--json]`
(it prints app.asar / unpacked / node_modules / per-OS native breakdowns).

---

## 5. Landing site redeploy

`.github/workflows/deploy-landing.yml` (name **Deploy landing**) runs **on every push to `main`
that touches its path filters** (`landing/**`, `resources/branding/**`, `resources/icon.*`,
`src/shared/domain/providers.ts`, `src/shared/ipc/schemas/providers.ts`, `package.json`,
`pnpm-lock.yaml`, the workflow itself), plus manual `workflow_dispatch`.

**After a tagged release it runs automatically**: the Release workflow's `finalize-release` job
dispatches it with `gh workflow run deploy-landing.yml --ref main`, so the baked release snapshot
and the `/changelog` page refresh on their own. Trigger it by hand only as a fallback:

1. Trigger it: `gh workflow run deploy-landing.yml`.
2. The job (`deploy` / **Cloudflare Pages**, `ubuntu-latest`) runs:
   - `pnpm install --frozen-lockfile`
   - `pnpm landing:build` — this runs `pnpm sync:brand`, `pnpm sync:landing-brand`, and
     `pnpm bake:landing-release` (`landing/scripts/bake-github-release.mjs`), which fetches the
     **latest published GitHub Releases** at build time and bakes their download URLs into
     `landing/src/lib/github-release.json` and the recent release notes into
     `landing/src/lib/github-releases.json` (a failed fetch keeps the previous snapshots rather
     than hiding the buttons)
   - `pnpm landing:check` (Astro check gate)
   - `pnpm dlx wrangler@4 pages deploy landing/dist --project-name=vyotiq --branch=main`
3. **Required repo secrets** (Settings → Secrets and variables → Actions):
   `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

**Known state (2026-09-10):** both Cloudflare secrets are **set** in the repo and deploys succeed
(they were empty before 2026-09-10, which is what failed run 34254965003 at wrangler auth). If a
deploy ever fails at wrangler auth again, re-check both secrets, then re-run the workflow.

---

## 6. Troubleshooting

| # | Symptom | Cause | Fix |
| --- | --- | --- | --- |
| a | A re-published release delivers nothing to users; colliding asset names | A published tag was moved, re-pointed, or deleted. electron-updater compares **versions**, not commits — a same-version re-tag produces no user update and collides with existing assets. | **Never move, re-point, or delete a published tag.** If a release fails midway (as v1.1.0's macOS job did), fix on `main` and ship the next version (v1.1.1), leaving the partial release in place. |
| b | Windows update fails with `ERR_UPDATER_INVALID_SIGNATURE` | `publisherName` is set in `electron-builder.yml` while release builds are unsigned — electron-updater compares the downloaded installer's Authenticode subject against it and always fails. | Keep `publisherName` **unset** until code signing is configured. Re-add it only together with `win.forceCodeSigning: true` once `CSC_LINK` is always present in the release environment. |
| c | macOS packaging crashes: `DOMParser.parseFromString: the provided mimeType undefined is not valid` | The `@xmldom/xmldom` override in `pnpm-workspace.yaml` was loosened from the exact pin; the `>=` range resolves 0.9.x, whose DOMParser API breaks `plist@3.1.0` (declares `^0.8.8`) used by `app-builder-lib` 26.15.3. | Keep `'@xmldom/xmldom': '0.8.15'` pinned **exactly** in `pnpm-workspace.yaml` `overrides` (fixed in commit ea70e01). |
| d | `pnpm version <x>` rejects with "Git working directory not clean" | Other sessions keep in-flight work uncommitted in this shared checkout. | Bump the `"version"` field in `package.json` manually and commit just that file (steps 1–2 in §2). |
| e | Working tree churn from `git restore .` / bulk revert | Concurrent sessions have in-flight work — a bulk revert destroys it. | Never bulk-revert. Stage explicit paths only: `git add package.json` etc. |
| f | Landing deploy fails at wrangler auth | `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` repo secrets are empty. | Add both secrets (Settings → Secrets and variables → Actions), then `gh workflow run deploy-landing.yml`. |
| g | Mac users on old versions never receive an update | `latest-mac.yml` missing from the release (macOS job failed — happened on v1.1.0). | Check all three `latest*.yml` assets after every release (§4). If missing, do not re-tag — fix the mac job on `main` and ship the next version. |
| h | Packaged app shows "A JavaScript error occurred in the main process" on launch | An over-aggressive `files:`/node_modules trim in `electron-builder.yml` dropped runtime-required files (v1.2.0: the gpt-tokenizer encoding trim removed `encodingParams/o200k_harmony.js`, which `modelParams.js` statically requires — 982 files missing). | Keep trims to provably dead trees (sources/tests/build tools). Verify with a static require scan AND by launching the packaged app (§3). The dialog names the missing module — read it via `Get-Process Vyotiq | Select MainWindowTitle` + screenshot, then fix the trim and ship a new version. |

---

## 7. Quick reference

```
# 1. Add the CHANGELOG.md entry for X.Y.Z (## [X.Y.Z] - date, ### subsections, - bullets)
#    Preview it: node scripts/extract-release-notes.mjs --version X.Y.Z

# 2. Bump version (dirty tree: edit package.json manually, then)
git add package.json CHANGELOG.md && git commit -m "chore: bump version to X.Y.Z"

# 3. Tag and push (this is the only release trigger)
git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z"
git push --follow-tags

# 4. Watch the release build (verify → create-release → package ×3 → finalize-release)
gh run list --workflow=release.yml
gh run watch <run-id> --exit-status

# 5. Spot-check the release (finalize-release already verified notes + manifests)
gh release view vX.Y.Z
gh api repos/vyotiqai/vyotiq-agent-v-releases/releases/tags/vX.Y.Z --jq '.assets[] | [.name, .size] | @tsv'
#   → confirm latest.yml, latest-linux.yml, latest-mac.yml are all present

# 6. Landing redeploy runs automatically from finalize-release; manual fallback:
gh workflow run deploy-landing.yml

# 7. Local size audit (after pnpm pack / electron-builder dir)
node scripts/bundle-size-report.mjs --unpacked dist-package/win-unpacked
```
