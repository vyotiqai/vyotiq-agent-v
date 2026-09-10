# 13 — Commit classification (audit remediation rounds 1–2)

**Status:** ready for the parent to land. Analysis only — nothing was staged or committed by this run.
**Produced:** 2026-09-10, by instance `vyotiq/instance/2fe57ecc-6379-447c-ab6d-162807c63f24` in its sandbox worktree (remediation/ is untracked in the main tree, so it is not visible from a worktree — the ten `NN-*.md` pair docs were copied into the sandbox and read there; ALL git evidence below was pulled fresh from the MAIN checkout via terminal). Evidence fresh as of **2026-09-10 10:30:30 +05:30** — final tripwire re-check ran `git diff --stat` over all 32 classified tracked files → `32 files changed, 482 insertions(+), 84 deletions(-)`, byte-identical to the 10:24:09 status capture: zero drift between evidence pull and this deliverable.

**Main tree at evidence time:** `git branch --show-current` → `main`; `git rev-parse HEAD` → `6db528c99c2ccdc2bf861c5340d7e4bd72f1c768` ("chore(release): v1.1.4"); fresh status captured 2026-09-10 10:24:09 +05:30 (working-tree diff hunks re-pulled per file at 10:25–10:30; the last re-check — `resources/harness/default.md` and both big docs — ran 10:29–10:30, after the in-flight session added a new hunk to the harness file, see §6).

**Audit-report state (per brief, re-verified):** `AUDIT-REPORT-2026-09-10.md` is tracked and committed at `34413bd` ("docs(audit): round-2 consolidated audit report with evidence sections") — nothing to do. `audit/sections/01..06-*.md` are **untracked** in the main tree (`git ls-files -- audit/` → empty; `?? audit/` in porcelain) → included in the deliverables commit below. `remediation/` and `audit/` are fully untracked, so no in-flight session can be sharing those paths.

**Attribution method (STRICT, evidence-first):** for every tracked file this remediation touched, the current MAIN-tree `git diff -- <file>` was dumped fresh this run and each hunk compared line-for-line against the exact `old_string`/`new_string` pairs documented in `remediation/01..10-*.md` (read in full). For untracked files, the main-tree content was copied into the sandbox and compared against the full-file specs in the docs (plus the two documented parent-authored forward fixes). Conservative default applied: **any** hunk not attributable to a documented pair (or to a documented parent-authored fix) → whole file EXCLUDE.

## 1. Per-file attribution table (tracked, modified)

Verdicts: **COMMIT-READY** (every hunk attributed) / **EXCLUDE** (≥1 unattributed hunk → shared with in-flight work).

| File | Documented pairs | Hunks seen | Attributed to | Unattributed (first line) | Verdict |
|---|---|---|---|---|---|
| `src/main/agent/state.ts` | 06-4a (loadStatus warn), 04-A1 (M2 re-check) | 2 | hunk @204 → 06-4a verbatim; hunk @1390 → 04-A1 verbatim | — | COMMIT-READY |
| `src/main/agent/eventAppendQueue.ts` | 04-B1 (M3 guarded unlink) | 1 | hunk @92 → 04-B1 verbatim | — | COMMIT-READY |
| `src/main/agent/messageAppendQueue.ts` | 06-6a (M4 eviction log) | 1 | hunk @180 → 06-6a verbatim | — | COMMIT-READY |
| `src/main/agent/followUpStore.ts` | 06-1a, 06-1b, 06-1c | 2 | import hunks → 1a+1b; catch hunk @31 → 1c | — | COMMIT-READY |
| `src/main/agent/loopCheckpoint.ts` | 06-2a, 06-2b, 06-2c | 2 | imports → 2a+2b; catch hunk @19 → 2c | — | COMMIT-READY |
| `src/main/agent/runGoal.ts` | 06-3a, 06-3b, 06-3c | 3 | each hunk verbatim | — | COMMIT-READY |
| `src/main/agent/loop.ts` | 06-5a (persist catch align) | 6 | hunk @1372 → 06-5a verbatim | 5 hunks: `+import { recordUsageDeltas } from './usageLedger'` (+4 more, usage-ledger feature) | **EXCLUDE** |
| `src/main/marketplace/install.ts` | 03-2.2, 03-2.3, 03-2.4, 03-2.5, 07-1 | 4 | @13 → 2.2; @87 → 2.3; @186 → 07-1 (+2.5 comment inside it); @649 → 2.4 | — | COMMIT-READY |
| `src/main/marketplace/catalog.ts` | 03-2.6 | 1 | hunk @54 verbatim | — | COMMIT-READY |
| `src/shared/ipc/schemas/marketplace.ts` | 03-2.1 (sha256 field) | 1 | hunk @169 verbatim | — | COMMIT-READY |
| `src/main/logging/crashDiagnostics.ts` | 02-P2 (detector) | 1 | hunk @291 verbatim | — | COMMIT-READY |
| `src/main/logging/init.ts` | 02-P3 (import), 02-P4 (hook) | 2 | both verbatim | — | COMMIT-READY |
| `src/renderer/src/features/updates/UpdateCard.tsx` | 02-P1 (notesSections guard) | 1 | hunk @83 verbatim | — | COMMIT-READY |
| `src/renderer/src/lib/hooks/useNetworkStatus.ts` | 09-L1 pair 1 | 1 | hunk @38 verbatim | — | COMMIT-READY |
| `src/renderer/src/features/settings/sections/AboutSection.tsx` | 09-L3 pairs 1–3 | 3 | all verbatim | — | COMMIT-READY |
| `src/main/agent/tools/writeGuard.ts` | 09-L5 pair 1 | 1 | hunk @46 verbatim | — | COMMIT-READY |
| `src/main/app/security.ts` | 09-L9 pair 1 (comment) | 1 | hunk @101 verbatim | — | COMMIT-READY |
| `tests/main/unit/eventAppendQueue.test.ts` | 04-T1, T2, T3 | 4 | T1/T2/T3 verbatim; 4th hunk (rewrite of the 2 rotation tests) is **EOL-only** | — (see note) | COMMIT-READY |
| `tests/main/unit/deleteRunNotifications.test.ts` | 04-D1…D6 | 6 | all verbatim | — | COMMIT-READY |
| `tests/main/unit/rendererCrashHistory.test.ts` (new) | 02 full-file spec | n/a (untracked) | content = doc-02 spec + parent-authored `setCrashHistoryPathForTests` fix (documented trap: lazy `require('electron')` defeats `vi.mock`) | — | COMMIT-READY |
| `tests/main/unit/crashDiagnostics.test.ts` | 02-P6 (import), 02-P7 (describe append) | 2 | both verbatim | — | COMMIT-READY |
| `tests/renderer/updates/updateCard.test.tsx` | 02-P5 | 1 | hunk @105 verbatim | — | COMMIT-READY |
| `tests/main/unit/marketplaceRegistryIntegrity.test.ts` (new) | 03 §3 + 07 pairs 2–4 | n/a (untracked) | content = doc-03 test file + doc-07 hostile-fixture/pre-scan describes, verbatim | — | COMMIT-READY |
| `tests/main/unit/rendererNoObjectUrls.test.ts` (new) | 09-L9 full-file spec | n/a (untracked) | verbatim (doc spec's `string[] = string[]): string[]` typo corrected to `string[] = [])` in the shipped file) | — | COMMIT-READY |
| `tests/main/unit/followUpStore.test.ts` | 06-T1a–T1d | 3 | all verbatim | — | COMMIT-READY |
| `tests/main/unit/loopCheckpoint.test.ts` | 06-T2a–T2c | 3 | all verbatim | — | COMMIT-READY |
| `tests/landing/docsTruth.test.ts` | 05 (README guard 61→60) | 1 | hunk @482 verbatim (`**61** tools` → `**60** tools`) | — | COMMIT-READY |
| `tests/main/unit/delegationPromptAssembly.test.ts` | 05 (harness-spine guard, documented in memory note) | 1 | hunk @61 verbatim (`every single time` → `every time`) | — | COMMIT-READY |
| `.github/workflows/release.yml` | 08 (single pair) | 1 | hunk @55 verbatim (tag↔package.json guard step) | — | COMMIT-READY |
| `.gitignore` | 10 (append block) | 1 | hunk @110 verbatim (lines 1–112 untouched; 3 rules + comment appended) | — | COMMIT-READY |
| `README.md` | 05-M1 | 1 | hunk @7 (`**61** tools` → `**60** tools`) verbatim | — | COMMIT-READY |
| `landing/src/content/docs/start/install.md` | 05-L1…L7 | 4 | all 7 pairs land verbatim across 4 hunks (`1.0.0` → `<version>` ×7) | — | COMMIT-READY |
| `RELEASE-RUNBOOK.md` | 05-R1–R4 | 4 | hunk @1 → R1; @79 → R2; @125 → R3; @219 → R4 | hunk @60: `+6. **Edit the release body** once the workflow publishes it. …` (in-flight; renumbered 5→6, 6→7) | **EXCLUDE** |
| `PRODUCTION-READINESS.md` | 05-P1, P2, P3 | 5 | P1 @88, P2 @126, P3 @99 (+2 table rows) all verbatim | hunk @14: `+| \`onnxruntime-web\` | ~107 MB packed | No src import. Every …` (in-flight qwen3AsrOrt cleanup) | **EXCLUDE** |
| `resources/harness/default.md` | 01 pairs 1–10 | **13** | hunks 2–13 → all ten doc-01 pairs verbatim (incl. pair-5 spine text the delegationPromptAssembly guard asserts) | **hunk 1** (the `<role>` line): `+You are Agent V, an orchestrator operating in the user’s current workspace. You coordinate planning, tool use, and verification to reliably complete the user’s task, delegating tasks to instances, …` | **EXCLUDE** |

Note — `tests/main/unit/eventAppendQueue.test.ts` 4th hunk: a plain diff shows the two existing rotation tests ("keeps the JSONL record that crosses the rotation byte boundary", "keeps UTF-8 JSONL records valid across a rotation boundary") as rewritten blocks; `git diff -w` and `--ignore-cr-at-eol` both collapse the file to exactly T1+T2+T3 (zero content delta), and `git diff --check` flags every changed line only as `trailing whitespace` (CR in an LF file — the inserted lines carry CRLF; git's EOL-convert-on-add will normalize them, evidenced by the `LF will be replaced by CRLF` warnings git already emits for these paths). Content-attributed to doc-04; the commit will silently normalize EOLs — harmless, but noted.

## 2. Untracked verification (nothing in-flight can share an untracked file)

| Path | Spec source | Verified against main tree this run | Verdict |
|---|---|---|---|
| `remediation/01..10-*.md` (10 docs) | written by round-1/2 child instances | on disk, timestamps 08:52–09:32; contents = the pair docs this classification reads | COMMIT-READY (deliverables commit) |
| `remediation/13-commit-classification.md` | this file | new | COMMIT-READY (deliverables commit) |
| `remediation/test-run.log`, `remediation/test-run-round2.log` | parent test evidence | `git check-ignore -v` → `.gitignore:33:*.log` matches both; `git ls-files -- "*.log"` → empty (no tracked logs exist, so the rule hides nothing) | EXCLUDE from commit (gitignored) |
| `tests/main/unit/rendererCrashHistory.test.ts` | doc-02 full-file spec | main-tree copy compared line-by-line: verbatim doc-02 content + the parent-authored `setCrashHistoryPathForTests` fixture fix (2 extra import token + 4-line comment + `mkdirSync` + path call) — matches the documented lazy-`require('electron')` trap | COMMIT-READY (parent-authored, attributed) |
| `tests/main/unit/marketplaceRegistryIntegrity.test.ts` | doc-03 §3 + doc-07 pairs 2–4 | main-tree copy contains every doc-03 describe plus doc-07's `ustarHeader`/`ustarArchive`/hostile fixture/pre-scan describes verbatim | COMMIT-READY |
| `tests/main/unit/rendererNoObjectUrls.test.ts` | doc-09-L9 full-file spec | main-tree copy verbatim vs doc-09 (one spec typo fixed) | COMMIT-READY |
| `audit/sections/01..06-*.md` (6 files) | round-2 audit child deliverables, referenced by the committed `AUDIT-REPORT-2026-09-10.md` §Method | untracked on disk, paths match the report's method section | COMMIT-READY (deliverables commit) |
| `AGENTS.md` (dirty, tracked? NO — gitignored) | 05-A1/A2 | `check-ignore -v` → `.gitignore:111:AGENTS.md`; spot-check shows both pairs applied on disk (lines 44/47 mention `vyotiq-agent-v-releases`, `v1.1.3`) | NEVER COMMIT (gitignored); pairs already landed in the working tree |
| `repro-askquestion.mjs` (untracked, root) | — | not remediation content | EXCLUDE — doc-10 recommends deletion, left untracked |

## 3. COMMIT-READY set — exact `git add` list (commit 1: remediation code+tests+ci+config; 31 files)

Copy-pasteable (PowerShell-safe, single line):

```
git add .github/workflows/release.yml .gitignore README.md landing/src/content/docs/start/install.md src/main/agent/state.ts src/main/agent/eventAppendQueue.ts src/main/agent/messageAppendQueue.ts src/main/agent/followUpStore.ts src/main/agent/loopCheckpoint.ts src/main/agent/runGoal.ts src/main/agent/tools/writeGuard.ts src/main/app/security.ts src/main/logging/crashDiagnostics.ts src/main/logging/init.ts src/main/marketplace/catalog.ts src/main/marketplace/install.ts src/shared/ipc/schemas/marketplace.ts src/renderer/src/features/updates/UpdateCard.tsx src/renderer/src/features/settings/sections/AboutSection.tsx src/renderer/src/lib/hooks/useNetworkStatus.ts tests/main/unit/eventAppendQueue.test.ts tests/main/unit/deleteRunNotifications.test.ts tests/main/unit/rendererCrashHistory.test.ts tests/main/unit/marketplaceRegistryIntegrity.test.ts tests/main/unit/rendererNoObjectUrls.test.ts tests/main/unit/crashDiagnostics.test.ts tests/main/unit/followUpStore.test.ts tests/main/unit/loopCheckpoint.test.ts tests/renderer/updates/updateCard.test.tsx tests/landing/docsTruth.test.ts tests/main/unit/delegationPromptAssembly.test.ts
```

**Before staging, re-verify each path fresh** (drift risk on a live tree): run `git diff -- <path>` per file (or `git diff --stat --` over the whole list) and confirm the hunk sets still match §1; if a listed file grew an unattributed hunk after this deliverable, drop it to the EXCLUDE list and re-add later — do not `git add` a file whose diff no longer matches.

## 4. COMMIT-READY set — exact `git add` list (commit 2: deliverables + audit sections)

```
git add remediation/ audit/sections/
```

Safe to use the directory form: the only `*.log` files under `remediation/` are already ignored (`check-ignore` → `.gitignore:33`), so `git add remediation/` stages exactly the 11 `.md` files (01–10 + this file; any sibling `NN` docs landing later would also be staged, which is the intended behavior); `audit/sections/` stages the 6 section reports and leaves no stray files. Equivalent explicit list: `remediation/01-harness-trim.md remediation/02-crash-telemetry.md remediation/03-marketplace-integrity.md remediation/04-agent-core-fixes.md remediation/05-docs-refresh.md remediation/06-corrupt-state-logging.md remediation/07-extraction-prescan.md remediation/08-release-version-guard.md remediation/09-small-fixes.md remediation/10-gitignore.md remediation/13-commit-classification.md audit/sections/01-runtime.md audit/sections/02-agent-core.md audit/sections/03-tools-security.md audit/sections/04-ipc-app-shell.md audit/sections/05-renderer-shared.md audit/sections/06-build-ci-deps.md`.

## 5. Proposed commit messages (Conventional-Commits, matching `git log --oneline -8` style: `type(scope): lowercase subject`, e.g. `docs(audit): round-2 consolidated audit report with evidence sections`, `test(gui-e2e): …`)

**Commit 1** (code, tests, CI guard, gitignore, README + landing docs):

```
fix(audit): remediation rounds 1-2 — H3/H6/M10 security, M2/M3/M4/M6 state safety, L1/L3/L5/L8/L9/L10

- H3: marketplace registry forced to https (catalog fetch + download origin gate) and optional sha256 digest verification before extraction
- H6: renderer error-boundary crashes wired into crash-history.json (log.hooks file-pass detector) + UpdateCard notesSections guard
- M2: deleteRun re-checks isActive immediately before rmSync; M3: events-archive unlink is skip-and-log; M4: message-archive eviction logs; M6: warn logs in corrupt-state loaders (status/followups/goal/loopCheckpoint) + aligned persist catch
- M10: tar entry pre-scan rejects `..`/absolute entries before extraction
- L8: release workflow fails on tag != package.json version; L9: dev CSP blob: cross-reference + rendererNoObjectUrls guard; L10: gitignore append block
- L1/L3/L5: visibility-gated network probe, hoisted AboutSection year, win32 case-insensitive writeGuard scope
- README + landing install doc refreshed (60 tools, version-agnostic artifact names)
- Full suite green: 530 files / 5231 tests passed (remediation/test-run-round2.log, 09:40 local)
```

**Commit 2** (deliverables):

```
docs(audit): remediation pair deliverables, commit classification, and audit sections
```

**Fallback (single commit)** if two commits complicate the landing: stage both lists, use the commit-1 subject plus a final body line `- Deliverables: remediation/01..13 pair docs + audit/sections 01..06`.

## 6. EXCLUDE list (shared with in-flight sessions — do NOT `git add`)

| Path | Reason (hunks attributed / seen) |
|---|---|
| `src/main/agent/loop.ts` | 1/6 hunks attributed (06-5a persist-catch align). Unattributed hunks belong to the in-flight usage-ledger feature: `+import { recordUsageDeltas } from './usageLedger'`, `+  /** Context window in effect at the latest step — for the closeout receipt. */`, `+        costLogContextWindow = contextWindow`, `+                recordUsageDeltas(runDir, costTotals, new Date(), contextWindow)`, and the receipt-args/final-record hunk (`+          provider: costLogProvider,`). The 06-5a fix itself is verified in-tree; land it later with the usage-ledger commit. |
| `RELEASE-RUNBOOK.md` | 3/4 hunks attributed (R1 @1, R2 @79, R3+R4 = the two `gh api …-releases` hunks @125/@219). Unattributed hunk @60 is the in-flight release-notes workflow: `+6. **Edit the release body** once the workflow publishes it. electron-builder publishes assets with` (renumbers steps 5/6→6/7). Land the whole file with that in-flight session's commit. |
| `PRODUCTION-READINESS.md` | 4/5 hunks attributed (P1 @88, P3 @99 rows, P2 @126). Unattributed hunk @14 rewrites the `onnxruntime-web` exclusion row (`+| \`onnxruntime-web\` | ~107 MB packed | No src import. Every …`) — it tracks the in-flight deletion of `src/main/dictation/qwen3AsrOrt*.ts` (see the `D` entries in status) and would be stale/false once that refactor lands differently. Land the whole file with that session. |
| `resources/harness/default.md` | 12/13 hunks attributed (all ten doc-01 pairs verbatim, re-verified). **Fresh re-check 10:29–10:30 flipped the verdict:** the in-flight session added a 13th hunk rewriting the `<role>` line — `+You are Agent V, an orchestrator operating in the user’s current workspace. You coordinate planning, tool use, and verification to reliably complete the user’s task, delegating tasks to instances, selecting appropriate tools, and reporting results clearly.` (an earlier 10:26 `git diff -U0` captured only 12 hunks; the new hunk appeared between the two checks). Per the conservative default → whole file EXCLUDE; land it with the in-flight harness session, which now also carries the ten applied pairs in its working tree. |

Not excluded but also NOT to be committed: `AGENTS.md` (gitignored `.gitignore:111` — both doc-05 pairs verified applied on disk; leave the file dirty-forever), all `*.log` files (`test-full-run.log`, `mac-job.log`, `audit-test-run.log`, `remediation/test-run*.log` — gitignored `.gitignore:33`; `git ls-files -- "*.log"` → empty, so the rule hides nothing tracked), and the in-flight feature set visible in status (e.g. `usageLedger.ts`, `activityStats.ts`, `ActivityPanel.tsx`, `useHomeActivity.ts`, `useMarketplaceActivity.ts`, `localDay.ts`, `opencodeSession.test.ts`, `usageLedger.test.ts`, `activityPanel.test.tsx`, `useMarketplaceActivity.test.tsx`, deleted `qwen3AsrOrt*`/`inlineComplete*` files) — none of it is remediation scope; do not `git add` it from this remediation.

## 7. Notes

- **`remediation/test-run*.log` excluded by rule:** confirmed fresh via `git check-ignore -v` → both match `.gitignore:33:*.log`; adding them would be a no-op anyway (ignored paths are not staged by `git add remediation/`).
- **`AGENTS.md` gitignored:** confirmed fresh (`.gitignore:111`), matches doc-10's ground truth (line 111 pre-edit; the L10 append landed below it and shifted nothing above).
- **Guard-test coupling kept intact:** `tests/landing/docsTruth.test.ts` (README `**60** tools`) and `tests/main/unit/delegationPromptAssembly.test.ts` (harness spine `every time, no matter how small the request`) are both COMMIT-READY, and both assertions still hold against the current working tree (README hunk attributed; the harness file contains the pair-5 text even in its excluded, in-flight-edited state). `tests/main/unit/rendererNoObjectUrls.test.ts` guards the dev/prod CSP delta and ships with commit 1 together with the `security.ts` comment.
- **What changed since the round-2 deliverable was written (re-checked this run, not from memory):** (a) `resources/harness/default.md` gained an unattributed in-flight hunk → verdict flipped COMMIT-READY→EXCLUDE (evidence above); (b) `loop.ts` was already dirty-with-feature at round-2 delivery time (the docs re-anchored on main-tree content) → excluded from the start of this classification; (c) every other file's diff matched its documented pairs exactly as of 10:25–10:30 this run.
- **Evidence trail (this run):** `git status --porcelain` (full tree, 10:24:09), `git log --oneline -8` (style reference), per-file `git diff` dumps for all 35 tracked files above, `git diff -w`/`--ignore-cr-at-eol`/`--check` for the EOL question, `git ls-files`/`check-ignore` for the untracked/ignored analysis, tail of `remediation/test-run.log` (`529 passed | 1 skipped (530)`, 09:13) and `remediation/test-run-round2.log` (`530 passed | 1 skipped (531)`, `5231 passed | 4 skipped (5235)`, 09:40). Instance-worktree copies of the three new test files were made for this comparison and live only in the sandbox (`classification-evidence/` — not part of the main tree, do not commit).
