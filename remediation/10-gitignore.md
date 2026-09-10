# L10 remediation — append-only `.gitignore` rules for measured untracked clutter

**Status:** ready to apply — one `str_replace` pair below (parent applies it).
**Target:** `.gitignore` in the main checkout `C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V`.
**Mode:** APPEND-ONLY. No existing rule is modified, reordered, or weakened; the `*.docx` catch-all + un-ignore machinery and the Windows ` (1).` re-ignore lines are untouched.

## Ground truth: main checkout state (verified 2026-09-10, read-only)

`git status --porcelain` in the main checkout lists this untracked clutter:

```
?? asar-list.txt
?? audit/
?? remediation/
?? repro-askquestion.mjs
?? screenshots/
?? scripts/tmp-release-notes-v112.md
?? scripts/tmp-release-notes-v113.md
```

(`audit/` and `remediation/` are the audit report sections and remediation deliverables — **not** clutter; see "Decisions" below. The other `??` entries — `src/main/agent/activityStats.ts`, `src/main/agent/usageLedger.ts`, `src/renderer/src/features/home/ActivityPanel.tsx`, `useHomeActivity.ts`, `useMarketplaceActivity.ts`, `src/shared/utils/localDay.ts`, and the new `tests/**` files — are legitimate new source/tests to be committed and must NOT be ignored.)

`screenshots/` contents (verified): `ocr.ps1` (1,913 B) plus 6 PNGs (`Screenshot 2026-09-08 2017*.png`, 139–290 KB each).
Log files on disk: `test-full-run.log`, `mac-job.log`, `audit-test-run.log` (repo root) and `remediation/test-run.log` — **none appear in `git status` because they are already ignored** (see duplicate-coverage check).

The current `.gitignore` is 112 lines, clean (`git status` shows it unmodified), and the main-checkout working copy, its HEAD blob, and this run's verified copy are byte-identical:

```
git hash-object .gitignore (main checkout)  → 7ce0f2629adb0cfc599b8a7b61d06abb0c002067
git hash-object .gitignore (verified copy) → 7ce0f2629adb0cfc599b8a7b61d06abb0c002067
git ls-files -s .gitignore (main)          → 100644 7ce0f2629adb0cfc599b8a7b61d06abb0c002067 0	.gitignore
```

So the `old_string` below is verbatim against the current tree.

## Duplicate-coverage checks (why no `*.log` rule is added)

- **`*.log` already exists** — `.gitignore` line 33 (`# Logs and temp` section). `git check-ignore -v` confirms it covers every measured log file:

  ```
  .gitignore:33:*.log	test-full-run.log
  .gitignore:33:*.log	mac-job.log
  .gitignore:33:*.log	audit-test-run.log
  .gitignore:33:*.log	remediation/test-run.log
  ```

- **No tracked `.log` files**: `git ls-files -- "*.log"` returns nothing — the existing bare `*.log` hides nothing the repo wants tracked, so no root-scoped `/*.log` variant is needed either.
- **No existing rule covers the other clutter**: `git check-ignore -v -- asar-list.txt repro-askquestion.mjs scripts/tmp-release-notes-v112.md` exits 1 (nothing matched, nothing printed). `git status --porcelain --ignored -- screenshots asar-list.txt repro-askquestion.mjs scripts/tmp-release-notes-v112.md` shows all four as `??`, i.e. untracked and NOT ignored.
- `git ls-files -- "*asar*"` → empty; `git ls-files -- "scripts/tmp-*"` → empty. Tracked `*screenshot*` files exist only under `tests/gui-e2e/` (`screenshot-audit-*.{json,spec.ts}`, `tests/main/e2e/screenshotAuditFixes.test.ts`) — none inside any directory named `screenshots/`, so a `screenshots/` dir pattern hides nothing tracked.

### Known check-ignore false positive (do not be fooled during verification)

On this machine (git 2.55.0.windows.3), `git check-ignore -v -- screenshots/` — the bare directory with a trailing slash — prints a bogus match with an **empty pattern at line 104** (a blank line; hex-verified output bytes: `".gitignore:104:" 09 "screenshots/"`), while controls `src/` and `docs/` and the real file `screenshots/ocr.ps1` all correctly exit 1 with no output. The authoritative signal is `git status --porcelain` (shows `?? screenshots/` — not ignored) and file-level `check-ignore` inside the directory. Verification below therefore uses files inside `screenshots/`, never the bare `screenshots/` form.

## The fix — exact append pair

Apply one `str_replace` to `.gitignore` (old_string is unique: `AGENTS.md` appears once, at line 111; the `scripts/remove-coauthors-from-history.sh` line appears once, at line 112 — the file's final line):

**old_string** (verbatim, lines 111–112 of the current 112-line file):

```
AGENTS.md
scripts/remove-coauthors-from-history.sh
```

**new_string**:

```
AGENTS.md
scripts/remove-coauthors-from-history.sh

# L10 remediation (2026-09-10 audit): local-only clutter. Append-only block —
# nothing above is modified, reordered, or weakened.
asar-list.txt
screenshots/
scripts/tmp-*
```

Applied to the current file this makes line 113 blank, 114–115 the comment, and the three rules land at lines 116–118.

## Per-rule justification

| New rule | Untracked clutter it covers | Why a new rule is needed | Safety check |
|---|---|---|---|
| `asar-list.txt` | `?? asar-list.txt` (one-off asar content listing from release testing) | `check-ignore` exit 1 — no existing rule matches | `git ls-files -- "*asar*"` empty: no tracked file matches anywhere in the tree |
| `screenshots/` | `?? screenshots/` — `ocr.ps1` + 6 PNGs (manual debug screenshots) | `git status --ignored` still shows `?? screenshots/` — not ignored today; files inside it are not ignored (`check-ignore` exit 1) | No tracked path lives under any `screenshots/` directory (tracked `screenshot*` files are `tests/gui-e2e/…` fixtures/specs, unaffected); unanchored form also catches future test-run screenshot dirs anywhere in the tree, which is desirable |
| `scripts/tmp-*` | `?? scripts/tmp-release-notes-v112.md`, `?? scripts/tmp-release-notes-v113.md` (throwaway release-notes drafts) | `check-ignore` exit 1 — no existing rule matches | Full `scripts/` listing (26 files) shows **no legitimate file starts with `tmp-`** — only the two tmp-release-notes files match; `git ls-files -- "scripts/tmp-*"` empty. The wider `tmp-*` glob (vs `tmp-*.md`) is chosen per round-1 L1 because the `tmp-` prefix is by-convention scratch and nothing legit matches it |

**No `*.log` rule is added** — one already exists at line 33 and demonstrably covers all four measured log files (evidence above); adding another would be a duplicate.

## Decisions on the remaining untracked items

- **`repro-askquestion.mjs`** (root, one-off dev repro script): **recommend deletion** rather than a rule. A `/repro-*.mjs` glob is speculative — it could catch future legitimate repro tooling — and a file-specific rule is pointless `.gitignore` clutter for a one-off. Delete the file (or move it out of the repo); until then it stays `??` in status. No ignore rule proposed.
- **`audit/` and `remediation/`**: intentionally **not** covered by any rule. They hold the audit report sections and the remediation deliverables (this file included), which should be committed, not ignored. The only clutter inside them, `remediation/test-run.log`, is already ignored by line 33 `*.log`.
- **New source/test files** (`src/main/agent/activityStats.ts`, `usageLedger.ts`, `ActivityPanel.tsx`, `useHomeActivity.ts`, `useMarketplaceActivity.ts`, `localDay.ts`, new `tests/**`): legitimate work to be committed — no rule touches them.

## Untouched machinery (explicit statement)

The append does not touch, reorder, or weaken ANY existing rule — in particular:

- `*.docx` catch-all and un-ignores for `docs/**`, `resources/**`, `.cursor/**`, `.vyotiq/rules/**`, `tests/**` (lines 78–86);
- Windows ` (1).` duplicate re-ignore lines, deliberately placed after the docx un-ignores (lines 88–90);
- local-only editor/notes ignores (92–98), `/_audit-runtime/*` machinery (99–103), `/coverage-baseline.txt` (106), and the `/docs/**` + `!/docs/**/` + `!/docs/**/*.docx` block (107–109).

After the edit, lines 1–112 must be byte-identical to before; the diff must be pure insertions after line 112.

## Parent verification checklist (apply, then verify in the main checkout)

1. Apply the single `str_replace` pair above to `.gitignore`.
2. `git diff -- .gitignore` → additions only at the tail; zero deletions/modifications in lines 1–112.
3. `git status --porcelain` → `asar-list.txt`, `screenshots/`, `scripts/tmp-release-notes-v112.md`, `scripts/tmp-release-notes-v113.md` are gone from the untracked list. (`repro-askquestion.mjs`, `audit/`, `remediation/` remain by design; log files were never listed.)
4. Spot checks — `git check-ignore -v -- asar-list.txt scripts/tmp-release-notes-v112.md scripts/tmp-release-notes-v113.md "screenshots/ocr.ps1"` → each prints `.gitignore:116:asar-list.txt`, `.gitignore:117:screenshots/`, `.gitignore:118:scripts/tmp-*` respectively, exit 0.
5. Negative controls — `git check-ignore -v -- <any tracked .docx from `git ls-files "*.docx"`>` and `-- tests/gui-e2e/screenshot-audit-meter.spec.ts` both exit 1 (docx un-ignore machinery and tracked files untouched).
6. Do NOT use the bare trailing-slash form `git check-ignore -- screenshots/` as a verdict — on git 2.55.0.windows.3 it emits a false-positive empty-pattern match (see the note above); use `git status --porcelain` and files inside `screenshots/` instead.
