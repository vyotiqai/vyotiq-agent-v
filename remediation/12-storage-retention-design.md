# Storage Retention Design — H4 (checkpoint blobs) + H5 (per-workspace runtime storage)

**Status:** design review — measured 2026-09-10 10:20–10:27 IST, read-only probe; no code changed, no source file touched, nothing under `%APPDATA%\vyotiq` created, modified, or deleted during measurement.
**Closes / clarifies:** AUDIT-REPORT-2026-09-10.md H4 (`:77-80`) and H5 (`:82-83`), the storage workstream of the round-2 remediation plan (`:197`).
**Repo paths in this document are relative to the main tree** (`C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V`); line numbers were verified from that tree on 2026-09-10 via read-only terminal reads. Runtime paths are absolute Windows paths. Path caveat in Appendix A.

---

## 1. Executive summary

The install footprint under `%APPDATA%\vyotiq` measured **10,122.76 MB / 8,822 files** (2026-09-10 10:20–10:27). The audit's H4/H5 concerns are real but are **not the dominant terms today**:

1. **Orphan workspace-storage directories ≈ 5,551 MB (55%)** — `workspaces/` holds **64** storage-id directories, but only **3** paths are tracked in `workspaces.json`. ~55 untracked dirs each hold ~99–103 MB of `codeindex/index.sqlite` (~78 MB) + `sparsegrep` (~22.7 MB). This is the single biggest, cheapest win.
2. **Dictation ASR models 3,886.1 MB (38%)** — one-time static download (`dictation/models/qwen3-asr-onnx-0.6b/`), bounded by nature. Retention policy should *report* it, not delete it.
3. **Everything H4/H5 actually names — transcripts (72.7 MB), checkpoint blobs (46.77 MB), per-run small state (0.08 MB), logs (2.81 MB) — totals ≈ 122 MB (~1.2%).** Unbounded, but growing from a small base.

Growth is driven by *workspace-id churn* (each new id mints ≈ 101 MB of indexes), not by long sessions: sessions 65 → 81 (+16) and storage dirs 49 → 62 (+13) between the audit's 08:15 baseline and 10:20, for **+1,417.83 MB in ~2 h 05 m** during an audit-heavy session. H4/H5 still need the policy the audit asks for — checkpoint blobs have no GC anywhere except whole-run `deleteRun`, transcripts are unbounded per run, and removed workspaces leave permanent footprints — but the measured data says the right shape is a count/age-capped GC with a size backstop, plus prune-on-removal and orphan reaping.

Memory (`{workspace}/.vyotiq/`) is **out of scope and never touched** by any option in this document (§6.3).

---

## 2. Scope, method, and attribution caveats

- **Measured (read-only):** directory rollups via `Get-ChildItem -Recurse -File | Measure-Object Length` over `C:\Users\ajay\AppData\Roaming\vyotiq` (userData) at 10:20–10:27 IST 2026-09-10; per-workspace decomposition; largest-file ranking; checkpoint/transcript inventories. Root JSON state files were read with values redacted (Appendix B).
- **Baseline for deltas:** audit round-2 measurement of `workspaces/` at 08:15 the same day — 4,492 MB / 12,328 files / 49 dirs (AUDIT-REPORT-2026-09-10.md `:83`).
- **Not measured / unknown — needs a probe:** (i) per-session *creation* timestamps for sessions older than a few days (only LastWrite was captured; a retention design needs createdAt or dir-birth time — see Appendix C); (ii) long-run *average* growth rate on a normal (non-audit) usage day — the 24 h and 2 h windows here are both audit-shaped; (iii) historical peak size of `checkpoints/index.json` and blob dirs for closed sessions that were already deleted.

**Attribution caveats that materially change the reading:**

- **A1 — Checkpoints copy the working set.** The active workspace (`1d7ca570…`) is this repo's main checkout, and the active session (`6aa7b0a4…`) holds the largest checkpoint dir (16.27 MB / 542 files). Checkpoint blobs snapshot prior file contents (checkpoints.ts `:217-224`, `:209 snapshotPrior`), and this repo's tracked-file working set is ~4,600–5,700 MB; the audit itself ran file-touching invokes against it. So a meaningful fraction of "checkpoint blob" volume here is audit-activity residue, not steady-state app usage.
- **A2 — The audit was live on this volume.** The 08:15→10:20 growth includes the audit's own child-instance worktrees and child-run session dirs. Partial attribution to the audit's work was already flagged UNKNOWN in the audit (`:83`); this design inherits that caveat and treats +1.4 GB/2 h as an *upper-bound* rate.
- **A3 — This document was drafted from an instance worktree** whose cwd lives *inside* userData; workspace-side `.vyotiq` therefore resolves to the main tree (Appendix A).

---

## 3. Measured inventory

### 3.1 `%APPDATA%\vyotiq` — top-level rollup (10:20–10:27, 2026-09-10)

| Directory | MB | Files | Sub-dirs | Last write | What it is |
|---|---:|---:|---:|---|---|
| `workspaces/` | 5,909.83 | 7,563 | 64 | 10:21 | per-workspace runtime storage (H5) — decomposed in §3.2 |
| `dictation/` | 3,886.10 | 6 | 1 | 09-09 18:14 | local ASR models (static download) |
| `codeindex/` | 146.40 | 5 | 1 | 09-08 19:16 | embedder model bundle (`models/DenseOn-onnx-int8/…model_quantized.onnx` 142.96 MB) |
| `traces/` | 99.65 | 2 | 0 | 09-09 22:36 | perf traces (2 manual dumps) |
| `Partitions/` | 54.16 | 657 | 4 | 09-10 08:19 | 4 `vyotiq-agent-browser-*` session partitions (5.98 / 20.85 / 10.30 / 17.03 MB) |
| `Cache/` | 23.12 | 161 | 16 | 10:11 | Chromium network cache |
| `logs/` | 2.81 | 1 | 0 | 09-08→10:25 | `vyotiq.log` (2,886.9 KB) |
| `Code Cache/` | 0.33 | 385 | 3 | 09-08 | Chromium |
| `Network/`, `Local Storage/`, `Shared Dictionary/` | 0.14 | 19 | 1 | — | Chromium storage |
| `Crashpad/` | 0.00 | 2 | 2 | 09-08 | crash handler metadata (no dumps on disk) |
| `blob_storage/`, `Session Storage/`, `home/` | 0.00 | 6 | 1 | — | empty / home workspace shell |
| (root files) | 0.22 | 15 | — | — | `settings.json` (2,320 B), `workspaces.json` (13,937 B), `model-catalog-cache.json` (25,047 B), `notifications.json` (5,247 B), `secrets.json` (280 B, encrypted store), `crash-history.json` (71 B), `Local State`, `Preferences`, `DIPS`+`-wal`, `gh-cli.json`, `chromium-cache-fingerprint`, `lockfile`, `SharedStorage`+`-wal` |
| **TOTAL** | **10,122.76** | **8,822** | | | |

### 3.2 `workspaces/` decomposition (64 storage-id dirs)

| Class | Dirs | MB | Notes |
|---|---:|---:|---|
| Untracked heavy (codeindex ~78.0–80 + sparsegrep 22.7, ≈ 99.2–102.7 MB each) | 55 | ≈ 5,494 | `codeindex/index.sqlite` 78.01–78.39 MB (largest-file table, §3.4); `sparsegrep` 22.7 MB each |
| Untracked small (`11.4 MB` — codeindex/db only, no embeddings or pruned) | 5 | 57.0 | ids `477b60aa`, `2583b90e`, `37d853f3`, `10fc3eac`, `e648f587` (last write 09-08) |
| Untracked legacy stub | 1 | 0.1 | `fb6b8238` |
| **Untracked subtotal** | **61** | **≈ 5,551.4** | **94% of `workspaces/`; paths not in `workspaces.json`** |
| Tracked active `1d7ca570…` (main repo) | 1 | 342.5 | `sessions/` 127.9 MB (2,068 f, **81 session dirs**), `instance-worktrees/` 113.5 MB (5,109 f, 27 children), `codeindex/` 78.4, `sparsegrep/` 22.7, `attachments/` 0.0 (2 f) |
| Tracked `172161f4…` (`Documents\OS`) | 1 | 15.8 | 11 session dirs, transcripts incl. 1.94 MB events + 1.69 MB messages |
| Tracked `2c90e1a6…` (home) | 1 | 0.1 | 0 session dirs — metadata only |
| **Total** | **64** | **5,909.83** | matches §3.1 |

**Workspace ↔ storage-id mapping (from `workspaces.json`, keys only):** `workspaceIdsByPath` has 3 entries, `recentPaths` 3, `openPaths` 2, `uiStateByPath` 3, `legacySessionsMigrated=true`. So **61 of 64 storage dirs are orphaned** — `removeWorkspace` (`workspaces.ts:585-606`) removes only the state entry and never touches storage (verified: no storage deletion in `:585-606`; audit `:83`).

### 3.3 Per-run artifacts inside session dirs (active + tracked workspaces)

| Artifact | Inventory | Largest observed | Bound today |
|---|---|---|---|
| `messages.jsonl` + archives | 184 files, **72.7 MB** total | **6.25 MB** (`…\sessions\6aa7b0a4…\messages.jsonl`, live) | archive count capped at 5 (`messageAppendQueue.ts:15`), cap enforced `:176-193`; file itself unbounded per run |
| `events.jsonl` + archives | included above | **1.94 MB** (`172161f4…\b9aea674…\events.jsonl`) | rotate at 2 MB keep 1 MB (`eventAppendQueue.ts:13-14`) + 5 archives (`:15`) ≈ ≤ 7 MB/session steady state |
| checkpoint blobs | 75 `checkpoints/` dirs, **46.77 MB** | **16.27 MB / 542 files** (session `6aa7b0a4…`); #2 is 2.97 MB | **none** — no GC anywhere (audit `:77-80`); index.json sidecars are trivial (75 files, 14.2 KB) |
| `status.json`, `loop.json`, `goal.json`, `loopCheckpoint.json` | 112 files, **0.08 MB** | sub-10 KB | negligible; `loopCheckpoint.json` is a per-run invariant file, one per run (`loopCheckpoint.ts:7-10`) |
| instance-worktrees (per child run) | 27 children | 113.5 MB / 5,109 files total | pruned on boot when not live (`index.ts:196-202` → `instanceWorktree.ts:1034`) — current 113.5 vs audit's 186 MB at 08:15 shows prune already ran |

### 3.4 Largest files (top 25 truncated to the interesting head)

| MB | File (relative to userData root) | Class |
|---:|---|---|
| 2,867.22 | `dictation\models\qwen3-asr-onnx-0.6b\decoder_weights.data` | static model |
| 711.21 | `dictation\models\qwen3-asr-onnx-0.6b\encoder.onnx` | static model |
| 296.75 | `dictation\models\qwen3-asr-onnx-0.6b\embed_tokens.bin` | static model |
| 142.96 | `codeindex\models\DenseOn-onnx-int8\onnx\model_quantized.onnx` | static embedder |
| 78.39 ×4 | `workspaces\{id}\codeindex\index.sqlite` (14d12adc, 1d7ca570, 25633cd6, 01d94411) | **per-workspace duplicated index** |
| 78.01–78.37 ×17+ | `workspaces\{id}\codeindex\index.sqlite` (5729cd99, dd8ee466, f7e4414d, 4593caf6, ed4c39ce, 3b76c526, 0591bd27, 8ad60e8c, 06fc8d35, 1e2b18ea, 1116e95a, d41397cf, 83247c64, 997fb28f, 6fe455ff, aa15a7ae, 3899c781…) | same |
| 50.84 / 48.81 | `traces\trace-manual-2026-09-09T*.json` | manual dumps |

### 3.5 Workspace-side (project-local) storage

| Surface | Measured | Bound today |
|---|---|---|
| `{main tree}\.vyotiq\memory\` | **0.342 MB / 49 files** (+ `rules/` 0.011 MB, `tmp/` 0, `editor-recovery.json` 0.008 MB) | none, but tiny and hand-curated — **exempt from all options (§6.3)** |
| `C:\Users\ajay\Documents\OS\.vyotiq\memory\` | 0.004 MB / 2 files | same exemption |
| `userData\vyotiq\home\.vyotiq` | **missing** (recorded, not invented) | n/a |
| run dirs the app created *inside* project trees | none observed — run dirs live under `userData\workspaces\{id}\sessions\` (§3.2), not in `{workspace}` | n/a |

### 3.6 "Today's terms" — what to attack first

| Rank | Term | MB | % of 10,122.76 | Action |
|---:|---|---:|---:|---|
| 1 | Orphan codeindex+sparsegrep (61 untracked dirs) | ≈ 5,551 | 54.8% | **prune-on-removal + orphan reaper** (§6.2) |
| 2 | Dictation models | 3,886.1 | 38.4% | report-only |
| 3 | codeindex embedder model | 146.4 | 1.4% | report-only |
| 4 | Tracked workspace runtime (sessions 127.9 + worktrees 113.5 + indexes 101.1 + attachments 0) | 342.5 | 3.4% | H5 policy (§6.2) |
| 5 | Tracked small workspaces | 15.9 | 0.2% | H5 policy |
| 6 | Traces | 99.65 | 1.0% | exists (10-file cap) |
| 7 | Checkpoint blobs (within sessions) | 46.77 | 0.5% | H4 policy (§6.1) |
| 8 | Transcripts+events (within sessions) | 72.7 | 0.7% | H5 policy |
| 9 | Browser partitions | 54.16 | 0.5% | report; clean only when app closed |
| 10 | Chromium caches (Cache + Code Cache) | 23.45 | 0.2% | Chromium-managed |
| 11 | Logs | 2.81 | <0.1% | exists (5 MB rotate) |
| — | Remaining Chromium storage (<1 MB: Network 0.06, Local Storage 0.04, Shared Dictionary 0.04, root files 0.22, others 0.00) | ≈ 0.9 | <0.1% | n/a |

---

## 4. Growth model (what grows, how fast, who writes it)

Observed deltas (audit baseline 08:15 → this measurement 10:20, same day):

- `workspaces/`: **4,492 → 5,909.83 MB (+1,417.83 MB)**; files **12,328 → 7,563 (−4,765)**; dirs **49 → 64 (+15)**.
- Sessions in the active workspace: **65 → 81 (+16)**.
- Both windows are audit-shaped (caveat A2); a plain-usage daily rate is unknown — needs a probe.

**(a) userData — unbounded today:**

| Surface | Writer (main tree, verified) | Per-unit growth | Bound today |
|---|---|---|---|
| Checkpoint blobs | `agent/checkpoints.ts` — every file-touching invoke appends to the index (`:331-352,373-377`, audit `:78`); `snapshotPrior` copies prior content (`:209, :217-224`); directory-delete snapshots up to `maxDirRestoreFiles = 20000` files (`:250`, check `:270`) | one blob per file-edit per step (full prior content); deletes snapshot the whole tree — measured spike 16.27 MB/542 files in one session | **none**; resolve/rewind only stamp meta, never delete (`:34, :42-44` meta fields; audit `:78`); sole reaper is whole-run `deleteRun` (`state.ts:1354`) |
| Workspace-id churn → indexes | codeindex store per id (`storage/paths.ts:44` + `agent/codeindex/*`), sparsegrep WAL-mode DB (`agent/indexInheritance.ts:15-16, :40`), inheritance copy into worktrees (`:133`) | **≈ 101 MB per workspace id ever opened** (78 + 22.7), replicated per worktree copy | **none** — nothing removes a dead id's dir (§3.2) |
| Logs | `logging/init.ts:62-64` (`maxSize = 5 MB` then rotate, single `vyotiq.log` currently 2,886.9 KB) | ≤ ~10 MB (rotated pair) | bounded |
| Traces | `perf/traceCapture.ts:65` (`TRACE_RETENTION = 10`), prune `:97-118` | ≤ ~10 × ~51 MB observed ≈ 500 MB worst case | bounded (count-based) |
| Crash history | `crash-history.json` 71 B (empty; renderer crashes never reach it — audit H6 `:86-89`) | negligible | bounded |
| Browser partitions | 4 × `vyotiq-agent-browser-*` | ≈ 6–21 MB each, grows with agent browsing | none found (no partition GC located) — unknown, needs a probe |

**(b) workspace run artifacts (under `userData\workspaces\{id}\`):**

| Surface | Writer | Per-unit growth | Bound today |
|---|---|---|---|
| `messages.jsonl` | per-run append queue `agent/messageAppendQueue.ts` (canonical transcript; AGENTS.md `:64`) | ≈ 0.79 MB/session avg (72.7/92), max 6.25 MB | archives capped (5, `:15`), file unbounded per run |
| `events.jsonl` | `agent/eventAppendQueue.ts` | ≤ ~7 MB/session steady state (rotate 2 MB / keep 1 MB / 5 archives) | bounded |
| checkpoint blobs | see (a) | ≈ 0.62 MB/session avg (46.77/75), max 16.27 | none |
| `goal.json`, `loop.json`, `status.json`, `loopCheckpoint.json` | run-goal/loop/status writers (`runGoal.ts:24-27` reads; status queue `statusWriteQueue.ts`) | 0.08 MB across 112 files | negligible |
| instance-worktrees | `git/instanceWorktree.ts:634` (dir), sparse-checkout copy | ≈ 4.2 MB per child run (113.5/27) | boot-time prune when not live |

**(c) memory files:** `{workspace}/.vyotiq/memory/` grows only via agent memory writes; measured 0.342 MB / 49 files in the busiest workspace. Hand-curated, cheap, and load-bearing at prompt time — **never touched by this design**.

**Net model:** the rate that matters is *workspace-id churn × 101 MB*, not transcript length. A run contributes roughly ≤ 7 MB of events + up to ~6 MB of transcript + up to ~16 MB of checkpoints (both medians far lower), of which `deleteRun` reaps only what it deletes.

---

## 5. What already exists (so the design only closes deltas)

| Mechanism | Where (verified) | Cap |
|---|---|---|
| Message archive eviction | `messageAppendQueue.ts:176-193` (evict + `MESSAGES_ARCHIVE_EVICTED` log `:183-188`) | 5 archives (`:15`) |
| Events rotation + eviction | `eventAppendQueue.ts:13-15`, rotate `:128+`, evict `:92` | 2 MB file / 1 MB keep / 5 archives |
| Log rotation | `logging/init.ts:64` | 5 MB per file (electron-log rotate) |
| Trace retention | `traceCapture.ts:65, :97-118` (best-effort unlink `:114-118`) | 10 files |
| Dictation cleanup | audit round-2 M2 verdict ("dictation deletion" exists — `:47`) | — (verified by audit; probe type unknown) |
| Instance-worktree prune | `index.ts:196-202` on boot → `instanceWorktree.ts:1034` | not-live worktrees |
| Whole-run reaping | `state.ts:1354 deleteRun` (checkpoint blobs go with the run) | per deleted run |
| **Missing** | checkpoint GC (H4), session retention, workspace-removal storage prune, orphan-id reaper, any Settings surface (§7: no storage section exists; schema has no storage key — `rg storage src/shared/ipc/schemas/settings.ts` hits only a comment at `:435`) | — |

---

## 6. Options

### 6.1 Surface (a): userData — checkpoint blobs (H4)

| # | Option | What it deletes | What is lost | Failure modes | Cost |
|---|---|---|---|---|---|
| A1 | **Count-capped GC with LRU eviction (keep last N sessions with checkpoint data + age backstop)**, async sweep after run end | oldest sessions' blob dirs beyond N, and blobs whose entry is `resolved`/`undone` per the meta fields checkpoints.ts already stamps (`:34, :42-44`); keeps index.json consistent with deletions | undo/rewind older than N sessions or past the age backstop; nothing current is touched (active run's dir excluded) | run in progress — excluded via `isActive` (`runRegistry.ts:380`); crash mid-GC — per-blob unlink after index update, partial sweep is safe (append-only index tolerates missing blobs as "gone"); concurrent sessions — per-session dirs are disjoint | medium: a GC pass + index rewrite/compaction, reusing existing meta flags |
| A2 | Size-capped GC (global byte budget for all `…\sessions\*\checkpoints\`) | oldest-by-mtime blobs until under budget | same as A1, but eviction order is crude (mtime), can evict a *useful recent* undo if a huge delete-spike lands | same as A1; a single 16 MB-class session can thrash the cap → needs the same N-sessions floor as A1 anyway | medium |
| A3 | Delete only `resolved && undone` blobs (audit remediation hint) | strictly dead history (user already decided Keep/Discard and undid) | nothing user-visible in normal flow | safest; but measured data shows most volume is *not* undone — cap needed anyway; alone it would have saved only part of the 46.77 MB | low |

**Recommendation: A1, with A3 folded in as the first (free) pass.** Defaults: keep **last 20 sessions** that have checkpoint data (measured density: avg 0.62 MB/session, max 16.27 MB → typical window ≈ 12 MB (20 × 0.62 MB avg); worst case ≈ 20 × 16.27 MB if every kept session were max-size, with the size cap (§6.4) as the backstop), age backstop **30 days**, `resolved/undone` blobs deleted immediately, **default ON**, hard-kill toggle in Settings (off ⇒ no checkpoint GC at all — restoring audit's status quo). Rationale: numbers from §3.3; a byte cap (A2) is kept as the *secondary* guarantee (§6.4), not the primary mechanism, because eviction-by-mtime fights the real usage pattern.

### 6.2 Surface (b): workspace run artifacts (H5) — includes the orphan-index discovery

| # | Option | What it deletes | What is lost | Failure modes | Cost |
|---|---|---|---|---|---|
| B1 | **Prune on workspace removal** (`removeWorkspace` also deletes `userData\workspaces\{id}\` + confirmation; sync with `enqueueWorkspaceMutation` — `register.ts:775`) | the removed workspace's whole storage dir: sessions, worktrees, codeindex, sparsegrep | the workspace's session history (transcripts are the archival copy — AGENTS.md `:64`); user is asked first | active runs on that workspace — refuse/abort-first via registry; crash mid-delete — leftovers become orphans that the orphan reaper (B3) later reaps | low-medium |
| B2 | Session retention: keep-last-N per workspace + age window, with explicit confirm | oldest session dirs beyond N / older than window (per workspace, min 1 kept, never the active session) | older transcripts (the archival copy), their checkpoints, receipts, rewind history | concurrent close of same workspace (mutation queue serializes — `register.ts:775`); crash mid-delete → partial (sessions are independent dirs; per-dir delete is atomic-ish) | medium |
| B3 | **Orphan storage-id reaper**: storage dirs in `workspaces/` whose id is not referenced by `workspaceIdsByPath`/`recentPaths`/`uiStateByPath` and whose last activity is older than a grace window | the dead dir's ≈ 101 MB of indexes (and any leftover session data) | only data belonging to workspaces the app no longer tracks — none recoverable from the app today anyway | **mapping completeness** — a dir minted but never persisted to `workspaces.json` (crash between mkdir and save) is indistinguishable from a user workspace → grace period + confirmation required; two instances (§8.4) | medium |
| B4 | Manual "Free up space" only (no automatic deletion) | whatever the user approves in the Settings surface | nothing silently | nothing automatic; disk can still fill between cleanups | low |

**Recommendation: B1 + B3 + B4 (B2 opt-in, default conservative).** Precise defaults: **keep-last-30 sessions** per workspace with a **60-day age window**, both default **OFF for auto-delete** — they run only inside the manual "Clean now" flow or when the user flips the auto toggle ON (this is the one place auto-delete default is a genuine product decision — open question Q2). Rationale: measured sessions are cheap (72.7 MB total today) but the churn term (B3/B1 targets ≈ 101 MB × ids) is where the disk goes. B3's grace window: **30 days** untracked inactivity before the *automatic* sweep will even consider an orphan, and the first sweep after upgrade is confirmation-gated (§8.1).

### 6.3 Explicitly out of scope (recommended *not* to auto-manage)

| Surface | Measured | Why exempt |
|---|---|---|
| `dictation/models/**` | 3,886.1 MB | static ASR model download; deleting it breaks dictation until re-download (3.9 GB). Already size-shown in Voice settings (VoiceSection.tsx:323-324) |
| `codeindex/models/**` | 146.4 MB | embedder bundle shared by all workspaces |
| `{workspace}/.vyotiq/**` (memory, rules) | 0.342 MB max observed | project-local agent memory — prompt-time data, never GC'd by app policy |
| home workspace dir | 0.0 MB | shell only |
| Chromium caches (`Cache`, `Code Cache`, `Network`, `Local Storage`, `Shared Dictionary`) | ≈ 23.5 MB | Chromium-managed; `session` APIs could clear but measured benefit is small |

### 6.4 Combined recommendation — precise defaults

1. **Checkpoint GC (H4): ON** — keep-last-20 checkpoint-bearing sessions, 30-day backstop, `resolved/undone` blobs pruned immediately, async sweep at run end + one sweep at boot; kill-switch toggle.
2. **Orphan reaper: ON, confirmation-gated** — untracked storage dirs idle ≥ 30 days; the upgrade-first-run sweep requires explicit confirmation (§8.1).
3. **Prune-on-removal: ON** — removing a workspace offers deletion of its storage dir (default = delete, with a confirm dialog listing the measured size; open question Q5 on default).
4. **Session retention: OFF (auto)** — controls exist; "Clean now" can apply keep-last-30 / 60-day windows on demand.
5. **Size-cap safety net: 5 GB** for the managed userData set (§6.4.5), LRU-evicting only surfaces already covered by (1)–(4) — at today's measured non-static footprint (≈ 791 MB: total 10,122.76 − dictation 3,886.1 − orphan indexes ≈ 5,551.4 − embedder 146.4) the cap has ≈ 6× headroom before it would ever fire.
6. **Report-only:** dictation/models, codeindex/models, memory, caches, partitions.

---

## 7. Settings / UI surface sketch (no code)

**Anchors (verified):** schema `src/shared/ipc/schemas/settings.ts` — `SETTINGS_FORMAT_VERSION = 2` at `:359`, `SettingsSchema` at `:361`, `DEFAULT_SETTINGS` at `:482`; main-side load/merge in `src/main/settings/settings.ts` (`getSettings` `:456+`, `normalizeSettings` `:346`); sections directory `src/renderer/src/features/settings/sections/` (AboutSection, AgentSection, AppearanceSection, GeneralSection, IndexingSection, ProvidersSection, ShortcutsSection, ToolsSection, VoiceSection); search index precedent `settingsSearchIndex.ts:158`. **Today there is no storage section and no storage settings key** (§5) — this is a new section, following the existing section pattern.

**Schema additions (shape, not code):** a single `storage` object on `SettingsSchema` — `checkpointGcEnabled: boolean (default true)`, `checkpointKeepSessions: int 5–100 (default 20)`, `checkpointMaxAgeDays: int 7–365 (default 30)`, `orphanReaperEnabled: boolean (default true)`, `orphanGraceDays: int (default 30)`, `pruneOnWorkspaceRemoval: boolean (default true)`, `sessionRetentionEnabled: boolean (default false)`, `sessionKeepCount: int (default 30)`, `sessionMaxAgeDays: int (default 60)`, `sizeCapGb: int 1–50 (default 5)`. Bump `SETTINGS_FORMAT_VERSION` per the existing migration path (`settings.ts:359` / loader merge logic).

**New `sections/StorageSection.tsx`** (registered beside the nine existing sections; searchable via `settingsSearchIndex`):

- **Usage report** — one line per category (measured by the same rollup code the GC uses): Checkpoints, Session transcripts, Indexes (per workspace listed), Instance worktrees, Traces, Logs, Dictation models, Embedder model, Browser partitions, Cache. Live-scan button + auto-refresh on open. Format via the existing `formatBytes` precedent (VoiceSection.tsx `:323-324` already shows on-disk model size this way).
- **"Free up space"** — runs the policy sweep immediately; **requires confirmation**, shows per-category reclaim preview *before* deleting and a result summary after; protected window: never deletes anything written in the last 24 h.
- **Retention controls** — the toggle/number set from §6.4, each with help text tying the default to measured numbers (pattern precedent: AgentSection.tsx `:414` help text). Kill-switch semantics stated in the help text ("Off = keep everything forever, as today").
- **Per-workspace storage detail** — the report lists tracked workspaces by path and flags untracked storage dirs as "Untracked (safe to clean)" — this is the UI for the orphan discovery (§3.2).
- **Wired-surface requirements:** every control reads/writes real settings through the existing settings IPC (redaction path already exists, `redactSettingsForIpc` `settings.ts:251`); usage numbers come from a real storage-report IPC (main scans userData; no fake data); a11y per existing section conventions (labelled inputs, focus order, no placeholder UI). Cross-check the audit's accessibility gate (§05-renderer-shared method, audit `:11-13`).

**Dictation/models row** links to VoiceSection (where the model is already shown "on disk") rather than offering deletion here — deleting a 3.9 GB model the user depends on is a Voice-section decision, not a storage-cleanup decision.

---

## 8. Migration / rollout

### 8.1 First run after upgrade (no auto-delete before the user sees the surface)

1. App boots → GC module is present but **suspended** until the user has seen Settings → Storage at least once (a one-time flag in settings state; `toolApprovalOnboardingDone` in the live settings.json leaf keys is the precedent for an acked-once flag).
2. A single, quiet, non-blocking banner (Home or Settings entry, not a modal) states: "Storage retention is now available. Measured footprint: X GB (Y GB of it is old workspace indexes and local ASR models)." Buttons: *Open Storage settings* / *Dismiss*.
3. **The only automatic action on first run is the immediate, free A3 pass** (delete blobs already stamped `resolved`/`undone`) — data the user has already explicitly discarded. Everything else waits for ack.
4. After ack: orphan reaper arm runs with its 30-day grace + confirmation; size-cap GC arms; prune-on-removal applies to future removals.

### 8.2 Sequencing (ships first → last)

1. **Storage report + Settings→Storage section** (read-only scan; no deletion) — standalone value, no risk, unlocks measurement for everything else.
2. **A3 pass + checkpoint GC (A1) + kill-switch** — closes H4; bounded blast radius (blobs only).
3. **Prune-on-removal (B1) + orphan reaper (B3)** — closes the dominant measured term (≈ 5.5 GB of dead indexes on this install; in the wild: whatever a user's churn produced).
4. **Session retention (B2) + size cap (§6.4.5)** — completes the settings surface.

### 8.3 Observability (M6-style, per the audit's logging discipline)

Every GC action logs one scoped line (`scope: 'storage'`) with: what was deleted (counts + bytes per category), why (policy rule that fired), what was skipped and why (active run, protected window, unlink failure). Eviction of a message archive already logs (`MESSAGES_ARCHIVE_EVICTED`, `messageAppendQueue.ts:183-188`) — mirror that shape (`CHECKPOINT_BLOB_EVICTED`, `ORPHAN_STORAGE_REAPED`, `SIZE_CAP_EVICTED`). Failures are skip-and-log, never run-fatal — the direct lesson of M3 (`eventAppendQueue.ts:90-113` unguarded `unlink` vs the messages queue's guarded one at `messageAppendQueue.ts:160-162`).

### 8.4 Edge cases

| Case | Handling |
|---|---|
| Run in progress during sweep | `isActive` check (`runRegistry.ts:380`) excludes that run's dir; sessions younger than 24 h never deleted (protected window); sweep is per-session dirs, serialized |
| Workspace removed while its dir is being swept | `removeWorkspace` runs through `enqueueWorkspaceMutation` (`register.ts:775`); GC also enqueues there — serialized, no double-delete |
| Crash mid-GC | Deletions are per-file/per-dir after index awareness; a partial sweep leaves fewer blobs but a consistent index; next sweep completes (append-only index tolerates missing blob dirs as "nothing to restore") |
| Two app instances | `requestSingleInstanceLock` (`index.ts:131`) — single main process owns sweeps; `MAX_ACTIVE_RUNS = 8` (`runRegistry.ts:57`) bounds concurrent runs whose dirs must be excluded; the app does spawn utility processes (dictation, indexing, codeindex) — sweeps stay in main and off those paths |
| One undeletable archive/dir (EBUSY/EPERM, Windows) | skip-and-log, continue (M3 lesson, §8.3); the settings report keeps showing the undeleted category so the user can retry |
| Very large delete snapshot (20k-file, `checkpoints.ts:250-270`) | sweep frequency is unaffected; size cap covers the spike; A3 pass reclaims resolved spikes early |
| Unknown-mapping orphan (dir minted but `workspaces.json` save crashed) | 30-day grace + confirmation + "Untracked" labeling (B3) — worst case we hold 100 MB for a month; never delete a dir the app might still reference |

---

## 9. Open questions (user decisions required)

1. **Auto-delete defaults:** should checkpoint GC (A1) and the orphan reaper (B3) ship default-ON as proposed, or default-OFF until the user opts in via the banner? (Proposal: ON for checkpoints, ON-with-confirmation for orphans; alternative: everything manual like B4.)
2. **Session retention default:** keep auto-OFF with keep-last-30/60-day as manual-only controls (proposal), or default-ON at a larger window (e.g. keep-last-50, 90 days)?
3. **Workspace-removal UX:** when a workspace is removed, default to *offer deletion with size shown* (proposal) or delete silently with an undo toast? (The transcripts are the archival copy — AGENTS.md `:64` — so silent delete needs an explicit user mandate.)
4. **Checkpoint keep-N number:** 20 sessions / 30 days (proposal, sized from measured density) — acceptable, or should rewind depth be user-tunable beyond 100?
5. **Size-cap number:** 5 GB cap with ≈ 6× headroom on today's measured footprint (§6.4.5) — acceptable, or a different budget for constrained machines?
6. **Grace window for orphans:** 30 days (proposal) vs. a shorter window with per-dir confirmation each time?
7. **Browser partitions (54.16 MB measured, unbounded mechanism unproven):** report-only (proposal) or add partition cleanup on agent-session close now? (Needs the probe in Appendix C first.)

---

## Appendix A — path translation note

This design was drafted from Agent-instance worktree `e7bf7b91…` whose cwd sits under `C:\Users\ajay\AppData\Roaming\vyotiq\workspaces\1d7ca570…\instance-worktrees\` — i.e. *inside* the userData tree being measured. Source-code line numbers cite the main tree (`C:\Users\ajay\Documents\VYOTIQ - AGENT V\VYOTIQ - AGENT V`, verified to exist with `src/` present). The instance worktree contains no `.vyotiq` (verified absent), so §3.5's memory measurement resolves to the main tree, and git branch is `vyotiq/instance/e7bf7b91-a769-4d9d-9abb-500ef2d691d2` (clean).

## Appendix B — measurement provenance

- All §3 numbers: single measurement pass, 2026-09-10 10:20–10:27 IST, PowerShell 5.1.26100.9444, `Get-ChildItem -Recurse -File -Force` + `Measure-Object Length -Sum` per directory level; largest-file ranking over the same enumeration. No writes anywhere; no file opened or echoed beyond name/size/metadata; `settings.json`/`workspaces.json` read as **key names only** (values redacted), `secrets.json` never read.
- Deltas vs the audit baseline (08:15) computed from AUDIT-REPORT-2026-09-10.md `:83`.

## Appendix C — explicit non-goals / unknowns carried forward

- Per-session createdAt probe (needed to make age windows precise): readdir/stat-only design — **needs a probe** (Appendix C).
- Browser-partition growth model: no writer located in the main tree grep — **needs a probe**.
- Dictation "deletion" mechanism referenced by audit round-2 M2 verdict (`:47`): exists per audit; its trigger/cap was not re-verified in this pass — **needs a probe before the report row is implemented**.
- Normal-usage (non-audit) daily growth rate: needs a week-long observation on a non-audit machine/day.
