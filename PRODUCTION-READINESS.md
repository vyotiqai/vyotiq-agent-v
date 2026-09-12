# Production Readiness — Vyotiq (Agent V desktop app)

Run report for the 2026-09-08 release window (v1.1.0 / v1.1.1). Every file path, constant, and behavior cited below was verified by reading the current tree on the instance branch.

> Update 2026-09-12 (v1.2.x): the v1.1.x-era codebase-index embedding stack
> (`node-llama-cpp`, `tree-sitter-wasms`, sparsegrep, local ONNX embedders,
> model downloads, `extraResources/codeindex/wasm`) has been removed. The code
> index is now a plain, fully local SQLite full-text/trigram index on the main
> process (see `CHANGELOG.md` and `src/main/agent/codeindex/`). The v1.1.x
> measurements below are retained as a historical run report.

> This file lives at the repo root because `docs/*.md` is gitignored in this repo — only `docs/**/*.docx` are tracked. `electron-builder.yml` excludes `docs/**` from the package for the same reason.

---

## 1. Installer size audit

Baseline win-x64 `--dir` build measured **1397.1 MB unpacked → 709.5 MB** after the exclusion pass; **app.asar 263.1 MB → 110.9 MB**.

### What was excluded — only never-imported bytes

| Exclusion | Size | Why it is safe |
| --- | --- | --- |
| `onnxruntime-web` | ~107 MB packed | No src import. Every `@huggingface/transformers` call site runs in main/utilityProcess where transformers.js resolves the `onnxruntime-node` backend. |
| `@node-llama-cpp/*-cuda-ext` | 346.1 MB | CUDA-extended binaries; the runtime GPU backend ships via Vulkan + CPU. |
| `@node-llama-cpp/*-cuda` | 162.8 MB | Same — excluded in favor of Vulkan. |
| `node-llama-cpp/llama` | ~33 MB | llama.cpp sources + cmake toolchains used only to compile from source (`npmRebuild: false`; runtime addon comes from `@node-llama-cpp/<platform>/bins`). |
| unused `gpt-tokenizer` encodings + TS src | — | Only `o200k_base` + `cl100k_base` are imported (`agent/context/tokenizer.ts`, `tokenizer.worker.ts`). |
| `node-pty` cross-OS prebuilds / build sources | — | Runtime loads `prebuilds/<os>-x64` via `lib/utils.js`; prebuild.js short-circuits node-gyp. |
| `tree-sitter-wasms`, `@sentry/react` node_modules copy, dev-only `{test,docs,examples}`, `*.map`, `cmake-js` | — | Grammars ship via extraResources/codeindex/wasm; `@sentry/react` is bundled into the renderer by vite (only `@sentry/electron/main` is required from main; `@sentry/browser` stays as a hard dependency of `@sentry/electron`). |

**GPU inference is preserved** via the Vulkan backend (94.7 MB) plus CPU fallback. Per-OS `files` globs in `electron-builder.yml` also drop platform-wrong onnxruntime natives (~150 MB win-side), other-OS `@node-llama-cpp` prebuilds, and other-OS `node-pty` prebuilds.

### Measured v1.1.1 GitHub Release assets (bytes)

| Asset | Bytes | MB |
| --- | --- | --- |
| `Vyotiq-1.1.1-setup.exe` | 180,997,568 | 172.6 |
| `Vyotiq-1.1.1.AppImage` | 317,851,508 | 303.1 |
| `Vyotiq-1.1.1-arm64.dmg` | 176,152,467 | 168.0 |
| `Vyotiq-1.1.1-x64.dmg` | 177,050,301 | 168.9 |
| `Vyotiq-1.1.1-arm64-mac.zip` | 195,438,010 | 186.4 |
| `Vyotiq-1.1.1-mac.zip` (x64) | 197,204,040 | 188.1 |

All assets ≤ 500 MB. Update manifests `latest.yml`, `latest-linux.yml`, and `latest-mac.yml` are all present on the release.

### Optional CUDA swap (documented, not applied)

Keeping `cuda` while dropping `cuda-ext` + Vulkan estimates **win ~261 MB / linux ~445–475 MB** — still under the 500 MB cap. Keeping `cuda-ext` as well pushes linux to **~535 MB, over the cap**. Decision intentionally left open; see the CUDA-kept alternative table referenced in `electron-builder.yml` comments.

### Re-running the audit

```sh
node scripts/bundle-size-report.mjs --unpacked dist-package/win-unpacked --asar dist-package/win-unpacked/resources/app.asar [--json]
```

Measures `resources/app.asar`, `resources/app.asar.unpacked`, and the whole `win-unpacked` tree; bytes inside the asar are attributed per top-level `node_modules` package by parsing the asar header (no extra dependency), unpacked bytes by walking the tree. `--json` emits machine-readable totals, per-package, platform-native, and top-level breakdowns.

---

## 2. Update system

Event-driven service in `src/main/updater/index.ts`:

- `autoUpdater.autoDownload = false`, `autoInstallOnAppQuit = false`, `disableWebInstaller = true`. **No polling** — transitions only from autoUpdater events or explicit renderer calls.
- One-shot startup check deferred **10 s** (`STARTUP_CHECK_DELAY_MS = 10_000`), skipped entirely in dev (`!app.isPackaged`), and gated by the Settings switch `autoCheckUpdates` — read via `getSettings()` in `src/main/index.ts` and passed as `scheduleStartupUpdateCheck({ autoCheckEnabled })` (absent setting = enabled).

State machine broadcasts `UpdaterStatePayload` on channel **`updater:state`** (`src/shared/ipc/channels.ts:114`):

- `status: idle | checking | available | not-available | downloading | downloaded | error`
- `info?` — `UpdateInfo { version, releaseDate, releaseName, notesText, notesSections }`; release notes parsed by `src/shared/utils/releaseNotes.ts`
- `progress?` — `{ percent, transferred, total }`
- `error?` — string message

Preload namespaces (`src/preload/index.ts:379-397`): `window.vyotiq.updater.{check, download, install, onState}` and `window.vyotiq.feedback.compose`. The old flat API (`getUpdaterStatus` / `checkForAppUpdates` / `downloadAppUpdate` / `installAppUpdate` / `onUpdaterStatus`) was removed; **Settings → About** (`AboutSection.tsx`) and the `App.tsx` toast were migrated to the namespaced bridge.

Update card UI: `src/renderer/src/features/updates/{UpdateCard.tsx, useUpdater.ts, types.ts}`, mounted in `src/renderer/src/app/AppShell.tsx` right after `CommandPalette` (line 458). Fixed bottom-right card showing release name + version, structured "What's new" note sections, determinate download progress (percent + MB), **Install & restart** once downloaded, and dismiss (button or Escape, persisted last-seen version). Renders nothing unless an update is available/downloading/downloaded, so layout never shifts.

---

## 3. Feedback

Settings → General → "Send feedback" opens `src/renderer/src/features/feedback/FeedbackDialog.tsx` (type: bug / feature / praise / other, title, message, optional diagnostics).

- Composes a **mailto to `support@vyotiq.com`** with subject `[Vyotiq <ver>] <type>: <title>` via `src/main/feedback/{index.ts, mailto.ts}` (`buildFeedbackMailto`, pure function) and opens it with `shell.openExternal`.
- Optional diagnostics block = **app version, OS, locale, timestamp only — never chat contents** (`src/main/feedback/mailto.ts:18-23`).
- The dialog also exposes a plain `mailto:` fallback link so feedback stays deliverable even if the IPC call fails.

The landing site mirrors the address (`landing/src/lib/site.ts` — `SITE_FEEDBACK_EMAIL` + `feedbackMailto()`) with affordances in the site header/footer.

---

## 4. Landing site

- Astro site under `landing/` (pnpm workspace package); `pnpm landing:build` verified — **54 pages**.
- Download links are baked from the latest published GitHub Release at build time by `landing/scripts/bake-github-release.mjs`: it fetches the releases API, falls back to the releases list when the latest has no assets, and — on any failure — keeps the previously baked `landing/src/lib/github-release.json` snapshot instead of hiding package buttons.
- Deployed by `.github/workflows/deploy-landing.yml` to Cloudflare Pages via `wrangler@4 pages deploy --project-name=vyotiq`.
- **Deploying:** the workflow requires repo secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`; as of 2026-09-10 both are set in the repo and deploys succeed — the live site's download CTA points at `vyotiqai/vyotiq-agent-v-releases/releases/latest`.

---

## 5. Release history

| Release | Status |
| --- | --- |
| v1.0.0 | Baseline. |
| v1.1.0 | Partial: Windows + Linux published; mac job failed. Tag is immutable and left in place. |
| v1.1.1 | Complete — published 2026-09-08, Release run 34254964752 success. |
| v1.1.2 | Complete — published 2026-09-08. Desktop update-check crash fix, blue default accent color. |
| v1.1.3 | Complete — published 2026-09-10 to the releases repo, current release. Memory tool reliability, OS-aware landing download button, accessible theme switcher, 19 accessibility findings resolved. |

Release commits: `74c82e1` (feat: production readiness), `39d54be` (chore(release): v1.1.0), `801c394` (ipcChannelParity updaterState), `a502aa8` (App updater-toast bridge guard), `ea70e01` (xmldom pin), `33c7389` (chore(release): v1.1.1).

---

## 6. macOS packaging bug fixed

`electron-builder` mac packaging crashed with `DOMParser.parseFromString: the provided mimeType undefined is not valid` inside `app-builder-lib@26.15.3 parsePlistFile`. Root cause: `plist@3.1.0` declares `@xmldom/xmldom ^0.8.8`, but the workspace override `>=0.8.15` resolved **0.9.12**, whose DOMParser API is incompatible with plist 3.x.

Fix: pinned the override to exactly `'0.8.15'` in `pnpm-workspace.yaml` (commit `ea70e01`). Verified `plist.parse` locally resolves `@xmldom/xmldom` 0.8.15, and `pnpm audit --audit-level high` stays clean.

---

## 7. Verification

- `pnpm typecheck` — exit 0.
- `pnpm lint` — exit 0.
- Targeted suites: **49/49** (updaterService, feedbackMailto, releaseNotes, ipcContract, ipcChannelParity, updateCard ×8, feedbackDialog ×5, removedUiGuard).
- Full suite: **5145 tests** — 10 failures found, **7 fixed this run** (`app.sessionDrop` ×4 + `appPaneIdentity` ×3 via the App updater-toast bridge guard; `ipcChannelParity` via the renamed `updater:state` channel); **3 remaining**, all pre-existing (see below).

---

## 8. Known issues / open items

1. **3 `appShell` tests red** (`button /new chat/i`): `DEFAULT_NAVIGATION_MODE = 'home'` (`src/shared/ipc/schemas/settings.ts:146`) hides the sidebar New Chat button; the tests set no `navigationMode`. Owned by the in-flight home-screen session, not this run.
2. **Landing deploy resolved** (2026-09-10): both Cloudflare secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) are set and deploys succeed; the live download CTA points at `vyotiqai/vyotiq-agent-v-releases/releases/latest`.
3. **Optional CUDA swap decision open** (section 1: keep `cuda`, drop `cuda-ext` + Vulkan — win ~261 / linux ~445–475 MB).
4. **`publisherName` must stay unset** in `electron-builder.yml` while builds are unsigned: electron-updater compares the downloaded installer's Authenticode subject against it and throws `ERR_UPDATER_INVALID_SIGNATURE` on mismatch. Re-add it together with `win.forceCodeSigning: true` once a signing cert is always present in the release environment.
