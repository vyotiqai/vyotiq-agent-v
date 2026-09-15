# Freeze diagnosis — 2026-09-14 "app completely Not Responding"

Line-cited findings from code reads, `vyotiq.log` (5 MB), and live `Win32_Process` queries. No reproduction load was run (it would re-freeze the app). Verified evidence only; unknowns listed at the end.

## Causal chain

1. **Trigger — machine CPU starvation, not an app bug.** A 17-worker vitest run (started through the app's own terminal tool) plus typecheck/lint plus two live agent loops saturated the machine; the window's UI thread starved and Windows marked it "Not Responding". Zero `render-process-gone` / `Reloading renderer after crash` lines exist in the log — the renderer never crashed. After the load ended, every Electron process returned to `Responding: True` with idle CPU.

2. **Relaunch was a silent no-op (the unrecoverability mechanism).** `src/main/index.ts:131-134`: a relaunch process quits at `requestSingleInstanceLock` **before** `initMainLogging()` runs, so nothing is logged on either side. `index.ts:135-142`: the `second-instance` handler only does `restore()` + `focus()` on the existing window — no health check, no window recreation, no restart. Evidence: main electron PID 8216 started 08:50:57 and survived every restart attempt; last `Logging initialized` line is 08:51:13; the log has zero second-instance lines.

3. **Auto-resume re-injected heavy load at every launch.** Renderer bootstrap loads the active run transcript at mount and auto-resumes interrupted runs: `src/renderer/src/lib/hooks/useWorkspaceManager.ts:1568-1622` (mount effect → `loadRunTranscript` → `allowAutoResume: true` → serialized queue → `ctrl.resumeInterrupted()`), `src/renderer/src/lib/hooks/createChatStreamController.ts:3055-3132` (`resumeInterrupted` → `chatStart`). Log: `Chat start { resume: true }` → `Agent run started` at 09:00:29 (run `cad8c973`, **step 194**, ~2.2M billed input tokens/step), 09:02:31, and 09:05:38 — each re-launching provider work whose calls then failed and retried (09:03:01, 09:05:06) on a saturated machine. Main-side goal/loop resume also fires immediately at window load: `src/main/index.ts:246-248` and `265-267` (`did-finish-load` → `resumeActiveGoalsAndLoops`).

4. **The suspected "new renderers" were Chromium utility processes.** Live query of PIDs 15584/2452: `--utility-sub-type=audio.mojom.AudioService` and `node.mojom.NodeService` (a `utilityProcess.fork` host). No new window was ever created and no renderer ever reloaded.

5. **Amplifiers under load (bounded today only in parts of the chain).**
   - `loadRun` returns the **entire** `messages.jsonl` in one uncapped IPC reply (`src/main/ipc/register.ts:1947-1973`), applied in one synchronous renderer patch (`applyTranscriptUi`), contrasted with the capped events channel (`LOAD_EVENTS_UI_LIMIT`).
   - Sync whole-file `loadMessages` (`src/main/agent/state.ts:499-506`) runs on the **main thread** and is wired into the running loop, run receipts, and child-instance summaries (`loop.ts:1202`, `runReceipt.ts:537`, `agentInstances.ts:227`).
   - The loop's `liveEvents` queue is unbounded (`src/main/agent/loop.ts:3207`, `:3254-3266`) — a wedged tool step can balloon it, unlike the main→renderer stream which is capped (`src/main/ipc/streamBatch.ts:1-19`, 512 segments / 8 MB drop-oldest).
   - Renderer PTY replay buffers (`src/shared/utils/ptyOutputBuffer.ts` + `features/chat/components/ptyOutputBuffers.ts`) accumulate with **no cap**, while main keeps only 200k chars (`src/main/app/ptySessions.ts:37`).

Already hardened (verified, no action needed): streamBatch delta caps + UI-subscription gating; PTY 16 ms output batching + 200k scrollback; terminal tool 64 KB capture caps (`terminal.ts:52`, `terminalSessions.ts:439-455`); serialized auto-resume queue with 750 ms gaps; `autoResumeInterruptedRuns` settings gate; renderer crash auto-reload (unused here — no crash occurred).

## Ranked robustness gaps -> fixes

1. **IMPLEMENTED — Second-instance recovery.** New pure helper `src/main/app/secondInstance.ts` (`planSecondInstanceAction`, 30s threshold) + per-webContents unresponsiveness tracking in `src/main/logging/init.ts` (`rendererUnresponsiveForMs`); `src/main/index.ts` second-instance handler now logs its action and, when the window has been unresponsive >= 30s, creates a fresh window (mirroring the `activate` path, new window BEFORE destroying the wedged one) and destroys the old one; `src/main/app/window.ts` `closed` handler only nulls `mainWindow` when the destroyed window is still the tracked instance. Tests: `tests/main/unit/secondInstance.test.ts` (5).
2. **IMPLEMENTED — Resume deferral.** Boot-time `resumeActiveGoalsAndLoops` deferred 2000ms after `did-finish-load` (`src/main/index.ts`, both call sites; safe — `resumedOnce` guard verified in `src/main/agent/resumeActiveGoals.ts:17-20`); renderer first auto-resume drain now scheduled via `requestIdleCallback` (2s timeout fallback `setTimeout` 1000ms) in `src/renderer/src/lib/hooks/useWorkspaceManager.ts` (`scheduleAutoResumeDrain`, deduped; existing 750ms serialization kept).
3. **NOT IMPLEMENTED — Uncapped `loadRun` hydration** -> design decision needed (tail-limiting changes what the user sees on restore). Follow-up.
4. **NOT IMPLEMENTED — Sync `loadMessages` on main-thread hot paths** -> larger refactor across user-modified files. Follow-up.
5. **IMPLEMENTED — Bounded live-event queue.** New `src/main/agent/liveEventQueue.ts` (drop-oldest-delta, 1024 segments / 4MB, fail-open like `streamBatch.ts`); `loop.ts` `emitLiveEvent` routes through `pushLiveEvent` with an overflow warn log. Tests: `tests/main/unit/liveEventQueue.test.ts` (6).
6. **IMPLEMENTED — Capped renderer PTY replay buffers.** `src/shared/utils/ptyOutputBuffer.ts` now trims to 200k chars per session (tail kept, matching `ptySessions.ts` scrollback). Tests: `tests/shared/ptyOutputBuffer.test.ts` (5).

Verification (2026-09-14 09:49-09:50): 16/16 tests across the three new test files (1.13s); `pnpm typecheck` exit 0; eslint clean on all 11 touched files; app processes all `Responding: True` during and after; no vitest/tinypool processes left behind. Full suite deliberately NOT run (would re-freeze the running app).

## Unknowns (not determinable from evidence)

- What UI action produced the 09:02:31 / 09:05:37 re-resumes (silent renderer re-bootstraps leave no log line).
- Which utility `utilityProcess` PID 2452 was hosting.
- Whether a sync `loadMessages` actually executed inside the freeze window.
