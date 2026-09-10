# 01 — Runtime state & telemetry audit (`%APPDATA%\vyotiq`)

**Round:** 2 (re-verification + extension of `AUDIT-REPORT-2026-09-10.md` findings M2/M6)
**Measured:** 2026-09-10 08:15–08:19 local (Asia/Calcutta) · app v1.1.3 · read-only PowerShell inspection
**Log window analyzed:** 2026-09-08 19:16:29 → 2026-09-10 08:16 (the only log file present)
**Markers:** `[VERIFIED]` = measured this run or cited at path:line in the current tree · `[UNKNOWN]` = not verifiable this run.

---

## Executive summary

`%APPDATA%\vyotiq` totals **≈8.7 GB**, dominated by three bodies: dictation models **3.89 GB**, per-workspace storage **4.49 GB (49 dirs)**, and code-index state (**146 MB** global embedding model + **≈78 MB codeindex + ≈23 MB sparsegrep sqlite per workspace**). Since round 1 (≈24 h earlier) workspace storage grew **3.6 GB → 4.49 GB (+0.9 GB)** and dir count **44 → 49** — the fastest-growing surface, with **no retention on workspace removal `[VERIFIED]`**.

Round-1 M2 ("no retention or cleanup surface") is now **partially refuted**: trace retention **does exist** (`TRACE_RETENTION = 10` files, `src/main/perf/traceCapture.ts:65`), message/event archives are capped at 5 each (`src/main/agent/messageAppendQueue.ts:15`, `src/main/agent/eventAppendQueue.ts:15`), a dictation-model delete surface exists (`src/main/dictation/local.ts:453`, IPC `src/main/ipc/register.ts:1403`), and log rotation is capped at 5 MB (`src/main/logging/init.ts:63`). What remains unbounded: **per-workspace session dirs and indexes** (no age/count cap, and `removeWorkspace` never deletes storage, `src/main/workspace/workspaces.ts:585`).

Round-1 M6 is **confirmed and root-caused**: 3 renderer crashes logged (all the same `UpdateCard` TypeError, 2026-09-08 23:16–23:17) are **renderer-side React error-boundary records** (`src/renderer/src/lib/ErrorBoundary.tsx:49`) that are structurally invisible to `crash-history.json` — its writer only fires on Electron `render-process-gone`/`child-process-gone` events (`src/main/logging/init.ts:126,227`), and the one-shot backfill parser only matches "Renderer process gone"/"Child process gone" lines carrying a `reason` field. The edit-tool diff-hunk failure mode persists (9+8 error entries this window; 34/16 raw mentions) and provider `custom` shows 12+10 HTTP/network failures plus a local-endpoint `ECONNREFUSED 127.0.0.1:11434`.

No Critical findings. Two High (unbounded workspace storage; crash telemetry blind spot), three Medium, two Low.

---

## Findings

### H1 — Per-workspace storage grows without bound and survives workspace removal (round-1 M2, confirmed for workspaces)

- **Severity:** High
- **Evidence `[VERIFIED]`:**
  - `workspaces\` = **4,492.0 MB, 12,328 files, 49 per-workspace storage dirs** (round 1: 44 dirs / 3.6 GB → **+5 dirs, +0.9 GB in ≈24 h**). Part of the growth is this audit's own parallel instance worktrees (5 registered in `git worktree list` this run) — attribution split is approximate `[UNKNOWN]`.
  - Composition of a typical ~100 MB dir (`workspaces\3899c781-…`, 101.1 MB total): `codeindex\index.sqlite` **78.4 MB** + `sparsegrep\index.sqlite` **22.7 MB**, **0 session dirs** — indexes persist with no session ever created.
  - The active workspace (`1d7ca570-…`, 438.3 MB) holds 65 session dirs, `instance-worktrees\` **186.2 MB**, `messages.jsonl` up to **6.03 MB**, `events.archive.…jsonl` up to **5.22 MB** per session.
  - `removeWorkspace` (`src/main/workspace/workspaces.ts:585-606`) only mutates `openPaths`/`activePath` tab state — the storage dir is never deleted. Grep for `MAX_SESSIONS|maxSessions|sessionCap|oldestRun` across `src/main`: **0 hits** (only `deleteRun`, a manual per-run surface: `src/main/agent/state.ts:1348`, IPC `src/main/ipc/register.ts:1918-1920`).
  - Per-session caps exist only for *archived segments*: `MAX_MESSAGE_ARCHIVES = 5` (`src/main/agent/messageAppendQueue.ts:15`, enforced at :178-186), `MAX_EVENT_ARCHIVES = 5` (`src/main/agent/eventAppendQueue.ts:15`, enforced at :92-95). Live `messages.jsonl`/`events.jsonl` and the *number of session dirs* are uncapped.
- **Impact:** Steady disk bloat at ≈100 MB per touched workspace floor (indexes alone) plus unbounded session history; a removed workspace leaves its data forever. At the observed 1-day pace this is the dominant growth risk of the install.
- **Remediation:** Prune (or offer to prune) the workspace storage dir when a workspace is removed; add an age/count cap for session dirs; consider sharing or trimming per-workspace `codeindex`/`sparsegrep` sqlite (a 0-session workspace should not retain a 78 MB index). Expose a Settings → Storage surface with per-category sizes and a reclaim action.

### H2 — Renderer React crashes never reach `crash-history.json` (round-1 M6, root-caused)

- **Severity:** High (telemetry gap masking a real recurring crash)
- **Evidence `[VERIFIED]`:**
  - `crash-history.json` = `{"snippets":[],"pendingRecovery":null,"backfillVersion":1}` while the log holds **3 `RENDERER_CRASH` records**, all 2026-09-08 23:16:57–23:17:12, all identical: `TypeError: Cannot read properties of undefined (reading 'length')` with componentStack `at UpdateCard (…out/renderer/assets/index-….js)` (paths redacted `[app]`).
  - Those records are written by the **renderer error boundary** — `logger.fatal(… 'Renderer crash', …)` at `src/renderer/src/lib/ErrorBoundary.tsx:49` — bridged to the main log, mapped `fatal→error` (`src/main/logging/init.ts:42`).
  - `crash-history.json` is written only by `recordCrashSnippet` (`src/main/logging/crashDiagnostics.ts:172`), called from exactly two places: the `child-process-gone` handler (`src/main/logging/init.ts:126`) and `logRendererProcessGone` on the Electron `render-process-gone` event (`src/main/logging/init.ts:227`, wired at :247-256). No `render-process-gone` line exists in the current log → the writer never fired for these crashes.
  - The one-shot backfill can't catch them either: `parseCrashSnippetsFromLogText` matches only lines containing "Renderer process gone"/"Child process gone" **and requiring a `reason:` field** (`src/main/logging/crashDiagnostics.ts` — `isRenderer`/`isChild` tests + `if (!reason …) continue` in the parser), and `crash-history.json` already carries `backfillVersion: 1` = `CRASH_BACKFILL_VERSION`, so `backfillCrashSnippetsFromLog` (`src/main/logging/init.ts:58`) permanently no-ops (`src/main/logging/crashDiagnostics.ts:243` early-return).
- **Impact:** Settings → General shows an empty crash history while the UI crashed 3× in one evening; users and support cannot see React-level crash causes; the recurring `UpdateCard` TypeError (an undefined prop reaching the update card) goes untracked.
- **Remediation:** Route the error-boundary record (ErrorBoundary.tsx:49) into `recordCrashSnippet` (e.g. via an IPC call or by having the bridge main-side detect `code: 'RENDERER_CRASH'` records); fix the 3 `UpdateCard` crashes (undefined value passed for a length-read prop); if log-backfill must catch these, teach the parser the `Renderer crash` shape and bump `CRASH_BACKFILL_VERSION`.

### M1 — Edit-tool diff-hunk matching remains the top agent-failure mode (round-1 M6, persists)

- **Severity:** Medium
- **Evidence `[VERIFIED]`:** In the 2026-09-08→09-10 window: **9** error entries `TOOL_EXEC: Diff hunk failed to match near line N (context/removal mismatch)` and **8** entries `TOOL_EXEC: Diff hunk failed to match (context/removal mismatch); the bare @@ header declares no line` — identical counts to round 1, same log window, so no regression but no fix either. Raw substring mentions across all lines: 34 and 16 (the rest appear in multi-line tool-result echoes). Redacted sample:
  - `[2026-09-09 06:47:25.416] [error] [tools] Tool execution failed: TOOL_EXEC: Diff hunk failed to match near line 810 (context/removal mismatch).`
  - `[2026-09-09 07:16:57.732] [error] [tools] Tool execution failed: TOOL_EXEC: Diff hunk failed to match (context/removal mismatch); the bare @@ header declares no line.`
- **Impact:** Wasted steps/retries on the single most-used mutation tool; the two failure shapes are reported distinctly but never auto-recovered.
- **Remediation:** Auto-recover on bare-`@@` headers (strip and re-apply as full-context hunk); add a one-shot re-read + retry for context/removal mismatches.

### M2 — Provider `custom` HTTP/network failures + dead local endpoint in the loop

- **Severity:** Medium
- **Evidence `[VERIFIED]`:** **12** `[provider] Provider http failure {` records + **10** `Provider network failure { code: 'PROVIDER_HTTP', provider: 'custom', kind: 'network' }` (matches round 1 exactly); plus **4** `Provider stream error { code: 'PROVIDER_HTTP', provider: 'opencode', step: N }` and **2** `PROVIDER_NETWORK` custom stream errors that round 1 did not itemize. One failure detail shows `providerMessage: 'connect ECONNREFUSED 127.0.0.1:11434'` — a configured local (Ollama-style) endpoint is not listening. No secrets appeared in any sampled record (key names/backends only).
- **Impact:** Silent run-step failures and user-visible stream errors; a configured-but-dead local endpoint repeatedly burns retries.
- **Remediation:** Surface provider health in the UI (failures with counts per backend); on `ECONNREFUSED` against a local endpoint, fail fast with a "backend not running" hint rather than retrying.

### M3 — Trace retention is count-based, not size-based

- **Severity:** Medium (Low impact today, structural ceiling tomorrow)
- **Evidence `[VERIFIED]`:** Retention exists — `TRACE_RETENTION = 10` (`src/main/perf/traceCapture.ts:65`), `pruneRetention()` keeps newest 10 `trace-*.json` (`src/main/perf/traceCapture.ts:97-114`, invoked after every dump at :226). Current state: 2 files, **99.7 MB** (`trace-manual-2026-09-09T15-44-03-152Z.json` 50.84 MB, `trace-manual-2026-09-09T17-06-54-568Z.json` 48.81 MB). At observed per-dump sizes (~49–51 MB), the cap admits **≈500 MB worst case**. The in-memory ring buffer itself is bounded at 16 MB (`trace_buffer_size_in_kb: 16_384`, `src/main/perf/traceCapture.ts:47`).
- **Impact:** A burst of dumps (crash/hang storms are the design trigger) can occupy half a GB before the count cap stops it.
- **Remediation:** Add a total-size budget (e.g. delete oldest until ≤200 MB) alongside the count cap.

### L1 — Error-count drift vs round 1 (81 vs 162) unexplained

- **Severity:** Low
- **Evidence `[VERIFIED]`:** Current `logs\vyotiq.log` (60,895 lines, 2.53 MB, only file in `logs\`, window 09-08 19:16 → 09-10 08:16) holds **81 `[error]`-tagged lines** and **1,797 `[warn]`**. Round 1 reported **162 error entries** for a same-sized file. The current file's first line is a fresh `Logging initialized` record, so earlier content is absent `[UNKNOWN]` — round 1 may have counted rotated file(s) since gone, or used a looser match (e.g. multi-line records / substring `error`). Cannot be resolved from present state.
- **Impact:** Cross-round comparability of log-health metrics is weak.
- **Remediation:** Pin the metric definition for future audits (count of `^\[…\] \[error\]` header lines) and record the log-window start/end timestamps.

### L2 — Workspace `instance-worktrees` are heavy but stale-pruned only at startup for live workspaces

- **Severity:** Low
- **Evidence `[VERIFIED]`:** `pruneStaleInstanceWorktreesBestEffort(root, liveIds)` runs from `src/main/index.ts:194-200` (dedup-seen set) — stale instance worktrees of *live* workspaces get cleaned, but worktree copies inside storage dirs of removed/closed workspaces are covered only by the same unbounded-storage problem as H1. Measured: 186.2 MB of instance worktrees in the active workspace's storage.
- **Impact:** Contributes to H1's growth; orphaned worktrees from deleted workspaces persist.
- **Remediation:** Fold instance-worktree cleanup into the H1 storage-reclaim path.

---

## Verified non-issues (checked this run, passed)

- **Log rotation is capped:** `log.transports.file.maxSize = 5 * 1024 * 1024` — `src/main/logging/init.ts:63` (round-1 citation confirmed). Current file 2.53 MB; no runaway growth.
- **Zero ENOENT entries in the log** — consistent with the logging-dir self-heal in `resolvePathFn` (`src/main/logging/init.ts:34-44`).
- **Zero unhandled-rejection / uncaught-exception entries** in the window (handlers exist at `src/main/logging/init.ts:135-160`; none fired).
- **Crashpad is empty:** `Crashpad\reports\` contains no `.dmp` files (only `metadata`, `settings.dat`) — no native crashes this window.
- **Updater cache absent:** no `vyotiq-updater` / `*updater*` entries under userData (updater is opt-in; nothing cached).
- **Trace recorder is memory-bounded** when idle: 16 MB ring buffer, narrow category set, argument filter on (`src/main/perf/traceCapture.ts:38-49`); nothing hits disk except problem-triggered dumps.
- **Message/event archive caps work:** 5-archive caps enforced (`messageAppendQueue.ts:178-186`, `eventAppendQueue.ts:92-95`); sampled workspace shows at most 1 archive file per session.
- **Dictation model delete surface exists:** `deleteDictationModelCache` (`src/main/dictation/local.ts:453-464`, refuses delete during download) exposed via IPC (`src/main/ipc/register.ts:1403-1404`).
- **Secrets hygiene:** `secrets.json` exists (0 MB) but was **not opened** per audit rules; no secret values observed anywhere in sampled log lines (provider names and error kinds only).
- **Child-process crash logging exists and is wired** (`installChildProcessCrashLogging`, `src/main/logging/init.ts:109-131`) — no `CHILD_PROCESS_CRASH` entries in the window.

## Full inventory (fresh, 2026-09-10 08:15) `[VERIFIED]`

| Path | Size | Files | Round-1 (2026-09-09) | Drift |
|---|---|---|---|---|
| `dictation\` (qwen3-asr-onnx-0.6b) | 3,886.1 MB | 6 | ≈3.8 GB | none |
| — decoder_weights.data | 2,867.2 MB | | | |
| — encoder.onnx | 711.2 MB | | | |
| — embed_tokens.bin | 296.8 MB | | | |
| — tokenizer.json | 10.9 MB | | | |
| `workspaces\` | 4,492.0 MB | 12,328 | ≈3.6 GB / 44 dirs | **+0.9 GB, +5 dirs** |
| `codeindex\` (global embedding model) | 146.4 MB | 5 | ≈146 MB | none |
| — model_quantized.onnx | 142.96 MB | | | |
| `traces\` | 99.7 MB | 2 | ≈100 MB | none (2 manual dumps, 09-09) |
| `logs\` | 2.53 MB | 1 (`vyotiq.log`) | 2.5 MB | no rotated files present |
| `Partitions\` | 45.4 MB | 515 | not reported | n/a |
| `Cache\` / `Code Cache\` / `Network\` | 2.2 / 0.2 / 0.1 MB | 8/6/6 | not reported | n/a |
| `Local Storage\` / `Session Storage\` / `Shared Dictionary\` / `blob_storage\` | ≤0.1 MB each | 8/6/4/0 | not reported | n/a |
| `Crashpad\` | ~0 MB | 2 (empty reports) | not reported | n/a |
| `crash-history.json` | empty (`snippets: []`, `backfillVersion: 1`) | — | empty | still empty |
| `gh-cli.json`, `model-catalog-cache.json`, `notifications.json`, `settings.json`, `secrets.json`, `workspaces.json`, `Preferences`, `Local State`, `lockfile`, `DIPS`(+wal), `SharedStorage`(+wal) | ≤0.1 MB each | — | — | not inspected (state/secrets rules) |
| **Total** | **≈8.72 GB** | | ≈7.8 GB | **+≈0.9 GB** |

Log-pattern counts (window 09-08 19:16 → 09-10 08:16, single file): `[error]` lines **81**; `[warn]` **1,797**; `RENDERER_CRASH` **3**; diff-hunk near-line **9** / bare-@@ **8** (error entries; 34/16 raw mentions); provider http failure **12** + network failure **10** (`custom`); provider stream errors **4** (`opencode`) + **2** (`custom` network); `ECONNREFUSED 127.0.0.1:11434` detail on provider failures; ENOENT **0**; unhandled rejections **0**.

## Unknowns

- **Why round 1 counted 162 error entries vs 81 now** — current log starts 2026-09-08 19:16 with a fresh `Logging initialized` line; any pre-window log or rotated file round 1 saw is gone `[UNKNOWN]`.
- **Attribution of the +0.9 GB/day workspace growth** — this audit's own parallel instance worktrees (5 active at measurement) contributed, but the user-vs-self split was not measured `[UNKNOWN]`.
- **Whether any renderer surface exposes trace files or a storage-management UI** — renderer settings not audited this run `[UNKNOWN]`.
- **Whether the dictation download flow discloses the 3.8 GB size before download** — renderer flow not audited `[UNKNOWN]`.
- **Crash causes before the current log window** — log content older than 09-08 19:16 is not retained/available `[UNKNOWN]`.
- **`gh-cli.json` absolute-path pin (round-1 L2)** — not re-read this run `[UNKNOWN]`.
