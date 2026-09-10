# 06 — Build / CI / Dependencies / Docs audit

**Date:** 2026-09-10 · **Auditor scope:** `.github/workflows/**`, `electron-builder.yml`, `electron.vite.config.ts`, `pnpm-workspace.yaml`, `scripts/**`, `vitest.config.ts`, `landing/**` release plumbing, docs drift (README / AGENTS / runbook / readiness / SECURITY).

**Tree audited:** commit `0392ac7` ("feat(release): publish installers to the public releases-only repo", 2026-09-10 08:13 IST) — identical to `origin/main` at audit time. The main checkout carries in-flight uncommitted changes (78 tracked files + untracked); of this workstream's files, only `electron-builder.yml`, `RELEASE-RUNBOOK.md`, `PRODUCTION-READINESS.md`, `scripts/patch-landing-tool-counts.mjs`, `scripts/sync-docx-md.mjs` differ from the audited commit, and those diffs were read from the main checkout via `git diff` (all comment-only or dead-code removals; no functional build/CI change — noted inline). `release.yml`, `deploy-landing.yml`, `ci.yml`, `pnpm-workspace.yaml`, `vitest.config.ts`, and all landing release scripts are byte-identical in both trees (absent from the main-tree diff).

**Round-1 unknowns closed this run:** `release.yml` and `deploy-landing.yml` were read directly; `pnpm audit --audit-level high` was executed; the live landing site and the live v1.1.3 GitHub release were checked over the network.

---

## Executive summary

The release and deploy pipelines are structurally sound and **work end-to-end today**: the v1.1.3 release in `vyotiqai/vyotiq-agent-v-releases` has every installer plus all three `latest*.yml` updater files (verified via GitHub API this run), and the live landing site's download CTA points at that repo's *latest* release page — **not** at v1.0.0 assets. Two round-1 headline claims are thereby resolved: **H1 (unsigned builds) is verified against the actual workflow config** — the design deliberately ships unsigned when signing secrets are absent, and every in-repo doc asserts they are absent; **H2 (landing deploy broken / serves v1.0.0) is refuted for the current tree and live site** — the runbook's 2026-09-08 "secrets empty" note is stale: the live site already serves the releases-repo URL that only landed on origin/main this morning, so a deploy succeeded after that change. What remains real is docs rot: the runbook still describes the *old* publish target (`vyotiqai/vyotiq-agent-v` with `GITHUB_TOKEN`), README claims 61 tools (registry has 60), AGENTS.md's release state is three versions behind, and the landing's release-bake pipeline is dead code no page renders.

| Round-1 item | Verdict this run |
| --- | --- |
| H1 — unsigned builds / unsigned update chain | **Verified** (config-level; secret presence unknown — see High-1) |
| H2 — landing deploy broken, serves v1.0.0 | **Refuted as of 2026-09-10** (see Medium-1/2 for the residual drift) |
| M5 — tool count & release-state drift | **Confirmed** (README 61 vs 60; AGENTS.md v1.0.0/1.0.1 vs 1.1.3) |
| L1 — repo clutter | **Confirmed, list refreshed** (see Low-1) |
| L3 — coverage floor 40/35/30 | **Confirmed** (vitest.config.ts:55-58) |
| L4 — 40-min test valve false-fail | **Confirmed** (scripts/test-exit-wrapper.cjs:56); does not affect CI's `test:coverage` gate |

---

## Findings — High

### High-1. Release builds are unsigned by design; signing state depends on repo secrets that all in-repo docs say are absent (round-1 H1, now verified from the workflow itself)

- **Evidence (all read this run):**
  - `.github/workflows/release.yml:11-15` — env comment: "Without a cert (CSC_LINK unset) pack unsigned so macOS DMG still builds", with `CSC_IDENTITY_AUTO_DISCOVERY: ${{ secrets.CSC_LINK != '' }}`.
  - `.github/workflows/release.yml:85-92` — publish command appends `--config.mac.identity=null` when `CSC_LINK` is unset, and `--config.mac.notarize=true` only when `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` are all present.
  - `electron-builder.yml:80-86` — the `publisherName` comment block: it "MUST stay unset while release builds are unsigned (release.yml falls back to unsigned packs when CSC_LINK is unset) or Windows auto-update always fails"; re-add only together with `win.forceCodeSigning: true`.
  - `electron-builder.yml:127` — `mac.notarize: false` (default; only overridden by the release.yml conditional flag).
  - `RELEASE-RUNBOOK.md` troubleshooting row b and `PRODUCTION-READINESS.md` §8.4 both describe the current state as unsigned.
- **What the workflow does NOT do:** there is no `win.forceCodeSigning`, no `certificateSubjectName`, and nothing fails the release when secrets are missing — an unsigned release publishes successfully. Windows NSIS packs unsigned whenever `CSC_LINK` is empty; macOS packs ad-hoc/unsigned with `identity=null` whenever `CSC_LINK` is empty.
- **Impact:** users cannot verify installer authenticity; electron-updater integrity rests entirely on TLS + GitHub release trust (no Authenticode verification possible, no Developer ID/Gatekeeper pass on macOS).
- **Unknown:** whether `CSC_LINK`/`APPLE_*` secrets are actually set in the repo — not readable from the tree. Every in-repo document asserts they are not.
- **Remediation:** acquire Windows Authenticode + Apple Developer ID credentials, set the secrets, then re-add `publisherName` together with `win.forceCodeSigning: true` and enable notarization — exactly the plan already written at `electron-builder.yml:80-86`.

---

## Findings — Medium

### Medium-1. `RELEASE-RUNBOOK.md` is stale against the releases-only-repo switch made this morning

- **Evidence:**
  - `RELEASE-RUNBOOK.md:2-3` — "published to GitHub Releases at `vyotiqai/vyotiq-agent-v`".
  - Runbook §2 step 5 (~line 72): "with `GH_TOKEN: secrets.GITHUB_TOKEN`" — but `.github/workflows/release.yml:79` uses `GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}` for the cross-repo publish.
  - Runbook §4 (~line 119) and §7 step 4 (~line 210-212): `gh api repos/vyotiqai/vyotiq-agent-v/releases/tags/...` — the verification commands target the private source repo, while releases now publish to `vyotiqai/vyotiq-agent-v-releases` (`electron-builder.yml:164-167`).
  - The runbook header (lines 5-9) claims "every … workflow name, secret name, and path below was verified against the actual … workflows" — no longer true for the publish target, token name, and API paths.
  - The in-flight working-tree diff to the runbook only renumbers step 5→7 and adds a release-notes editing step (§2 step 6, `gh release edit … --notes-file`); it does **not** fix any of the above.
- **Impact:** an operator following §4/§7 verification would query the wrong repo and either fail or see no release; the documented token name (`GITHUB_TOKEN`) cannot publish cross-repo, so anyone "fixing" the workflow per the runbook would break releases.
- **Remediation:** update the runbook's repo name (→ `vyotiqai/vyotiq-agent-v-releases`), token name (→ `RELEASES_TOKEN`), and all `gh api` commands; re-assert the header's verification claim after the change.

### Medium-2. The landing release-bake pipeline is dead code, and the docs describe a download-UI that no longer exists (this is what made round-1 H2 plausible)

- **Evidence:**
  - `landing/scripts/bake-github-release.mjs` runs on every landing build (`package.json` `landing:build` = `sync:brand` + `sync:landing-brand` + `bake:landing-release` + astro build; executed by `deploy-landing.yml:59-61` and `ci.yml:70`), fetching the GitHub releases API and writing `landing/src/lib/github-release.json` (currently baked as **v1.1.3** with per-platform asset URLs).
  - But no landing page or component consumes the baked assets: `landing/src/components/ReleaseInstallers.astro:2` imports only `RELEASES_PAGE`; its comment (lines 4-6) explains "the code repository is private, so per-platform asset links cannot be served … one call to action pointing at the releases page". A repo-wide grep over `landing/src/**` finds no other importer of the snapshot (`githubRelease` is exported from `landing/src/lib/githubRelease.ts:72` and used nowhere else).
  - `RELEASE-RUNBOOK.md` §5 (~lines 160-172) and §2 step 7 still say the landing's "download buttons bake the new release" — describing the removed per-platform button design.
- **Impact:** every CI run and deploy performs a network fetch to maintain a snapshot nothing renders; docs mislead the next release operator into thinking a landing redeploy is needed to refresh download links (it is not — the live CTA follows GitHub's *latest*).
- **Remediation:** either delete the bake script + `githubRelease.ts`/`github-release.json` and their doc references, or reintroduce a consumer. Keep whichever matches product intent for the private-repo era (the current single-CTA design already solves it via the public releases repo).

### Medium-3. Documentation version drift (round-1 M5, confirmed and extended)

- **Evidence (all verified this run):**
  - `README.md:7` — "**61** tools"; the registry in `src/main/agent/schemas/tools.ts:974-1257` has **exactly 60** entries (enumerated by grep), and `tests/main/unit/toolsSchema.test.ts:67` asserts `toHaveLength(60)`. README is off by one.
  - `AGENTS.md:47` — "Released so far: `v1.0.0` … Next: patch bump (1.0.1)" vs `package.json:4` `"version": "1.1.3"` and the live v1.1.3 release. `AGENTS.md:44` also says releases publish to `vyotiqai/vyotiq-agent-v` — stale (now the releases-only repo). Note: `AGENTS.md` is **gitignored** (`.gitignore:111`) — local-only, but it steers every agent session that reads it.
  - `landing/src/content/docs/start/install.md:39-41,55,64,72` — install docs still name `Vyotiq-1.0.0-setup.exe` / `-arm64.dmg` / `.AppImage`.
  - `PRODUCTION-READINESS.md` §5 release history table stops at v1.1.1 (v1.1.2 and v1.1.3 missing; the repo's untracked `scripts/tmp-release-notes-v112.md` / `-v113.md` confirm those releases happened); §4 and §8.2 still describe the landing deploy as **blocked** on empty Cloudflare secrets — stale per this run's live evidence (Medium-1/H2 closure).
- **Impact:** contributors, users, and agent sessions act on wrong versions and a wrong publish target; the readiness doc's "blocked" claim now causes unnecessary re-remediation effort.
- **Remediation:** single-source the tool count (derive from the registry or assert README against `BUILTIN_TOOL_NAMES.length` in CI); refresh AGENTS.md's release-state section and publish target; update landing install docs artifact names or make them version-agnostic; append v1.1.2/v1.1.3 to the readiness history and correct the landing-deploy status.

### Medium-4. `pnpm audit` result: 4 moderate, 0 high — the `--audit-level high` gate passes, but one moderate sits in a runtime dependency with no patched version

- **Evidence (`pnpm audit --audit-level high` executed this run, exit 0; full `pnpm audit` for detail, exit 1 with moderates only):**
  - `adm-zip` (GHSA-vwc7-r8mq-g2x9, symlink-following extraction, vulnerable `>=0.5.9 <=0.6.0`, **patched versions: none**) via `.>onnxruntime-node>adm-zip` — a runtime `dependency` path (`package.json` dependencies include `onnxruntime-node: 1.24.3`). The workspace override `adm-zip: '>=0.6.0'` (`pnpm-workspace.yaml:32`) resolves *into* the vulnerable range and cannot fix this.
  - `colord` (GHSA-2wm5-q62r-hmrv, slow rejection of malformed color strings, `<2.9.4`) via `@lobehub/icons>@lobehub/ui>leva` — renderer icon dep.
  - `vitest` + `@vitest/mocker` (GHSA-82fw-gwwq-j7x9, path traversal via mock redirect, `>=2.1.0 <4.1.11`) — dev-only (matches `package.json` vitest `^3.2.7`).
- **Impact:** nothing high/critical; the CI gate (ci.yml:81) correctly passes. The adm-zip item is unfixable today (no patched release exists) and sits in the packaged app's dependency tree — though `adm-zip` is used by onnxruntime-node's install-time tooling, not the app's runtime code path (not exhaustively verified — see Unknowns).
- **Remediation:** track the adm-zip advisory; when a patched release appears, bump the override. Consider an override note that `>=0.6.0` is inside the currently vulnerable range so nobody mistakes it for a fix. The vitest finding clears when vitest 4.1.11+ is adopted.

---

## Findings — Low

### Low-1. Repo clutter (round-1 L1 — confirmed, list refreshed against the main checkout, 2026-09-10)

- **Evidence (`git status --porcelain` on the main checkout this run):** untracked — `AUDIT-REPORT-2026-09-10.md`, `asar-list.txt`, `repro-askquestion.mjs`, `screenshots/` (6 PNGs + `ocr.ps1`), `scripts/tmp-release-notes-v112.md`, `scripts/tmp-release-notes-v113.md`. Round-1's `test-full-run.log` is gone; the rest remains. Additionally, one-off dev scripts are committed to VCS: `scripts/brand-variants3.mjs`, `brand-variants4.mjs`, `brand-variants7.mjs`, `brand-variants8.mjs`, `_unbounded-wordmark.mjs` (none referenced by `package.json` scripts or workflows).
- **Impact:** accidental-commit and review-noise risk; the round-1 audit report itself is untracked and one `git clean` from loss (as are the new in-flight source files — round-1 already flagged this).
- **Remediation:** add ignore rules for `asar-list.txt`, `screenshots/`, `scripts/tmp-*`; move or delete the one-off brand-variant scripts; commit or intentionally discard the audit report and tmp release notes.

### Low-2. Landing deploy pins wrangler by major only, fetched at run time

- **Evidence:** `.github/workflows/deploy-landing.yml:75-76` — `pnpm dlx wrangler@4 pages project create …` / `pages deploy …`; the comment (lines 69-74) explains the GitHub-owned-actions-only policy forced the CLI route. Every actual GitHub Action in all three workflows is SHA-pinned (ci.yml:25,29,38,57; release.yml:49,58,66; deploy-landing.yml:43,52), but wrangler itself floats to any 4.x at deploy time.
- **Impact:** a compromised or breaking wrangler 4.x release is executed with Cloudflare credentials in every deploy; deploys are not reproducible.
- **Remediation:** pin an exact wrangler version (e.g. `wrangler@4.x.y` with the lockfile-style hash pnpm supports), or vendor it as a devDependency of the landing package so the lockfile pins it.

### Low-3. No workflow guard that the pushed tag matches `package.json` version

- **Evidence:** `.github/workflows/release.yml` publishes whatever `package.json` says — `--publish always` on tag pushes (line 90) hands version derivation entirely to electron-builder; nothing in the workflow compares `github.ref_name` to the package version. `RELEASE-RUNBOOK.md` §1 (lines 12-30) and troubleshooting row a (line 185) document the consequence: a tag/version mismatch publishes assets named for the old version onto the derived release — colliding assets and no user update. The same consequence is stated at `AGENTS.md:45`.
- **Impact:** the single most destructive release mistake is prevented only by process discipline, in a repo whose runbook itself says in-flight work is nearly always present.
- **Remediation:** add a workflow step that fails unless `package.json` version equals the tag (`node -p` compare, exit 1 on mismatch) before any packaging. Cheap and closes the runbook's worst row (a).

### Low-4. Coverage gates are a low absolute floor (round-1 L3 — confirmed as described)

- **Evidence:** `vitest.config.ts:55-58` — `lines: 40, statements: 40, functions: 35, branches: 30`, with the in-file comment framing them as a CI tripwire ("dropping a test suite or shipping untested runtime paths must fail the coverage run").
- **Remediation:** treat as a ratchet (forbid regression below current actuals) rather than raising the floor across the board.

### Low-5. Test wrapper's 40-min valve can fail a run with zero test failures (round-1 L4 — confirmed, with a scoping correction)

- **Evidence:** `scripts/test-exit-wrapper.cjs:56` — "no summary after 40min; killing tree" → `finish(true, 1, …)`; `:22` defines `HANG_EXIT = 86` (currently unused — the function exits with the derived code, and `failed` is derived from the output regex at `:63`). Primary fix is `teardownTimeout: 15_000` (`vitest.config.ts:33`); the wrapper is a safety net.
- **Scoping correction:** only `pnpm test` goes through the wrapper (`package.json` `"test": "… node scripts/test-exit-wrapper.cjs"`); CI's gate is `pnpm test:coverage` (ci.yml:53), which runs vitest directly and is **not** subject to the valve. So the false-fail class cannot fail CI's coverage gate — it affects local full-suite runs only.
- **Remediation:** keep as-is (documented), or wire `HANG_EXIT = 86` into the exit path so a hang is distinguishable from a genuine failure.

---

## Verified non-issues

- **Release trigger & publish design (direct read, round-1 gap closed):** tag-push-only publishing (`release.yml:5-6` `v*`), with `workflow_dispatch` deliberately degraded to `--publish never` (`release.yml:85-90` and comment) so a manual branch dispatch cannot republish; matrix covers windows-x64 (NSIS), linux-x64 (AppImage), macOS dual-arch in one job with a documented rationale (single `latest-mac.yml` for both zips, `release.yml:28-33`); artifacts uploaded with `if-no-files-found: error` (`release.yml:100-105`); job-scoped `permissions: contents: write` over a workflow-level `contents: read` (`release.yml:10-11,21-22`).
- **Cross-repo publish wiring is internally consistent:** `GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}` (`release.yml:79`) ↔ `publish.provider: github / owner: vyotiqai / repo: vyotiq-agent-v-releases / releaseType: release` (`electron-builder.yml:164-167`), and the baked landing snapshot plus the live release both confirm assets land in that repo.
- **Live release pipeline verified end-to-end (GitHub API, this run):** the latest release in `vyotiqai/vyotiq-agent-v-releases` is **v1.1.3** with `latest.yml` (341 B), `latest-linux.yml` (364 B), `latest-mac.yml` (798 B), `Vyotiq-1.1.3-setup.exe` (+blockmap), `Vyotiq-1.1.3.AppImage`, `Vyotiq-1.1.3-arm64.dmg`, `Vyotiq-1.1.3-x64.dmg`, `Vyotiq-1.1.3-arm64-mac.zip`, `Vyotiq-1.1.3-mac.zip` (+blockmaps). All three `latest*.yml` present — the runbook's v1.1.0 failure mode (row g) did not recur.
- **Landing deploy pipeline (direct read, round-1 gap closed):** `deploy-landing.yml` triggers on path-filtered main pushes plus dispatch (`:10-24`), gates the deploy on `pnpm landing:check` (`:66`, same Astro check CI runs — a type error cannot reach production), uses `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` by name only (`:78-79`), documents both (`:1-4`), and the `project create … || echo` idempotency trick is commented (`:71-75`).
- **Live landing site (checked this run):** vyotiq.com is up; its download CTA points at `https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/latest`; the homepage HTML contains **no** baked `Vyotiq-<version>` asset URLs. Since that releases-repo URL only entered the landing in commit `0392ac7` (pushed to origin/main this morning), a deploy succeeded after the switch — the runbook's "deploy broken" state (2026-09-08) is resolved in practice.
- **CI gates (all verified in `ci.yml`):** typecheck (:46), `pnpm test:coverage` with coverage artifact upload (:53-62), lint (:65), `pnpm build:vite` (:68), landing build (:71), landing check + audit on Linux (:74-78), `pnpm audit --audit-level high` (:81), unpacked `electron-builder --<os> dir --publish never` smoke package (:84), GUI e2e on all three OSes with `VYOTIQ_E2E_FIXTURE` and xvfb on Linux (:86-96). All actions SHA-pinned; pnpm pinned via `corepack prepare pnpm@11.25.0` matching `package.json` `packageManager`; concurrency with cancel-in-progress; workflow `permissions: contents: read`.
- **electron-builder packaging:** `asar: true` (`electron-builder.yml:7`); narrow `asarUnpack` — `resources/**`, `**/*.node`, `onnxruntime-node/bin/**` only (`:69-73`); `npmRebuild: false` with per-OS native trimming (win/mac/linux `files` blocks) each carrying a rationale comment; artifact naming (`nsis.artifactName ${productName}-${version}-setup.${ext}`, `dmg ${…}-${arch}.${ext}`, `appImage ${…}-${version}.${ext}`) matches the runbook's §1 derivation and the live v1.1.3 asset names exactly.
- **Sentry DSN define (direct read):** `electron.vite.config.ts:8-12` builds the DSN from `SENTRY_DSN`/`VITE_SENTRY_DSN` at build time and injects it via `define` into main (`:19`) and preload (`:54`) plus `import.meta.env.VITE_SENTRY_DSN` in the renderer (`:73`) — the correct pattern for packaged builds where runtime `process.env` is empty; preload additionally bundles all deps (`externalizeDeps: false`, `:41-49`), consistent with the sandbox.
- **pnpm supply-chain pins (all verified, `pnpm-workspace.yaml`):** `minimumReleaseAge: 1440` (:2), `nodeLinker: isolated` (:3), `allowBuilds` allow-list of 8 native builders (:8-16), `overrides` with per-CVE rationale (:29-47) including the exact `@xmldom/xmldom: 0.8.15` pin the runbook's row c depends on, `packageExtensions` for `@astrojs/check` TS 6 (:24-27), and a 4-entry `minimumReleaseAgeExclude` (:49-53).
- **`pnpm audit --audit-level high` executes successfully over the network and passes** (exit 0, 4 moderate / 0 high / 0 critical) — closing the round-1 gap of never having run it. `SECURITY.md`'s claim "CI runs `pnpm audit --audit-level high` on every change" matches `ci.yml:81` exactly.
- **Sync-script wiring:** `dev`/`build:vite`/`test`/`postinstall`/`landing:build` all route through the sync scripts (`package.json:14-56`), and the deploy workflow runs the same `landing:build` chain CI does, so the deployed site is never built from a different pipeline than the tested one.

---

## Unknowns / not verified

- **Whether signing secrets (`CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `RELEASES_TOKEN`) are configured in the GitHub repo** — repo secrets are not readable from the tree; every in-repo doc asserts they are absent, and the unsigned-fallback design is confirmed, but the *actual* signedness of the published v1.1.3 assets was not verified (the 172 MB installers were not downloaded and inspected for Authenticode/Developer ID signatures).
- **Whether the Cloudflare secrets are now set, or whether the live-site deploy was manual** — the live site proves a deploy happened after the releases-repo URL change, but GitHub Actions run history for the private repo was not queried (no `gh` auth assumed in this environment). The 2026-09-08 "secrets empty" note (RELEASE-RUNBOOK.md:172-173) cannot be confirmed fixed from the repo alone, only from the live evidence.
- **Whether `adm-zip` is reachable at packaged-app runtime** — the audit path is `.>onnxruntime-node>adm-zip`; onnxruntime-node's use of adm-zip appears install-time-only, but that was not traced exhaustively.
- **Sync scripts' internal correctness** — audited at wiring level (which scripts run when, and the working-tree diffs to `patch-landing-tool-counts.mjs`/`sync-docx-md.mjs`, both of which only remove Qwen3-ASR references from landing docs). `scripts/sync-docx-md.mjs` (21 KB) and `scripts/sync-harness.mjs` were not reviewed line-by-line.
- **Live landing docs pages** — the live `/docs/start/install` fetch returned a 308 redirect and was not followed; the *tracked* source for that page still names v1.0.0 artifacts (Medium-3), but whether the live page shows them was not confirmed.
- **Tool-count claims in landing docs beyond `install.md`** — `scripts/patch-landing-tool-counts.mjs` maintains counts inside `.docx` sources; those docx contents were not re-counted this run.
- **Full test suite, lint, and typecheck were not run** (audit rules; the 40-min valve is documented above). Whether the current dirty main tree still typechecks is round-1's claim, not re-verified here.
