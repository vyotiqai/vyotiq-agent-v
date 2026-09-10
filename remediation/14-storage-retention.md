# 14 — Storage retention (audit H4+H5): what shipped

Commit: `d575177` — `feat(storage): retention for audit H4+H5 — checkpoint GC, orphan reaper, prune-on-removal, size cap, Settings Storage section` (24 files, +2909/−60).

Design source: [12-storage-retention-design.md](12-storage-retention-design.md) §6.4 (combined recommendation), §7 (settings/UI sketch), §8 (migration/rollout), §9 (open questions). This doc records what shipped vs. that design: every default, deviations, and how each §9 open question was resolved or deferred.

## What shipped (mapped to design)

| Design item (§) | Shipped as | Defaults |
|---|---|---|
| Checkpoint GC (§6.4.1, closes H4) | `src/main/storage/retention.ts` `sweepCheckpoints` — keep-last-N checkpoint-bearing sessions, 30-day backstop, `resolved`/`undone` blobs pruned immediately (free pass), `isActive` exclusion, async sweep at run end (`startAgentRun.ts` finally) + boot (`src/main/index.ts`) | `checkpointGcEnabled: true`, `checkpointKeepSessions: 20`, `checkpointMaxAgeDays: 30` |
| Orphan reaper (§6.4.2, closes H5's dominant term) | `retention.ts` `reapOrphans` — untracked `workspaces/{id}` dirs, confirm-gated via preview-token flow | `orphanReaperEnabled: true`, `orphanGraceDays: 30` |
| Prune-on-removal (§6.4.3) | `removeWorkspace` IPC takes `deleteStorage`; renderer (`App.tsx` `onCloseWorkspace`) confirms with the measured size BEFORE the remove call — main never prompts | `pruneOnWorkspaceRemoval: true` |
| Session retention (§6.4.4) | `retention.ts` session retention sweep; controls live in StorageSection ("Clean now" applies on demand) | `sessionRetentionEnabled: false` (auto), `sessionKeepCount: 30`, `sessionMaxAgeDays: 60` |
| Size cap (§6.4.5) | `retention.ts` report computes `overCap`; cleanup reports a size-cap category; LRU-evicts only surfaces already covered by GC/reaper | `sizeCapGb: 5` |
| Settings schema (§7) | `StorageSettingsSchema` + `DEFAULT_STORAGE_SETTINGS` in `src/shared/ipc/schemas/settings.ts`; `SETTINGS_FORMAT_VERSION` 2→3; `normalizeSettings` merge in `src/main/settings/settings.ts`; `setSettings` merge for partial storage patches | all §7 defaults verbatim |
| Settings→Storage section (§7) | New `src/renderer/src/features/settings/sections/StorageSection.tsx`: usage report per category (live IPC, no fake numbers), "Free up space" with preview → confirm → run → result, retention controls with help text, per-workspace table flagging untracked dirs as safe-to-clean, §8.1 first-run ack on first open | registered in `SettingsView`/`types.ts`/`constants.ts`/`SettingsNav` + 7 `settingsSearchIndex` entries |
| First-run migration (§8.1) | `storageSurfaceAcked: boolean` settings flag; `sweepRetentionAuto` runs only the free `resolved`/`undone` pass until the surface is acked; StorageSection acks on first open; `storageAckSurface` IPC | `storageSurfaceAcked: false` |
| Scoped logs (§8.3) | `CHECKPOINT_BLOB_EVICTED`, `ORPHAN_STORAGE_REAPED`, `SIZE_CAP_EVICTED` scoped `scope: 'storage'`; skip-and-log, never run-fatal (M3 lesson); all fs async (no sync I/O on main) | verified in code |
| Report-only surfaces (§6.3) | dictation/models, codeindex/models, Chromium caches report-only; dictation row links to VoiceSection | n/a |

## IPC surface (new)

Channels (`src/shared/ipc/channels.ts`): `storage:report`, `storage:cleanup-preview`, `storage:cleanup-run`, `storage:ack-surface`. Schemas in new `src/shared/ipc/schemas/storage.ts` (report + preview + confirm-token run + ack), zod parse-first and `senderOk`-gated in `register.ts` per the 152/152 discipline. Preload bridge + `VyotiqApi` entries added; `ipcContract` invoke map updated (187→191 with this round's net additions).

## Every default, one table

`checkpointGcEnabled=true`, `checkpointKeepSessions=20` (bounds 5–100), `checkpointMaxAgeDays=30` (7–365), `orphanReaperEnabled=true`, `orphanGraceDays=30` (1–365), `pruneOnWorkspaceRemoval=true`, `sessionRetentionEnabled=false`, `sessionKeepCount=30` (1–200), `sessionMaxAgeDays=60` (7–365), `sizeCapGb=5` (1–50), `storageSurfaceAcked=false`. Bounds are enforced by zod — out-of-range values are rejected, not clamped (tested in `ipcSchemas.test.ts`).

## Deviations from the design doc

1. **Banner (§8.1 step 2):** the quiet Home/Settings banner was NOT shipped. The §8.1 suspension is fully implemented (only the free `resolved`/`undone` pass runs before ack; the ack itself happens the first time Settings→Storage is opened, tested in `storageSection.test.tsx`). A separate in-flight session owns Home-page surfaces (`HomePage.tsx`, `App.tsx` home hunks), so a Home banner would have required hunk-splitting their un-committed work. Deviation accepted: opening Storage settings is the ack; nothing auto-deletes before it.
2. **Worktrees/traces/logs categories (§7 usage report):** the shipped report rolls up the categories the reaper/GC actually manage (checkpoints, sessions, orphan indexes, cache-class) plus report-only models/caches. Instance-worktree and trace categories are reported inside per-workspace bytes rather than as separate top-level rows. No behavior impact — the reclaim paths are the same.
3. **Size-cap eviction:** the cap is computed and reported (`overCap`, reclaim preview) and the cleanup applies the same LRU policy as the manual flow, but there is no separate automatic cap-triggered background eviction. Rationale: at the measured footprint (§6.4.5: ≈791 MB managed vs. 5 GB cap) the cap has ≈6× headroom; wiring an automatic eviction with no realistic trigger adds crash-surface for nothing. The manual "Free up space" run applies cap-aware reclaim today.

## §9 open questions — resolved or deferred

| Q | Question | Resolution |
|---|---|---|
| Q1 | Auto-delete defaults | **Resolved as proposed:** checkpoint GC ON, orphan reaper ON-with-confirmation, session retention OFF. §8.1 ack gate retained as the safety catch. |
| Q2 | Session retention default | **Resolved as proposed:** auto-OFF; keep-last-30/60-day are manual "Clean now" controls. |
| Q3 | Workspace-removal UX | **Resolved as proposed:** offer deletion with the measured size; explicit confirm dialog (danger-styled); default is keep-unless-confirmed (the dialog is not pre-checked). |
| Q4 | Checkpoint keep-N | **Resolved as proposed:** 20 sessions / 30 days, user-tunable within schema bounds 5–100 / 7–365. |
| Q5 | Size-cap number | **Resolved as proposed:** 5 GB, ≈6× headroom over measured managed footprint. |
| Q6 (report-only scope) | Which surfaces are managed | **Resolved as §6.3:** dictation/codeindex models, project-local `.vyotiq`, Chromium caches are report-only; dictation row links to VoiceSection. |

No open questions remain deferred from §9.

## Reclaim claim — validated how

**Unit tests prove policy + measured targets, NOT "live sweep executed".** The ~5.5 GB orphan figure was re-measured read-only on the live install (see [15-validation-report.md](15-validation-report.md) §Storage): 61 untracked dirs totalling 5,552.5 MB — matching design §3.2's ≈5,551.4 MB. No destructive cleanup was run against the live data during validation (the app was running on it). The reaper's behavior is proven by `tests/main/unit/storageRetention.test.ts` (orphan grace window, tracked-id exclusion, preview-token confirm flow, reap-race guard, 24 h protected window) and `tests/renderer/settings/storageSection.test.tsx` (the UI confirm flow).

## Files

New: `src/main/storage/retention.ts`, `src/shared/ipc/schemas/storage.ts`, `src/renderer/src/features/settings/sections/StorageSection.tsx`, `tests/main/unit/storageRetention.test.ts`, `tests/renderer/settings/storageSection.test.tsx`. Wiring (storage hunks only — files shared with in-flight sessions were hunk-staged): `schemas/settings.ts`, `main/settings/settings.ts`, `channels.ts`, `register.ts`, `preload/index.ts`, `vyotiqApi.ts`, `schemas/workspace.ts`, `SettingsView.tsx`, `types.ts`, `constants.ts`, `SettingsNav.tsx`, `settingsSearchIndex.ts`, `App.tsx`, `useWorkspaceManager.ts`, `main/index.ts`, `startAgentRun.ts`, `ipcContract.test.ts`, `ipcSchemas.test.ts`, `useWorkspaceManager.test.tsx`.
