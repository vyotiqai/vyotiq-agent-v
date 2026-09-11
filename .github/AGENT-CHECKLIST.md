# AI Agent Checklist — Vyotiq (Agent V)

> **Prompt for AI agents working in this repository.** Read this file fully
> before making changes, and follow the phase checklists in order. Every rule
> below exists because breaking it shipped a broken installer, a red main, or
> a silently-dead auto-update path. Do not "optimize" these steps away.

You are an AI agent operating on **Agent V** (`vyotiq`), an Electron desktop
app (React 19 + Tailwind v4 renderer, TypeScript main process, pnpm
workspace, electron-vite + electron-builder + electron-updater) plus an Astro
landing site under `landing/`. Main is a shared checkout — other agents and
humans keep in-flight work here. Your standing goals: **main stays green,
every tagged release installs and launches on all three OSes, and the
in-app updater chain never breaks.**

---

## 0. Non-negotiable invariants

- [ ] **Never force-push `main`, never re-point or delete a published tag.**
      electron-updater compares versions, not commits; a moved tag produces
      silent non-updates and colliding assets. If a release fails midway, fix
      on `main` and ship the next version.
- [ ] **`package.json` `"version"` is the single version source.** A tag
      `vX.Y.Z` must equal the package.json version. The Release workflow's
      `verify` job enforces this — do not bypass it.
- [ ] **Never merge a grouped Dependabot major bump.** Major upgrades
      (zod, electron, vite, vitest, react, gpt-tokenizer, onnxruntime) are
      done **one at a time**, each with the full verification suite and a
      packaged-app launch (see §3). Close stale grouped PRs with a rationale
      comment; Dependabot re-proposes weekly against current main.
- [ ] **Never bulk-revert the working tree** (`git restore .`, `git reset --hard`).
      Concurrent sessions keep uncommitted work here. Stage explicit paths only.
- [ ] **Never commit machine-local clutter**: `dist-verify*/`, `tmp-os-evidence/`,
      `screenshots/`, `scripts/tmp-*`, `AGENTS.md`, `.cursorrules` are
      gitignored — keep them that way. Before `git add -A`, check
      `git status` and exclude anything that is not source.
- [ ] **`publisherName` stays unset** in `electron-builder.yml` while builds
      are unsigned; re-adding it early breaks Windows auto-update with
      `ERR_UPDATER_INVALID_SIGNATURE`.
- [ ] **`@xmldom/xmldom` stays pinned to exactly `0.8.15`** in
      `pnpm-workspace.yaml` overrides; `>=0.8.15` resolves 0.9.x which breaks
      `plist@3.1.0` mac packaging.
- [ ] **Every release ships from `CHANGELOG.md`.** The release body, the
      in-app update card, and the website changelog all parse it
      (`## Heading` + `- bullet` after extraction). A release without a
      changelog entry must fail — never weaken that gate.
- [ ] **Installers live on the releases-only repo**
      (`vyotiqai/vyotiq-agent-v-releases`); the updater and website point
      there. The source repo (`vyotiqai/vyotiq-agent-v`) only receives a
      mirrored pointer release (finalize job does this — keep it).

---

## 1. Before every commit

- [ ] `pnpm typecheck` — exit 0.
- [ ] `pnpm lint` — exit 0.
- [ ] `pnpm test` — green. Known-allowed failures are listed in
      `RELEASE-RUNBOOK.md` §3; confirm the failure set has not grown, and
      never introduce a new one.
- [ ] If you touched a feature area, run its targeted suites first for a fast
      loop (e.g. `pnpm exec vitest run tests/renderer/updates
      tests/main/unit/updaterService.test.ts`).
- [ ] `git status` clean of unintended files (junk check above).
- [ ] Commit message: Conventional Commits (`feat:`, `fix:`, `chore:`,
      `docs:`, `test:`; optional scope). Push only after the suite is green.

---

## 2. Packaging & build changes (highest blast radius)

> The v1.2.0 incident: a "clever" node_modules trim in
> `electron-builder.yml` dropped 982 gpt-tokenizer files, including files on
> the startup require path. Every platform's installer crashed at launch
> with a generic "JavaScript error occurred in the main process" dialog.
> CI (build + smoke package + GUI e2e) did **not** catch it. Only a
> packaged-app launch does.

If you touch `electron-builder.yml` (especially `files`, platform `files`
`from/filter` blocks, `asarUnpack`, `extraResources`), or any runtime
dependency's file layout:

- [ ] **Static require scan** for every package you trim or filter: grep the
      package's shipped JS for `require('./...')`/`import ... from './...'`
      and confirm every statically-required file survives your exclusion
      patterns. Remember: registries like `modelParams.js` statically
      require *all* sibling modules, so "we only use encoding X" reasoning
      is wrong. `.d.ts`, `.md`, `.js.map` are safe to exclude; nothing else
      is assumed safe.
- [ ] **Remember the glob semantics**: an ignore-only matcher gets `**/*`
      prepended by AppFileWalker and **unions** with other matchers —
      platform `files` blocks must repeat the full exclusion list (see the
      comment at the top of `files:` in `electron-builder.yml`).
- [ ] `pnpm pack:dir:win` (or the `:alt` variant if the output dir is locked —
      transient AV/EBUSY/EPERM locks on fresh extractions are normal; wait
      and retry, or switch to `dist-package-alt`).
- [ ] **Launch the packaged app**: start
      `dist-package*/win-unpacked/Vyotiq.exe`; confirm a real app window
      (title `Vyotiq`, not `Error`), 4+ processes, and that
      `%APPDATA%\Vyotiq\logs\vyotiq.log` is created with fresh entries.
      An "Error"-titled window = main-process crash = **do not ship**.
- [ ] **Install-launch test for release candidates**: run the built
      `setup.exe /S`, verify
      `(Get-Item "$env:LOCALAPPDATA\Programs\Vyotiq\Vyotiq.exe").VersionInfo.ProductVersion`
      equals the release version, then launch and re-check the window/logs.
- [ ] Kill any running `Vyotiq.exe` **before** silent-installing over it —
      the NSIS installer exits 0 even when it cannot replace locked files.
- [ ] For dependency/file-layout changes: re-run
      `node scripts/bundle-size-report.mjs --unpacked <dir> --asar <asar>` if
      sizes look off (assets must stay ≤ 500 MB).

---

## 3. Dependency upgrades

- [ ] One package (or one minor/patch group) per change; majors go solo.
- [ ] After `pnpm add/update`: `pnpm typecheck && pnpm lint && pnpm test`,
      then the **full** packaging flow from §2 if the package is a runtime
      dependency (`dependencies`/`optionalDependencies` in package.json).
      Dev-only bumps (vitest, vite, typescript, eslint…) need the suite but
      not the launch test — unless they affect the build output
      (vite plugins, minifiers do).
- [ ] Check for breaking-change migration guides on majors; write the
      migration, don't just bump. Example: vitest 4 moved `poolOptions` to
      top-level options — a green-looking run printed a deprecation first.
- [ ] `pnpm audit --audit-level high` must pass (CI gate). Mediums are
      triaged in the open Dependabot alerts: if `first_patched_version` is
      null (e.g. adm-zip via onnxruntime-node) and the package is never
      invoked with untrusted input, document and leave the alert open.
- [ ] `pnpm-lock.yaml` changes must be committed together with the
      `package.json` change that caused them.

---

## 4. CI & GitHub Actions

- [ ] Actions are **SHA-pinned** (policy: GitHub-owned actions only). To
      bump: `git ls-remote https://github.com/<owner>/<repo> refs/tags/vX`
      and pin the tag commit; read the release notes for breaking changes
      (e.g. setup-node v5+ enables `package-manager-cache` by default and
      resolves the package manager **inside the action** — pnpm/corepack
      must be enabled before it, and jobs that never touch pnpm must set
      `package-manager-cache: false`).
- [ ] `ci.yml` runs the full matrix (typecheck, coverage, lint, build,
      landing build/check/audit, dependency audit, unpacked smoke, GUI e2e)
      on every push to main and every PR — keep it green; a red main blocks
      the release pipeline's `verify` trust model.
- [ ] `release.yml` job order is load-bearing:
      `verify → create-release (notes!) → package ×3 → finalize-release`.
      Finalize enforces: release body not a stub, all three `latest*.yml`
      manifests + all installers present, landing redeploy dispatched,
      pointer release mirrored to the source repo. Never remove these gates.
- [ ] Workflow path filters matter: tag pushes trigger Release; landing
      deploys trigger on its path filters + manual dispatch + the finalize
      job's `gh workflow run`.

---

## 5. Release procedure (follow in order)

1. [ ] Add the release entry to `CHANGELOG.md`:
       `## [X.Y.Z] - YYYY-MM-DD` with `### Added/Changed/Fixed` subsections
       and `- ` bullets. These become the update card's "About this update".
       Preview with
       `node scripts/extract-release-notes.mjs --version X.Y.Z`
       (exit 1 + clear error = fix the entry; the pipeline fails on empty).
2. [ ] Bump `"version"` in `package.json` (on a dirty tree, edit manually —
       `pnpm version` refuses a dirty tree; do **not** bulk-revert).
3. [ ] `git add package.json CHANGELOG.md && git commit -m "chore: bump version to X.Y.Z"`.
4. [ ] **Run the pre-tag gate** (§1 suite + §2 launch test if packaging or
       runtime deps changed).
5. [ ] `git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z"` then
       `git push origin main` **then** `git push origin vX.Y.Z`
       (verify each push actually landed — check `git status -sb` is not
       ahead; a swallowed push error leaves the tag unpublished).
6. [ ] Watch: `gh run watch <run-id> --repo vyotiqai/vyotiq-agent-v --exit-status`
       for the Release workflow. Jobs: Verify → Create release →
       windows-x64 / linux-x64 / macOS → Finalize release.
7. [ ] Post-verify the release:
       - `gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases`
         shows structured notes (not a stub).
       - Assets include: `latest.yml`, `latest-linux.yml`, `latest-mac.yml`,
         `Vyotiq-X.Y.Z-setup.exe`, both `-arm64.dmg`/`-x64.dmg`, both
         `*-mac.zip`, `.AppImage` (+ blockmaps). All three manifests are
         mandatory — a missing one silently kills that OS's auto-update
         (the v1.1.0 incident).
       - Pointer release mirrored on the source repo, marked Latest.
       - `deploy-landing` run succeeded; vyotiq.com buttons point at the new
         version; `/changelog` leads with the new entry.
8. [ ] **Install-launch the released artifact** (§2): download the real
       asset, verify SHA512 against `latest.yml`
       (`certutil -hashfile <file> SHA512`, decode the manifest's base64 —
       truncated downloads produce broken installers that fail with cryptic
       errors), silent-install, launch, confirm version + window + logs.
9. [ ] Announce/state clearly: **v1.2.0-style broken releases cannot
       self-update** (the app dies before the update card renders) — say so
       in the changelog and release notes so users know to reinstall manually.

---

## 6. Debugging playbook

- **"JavaScript error occurred in the main process" dialog** (window title
  `Error`): a main-process uncaught exception, usually a missing module from
  a packaging trim. Read the dialog:
  `Get-Process Vyotiq | Where-Object MainWindowTitle | Select Id,MainWindowTitle`
  (title `Error` = crash), screenshot for the message, or check
  `%APPDATA%\Vyotiq\logs\vyotiq.log` + `crash-history.json`. The missing
  module name tells you which trim/filter to fix.
- **App runs but no `%APPDATA%\Vyotiq`**: it died before
  `initMainLogging()` — expect a top-level import/require failure in the
  packaged `out/main/index.js`.
- **Installer "errors"**: (1) verify the downloaded file's SHA512 against
  `latest.yml` — truncated downloads are the #1 cause; (2) kill running
  instances before silent installs; (3) only then suspect the NSIS config.
- **Auto-update silently dead on one OS**: that OS's `latest*.yml` is
  missing from the release. Never fix by re-tagging; ship the next version.
- **Windows packaging EBUSY/EPERM on `win-unpacked(.tmp)`**: transient
  AV/indexer locks — kill stray `Vyotiq.exe`, wait, retry, or use the
  `:alt` output-dir scripts.
- **Landing deploy fails at wrangler auth**: check `CLOUDFLARE_API_TOKEN` /
  `CLOUDFLARE_ACCOUNT_ID` secrets, then `gh workflow run deploy-landing.yml`.

---

## 7. Definition of done

A change is done when: typecheck + lint + tests green locally; CI green on
the pushed commit; any packaging-adjacent change has a launched, logs-verified
packaged app; any release has all three manifests, mirrored pointer, updated
landing; and the next person (human or agent) can read **what** you did and
**why** from the commit message and, where it matters, from
`RELEASE-RUNBOOK.md` / this file. If you discovered a new failure mode, add
its signature and fix to §6 and the runbook — that is how this checklist
grows.
