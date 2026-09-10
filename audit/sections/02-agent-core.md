# Section 02 — Agent core reliability deep-dive (`src/main/agent`)

Audit round 2, 2026-09-10. Read-only review of the current working tree (branch `vyotiq/instance/acd2072d…`, clean status). Every claim below cites `path:line` verified by a fresh read this run; anything not verified is listed under **Unknowns**.

> **Constraint note:** the round-1 report `AUDIT-REPORT-2026-09-10.md` is **not present in this worktree** (untracked in the parent workspace and never delivered here — consistent with the known child-delivery limitation). The round-1 M1 sync-I/O site list was taken verbatim from this run's contract and re-verified fresh; round-1 framing and its "Unknowns" section could not be cross-checked.

## Executive summary

- **No Critical findings.** The core loop's terminal paths, cancel/quit quiesce bounds, append-queue ordering, and retry caps are substantially sound and better-documented than typical.
- **1 High:** write-checkpoint blobs and `checkpoints/index.json` are never garbage-collected — unbounded per-workspace disk growth, amplified by directory-delete snapshots of up to 20,000 files each.
- **8 Medium**, the most consequential being: a TOCTOU in `deleteRun` (active-run check separated from `rmSync` by awaits), an unguarded `unlink` in the events rotation path that can kill a run's event persistence on Windows file locks, and a class of **per-step synchronous main-thread I/O** that round 1's M1 list missed entirely (`readGoal`, `readTodos`, skills/plugin-rules scans every step; full-transcript sync reads + `writeFileSync` trajectory every 5 steps).
- Round-1 M1 re-verification: **7 of 8 sites confirmed** (one with a 3-line drift), **1 refuted** — `activityStats.ts` does not exist in the current tree.
- Concurrency bound verified: `MAX_ACTIVE_RUNS = 8` with an atomic check-and-set gate; quit quiesce bounded at 15 s; zombie-cancel force-finish fires at **30 s** (not 15 s — that figure was the quit quiesce).

---

## Findings

### H-1 — Write checkpoints accumulate on disk forever (no blob GC, index never pruned)

**Evidence**
- `src/main/agent/checkpoints.ts:250` — directory-delete snapshots copy up to `maxDirRestoreFiles = 20000` files per deleted directory, each into the checkpoint blob tree (`checkpoints.ts:249-275`).
- `src/main/agent/checkpoints.ts:373-377` (`finalize`) and `checkpoints.ts:331-352` (`persistIncremental`) append an entry to `checkpoints/index.json` on every invoke that touched files; `loadIndex`/`saveIndex` (`checkpoints.ts:100-121`) only ever append.
- `resolveWritesInCheckpoint` (`checkpoints.ts:616-674`) and `markCheckpointFullyResolved` (`checkpoints.ts:595-601`) mark `resolved`/`undone` in meta but never delete blobs or index entries. `rewindWritesFrom` (`checkpoints.ts:790-821`) likewise only stamps meta.
- No code path in `src/main/agent` prunes checkpoint blobs; `deleteRun` (`src/main/agent/state.ts:1348-1396`) is the only reaper and only when the whole run is deleted.

**Impact** Long-lived workspaces accumulate a full prior-content copy of every file the agent edits, every turn, plus whole-tree copies of every directory it deletes. A run that deletes `node_modules`-scale directories snapshots up to 20k files per delete. Index grows monotonically and is re-read/rewritten synchronously on every Keep/Discard/rewind (`checkpoints.ts:100-121`, all sync).

**Remediation** Add a retention policy: delete blob dirs of checkpoints that are `resolved && undone` (or older than N days / M checkpoints), and cap `index.json` length; run the prune asynchronously after run end.

### M-2 — `deleteRun` TOCTOU: active-run check is separated from `rmSync` by awaits

**Evidence**
- `src/main/agent/state.ts:1350` — `if (isActive(runId)) return { ok: false, ... }`.
- `state.ts:1358-1375` — several `await`s follow (child-run collection, worktree finalize, `drainRunWritersBeforeDelete`), then `rmSync(dir, { recursive: true, force: true })` at `state.ts:1387`.
- `tryRegisterRunAbort` (`src/main/agent/runRegistry.ts:150-172`) can admit a `chatStart` for the same runId during any of those awaits (IPC is interleaved on the main-thread event loop), after which `runAgent` writes into a directory that is then deleted mid-flight.

**Impact** A live run's `runDir` can be `rmSync`'d underneath it: appends then fail (ENOENT is recorded as `PERSIST` append failures, `messageAppendQueue.ts:50-66`), the status queue can re-create a phantom dir containing only `status.json` (the exact scenario `clearStatusWritesForDir` documents at `statusWriteQueue.ts:238-252`), and the receipt/finally block errors.

**Remediation** Re-check `isActive(runId)` immediately before `rmSync`, or (better) register a tombstone in the run registry so `tryRegisterRunAbort` rejects the runId until the delete completes.

### M-3 — Events rotation: unguarded `unlink` can kill the run's event persistence

**Evidence**
- `src/main/agent/eventAppendQueue.ts:90-97` — `enforceArchiveCap` does `await unlink(join(dir, oldest))` with **no try/catch**. It runs inside `archiveDiscardedHead` (`eventAppendQueue.ts:99-113`), which is inside `rotateEventsFileIfNeeded`, which is inside `withTransientAppendRetry` (`eventAppendQueue.ts:166-172`).
- Contrast: the messages queue guards the identical operation — `messageAppendQueue.ts:172-180` wraps the unlink in try/catch ("best effort — an undeletable archive must not block the append chain").

**Impact** One persistently undeletable oldest archive (EBUSY/EPERM — common on Windows with AV scanners) fails the whole rotation after the 3 transient retries, so **every subsequent event append fails**, the failure surfaces via `takeEventAppendFailureNotice`, and the loop terminates the run with a `PERSIST` error (`loop.ts:612-634`, `loop.ts:1768-1786`). A best-effort cap must not have fatal semantics.

**Remediation** Mirror the messages queue: skip-and-log an undeletable archive instead of failing the append chain.

### M-4 — Oldest transcript history is silently and permanently lost past 5 archives

**Evidence**
- `src/main/agent/messageAppendQueue.ts:16-19` — rotation at 8 MB keeping 4 MB; `MAX_MESSAGE_ARCHIVES = 5` enforced by `enforceMessageArchiveCap` (`messageAppendQueue.ts:171-183`).
- Stitched readers concatenate only the surviving archives (`state.ts:356-370` sync, `state.ts:745-764` async), so the readable transcript is capped at ~5×4 MB of archived heads + 8 MB live; everything older is deleted with no warning and no log.
- Same shape for events (`eventAppendQueue.ts:13-17`), where step-usage loss is compensated by the monotonic `loopCheckpoint.json` totals (`loop.ts:1064-1080`) — but there is no equivalent compensation for transcript turns.

**Impact** On very long runs, resume/hydrate, rewind-to-start (`planRewindWrites`/`rewindWritesFrom` index against full-transcript indices, `checkpoints.ts:727-760`), markdown export (`state.ts:899-937`), and receipts silently operate on a truncated history. `appendOrphanToolStubs` (`state.ts:955-996`) can also miss an assistant tool_use that has rotated out, leaving an unpairable tool stub path. Partially by design (rotation exists on purpose), but the loss is invisible.

**Remediation** Log (once per run) when archive cap eviction drops stitched content; consider refusing rewind below the retained window rather than rewinding a partial view.

### M-5 — Per-step synchronous main-thread I/O that round 1's M1 list missed

**Evidence** (all confirmed by read; see also the M1 table below)
- **Every step:** `readGoal` sync read (`runGoal.ts:24-27`, `readFileSync`) via `loop.ts:1928`; `readTodos` sync read (`tools/todo.ts:36-38`) via the `taskList` section built at `loop.ts:1923`; skills + plugin-rules rescan via `refreshSkillPromptSections()` at `loop.ts:1842` → `readdirSync`/`lstatSync`/`readFileSync` scans (`skills/index.ts:205, 216, 131, 288, 301, 364`).
- **Every 5 steps (`RECEIPT_PERSIST_EVERY_STEPS`, `loop.ts:968`):** `persistInterimReceipt` (`loop.ts:974-1000`) does a full events stitch (`loadEventsAsync` no-limit, `state.ts:745-764`), a `loadMessages`-callback receipt build — and `loadMessages` (`state.ts:436-443` → `stitchedMessagesContentSync` `state.ts:356-370`) is a **synchronous full-transcript read** — plus `writeTrajectoryArtifactsBestEffort` whose writer is `mkdirSync` + `writeFileSync` (`runTrajectory.ts:212-214`).
- **Run start and run finally:** the same receipt path runs again with fresh sync transcript reads (`loop.ts:1355-1364`, `loop.ts:3878-3893`); the finally also re-stitches all events (`loop.ts:3852`).
- **Harness per invoke:** `loadHarness` sync-reads the bundled spine and workspace appendix (`harness.ts:85`, `harness.ts:112`, called at `loop.ts:1280`); the workspace appendix is capped at 24k chars (`harness.ts:41`).

**Impact** The Electron main thread performs multiple blocking disk reads every step and a multi-MB sync read + sync write every 5 steps and at run end. On an 8 MB-transcript run this is a visible UI stall class, exactly the M1 problem round 1 flagged — but on the loop's hot path rather than IPC handlers.

**Remediation** Cache `goal.json`/todos in memory with mtime invalidation; move skills/plugin-rule scanning to an async, fingerprint-guarded background refresh; make the interim receipt/trajectory path fully async (the async loaders already exist in `state.ts`).

### M-6 — Checkpoint hashing is synchronous on the main thread (M1 site, hot paths)

**Evidence**
- `src/main/agent/checkpoints.ts:88` — `createHash('sha256').update(readFileSync(path)).digest('hex')` inside `hashExistingFile` (`checkpoints.ts:83-90`).
- Called from `stampPostWriteHashes` (`checkpoints.ts:361-375`) during `finalize()` — i.e. in the loop's `finally` via `finalizeWriteCheckpoint` (`loop.ts:3844-3856`) and at every mid-run `flushWriteCheckpoint` (`loop.ts:962-977`) — and twice per file from `restoreOneFile` during Keep/Discard/rewind IPC (`checkpoints.ts:515-546`).

**Impact** SHA-256 of whole files (any size — the agent can edit multi-hundred-MB files or vendored binaries) runs on the main thread, once per touched file at turn end and up to twice per file on restore.

**Remediation** Hash async (the record path already copies blobs async); or hash at record time and reuse.

### M-7 — `wait_forever` offline mode can hold all 8 run slots indefinitely

**Evidence**
- `src/main/agent/networkMonitor.ts:16-27` — `resolveOfflineWaitMs` returns `Number.POSITIVE_INFINITY` for `wait_forever` + `autonomousMode`.
- `networkMonitor.ts:100-125` — `iterateNetworkWait` then polls every 2 s without any bound (only the abort signal ends it); the loop sits inside `yieldStreamRetryWait` (`loop.ts:311-343`) between stream attempts, holding its `active` slot.
- `runRegistry.ts:57, 160-166` — `MAX_ACTIVE_RUNS = 8`; once 8 runs are in the offline wait, every new `chatStart` is rejected with `RUN_LIMIT_REACHED`.

**Impact** A network outage during autonomous operation converts up to 8 runs into indefinite slot holders; the user cannot start anything new (resumes bypass the gate, `runRegistry.ts:44-56` note + `registerRunAbort` reuse path `runRegistry.ts:130-141`). By design for autonomy, but it is also a slot-exhaustion hazard.

**Remediation** At minimum, surface slot exhaustion to the UI with the cause ("N runs waiting for network"); consider admitting one interactive run above the cap or shrinking the wait budget as the slot count fills.

### M-8 — Silent catch-and-default loaders can mask state corruption

**Evidence**
- `followUpStore.ts:30-36` — `loadFollowUps` returns `[]` on JSON.parse/schema failure, **no log**; queued user tasks vanish on resume if the file corrupts.
- `loopCheckpoint.ts:13-20` — `loadLoopCheckpoint` returns `null` on any parse failure, silently resetting loop-safety streaks and usage totals on resume.
- `state.ts:201-209` — `loadStatus` returns `null` on corrupt `status.json` with no log (orphan sweep then treats the run as non-running).
- `runGoal.ts:24-29` — `readGoal` → `null` silently.
- Contrast: `persistUsageTotalsCheckpoint`'s empty `catch {}` (`loop.ts:1374-1377`) vs. `persistLoopCheckpoint` which logs the identical failure (`loop.ts:1402-1409`).

**Impact** A truncated/corrupted queue or checkpoint file degrades silently to defaults; the user sees tasks disappear or a run re-burn steps/repetitions the checkpoint existed to prevent, with nothing in the logs to diagnose.

**Remediation** Log at warn level in each default-return catch (these are cold paths — the log is free), and align the two checkpoint-persist catch blocks.

### L-9 — `runLoopScheduler` meta/timer entries leak for deleted armed-loop runs

**Evidence** `deleteRun` (`state.ts:1348-1396`) never calls `disarmLoop`. After deletion, the next tick's `readLoop` returns null and `onTick` runs `clearTimer(runId)` (`runLoopScheduler.ts:73-81`) — which deletes the timer but **not** the `meta` entry (`runLoopScheduler.ts:29-31`), so `meta` retains `{workspacePath, runDir}` per deleted armed-loop run for the process lifetime.

**Impact** Small constant leak; also one wasted timer tick per deleted run. **Remediation** delete `meta` in the null-loop branch, or call `disarmLoop` from `deleteRun`.

### L-10 — `stream_snapshot` events grow quadratically within a single generation

**Evidence** `loop.ts:2375-2390` — every `STREAM_SNAPSHOT_INTERVAL_MS = 1500` (`loop.ts:735`) the loop appends the **full** accumulated `assistantText` to `events.jsonl`. An N-token answer streaming for T seconds writes ~O(N·T/1.5 s) bytes.

**Impact** Bounded by rotation (`eventAppendQueue.ts:13-17`), but long generations churn the events file, trigger repeated 2 MB rotations, and evict forensic history (step_usage, writes_checkpoint) faster. The comment at `loop.ts:2379-2383` shows the thinking-text variant was already fixed for the same reason. **Remediation** append deltas, or cap snapshot count per step.

### L-11 — AbortSignal fallback paths leak listeners (conditional on old Node)

**Evidence** `runRegistry.ts:646-664` (`streamSignalFor` fallback attaches `abort` listeners per call, removed only when abort fires) and `networkMonitor.ts:36-46` (`probeTimeoutSignal` fallback attaches a parent listener per 2 s probe). Both are dead code when `AbortSignal.any` exists (Node ≥ 20).

**Impact** Max-listener warnings and slow listener accumulation only on runtimes without `AbortSignal.any`. **Remediation** none urgent; consider a `finally` removeEventListener.

### L-12 — Late-event buffers can outlive a run if its consumer never takes them

**Evidence** `runRegistry.ts:113-125` — `lateWriteCheckpointByRun`/`lateFollowUpDroppedByRun` are set in the loop `finally` (`loop.ts:3862-3874`, `loop.ts:3968-3980`) and `clearRunAbort` **deliberately keeps them** (`runRegistry.ts:553-561`). `startAgentRun` takes both in its own `finally` (`startAgentRun.ts:208-213`), so the normal IPC path is clean; any other `runAgent` consumer (tests, future harnesses) leaks one event per run.

**Impact** Bounded, known trade-off (documented in code). **Remediation** an age-based sweep or explicit reset on quit.

### L-13 — Circuit-breaker map is unbounded by key

**Evidence** `circuitBreaker.ts:62-77` — `breakers` never evicts; keys include per-session MCP keys (`mcp-connect:<sessionKey>`, `circuitBreaker.ts:96-104`) that can accumulate across sessions. Entries are tiny. **Remediation** evict on `recordCircuitSuccess` after idle, or LRU-cap.

### L-14 — `startAgentRun` relaunch maps persist for the run's session lifetime

**Evidence** `startAgentRun.ts:31-42` — `relaunchCounts`/`relaunchTimers` are only cleared by `clearGoalRelaunchState` (cancel path, `startAgentRun.ts:146-149`) or timer fire (`startAgentRun.ts:268-272`); a run that goes done and is never cancelled retains its counter entry until process exit. Bounded by number of distinct runIds per session. **Remediation** clear on terminal done/cancelled status.

### L-15 — `renameRun` reads `contract.md` and `status.json` synchronously (IPC)

**Evidence** `state.ts:1437-1450` — `readFileSync` on `statusPath` and `contractPath` in the rename IPC handler; contract is capped elsewhere (`CONTRACT_CAP = 4000`, `state.ts:63`) but this path reads the **full** file unbounded before the regex replace. **Remediation** trivial switch to the async reader.

---

## M1 re-verification (round-1 sync-I/O sites)

| Round-1 site | Verdict | Fresh evidence |
|---|---|---|
| `checkpoints.ts:88` (readFileSync hash) | **CONFIRMED** | `checkpoints.ts:88` — unchanged; see finding M-6 for call-site hot paths |
| `activityStats.ts:222-225`, `:25`, `:59` (readdirSync) | **REFUTED — file does not exist** | No `activityStats*` anywhere under `src/main` (glob `src/main/**/activity*` and grep `activityStats` both return nothing; not in the `src/main/agent` listing). The stale index can still surface a phantom path — treat this site as deleted/renamed; its successor is unknown (see Unknowns) |
| `harnessReview.ts:101-112` | **CONFIRMED** | `harnessReview.ts:101, 103, 110, 112` — `collectRecentReceipts` sync-scans all run dirs and sync-`JSON.parse`s up to 100 receipts (IPC `/harness-review`) |
| `harnessApply.ts:366, 372` (writeFileSync) | **CONFIRMED** | `harnessApply.ts:365-366` (backup write), `:372` (revert write); also missed-then: `readFileSync` `:226, :233`, `readdirSync` `:203` |
| `followUpStore.ts:33` | **CONFIRMED** | `followUpStore.ts:33` — `readFileSync` in `loadFollowUps` (called on every chatStart/resume via `hydrateRunFollowUps`, `startAgentRun.ts:316-336`) |
| `harness.ts:85, 112` | **CONFIRMED** | `harness.ts:85` (bundled spine), `:112` (workspace appendix); called once per invoke at `loop.ts:1280` |
| `loopCheckpoint.ts:16` | **CONFIRMED** | `loopCheckpoint.ts:16` — resume-only, small file |
| `loop.ts:1183` | **CONFIRMED (line drift → 1180)** | `loop.ts:1180` — `readFileSync(contractPath)` in the trivial-seed goal-refresh block (`loop.ts:1177-1186`); `atomicWriteFile` is used for the write |

### Sync-I/O sites round 1 missed (new, verified this run)

- `state.ts` sync reader surface, used on hot paths: `loadStatus` `:201-209`; `readContract` `:74-82`; `loadCompaction` `:148-163`; `stitchedMessagesContentSync` `:356-370` (drives sync `loadMessages` `:436-443` and `loadMessagesAfterFold` `:448-459`); `readFileTailSync` `openSync/readSync/fstatSync/closeSync` `:677-703`; `loadEvents` sync stitch `:712-725`; `collectRunsFromRoot` per-run `loop.json` readFileSync `:956`; `interruptOrphanRuns` per-run `readdirSync/statSync/readFileSync` `:1173-1196`; `renameRun` `:1437-1450`.
- Per-step hot path in the loop: `readGoal` (`runGoal.ts:24-27`, via `loop.ts:1928`), `readTodos` (`tools/todo.ts:36-38`, via `loop.ts:1923`), skills/plugin-rules rescan (`skills/index.ts:205, 216, 131, 288, 301, 364`, via `loop.ts:1842`).
- Every-5-steps and run-end: sync full-transcript receipt reads (`loop.ts:974-1000`, `:1355-1364`, `:3878-3893`), `runTrajectory.ts:212-214` (`mkdirSync` + `writeFileSync`).
- Scheduler/IPC: `runLoopScheduler.ts:40-44` (`readLoop` sync read per tick), `agentInstances.ts:195-197` (receipt readFileSync), `resumeActiveGoals.ts:28-33` (startup-only `readdirSync`), `runGoal.ts:114` (status read), `runStats.ts:33, 58` (`existsSync` — cheap), `harnessReview.ts:330, 417, 424`.
- The per-dir archive listing helpers are sync too but bounded: `eventAppendQueue.ts:66-77`, `messageAppendQueue.ts:141-159`.

---

## Verified non-issues (checked explicitly, no defect found)

- **Quit quiesce is bounded at 15 s.** `QUIT_RUN_QUIESCE_MS = 15_000` (`runRegistry.ts:405`), `waitUntilRunInactive` polls every 25 ms and returns false on timeout (`runRegistry.ts:392-404`); `cancelAndWaitActiveRuns` waits all runs in parallel with per-run bounds (`runRegistry.ts:414-428`).
- **Zombie-cancel force-finish is 30 s, not 15 s.** `CANCEL_FORCE_FINISH_MS = 30_000` (`runRegistry.ts:269`), armed on every cancel (`runRegistry.ts:273-281`), timer `unref`'d so it never holds quit open, disarmed in `clearRunAbort` (`runRegistry.ts:560`). `forceFinishCancelledRun` is idempotent and skips already-terminal runs (`runRegistry.ts:296-302`).
- **No overlapping invokes on one runDir.** The `active` slot is held until the very end of the loop's `finally` (`clearRunAbort`, `loop.ts:3975`), `tryRegisterRunAbort` rejects a live slot atomically (single-threaded check+set, `runRegistry.ts:150-172`), and `enqueueFollowUp` rejects after `turnComplete` (`runRegistry.ts:518-521`). `writeStatus`/checkpoint persists are `isCurrentInvoke`-guarded (`loop.ts:960-962`, `loop.ts:1349-1351`).
- **Event/message append ordering is sound.** Per-dir serialized promise chains with settle-time self-eviction (`eventAppendQueue.ts:159-181`, `messageAppendQueue.ts:47-73`); whole-file rewrites serialize behind the chain via `enqueueMessageRewrite` (`messageAppendQueue.ts:98-126`); sync `syncMessages` callers flush the chain first (`state.ts:223-231` + callers at `state.ts:955-996` post-flush).
- **`applyDrainedFollowUps`' fire-and-forget `void enqueueMessageRewrite(...)` is safe** (`loop.ts:540-545`): `enqueueMessageRewrite` never rejects — it catches and records the failure (`messageAppendQueue.ts:107-114`), which then surfaces via the append-failure notice.
- **Terminal ordering is fixed** error → checkpoint flush → status (`emitTerminalRunError`, `loop.ts:696-711`), so every failure site persists in the same order.
- **Append failures are surfaced, not swallowed**: per-run `pendingNotices` survive until the run consumes them at step boundaries and before terminal close (`eventAppendQueue.ts:36-48`, `messageAppendQueue.ts:37-49`; consumption at `loop.ts:1768-1810`, `loop.ts:3506-3543`, `loop.ts:3328-3349`), and a mid-run persist failure stops the run rather than continuing with a corrupt transcript.
- **Retry logic is well-bounded.** Transient-FS append retries: 3 attempts, transient codes only, linear 15 ms backoff (`appendRetry.ts:40-56`). Stream retries: capped 5 (network connect-class 2), jittered exponential backoff capped at 8 s / 30 s for HTTP (`streamRetry.ts:16-33, 92-113`); quota-exhaustion 429s go terminal immediately with no retry burn (`loop.ts:2595-2621`); half-open circuit probes are released on abort/throw so the breaker cannot latch open (`streamRetry.ts:277-285, 344-352`). Status writes: terminal patches retry forever with capped 4 s backoff (documented zombie guard, `statusWriteQueue.ts:139-160`); non-terminal patches capped at 5 retries. Loop-tick delivery retries capped 6 (`runLoopScheduler.ts:37-39, 137-156`).
- **The `hasPendingFollowUps` → `markRunTurnComplete` TOCTOU is closed atomically** by `tryBeginRunClosing` (`runRegistry.ts:184-203`; use at `loop.ts:3263-3280`), with the residual window's orphans dropped-and-logged in the loop `finally` (`loop.ts:3952-3973`).
- **Cancel-vs-flush:** user cancel flushes the partial assistant, writes `cancelled` status + event, and the `finally` re-flushes idempotently (`loop.ts:2905-2918`, `loop.ts:3808-3817`); `clearFollowUpsOnDiskNow` prevents cancelled follow-ups re-hydrating on resume (`runRegistry.ts:251-267`).
- **MAX_ACTIVE_RUNS=8 concurrency safety:** the gate is atomic (`runRegistry.ts:150-172`), inline children cascade-cancel (`runRegistry.ts:443-451`), and resumes bypassing the gate are a documented crash-recovery choice (`runRegistry.ts:44-56`).
- **The compaction event-dedupe guard is ordering-correct** (adopt-then-assign, explained at `loop.ts:2055-2061`), and the per-step `setImmediate` fairness yield exists (`loop.ts:1810-1812`).
- **Checkpoint `checkpointFlushed` single-shot with correct reopen** (post-follow-up-drain anchor, `loop.ts:3266-3276`), and the `finally` re-finalizes only if not already flushed, forwarding the event via `setLateWriteCheckpoint` so the renderer still sees it (`loop.ts:3844-3861`).

---

## Unknowns

1. **Round-1 report unavailable** — `AUDIT-REPORT-2026-09-10.md` is not in this worktree; its exact M1 wording, severity scale, and "Unknowns" list could not be consulted. The M1 table above is re-derived from the contract's site list.
2. **`activityStats.ts` successor** — the round-1 file does not exist; whether its `readdirSync` logic moved elsewhere (renderer, deleted ledger) is unverified. My grep covered `src/main` only.
3. **Not read line-by-line (swept via grep / import-graph only):** `agentInstances.ts` (only fs-grep: `readFileSync` at `:197`; inline-child `notifyChildTerminal`/unregister lifecycle unverified), `executeStepTools.ts` (tool-execution internals incl. live-event and checkpoint record calls), `compactRun.ts` (auto-compaction internals), `runReceipt.ts` (receipt builder — only its call contract verified), `rewindRun.ts`, `runTrajectory.ts` (beyond the writer lines), `toolApproval.ts`, `goalRelaunchPlan.ts`, `launchRunInvoke.ts`, `quotaGate.ts`, `goalEvents.ts`, `tools/todo.ts` (beyond `readTodos`), `skills/*` bodies, `atomicWrite` implementation, `ChatEventBatcher` (`ipc/streamBatch`).
4. **`pushRecentLargeCacheHit` boundedness** (`shared/utils/tokenCost`) — the loop feeds it every large step (`loop.ts:2558-2560`); its internal cap was not verified.
5. **Provider/SSE abort semantics** (`providers/*`, `providers/sse`) — whether every stream path honors the combined `streamSignalFor` signal promptly is out of this workstream's scope.
6. **E2E fixture replay path** (`startAgentRun.ts:127-131`) — not exercised/read.
7. **Loop generator consumer edge:** if a consumer of `runAgent` other than `startAgentRun` exists in prod code, the L-12 late-buffer leak applies to it; I did not enumerate all call sites of `runAgent`.

---

## Coverage table

Exhaustive = every line read this run. Swept = targeted grep/import reads only. Skipped = out of scope per contract, not opened.

| File | Lines | Coverage |
|---|---|---|
| `loop.ts` | 3989 | **Exhaustive** (slices 1-700, 700-1400, 1400-2100, 2100-2800, 2800-3500, 3500-3989; no gaps) |
| `state.ts` | 1466 | **Exhaustive** |
| `loopPolicy.ts` | 851 | **Exhaustive** |
| `runRegistry.ts` | 698 | **Exhaustive** |
| `checkpoints.ts` | 877 | **Exhaustive** |
| `followUpStore.ts` | 78 | **Exhaustive** |
| `loopCheckpoint.ts` | 40 | **Exhaustive** |
| `eventAppendQueue.ts` | 226 | **Exhaustive** |
| `messageAppendQueue.ts` | 268 | **Exhaustive** |
| `statusWriteQueue.ts` | 282 | **Exhaustive** |
| `appendRetry.ts` | 70 | **Exhaustive** |
| `networkMonitor.ts` | 131 | **Exhaustive** |
| `streamRetry.ts` | 335 | **Exhaustive** |
| `circuitBreaker.ts` | 224 | **Exhaustive** |
| `resumeActiveGoals.ts` | 92 | **Exhaustive** |
| `runLoopScheduler.ts` | 242 | **Exhaustive** |
| `startAgentRun.ts` | 389 | **Exhaustive** |
| `harness.ts` | 187 | **Exhaustive** |
| `harnessApply.ts` | 398 | **Exhaustive** |
| `harnessReview.ts` | 465 | **Exhaustive** |
| `runGoal.ts` | ~150 | **Exhaustive** |
| `runStats.ts`, `planArtifacts.ts`, `indexStoragePaths.ts`, `runModelSelection.ts`, `types.ts`, `dedupeToolCalls.ts`, `generationRepetition.ts`, `goalEvents.ts`, `harnessReviewRun.ts`, `processPriority.ts`, `promptSections.ts`, `runListCache.ts`, `untrustedContent.ts`, `toolArgWire.ts` | small | Swept (grep / import-graph) |
| `agentInstances.ts`, `executeStepTools.ts`, `compactRun.ts`, `runReceipt.ts`, `rewindRun.ts`, `runTrajectory.ts`, `toolApproval.ts`, `toolApprovalStore.ts`, `quotaGate.ts`, `goalRelaunchPlan.ts`, `launchRunInvoke.ts`, `agentQuestion.ts`, `tools/todo.ts` | 13-27K | Swept (fs-grep + call-contract only) — findings may exist inside |
| `context/*` (assembleContext, fold, memory, rules), `providers/*`, `mcp/*`, `tools/*` (except todo grep), `skills/*` bodies, `schemas/*`, `sparsegrep/`, `arcEval/`, `codeindex/*`, `slashCommands/`, `workspaceIndex*.ts`, `workspaceMutationWatch.ts`, `harnessHeldOutEval.ts`, `harnessSections.ts`, `runStats.ts` internals | — | Skipped (out of workstream; only the sync-fs grep crossed them) |

**Bottom line:** the run-queue / persistence spine (registry, queues, status writer, checkpoints, retry policies) is exhaustively reviewed and largely sound; the highest-value fixes are checkpoint blob GC (H-1), the `deleteRun` race (M-2), the events-rotation `unlink` guard (M-3), and moving the per-step/per-5-step sync I/O off the main thread (M-5/M-6).
