# SHIP A RELEASE — agent prompt

> **Paste this whole file to a coding agent** (Claude Code, Cursor, Codex,
> Copilot, Windsurf, Aider — any of them) when the job is: *get the current work
> committed, verified, released as installers, and written up.* It is written to be executed top to bottom with no prior knowledge of
> this repository.
>
> Companion documents, which this prompt supersedes where they disagree:
> `.github/AGENT-CHECKLIST.md` (day-to-day engineering rules) and
> `RELEASE-RUNBOOK.md` (pipeline reference). **Where they say the release body
> may be a stub, this prompt overrides them: every release now ships authored,
> structured notes** — see §5 for why that is not optional.

---

## 0. How to use this prompt

Fill in the three variables below, then execute §1 → §12 in order. Do not skip a
phase because it "looks fine"; each gate exists because skipping it once shipped
a broken installer, a red `main`, or a silently dead auto-updater.

```
RELEASE_KIND   = patch | minor | major          # §4 decides if unset
SCOPE          = <what is being released, in one sentence>
DRY_RUN        = false                          # true = do everything except push, tag, publish
```

**Report as you go.** After every phase, print a one-line status:
`PHASE <n> <name> — PASS/FAIL — <evidence>`. Never report a phase green without
having run the command and read its output. If a command fails, stop and apply
§A (failure playbook) rather than working around it.

---

## 1. Mission

Take the repository from *"there is work in the tree"* to *"a user on Windows,
macOS or Linux can download and install the new version from the releases
repository, and an existing installation offers the update in-app."*

That is done when, and only when, all of the following are true:

1. Everything intended to ship is committed and pushed — nothing needed is left
   uncommitted, nothing unrelated was swept in.
2. `typecheck`, `lint`, the test suite and the dependency audit are green on the
   exact commit being released.
3. A packaged build launches — a real window, not an error dialog.
4. `package.json` version, the git tag and the release all state the same version.
5. The GitHub release is **published**, carries **authored structured notes**, and
   has every installer plus all three updater manifests.
6. The in-app updater offers the new version to an older installation.

---

## 2. Hard rules — violating any of these is a failed run

- **Never force-push `main`. Never delete, move or re-point a published tag.**
  electron-updater compares versions, not commits: a moved tag produces silent
  non-updates and colliding asset names. A release that went wrong is fixed by
  shipping the *next* version, never by re-tagging. The `0.x` releases and tags
  were deleted once, deliberately, when the project restarted at `1.0.0` — that
  was a one-time reset the user asked for, and it is **not** precedent. There is
  no second one.
- **Never bulk-revert the working tree.** No `git reset --hard`, no
  `git restore .`, no `git checkout -- .`. This checkout is shared with other
  agents and humans who keep in-flight work here. Stage explicit paths only.
- **Never `git add -A` without reading `git status` first.** Machine-local junk
  (`dist-verify*/`, `tmp-os-evidence/`, `screenshots/`, `scripts/tmp-*`,
  `AGENTS.md`, `.cursorrules`) must stay out of commits.
- **Never invent a version, a filename, a download URL or a deploy target.**
  Every one of these is derived from a command's output or read from a file. If
  you cannot derive it, STOP (§B).
- **Never publish a release whose notes you did not author.** The stub body
  `Vyotiq vX.Y.Z installers and update metadata.` is a failure state, not a
  default (§5).
- **Never mark a phase green on the strength of CI alone** where this prompt
  asks for a packaged-app launch or a download check. CI has passed on builds
  that crashed at startup.
- **Do not touch `publisherName` in `electron-builder.yml`** while builds are
  unsigned — re-adding it breaks Windows auto-update with
  `ERR_UPDATER_INVALID_SIGNATURE`.
- **Do not unpin `@xmldom/xmldom` from exactly `0.8.15`** in
  `pnpm-workspace.yaml` — `>=0.8.15` resolves 0.9.x and breaks macOS packaging.
- If `DRY_RUN = true`: do every check, produce every artifact and write every
  file, but execute no `git push`, no `git tag` and no `gh release` mutation.
  Print exactly what you *would* have run.

---

## 3. Ground truth — the shape of this project

Read this instead of rediscovering it.

**The app.** `vyotiq` — an Electron desktop app. TypeScript main process, React
19 + Tailwind v4 renderer, pnpm workspace, electron-vite + electron-builder +
electron-updater. Node ≥ 22.18, pnpm 12.4.2 via corepack.

**Two repositories.**

| Repo | Role |
|---|---|
| `vyotiqai/vyotiq-agent-v` | Source. CI and the release workflow. |
| `vyotiqai/vyotiq-agent-v-releases` | **Installers live here.** The in-app updater reads this repo. |

The source repo also gets a *pointer* release per tag (title + links, no
assets), created automatically by the finalize job so its Releases page is not
empty.

**Version is single-sourced** from `package.json` `"version"`. The tag is that
version prefixed with `v`. The release workflow fails the run if they disagree.

**The release pipeline** (`.github/workflows/release.yml`) triggers on a pushed
tag matching `v*` and runs four stages in order:

```
verify              typecheck + unit tests + tag/version match
  └─ create-release creates a DRAFT release in the releases repo, stub body
       └─ package   3 parallel jobs: windows-x64 | linux-x64 | macOS (arm64+x64)
                    electron-builder --publish always → uploads into that draft
            └─ finalize-release
                    backfills notes only if the body is empty or still the stub
                    asserts all installers + latest.yml / latest-linux.yml / latest-mac.yml
                    flips draft → published
                    mirrors the pointer release onto the source repo
```

Draft-first is deliberate: the updater can never see a half-uploaded release.

**CI** (`.github/workflows/ci.yml`) runs on every push to `main` and every PR,
across Windows/macOS/Linux: typecheck, tests with coverage, lint, build,
`pnpm audit --audit-level high`, an unpacked packaging smoke test, and GUI e2e.

**There is no website right now.** The old vyotiq.com (`landing/`) was removed on
2026-09-27 and GitHub Pages was unpublished while a new site is built; see §11.

---

## 4. PHASE 1 — Orient, and decide the version

Run these and read the output before doing anything else:

```bash
git status -sb
git log --oneline -15
git tag --list | tail -5
gh release view --repo vyotiqai/vyotiq-agent-v-releases --json tagName,isDraft,publishedAt --jq '{tag:.tagName,draft:.isDraft,published:.publishedAt}'
node -p "require('./package.json').version"
```

Establish and state explicitly:

- **Current branch**, and whether it is `main` or a feature branch.
- **Uncommitted work**: for each modified/untracked path, decide *ships* or
  *does not ship*. Anything you cannot justify does not ship — leave it in the
  tree, do not revert it.
- **Last published version** vs **`package.json` version**. Three cases:
  - *package.json is ahead of the last release and its tag is unpushed* → the
    bump already happened; skip §8's bump, keep the version.
  - *package.json equals the last published release* → you must bump (below).
  - *a tag exists for this version and is already published* → **STOP** (§B):
    that version is spent, the next release must be a new version.

**Choosing the bump.** Agent V follows semantic versioning from `1.0.0`
onward. The `0.x` line was retired: `1.0.0` is the first release of this
codebase, and `0.1.0`–`0.3.0` were deleted along with their tags. Do not
reason from them, do not restore them, and never start a version below the
last published one.

Before choosing, know what the number is actually read by — this decides how
much the choice can hurt:

| Reader | What it does with the version |
|---|---|
| electron-updater | Compares ordinally: is the release newer than what is installed. |
| What's New (`useWhatsNew.ts`) | Compares ordinally against the last version the user saw. |
| The tag, the filenames | Prints it. |

Nothing in this codebase branches on *which* component changed. No migration,
no settings schema, no compatibility gate keys off major-vs-minor. So the one
mechanical invariant is **strictly increasing under semver ordering**, and the
components are a *message to the person deciding whether to take the update* —
not a compatibility contract with a machine. Choose them as writing, and be
honest:

| Bump | When | The question it answers |
|---|---|---|
| **patch** `1.0.0 → 1.0.1` | Fixes and internal work only. Nothing new to learn, nothing removed, no default changed, no new prompt or permission. | "Anything I need to know?" — no. |
| **minor** `1.0.0 → 1.1.0` | Any new user-visible capability, any changed default, any removal that has a replacement, any new confirmation the user will now be asked for. | "Will the app behave differently?" — yes, and here is how. |
| **major** `1.0.0 → 2.0.0` | The update cannot be quietly taken back: stored data migrated so an older version can no longer read it, a capability removed with no replacement, userData moved, or a build that cannot self-update from the previous major. | "Can I go back if I don't like it?" — no. |

Rules that settle the arguments this table will otherwise start:

- **When torn between two, pick the higher one.** Over-stating costs a reader
  five seconds on notes they did not need. Under-stating ships someone a
  changed default they were never warned about.
- **A bump is never justified by effort.** A release that took three weeks and
  only fixes defects is a patch. A one-line change to a default is a minor.
- **`major` still needs the user to say so.** It is the only bump that makes a
  promise about going back, and it is usually a packaging or data decision
  rather than a feature one. Recommend it, state the reason, and ask.
- **Never re-point, move or delete a published tag to correct a bump.** A
  version chosen wrongly is fixed by the next release, never by rewriting the
  last one. This is the same rule as §2 and it has no exception.

If `RELEASE_KIND` was supplied, use it, but state in your report whether the
diff actually justifies it. A release that removes six bundled skills is not a
patch, whatever the variable says.

Print: `PHASE 1 orient — PASS — releasing X.Y.Z (was A.B.C, bump=<kind>), N files to ship`.

---

## 5. PHASE 2 — Write the changelog *before* you release

Written now, deliberately — not at the end. The notes are a design review of
what you are shipping; writing them first catches "wait, that isn't finished".

### 5.1 Where the notes live, and why they matter twice over

There is **no `CHANGELOG.md` in this project.** The GitHub release body *is* the
changelog, and it is consumed by two surfaces:

1. **GitHub** — the release page, rendered as full markdown.
2. **The in-app update panel** — `src/shared/utils/releaseNotes.ts`
   (`parseReleaseNotes`) parses the body into sections that
   `src/renderer/src/features/updates/UpdatePanel.tsx` renders. Its grammar is
   narrow, and anything outside it is silently dropped from the card.

### 5.2 The format contract — follow it exactly

`parseReleaseNotes` recognises **only two line shapes**:

- `## Heading` — opens a section. The heading becomes the card's section label.
- `- item` — a bullet, added to the open section. Bullets before any heading
  land in one unlabelled section.

Everything else (prose paragraphs, sub-headings, code fences, tables) still
appears on GitHub, but **is invisible in the update panel**.
Therefore:

- **Every substantive change must appear as a `- ` bullet under a `## ` heading.**
  Use the lede paragraph for framing only — never to carry a change that is not
  also a bullet.
- Nested bullets are flattened into the parent section by the parser. Use them
  sparingly, and only for detail that reads fine standing alone.
- No code fences, tables or raw HTML. HTML tags are stripped from the update
  panel, and fences become noise there.

### 5.3 House style

Sections, in this order, omitting any that is empty:

```
## Added        new user-visible capability
## Improved     existing behaviour made better, faster, clearer
## Removed      anything taken away — always name it explicitly
## Fixed        defects that users could hit
## Security     vulnerability fixes, dependency CVEs (name the advisory)
## Known issues anything shipping broken on purpose — see 5.4
```

Bullet style, as established by the v1.0.0 release — copy it:

- Open with a **bold claim sentence.** Then explain, in plain language, what was
  actually wrong or what is now possible.
- Write for someone who uses the app, not someone who read the diff. No commit
  hashes, no PR numbers, no file paths, no internal class names.
- Be specific and measured. *"Each candidate address only got 250ms, shorter
  than the real round trip to much of the internet"* is a good bullet.
  *"Improved MCP reliability"* is not.
- Say why a fix mattered, especially when the symptom looked like something
  else.
- One lede paragraph above the first heading, framing the release in two or
  three sentences.

A worked template is Appendix A. The published v1.0.0 body is the canonical
example — read it before writing:

```bash
gh release view v1.0.0 --repo vyotiqai/vyotiq-agent-v-releases --json body --jq .body
```

`release-notes/v1.0.0.md` is the house-style reference: the rebuilt app's
first release. The `0.x` previews and the teammates release before it were
withdrawn; never cite them in a release, and never link a reader to them.

**Known cosmetic limitation, accepted deliberately:** `**bold**` renders as bold
on GitHub, but the update panel shows the asterisks literally, because it does
not render markdown. Keep the bold — GitHub is the
primary surface — and do not "fix" it by dropping the emphasis. The real fix is
in `parseReleaseNotes` / `UpdatePanel`, and is a separate change from a release.

### 5.4 Honesty requirements

- Anything knowingly shipping broken goes under `## Known issues`. Do not omit it.
- If this release cannot self-update from a previous broken build, say so in the
  notes, with the manual reinstall instruction. A build that crashes at startup
  never renders the update panel, so the notes are the only channel left.
- Do not claim a capability the app does not ship.

### 5.5 Produce the file

Write the notes to `release-notes/vX.Y.Z.md` (create the directory if needed; it
is a working file, and it is fine for it to stay untracked). Derive its content
from the actual diff:

```bash
git log --oneline <last-tag>..HEAD
git diff --stat <last-tag>..HEAD
```

Read the commits *and* the diff — commit subjects alone will make you miss
user-visible consequences of refactors.

Print: `PHASE 2 changelog — PASS — release-notes/vX.Y.Z.md, N sections, M bullets`.

---

## 6. PHASE 3 — The production-readiness gate

Every command below must exit 0 **on the tree you are about to ship**. Run them
in this order; fix and re-run rather than proceeding past a failure.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
pnpm audit --audit-level high
pnpm build:vite
```

Notes that save time:

- **`pnpm test` runs through `scripts/test-exit-wrapper.cjs`.** Read the summary,
  not just the exit code.
- **Known-flaky under full-suite load:** terminal/PTY tests can fail with
  `AttachConsole failed` when the whole suite runs concurrently. Before
  attributing such a failure to your change, re-run that file alone. If it
  passes in isolation, record it as a known flake in your report; it is not a
  release blocker. **No other failure is tolerated** — there is no allow-list.
- **`pnpm audit`**: mediums with `first_patched_version: null` on packages never
  fed untrusted input are triaged and documented, not fixed at release time.
  Highs block the release.
- If the lockfile changed, it must be committed alongside the `package.json`
  change that caused it.

### 6.1 The packaged-app launch test — mandatory

**Required** if this release touches `electron-builder.yml`, any runtime
dependency (`dependencies` / `optionalDependencies`), `src/main/**`, or anything
on the startup path. **Recommended always.** CI's smoke test does not catch
startup crashes; only launching the packaged binary does.

```bash
pnpm pack:dir:win          # use pack:dir:win:alt if the output dir is locked
```

Then launch `dist-package/win-unpacked/Vyotiq.exe` and confirm:

- A real application window titled **`Vyotiq`**. A window titled **`Error`** is a
  main-process crash — **do not ship**; read the dialog and
  `%APPDATA%\Vyotiq\logs\vyotiq.log`.
- 4+ `Vyotiq` processes running.
- `%APPDATA%\Vyotiq\logs\vyotiq.log` exists with entries from this launch. No
  `%APPDATA%\Vyotiq` at all means it died before logging initialised — expect a
  failed import in the packaged `out/main/index.js`.

```powershell
Get-Process Vyotiq | Where-Object MainWindowTitle | Select-Object Id,MainWindowTitle
```

Transient `EBUSY`/`EPERM` on `win-unpacked` is antivirus or the indexer holding
files: kill stray `Vyotiq.exe`, wait, retry, or use the `:alt` output directory.

Print: `PHASE 3 gate — PASS — typecheck/lint/test/audit/build green, packaged app launched (title=Vyotiq, logs fresh)`.

---

## 7. PHASE 4 — Land the code

### 7.1 Commit

Stage **explicit paths**. Read `git status` first and exclude anything that is
not source.

```bash
git status
git add <explicit> <paths> <only>
git commit
```

Conventional Commits, with a scope where it helps: `feat(agent):`, `fix(mcp):`,
`chore(brand):`, `docs:`, `test:`, `refactor:`, `perf:`, `ci:`. Subject in the
imperative, no trailing period, ≤ 72 characters. The body explains **why**, not
what — the diff already says what. Group related work into one coherent commit
rather than a stream of "fix typo" commits.

### 7.2 Branch and merge

- **On a feature branch** — the normal case. Push it and open a PR:

  ```bash
  git push -u origin <branch>
  gh pr create --fill --base main
  ```

  Wait for CI to go green on the PR, then merge. **Do not merge red CI.**

  ```bash
  gh pr checks --watch
  gh pr merge --squash --delete-branch
  ```

  Squash keeps `main` readable and makes the release diff match the notes. Use a
  merge commit only if the branch's individual commits are themselves meaningful
  history.

- **Already on `main`** — push directly only if the §6 gate is green:

  ```bash
  git push origin main
  ```

**Verify the push actually landed** — `git status -sb` must not say `ahead`. A
swallowed push error is the single most common cause of "the tag points at
nothing".

Print: `PHASE 4 land — PASS — <sha> on main, CI <run-url> green`.

---

## 8. PHASE 5 — Bump, tag, and trigger the release

Skip the bump if §4 established it already happened.

```bash
# 1. Bump. Edit package.json by hand if the tree is dirty — `pnpm version`
#    refuses a dirty tree, and you must not clean the tree to satisfy it.
git add package.json pnpm-lock.yaml
git commit -m "chore: bump version to X.Y.Z"

# 2. Confirm the version is what you think it is.
node -p "require('./package.json').version"

# 3. Annotated tag, then push branch and tag.
git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z"
git push origin main
git push origin vX.Y.Z

# 4. Prove both landed.
git status -sb
git ls-remote --tags origin | grep vX.Y.Z
```

Then watch the pipeline to completion:

```bash
gh run list --workflow=Release --limit 1
gh run watch <run-id> --repo vyotiqai/vyotiq-agent-v --exit-status
```

Expect roughly 20–40 minutes: `Verify → Create release → windows-x64 /
linux-x64 / macOS → Finalize release`.

Print: `PHASE 5 tag — PASS — vX.Y.Z pushed, run <url> <status>`.

---

## 9. PHASE 6 — Put the authored notes on the release

The `create-release` job writes a **stub** body. Replace it with the notes from
§5. Do this **as soon as the draft exists** — while the three package jobs are
still building. `finalize-release` only overwrites a body that is empty or still
the stub, so authored notes written before it runs are preserved untouched.

```bash
gh release edit vX.Y.Z \
  --repo vyotiqai/vyotiq-agent-v-releases \
  --notes-file release-notes/vX.Y.Z.md
```

Then read it back and confirm it is yours, not the stub:

```bash
gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases --json body --jq .body
```

If the finalize job already ran and backfilled the stub, editing the published
release afterwards is fine.

Print: `PHASE 6 notes — PASS — authored body set on vX.Y.Z (N chars, not the stub)`.

---

## 10. PHASE 7 — Verify the release like a user would

CI's finalize job checks asset presence. You check that the artifacts actually
work.

### 10.1 The release is published and complete

```bash
gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases \
  --json tagName,isDraft,body,assets \
  --jq '{tag:.tagName,draft:.isDraft,bodyLen:(.body|length),assets:[.assets[].name]}'
```

Required — the run is not done until every one is present:

- `isDraft: false`
- A body that is your authored notes
- **All three updater manifests**: `latest.yml`, `latest-linux.yml`,
  `latest-mac.yml`. A missing one **silently kills auto-update on that OS** (this
  happened on v1.1.0). Blockmaps alongside them.
- Installers: `Vyotiq-X.Y.Z-setup.exe`, `Vyotiq-X.Y.Z.AppImage`,
  `vyotiq_X.Y.Z_amd64.deb`, `vyotiq-X.Y.Z.x86_64.rpm`, `Vyotiq-X.Y.Z-arm64.dmg`,
  `Vyotiq-X.Y.Z-x64.dmg`, `Vyotiq-X.Y.Z-arm64-mac.zip`, `Vyotiq-X.Y.Z-mac.zip`
- The version inside each filename equals `X.Y.Z`.
- The pointer release `vX.Y.Z` exists on `vyotiqai/vyotiq-agent-v`, marked Latest.

### 10.2 Download, hash-check, verify the payload

Do this for at least the platform you are on.

```powershell
gh release download vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases --pattern "*-setup.exe" --dir .\dist-verify
gh release download vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases --pattern "latest.yml" --dir .\dist-verify
certutil -hashfile .\dist-verify\Vyotiq-X.Y.Z-setup.exe SHA512
```

`latest.yml` carries the SHA512 **base64-encoded**; decode it and compare. A
mismatch means a truncated download — the number-one cause of "the installer is
broken" reports. Re-download before suspecting anything else.

> **Never install over `%LOCALAPPDATA%\Programs\Vyotiq`.** That is a human's
> working install. `/S` gives them no prompt, no progress and no way to decline,
> and killing `Vyotiq.exe` to unlock it destroys whatever agent runs were in
> flight. A release agent doing this unattended is how someone opens their app
> and finds it silently on a new version they never chose.

**`/D=` into a temp folder is not a safe workaround either.** `perMachine: false`
puts the uninstall entry at a **stable per-user GUID** key
(`HKCU\…\Uninstall\1df4ea88-ee18-5f72-970a-4a73724e0a59`), derived from the app
id and not from the install path. Any second install rewrites that one key, so a
throwaway install still leaves the real installation with a dangling uninstall
entry pointing at a folder you then delete.

So the default verification **never executes the installer**. Confirm the
payload by unpacking it instead — an NSIS installer is a readable archive:

```powershell
$7z = (Get-ChildItem node_modules\.pnpm -Recurse -Filter 7z.exe | Select-Object -First 1).FullName
& $7z l .\dist-verify\Vyotiq-X.Y.Z-setup.exe | Select-String 'app-64.7z|\.exe$'
& $7z e .\dist-verify\Vyotiq-X.Y.Z-setup.exe -o.\dist-verify\unpacked -y $null
```

The SHA512 match plus the expected payload entries is the release gate. CI has
already launched the packaged app (`pnpm pack:dir:win` +
`dist-package*/win-unpacked/Vyotiq.exe`), which exercises the same binaries
without touching any installed state — prefer that for a launch smoke test.

**An actual install smoke test needs an explicit human yes**, because on a
machine with a real install it replaces that install, closes the running app,
and rewrites the shared uninstall entry. Do it on a clean VM when you can. Never
fold it into an unattended release run.

Print: `PHASE 7 verify — PASS — 8 installers + 3 manifests, SHA512 matched, payload X.Y.Z confirmed`.

---

## 11. PHASE 8 — The website

**There is no website right now.** The old vyotiq.com (`landing/`, an Astro site
deployed to GitHub Pages by `deploy-landing.yml`) was removed on 2026-09-27, and
Pages was unpublished, while a new site is built. Both removed versions are kept
under the git tags `archive/site-old` and `archive/site-new`; their page files
are in `docs/site-pages/`.

Skip this phase. If a new site exists by the time you run this prompt and this
section has not been rewritten for it, **STOP and ask** (§B) how it learns about a
release and what deploys it. Do not restore the old pipeline from the tags.

Print: `PHASE 8 site — SKIPPED — no website`.

---

## 12. PHASE 9 — Post-release checks

1. **In-app update**: launch an installation of the *previous* version and
   confirm the update panel appears, names `X.Y.Z`, and shows your notes as
   sections. This is the end-to-end proof that the manifests and the notes format
   are both right.
2. **Crash reporting**: the packaged build inlines `SENTRY_DSN` at build time
   from repo secrets. If it was unset during the run, the shipped build has no
   crash reporting — say so in your report.
3. **Signing status**: builds are unsigned unless `CSC_LINK` (Windows) or the
   `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` trio (macOS
   notarization) are configured. Unsigned builds show SmartScreen and Gatekeeper
   warnings. State the actual status — do not imply the build is signed.
4. **Docs**: if this release changed the release process itself, update
   `RELEASE-RUNBOOK.md` and `.github/AGENT-CHECKLIST.md`. If you hit a new failure
   mode, add its signature and fix to the checklist's debugging playbook — that is
   how these documents stay true.

---

## A. Failure playbook

| Symptom | Cause | Action |
|---|---|---|
| `verify` job fails on tag/version mismatch | Tag ≠ `package.json` version | Nothing is uploaded yet, so it is safe: bump `package.json` to the tag and push, **or** delete the *unpublished* tag and re-tag correctly. Never do this once assets exist. |
| A `package` job fails, others succeed | Platform-specific build break | Fix on `main`, then **re-run the failed job** (`gh run rerun <id> --failed`). The release is still a draft; do not re-tag. |
| `finalize-release` fails on a missing manifest | That OS's `latest*.yml` never uploaded | Re-run that platform's job. The release stays a draft, which is the system working as designed. |
| Release published, one manifest missing | Auto-update is dead on that OS | **Never re-tag.** Ship the next patch version. |
| App installs but shows a window titled `Error` | Main-process crash, usually a packaging trim dropping a required module | Read `%APPDATA%\Vyotiq\logs\vyotiq.log` and `crash-history.json`; the missing module names the bad filter. Fix, ship the next version, and say in the notes that the broken build cannot self-update. |
| Installer "corrupt" / cryptic failure | Truncated download | Verify SHA512 against `latest.yml` before suspecting anything else. |
| Silent install exits 0, old version still runs | A running `Vyotiq.exe` locked the files | Kill it, reinstall. |
| Terminal/PTY tests fail under full-suite load | Known `AttachConsole` flake | Re-run that file alone. Passing in isolation = not a blocker; record it. |

---

## B. STOP and ask the user — do not improvise

Stop, state what you found, and ask, if any of these are true:

1. The version you are about to release **is already published**.
2. `main` is red and the fix is not obviously yours.
3. A new website exists but §11 does not yet say how to update it.
4. The release needs a **major** bump, or a breaking change needs a migration you
   were not asked to write.
5. Tests fail in a way you cannot attribute, or the failure set has grown beyond
   the documented flake.
6. A secret is missing that changes what ships (`SENTRY_DSN`, signing
   credentials, `RELEASES_TOKEN`).
7. Anything in the working tree is ambiguous about whether it should ship.
8. The packaged app will not launch and you cannot find why.

Ask once, precisely, with the options and your recommendation. Then continue
everything that does not depend on the answer.

---

## C. Definition of done, and the final report

A release is done when every box is ticked with evidence:

- [ ] Intended work committed with Conventional Commit messages; nothing unrelated swept in
- [ ] `typecheck` · `lint` · `test` · `audit` · `build` green on the released commit
- [ ] Packaged app launched: window titled `Vyotiq`, logs fresh
- [ ] CI green on `main` at the released SHA
- [ ] `package.json` version = tag = release version
- [ ] Release **published**, not draft, in `vyotiqai/vyotiq-agent-v-releases`
- [ ] Authored structured notes on the release — not the stub
- [ ] 8 installers + `latest.yml` + `latest-linux.yml` + `latest-mac.yml` + blockmaps
- [ ] Downloaded installer SHA512 matched, installed, launched, version confirmed
- [ ] Pointer release mirrored on the source repo, marked Latest
- [ ] In-app updater offers the new version from an older installation
- [ ] Signing / crash-reporting status stated honestly

Close with this report:

```
RELEASE X.Y.Z — <shipped | blocked>

Commits        <n> commits, <sha-range>
Gate           typecheck/lint/test/audit/build <status> · packaged launch <status>
Release        https://github.com/vyotiqai/vyotiq-agent-v-releases/releases/tag/vX.Y.Z
Installers     <n> assets, 3 manifests, SHA512 verified on <platform>
Notes          <n> sections, <m> bullets, authored
Updater        <offered from A.B.C | not verified — reason>
Signing        Windows <signed|unsigned> · macOS <notarized|unsigned>
Crash report   Sentry DSN <present|absent at build time>

Not done       <anything skipped, and why>
Follow-ups     <issues discovered, not fixed here>
```

Report failures plainly, with the command output. A release reported green that
is not green is worse than a release reported blocked.

---

## Appendix A — Release notes template

```markdown
<One or two sentences framing the release: what changed in character, not a list.
This paragraph is visible on GitHub, but NOT in the update panel —
never let it carry a change that is not also a bullet below.>

## Added

- **A short bold claim.** Then the plain-language explanation: what is now
  possible, and what it replaces. Written for someone who uses the app.

## Improved

- **The thing that got better.** What was wrong before, specifically and
  measurably, and what it does now. If the symptom looked like something else,
  say so — that is the most useful sentence in a changelog.

## Removed

- **What was taken away**, named explicitly, and what to use instead.

## Fixed

- **The defect, in user terms.** The condition that triggered it, so a reader can
  tell whether it was the thing biting them.

## Known issues

- Anything shipping broken on purpose, with the workaround.
```

Rules restated: only `## Heading` and `- bullet` reach the update panel. No code
fences, tables or HTML. No commit hashes, PR numbers or file paths.

---

## Appendix B — Command reference

```bash
# Gate
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm test && pnpm audit --audit-level high
pnpm build:vite

# Targeted suites (fast loop)
pnpm exec vitest run tests/renderer/updates tests/main/unit/updaterService.test.ts

# Package locally
pnpm pack:dir:win        # unpacked, for the launch test
pnpm pack:win            # NSIS installer
pnpm pack:mac            # dmg
pnpm pack:linux          # AppImage
pnpm pack:dir:win:alt    # alternate output dir when the first is locked

# Release
git tag -a vX.Y.Z -m "Vyotiq vX.Y.Z" && git push origin main && git push origin vX.Y.Z
gh run watch <id> --repo vyotiqai/vyotiq-agent-v --exit-status
gh release edit vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases --notes-file release-notes/vX.Y.Z.md
gh release view vX.Y.Z --repo vyotiqai/vyotiq-agent-v-releases --json isDraft,body,assets
```

---

## Appendix C — Building installers without CI

Only when the pipeline is unavailable and the user has asked for local artifacts.
Locally built installers are **not** a substitute for a release: they carry no
updater manifests unless electron-builder publishes them, and they are built on
one machine's toolchain.

```bash
pnpm pack:win       # → dist-package/Vyotiq-X.Y.Z-setup.exe
pnpm pack:linux     # → dist-package/Vyotiq-X.Y.Z.AppImage
pnpm pack:mac       # → dist-package/Vyotiq-X.Y.Z-{arm64,x64}.dmg   (macOS host only)
```

Cross-building macOS from Windows or Linux is not supported — the DMG and the
notarization both require a macOS host. Never hand-upload local artifacts onto a
release that the pipeline built: the filenames collide, and the manifests will
describe files that are no longer there.

---

## Appendix D — Using this prompt on a different project

Sections §1, §2, §6, §7, §10 and §C transfer as written, as does §5 apart from
the format contract. Replace the project-specific parts by answering these, from
the repo, before starting:

1. Where is the version single-sourced, and what enforces tag/version agreement?
2. What builds the installers, and where do they land?
3. Where do release notes live, and **what consumes them** — that decides their
   format far more than taste does.
4. How does the website learn about a new release: baked at build time, fetched
   at runtime, or hardcoded? Baked means *the site must be rebuilt after every
   release.*
5. What deploys the website, and is it triggered by a push or by a workflow?
6. What does the auto-updater read, and what happens if it is missing?

Answer those six and the rest of this prompt maps over cleanly.
