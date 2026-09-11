# 16 — Round-5 remediation & validation report

**Date:** 2026-09-10 22:20 → 2026-09-11 06:42 local · **Tree:** HEAD `802cbfd` + shared in-flight worktree (another session actively landing work; 88 → 112 changed entries during the round)
**Inputs:** `audit/sections/08-round-5-audit-report.md` (Step 1 findings), three read-only workstreams (in-flight diff audit, remediation re-verification, runtime delta), one static #185 root-cause hunt, and an independent peer review of every remediation hunk.
**Rule applied:** fix forward only; every claim below was re-verified against the working tree and the gate outputs of this session.

---

## 1. Remediation executed (Step 2)

| # | Finding (audit 08) | Sev | Change | Test evidence | Result |
|---|---|---|---|---|---|
| R1 | React #185 renderer crash class (2 live crashes) | High | **Root cause of crash #1 already fixed** by the concurrent session at 21:38 (`useOfflineSendQueue.ts:126-137`, comment documents the self-dep cascade); this round added the missing production diagnostic: React 19 root `onUncaughtError` → `reportUncaughtRendererError` carrying `errorInfo.componentStack` (`src/renderer/src/main.tsx:27-31`; `src/renderer/src/logging/handlers.ts`) | `tests/renderer/logging/handlers.test.ts` — "reports React root uncaught errors with the production component stack" | pass |
| R2 | One-shot "Review changes" request replayed on every ChatView remount | Medium | `ChatView` now acks consumption (`onOpenChangesRequestHandled`, effect at `ChatView.tsx:818-836`, clears the handled mark when the owner resets to 0); `App.tsx:255` supplies stable `consumeOpenChangesRequest` (wired `:2301`) | `tests/renderer/chat/chatView.placement.test.tsx` — consume-once, same-value no-refire, reset-then-request again, remount-no-replay | pass |
| R3 | Removed Qwen3 dictation engines silently fell back to the cloud (`openai`) engine | Medium | `SETTINGS_FORMAT_VERSION` 3→4; `migrateRemovedDictationEngine` maps `qwen3-asr`/`qwen3-asr-onnx` → `local`, clears legacy model ids, deletes nested `qwen3AsrServerUrl`/`qwen3AsrApiKey` (the real schema location), logs `SETTINGS_DICTATION_MIGRATE`; schema-mismatch fallback keeps working | `tests/main/unit/settingsDictationMigration.test.ts` (6 cases incl. nested-secret removal and deliberate-preference survival); `tests/shared/ipcSchemas.test.ts` pins `SETTINGS_FORMAT_VERSION === 4` | pass |
| R4 | Crashpad minidumps accumulated unbounded (82.9 MB from 2 crashes) | Medium | `pruneCrashpadReports(dir, keep = 5)` deletes oldest `.dmp` beyond the newest 5, best-effort; called at reporter start (`crashReporter.ts`) | `tests/main/unit/crashDiagnostics.test.ts` — keeps newest 5, preserves non-dump files, missing-dir no-op | pass |
| R5 | Harness memory guidance lost `notes/<name>.md` placeholder | Low | `resources/harness/default.md:99` restored | `tests/main/unit/toolsSchema.test.ts` 42/42 (token ceiling still passes) | pass |

### Peer-review corrections applied before certification

The independent reviewer (read-only, full diff) found one **High regression introduced by this round**, which was fixed:

1. **Version bump re-armed v1-era default rewrites (High).** `SETTINGS_FORMAT_VERSION` 3→4 made the un-gated `thinkingEffort === 'medium' → 'low'` and `autoCompactThresholdRatio === 0.2 → 0.55` rewrites run for every v3 user, silently discarding deliberate post-v3 choices (reviewer reproduced it: v3 file with `'medium'`/`0.2` loaded as low/0.55). Fixed by gating each rewrite at `rawVersion < 3` (the version that actually seeded them); regression test added ("does not re-run the older v1-era default rewrites on a v3 file") — passes.
2. **Dedupe ref collided with the owner's reset-to-0 (Medium).** A request issued while ChatView stayed mounted after a consume would be dropped (0→1 reused). Fixed by clearing the handled mark when the prop is `<= 0`; the ChatView test now exercises consume → reset → second request.
3. **Test hardening (Low×3):** no-rewrite test now uses a sentinel key a persist would drop; `ipcSchemas` pins the literal version 4 in addition to the constant; the qwen3 secret test uses the real nested shape.

Remediation-scope decisions (deliberately **not** changed, documented in audit 08): half-wired `homeActivity`/`useMarketplaceActivity` (another session's in-flight surface), `activityStats` sync I/O (unreachable until wired), peak input/context pairing, `useRunGoal`/`useRunTodos` 500 ms identity churn, events-cap success logging, `adm-zip` (unpatchable upstream), code signing (certs, not code).

---

## 2. Validation (Step 3)

**Final certification run on the post-review tree (all executed this session):**

| Gate | Command | Result | Notes |
|---|---|---|---|
| Typecheck | `pnpm typecheck` | **PASS (exit 0)** | both tsconfigs |
| Lint | `pnpm lint` | **PASS (exit 0)** | full `eslint .` |
| Targeted suites | `vitest run` (8 files) | **PASS — 156/156** | settings migration ×3, ipcSchemas, chatView.placement, crashDiagnostics, handlers, toolsSchema |
| Full test suite | `pnpm test` | **PASS (exit 0)** | **534 files passed / 1 skipped; 5278 tests passed / 5 skipped** (5283); 563 s |
| Dependency audit | `pnpm audit --audit-level high` | **PASS (exit 0)** | 4 moderate, 0 high (`adm-zip` unpatchable; `colord`; dev `vitest`) |
| Production build | `pnpm build:vite` | **PASS (exit 0)** | harness valid, 0 docx updates, 1130 icons synced, main 2.15 MB / preload 269 kB / 7911 renderer modules; only pre-existing chunking + circular-reexport warnings (no new warning from this round) |

**Evidence integrity — transient failures were not misreported:** the first full-suite run (22:26) showed 6 failures in `providerHttpErrors`/`thinkingProviders`; those files were rewritten by the concurrent session at 22:27–22:30 *during* the run (mtimes vs run start 22:26:36). Isolated re-run: 69/69 pass. A second run (23:32) was fully green except one literal pinned by my version bump, which was then fixed forward (and the assertion made constant-based). The third and final run above is green.

**Behavior-vs-original comparison:** the two runtime crash classes were re-measured; crash #1's root cause is closed in code, `crash-history.json` now records boundary crashes (live-proven with the 2 #185 snippets), and no new renderer crash, EPERM, ENOENT, or PERSIST class appeared in the log window after 20:15 beyond `REACT_185`.

---

## 3. Monitoring (durable)

- **#185 follow-up is now self-diagnosing:** the next occurrence is recorded in `%APPDATA%\vyotiq\crash-history.json` and `logs\vyotiq.log` as `code: 'REACT_185'` **with a `componentStack` field** (previously absent in production). Watch for `React maximum update depth (#185)` and use the stack to close the remaining unexplained crash #2. Crashpad keeps the newest 5 dumps (~≤215 MB) at boot.
- **Dictation migration is observable:** affected users log `[settings] Migrated removed dictation engine to local { code: 'SETTINGS_DICTATION_MIGRATE', engine }` on first load after this build; settings file lands at `settingsVersion: 4`.
- **Storage retention unchanged and active:** boot/run-end sweeps (`CHECKPOINT_BLOB_EVICTED`, `SIZE_CAP_EVICTED`); orphan reaper correctly holds all 69 current orphans inside the 30-day grace. Durable follow-up from round 4 still open: re-measure `workspaces\` after the first real user-driven "Free up space".
- **Watch list (open L findings):** half-wired home activity surface; `activityStats` sync I/O; goal/todo 500 ms churn; events-cap success log; `adm-zip` advisory; release signing (round-1 H1, certs).

## 4. Residual unknowns (not claimed as verified)

1. **Crash #2 root cause** — not reproduced; could be the pre-21:38 bundle (app boot 21:47 vs `out/` rebuild 22:14) or a distinct loop. Instrumented for the next event.
2. Whether the half-wired activity surface is intentionally mid-landing in the shared worktree.
3. Destructive retention paths on real >30-day/>60-day data; `adm-zip` packaged-runtime reachability; signed installers.

## 5. Full app build (packaged)

`pnpm pack:win` → **PASS (exit 0)** on the validated tree (typecheck + `build:vite` + `electron-builder --win nsis --publish never`):

- `dist-package\Vyotiq-1.1.4-setup.exe` — **172.29 MB**, built 2026-09-11 06:50, `Get-AuthenticodeSignature` = **NotSigned** (expected; round-1 H1 code-signing gap, certs not code)
- `dist-package\Vyotiq-1.1.4-setup.exe.blockmap` + `dist-package\latest.yml` (updater metadata, generated locally by the `--publish never` run — nothing was published)
- `dist-package\win-unpacked\Vyotiq.exe` — 215.16 MB, ProductVersion 1.1.4.0 (unpacked smoke layout)
- electron-builder log notes only the known packaging characteristics: skipped dependency rebuild (`npmRebuild: false`), non-bundled other-platform optional binaries, and no-op `signtool` attempts without a certificate.

## 6. Files changed this round

`src/renderer/src/features/chat/ChatView.tsx`, `src/renderer/src/app/App.tsx`, `src/main/settings/settings.ts`, `src/shared/ipc/schemas/settings.ts`, `src/main/logging/crashDiagnostics.ts`, `src/main/logging/crashReporter.ts`, `src/renderer/src/logging/handlers.ts`, `src/renderer/src/main.tsx`, `resources/harness/default.md`, `tests/main/unit/settingsDictationMigration.test.ts` (new), `tests/main/unit/crashDiagnostics.test.ts`, `tests/renderer/logging/handlers.test.ts`, `tests/renderer/chat/chatView.placement.test.tsx`, `tests/shared/ipcSchemas.test.ts`, plus this report and `audit/sections/08-round-5-audit-report.md`. No commits made; all changes are working-tree only, alongside the other session's in-flight hunks.
