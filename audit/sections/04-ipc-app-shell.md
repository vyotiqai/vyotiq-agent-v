# Section 04 — IPC / Preload / App Shell / Updater / Secrets Audit

**Workstream:** `src/main/ipc/**`, `src/preload/index.ts`, `src/main/app/**` (window.ts, security.ts, index.ts), `src/main/updater/**`, `src/main/logging/init.ts`, `src/main/settings/secrets.ts`, `src/main/storage/**`, `src/main/perf/**`
**Method:** Static, evidence-only review of the current working tree (read-only; no tests/builds executed per contract). Every claim below cites `path:line` verified this run. The round-1 report `AUDIT-REPORT-2026-09-10.md` was **not present in this worktree** (untracked in the parent workspace), so all round-1 claims were re-verified from scratch; the M4 premise is taken from the task brief.

## Executive summary

- **IPC validation coverage: 100% of payload-accepting channels.** `src/main/ipc/register.ts` registers **193 IPC endpoints** (192 `ipcMain.handle` + 1 `ipcMain.on`). **152 accept a renderer payload and every one validates it with a zod `Schema.parse` before use; 0 unvalidated payload channels found.** The remaining 41 handlers take no payload (validation N/A). One additional sync listener (`src/main/index.ts:111`, editor-flush ack) validates structurally rather than via zod — acceptable, see L3.
- **Preload exposure is tight:** one contextBridge key (`vyotiq`), every `on*` event listener schema-validates (or structurally type-checks) before dispatch, no Node primitives leak, and `browserGetState` even re-validates main's response.
- **M4 verdict (resolved): the dev-only `blob:` in `img-src` is a DEAD DIRECTIVE, not a real gap.** There is **zero `URL.createObjectURL`/`revokeObjectURL` usage anywhere in `src/`** (main or renderer). Every shipped image surface renders `data:` URLs. Production `img-src 'self' data:` is sufficient; nothing breaks in packaged builds. No `media-src` or `worker-src` additions are needed.
- **Window/CSP/updater/secrets hardening all re-verified intact** — see Verified non-issues.
- **No Critical or High findings. Three Low findings**, all hygiene-level.
- **Perf/logging state is bounded:** 5 MB log rotation, 16 MB trace ring buffer with 10-file retention, capped lag samples (120), crash snippets (8), renderer reloads (3), and dispatcher slots that detach at refcount zero.

---

## Findings

### No Critical findings
### No High findings
### No Medium findings

---

### L1 — [Low] Dev CSP `img-src ... blob:` is a dead directive (M4 resolution)

**Evidence:**
- `src/main/app/security.ts:104` — dev (Vite HMR) policy: `"img-src 'self' data: blob:"`.
- `src/main/app/security.ts:113` — production policy: `"img-src 'self' data:"` (no `blob:`).
- Grep for `createObjectURL|revokeObjectURL` across **all of `src/**`**: **zero hits**. Grep for `blob:` in `src/renderer/**`: zero hits (only `Blob`-typed identifiers in `src/renderer/src/lib/audio/pcm16k.ts:8,65,83`, which convert a recorded `Blob` to base64 — no object URL is ever constructed).
- Every shipped image surface uses `data:` URLs, all verified this run:
  - `workspaceReadImage` returns `data:<mime>;base64,...` — `src/main/ipc/register.ts:3462`.
  - `runsReadArtifact` returns `data:image/jpeg;base64,...` for browser snapshots — `src/main/ipc/register.ts:1712-1713`.
  - Browser snapshot `<img>` renders that artifact content — `src/renderer/src/features/chat/toolUi/bodies/BrowserBody.tsx:136-137` (source fetched via `readRunArtifact` at `BrowserBody.tsx:50-67`).
  - File previews build `data:` URLs — `src/renderer/src/features/chat/components/filePreviewKind.ts:49-58` (`previewSourceUrl`), rendered at `FilePreview.tsx:73`.
  - Marketplace icons are **restricted to data-image URLs ≤200 KB** by allow-list regex — `src/shared/utils/marketplaceIconUrl.ts:1-16`, used at `PackageIcon.tsx:12-25` (`isAllowedMarketplaceIconUrl`); comment there explicitly notes "CSP allows `data:` but not remote http".
  - `ImageChip.tsx:86-87` / `ImageLightbox.tsx:35-36` render a `url` prop — with no `createObjectURL` anywhere in the tree, in-app code cannot produce a `blob:` URL for these.
- `media-src` not needed: grep for `<audio|<video` in `src/renderer` found none; dictation uses `getUserMedia` + `MediaRecorder` + `AudioContext` (`useComposerDictation.ts:30-33,354,563-564`, `pcm16k.ts:87`) — none of which are governed by `media-src`.
- `worker-src` not needed: the only `new Worker` in the codebase is a main-process `node:worker_threads` Worker (`src/main/agent/context/tokenizerPool.ts:5,157`), outside CSP scope. No renderer workers exist.

**Impact:** None today — production `img-src 'self' data:` is sufficient for all shipped surfaces; the dev-only `blob:` simply never matches anything. Risk is latent: if future renderer code adopts `URL.createObjectURL` (e.g. audio playback), it would work in dev and silently break in packaged builds (the exact dev/prod delta class M4 was raised against).

**Remediation:** Either delete `blob:` from the dev policy at `security.ts:104` or add a comment cross-referencing this audit; optionally add a lint/grep CI guard for `createObjectURL` in `src/renderer` so the dev/prod CSP delta can never silently diverge.

### L2 — [Low] `listRuns` touches `raw` before schema validation (cast + unguarded `.trim()`)

**Evidence:** `src/main/ipc/register.ts:1827-1830`:
```ts
const body = (raw ?? {}) as { workspacePath?: string }
const workspacePath = body.workspacePath?.trim() ?? ''
```
followed by `ListRunsRequestSchema.parse({ workspacePath })` at `register.ts:1830`. A non-string `workspacePath` (e.g. `{workspacePath: 123}`) throws a TypeError inside `try`, caught by `failFrom` and returned as an error `IpcResult`.

**Impact:** None exploitable — the value is never used before the schema re-parse, and the failure is contained. It is the single handler that deviates from the parse-first discipline observed in the other 151 payload handlers.

**Remediation:** Parse first (`ListRunsRequestSchema.parse(raw ?? {})`) or wrap in `typeof` checks, matching the pattern at e.g. `register.ts:2246` (`GitDiffRequestSchema.parse(raw ?? {})`).

### L3 — [Low] `workspaceEditorFlushResponse` sync channel validated structurally, not via zod

**Evidence:** `src/main/index.ts:111` — `ipcMain.on(IPC.workspaceEditorFlushResponse, onResponse)`; the listener (`index.ts:112-121`) checks `event.sender.id !== win.webContents.id` (sender pinned to the requesting window), rejects non-objects/arrays, and requires `response.requestId === requestId` (correlation token minted by main at `index.ts:86`) plus `response.ok === true`. No zod schema is applied.

**Impact:** Low. The channel is main-initiated request/response with a per-request correlation id and sender-id pinning; a malicious renderer could only ack its own flush request. Inconsistent with the otherwise-universal zod discipline.

**Remediation:** Optional: add a tiny zod schema (`{ requestId: string, ok: boolean }`) for uniformity. Not required for security.

---

## IPC validation coverage detail (task 1)

- **Enumeration:** grep of `ipcMain.(handle|on)` across all of `src/main/**` returns registrations **only** in `src/main/ipc/register.ts` (192 `handle` + 1 `on`) and `src/main/index.ts:111` (the L3 flush-ack listener). `src/main/ipc/streamBatch.ts` registers no channels (it is the chat-event batcher/dispatcher behind `chatEvent` sends).
- **152 payload channels → 152 validated.** Each parses via a named zod request schema before any use, e.g. `WorkspacesAddRequestSchema.parse(raw ?? {})` (`register.ts:731`), `ChatStartRequestSchema.parse(raw)` (`register.ts:975`), `ShellOpenExternalRequestSchema.parse(raw)` (`register.ts:2404`), `BrowserWorkspaceScopeSchema.optional().parse(raw)` (`register.ts:3897`), and the sync `workspacesUpdateUiStateSync` → `WorkspacesUpdateUiStateRequestSchema.parse(raw)` (`register.ts:823`). `browserSetBounds` (`register.ts:4005-4009`) deliberately treats `raw == null` as "clear bounds" and otherwise parses — intentional, safe.
- **41 zero-payload handlers** (e.g. `pickWorkspace` `register.ts:707`, `secretStatus` `register.ts:923`, `runsActive` `register.ts:2094`, `getSystemTheme` `register.ts:4018`, `processMetrics` `register.ts:4074`) — validation N/A by construction; all verified to take no payload parameter.
- **Sender gating:** every handler starts with `if (!senderOk(event)) return fail('Invalid sender')`. `senderOk` (`register.ts:489-506`) requires: sender maps to the non-destroyed **main window** (`BrowserWindow.fromWebContents` + identity against `getMainWindow()`), and `senderFrame === mainFrame` — blocking compromised-subframe invokes per Electron guidance.
- **Workspace/path containment:** handlers taking `workspacePath` gate on `isOpenWorkspace` (`register.ts:522`); file-ish channels additionally enforce `isSafeWorkspaceRelPath` + `resolveInsideWorkspace` (e.g. `workspaceReadImage` `register.ts:3450-3460`, `slashCommandsOpenFile` `register.ts:3366-3384` with explicit absolute-path containment check, `workspaceFileReveal` `register.ts:3578-3580`).
- **Error taxonomy:** zod failures are classified `IPC_VALIDATION` and logged as warnings without echoing the payload (`failFrom`, `register.ts:575-635`).
- **Round-1 extension:** round 1 sampled `register.ts:756-1323+`; this pass read the **entire file (1-4083)** and re-verified every registration line-by-line. No new gaps found; the one pre-parse touch (L2) is contained.

## Preload exposure review (task 2)

- Single bridge key: `contextBridge.exposeInMainWorld('vyotiq', api)` — `src/preload/index.ts:574`. No other globals, no `ipcRenderer` itself exposed.
- **Event listeners validate before dispatch:**
  - Chat events via `parseRendererChatEvent(raw)` with drop + `console.warn` on failure — `preload/index.ts:96-104`.
  - zod `safeParse` for: tool approval requests, agent questions, browser state, updater state, dictation status, GitHub auth status, code-index status, skills-changed, notifications list/action (all read this run; e.g. `ToolApprovalRequestSchema.safeParse(raw)` at `preload/index.ts:114`).
  - Structural type-guards for boolean/prim channels: `onPtyData` (`{id:string,data:string}`), `onPtyExit`, `onWindowMaximizedChanged`/`onWindowFocusChanged`/`onSystemThemeChanged` (boolean), `onAccessibilitySupportChanged` (`enabled` boolean), `onWorkspaceEditorFlushRequest` (non-empty string requestId).
  - Defense in depth: `browserGetState` re-`safeParse`s main's *response* (`preload/index.ts:322-328`).
- **No Node primitives leak:** the API surface is `ipcRenderer.invoke/send/on/removeListener`, `clipboard.writeText` (guarded `typeof text !== 'string'`), and `process.platform`. No `Buffer`, `process.env`, `require`, or raw `WebContents` handles.
- `updateWorkspaceUiStateSync` uses `ipcRenderer.send` (sync) — validated main-side at `register.ts:823`.

## Window / CSP / permission / cert re-verification (task 3)

- **Window hardening** — `src/main/app/window.ts:95-99`: `contextIsolation: true` (:96), `nodeIntegration: false` (:97), `sandbox: true` (:98), `webSecurity: true` (:99); preload path only at :95. All four flags verified present in the current tree.
- **Navigation locks** — `security.ts:31-37`: `setWindowOpenHandler` always `{action:'deny'}`, with https-only validated URLs (`isAllowedHttpsUrl`, rejects non-https and userinfo, `security.ts:7-13`) shelled out via `shell.openExternal`; `will-navigate`/`will-redirect` prevent any URL change off the current page (`security.ts:40-46`).
- **Permission allow-list** — `security.ts:16`: `{'media', 'clipboard-sanitized-write'}` only. Request handler (`security.ts:48-56`) grants `media` solely when `wc === win.webContents` **and** all requested mediaTypes are audio; check handler (:58-60) same allow-list + same-webContents.
- **Certificate handling** — `security.ts:70-81`: `setCertificateVerifyProc` logs hostname-only on failure and always `callback(-3)` (defer to Chromium default, i.e. reject on error). **No bypass path exists** — `callback(true)` never appears.
- **CSP build** — `security.ts:92-108` + apply via `onHeadersReceived` (`security.ts:122-131`). Dev policy only when a Vite renderer URL exists (`needsViteHmrCsp`, `security.ts:83-89`) and contains `script-src 'self' 'unsafe-inline'` for HMR but **no `unsafe-eval`**; production: `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `img-src 'self' data:` (:113). (Note: round-1 line refs 39-60/71-82/84-108 are shifted in the current tree; verified equivalents cited above.)

## Updater re-verification (task 5)

`src/main/updater/index.ts`:
- `autoDownload = false` (:68), `autoInstallOnAppQuit = false` (:69), `disableWebInstaller = true` (:70). Comment at :60-63 confirms intent: full NSIS installers only, renderer shows release notes and the user picks download/install explicitly.
- **No polling:** one-shot deferred startup check (`scheduleStartupUpdateCheck`): skipped in dev (`!app.isPackaged`), gated by the Settings auto-check switch, no interval — later checks only via explicit `updater:check` IPC.
- **Dedup:** `checkInFlight` guard (:18, :148-151, :161) collapses concurrent invokes into one in-flight check.
- **Gated install:** `installAppUpdate` requires `status === 'downloaded' && lastInfo` (:186) before `quitAndInstall()` (:193); download gated on `available`/`downloading` status. All three IPC entry points parse their (empty-object) request schemas (`register.ts:2657,2668,2679`).
- Startup wiring: `src/main/index.ts` — `initAutoUpdater()` + `scheduleStartupUpdateCheck({ autoCheckEnabled: getSettings().autoCheckUpdates !== false })` immediately after `registerIpc()` (read this run, index.ts:202-204 region).

## Secrets re-verification (task 5)

`src/main/settings/secrets.ts` (full file read, lines 1-534; **no secret values were printed and none appear in this report**):
- **Encryption:** all writes go through `encryptBlob` → `safeStorage.encryptString` → base64 (`:138-146`); `safeStorage.isEncryptionAvailable()` required (`:144`); decrypt via `safeStorage.decryptString` (`:148-152`).
- **basic_text refusal:** on Linux, `assertSafeStorageBackend` throws when `getSelectedStorageBackend() === 'basic_text'` (`:129-137`), and `secretStatus()` reports `encryptionAvailable: false` in that case (`:203-211`) — no unencrypted fallback anywhere.
- **Atomic 0600 writes:** `writeFile` uses `atomicWriteFile(p, JSON.stringify(...), 0o600)` (`:92`) — temp-sibling + rename + chmod in `src/main/storage/atomicWrite.ts:148-171` — plus explicit `chmodSync(p, 0o600)` on POSIX (`:97-99`, wrapped in try/catch as Windows ignores chmod).
- **Serialized mutations:** `enqueueSecretsMutation` chains all IPC mutations through one promise chain so read-modify-writes cannot interleave (`:107-127`; all secret-writing IPC handlers in `register.ts:903,916,2835,2868,2893,2911,2941,2960` await it).
- **Corrupt-store safety:** unreadable/ill-typed `secrets.json` sets `secretsFileLoadError` (`:49-70`) and `assertSecretsStoreWritable` (`:73-76`) blocks all subsequent writes — a corrupt store is never overwritten with `{}`.
- **No value leakage in logs:** every `logger.*` call in the file logs only `provider` / `serverId` / error objects, never payloads (verified across :1-534). `getSettings` responses are redacted via `redactSettingsForIpc` (`register.ts:868,888`).

## Logging + perf state review (task 6)

- **Log rotation:** `log.transports.file.maxSize = 5 * 1024 * 1024` (5 MB) — `src/main/logging/init.ts:63` (matches round-1). ENOENT self-heal via `resolvePathFn` re-ensuring the logs dir per write (`init.ts:42-44`). Fatal paths log then exit after a 250 ms flush (`init.ts` uncaughtException/unhandledRejection handlers).
- **Crash diagnostics bounded:** `MAX_CRASH_SNIPPETS = 8` (`src/main/logging/crashDiagnostics.ts:99`, enforced at :174 and :323), `MAX_RENDERER_RELOADS = 3` (:25), reload cool-down + healthy-reset reset the counters.
- **Trace flight recorder bounded:** 16 MB ring buffer (`trace_buffer_size_in_kb: 16_384`, `src/main/perf/traceCapture.ts` FLIGHT_RECORDER_CONFIG), disk dumps retained at 10 (`TRACE_RETENTION = 10`, `pruneRetention` deletes the excess), 30 s auto-dump cool-down, dumps serialized through `dumpChain`, always resumes after dump. Argument filter enabled (PII).
- **IPC timing:** `src/main/perf/ipcTiming.ts` patches `ipcMain.handle` only when `VYOTIQ_PERF=1`; retains only an `installed` flag and a `seq` counter (no growth).
- **Load monitor:** `src/main/perf/loadSnapshot.ts` — 5 s timer; event-loop-lag samples capped at `LAG_SAMPLE_CAP = 120` (shift on overflow); `stopLoadPerfMonitor` clears state. `processMetrics.ts` is stateless summarization; verbose sampling additionally gated on >1 GB RSS or perf-debug, rate-limited to one log / 30 s (`shouldLogProcessMetrics`).
- **Chat-event dispatcher** (`src/main/ipc/streamBatch.ts`): per-run slots detach when `attachCount` reaches 0 (no unbounded slot map); `pendingUsageByStep` coalesces usage per (type, step) and clears on every flush; `stats.byType` is keyed only by the closed `AgentEvent` type union (bounded key space). Delta coalescing further bounds `pendingSegments` growth between flushes.
- **Atomic writes** (`src/main/storage/atomicWrite.ts`): unique temp sibling (`.pid.random.tmp`) so concurrent writers cannot clobber each other, Windows EPERM/EACCES/EBUSY rename retry with backoff, temp unlinked on failure.

## Verified non-issues

1. **IPC validation: 152/152 payload channels zod-validated; 0 gaps** (full-file read of `register.ts`; see coverage detail above).
2. **`senderOk` main-window + main-frame gate on every handler** — `register.ts:489-506`.
3. **`shellOpenExternal` is https-only and rejects credential-bearing URLs** — `register.ts:2401-2420` (zod parse + `new URL` + protocol + username/password checks).
4. **Preload: single `vyotiq` bridge key, all inbound events schema/structurally validated, no Node primitives** — `preload/index.ts:574` and listener review above.
5. **Window flags all present:** contextIsolation/sandbox true, nodeIntegration/webSecurity per Electron best practice — `window.ts:96-99`.
6. **Navigation locked to the loaded app; window.open denied; external links https-only** — `security.ts:31-46`.
7. **Permissions allow-listed to audio-only media + sanitized clipboard write, same-window enforced** — `security.ts:16,48-60`.
8. **Certificates: no override path; Chromium default verdict always taken** — `security.ts:70-81`.
9. **Updater fully opt-in (autoDownload/autoInstallOnAppQuit false, web installer disabled), deduped, install gated on completed download, no polling** — `updater/index.ts:68-70,148-161,186-193`.
10. **Secrets: safeStorage-only with basic_text refusal, atomic 0600 writes, serialized mutation chain, corrupt-store write refusal, values never logged** — `secrets.ts` (cited above).
11. **M4: no `blob:` URL generation exists anywhere in `src/`; production `img-src 'self' data:` covers every shipped image surface; no media-src/worker-src needed** — evidence under L1.
12. **Bounded perf state across `src/main/perf/**` and adjacent logging state** — cited above.
13. **`streamBatch.ts` registers no IPC channels and retains no unbounded per-run state.**
14. **Round-1's "5 MB at logging/init.ts:63" confirmed still true** (`init.ts:63`).

## Unknowns

1. **Round-1 report unavailability:** `AUDIT-REPORT-2026-09-10.md` does not exist in this worktree (it is untracked in the parent workspace and instance worktrees do not receive untracked files). Round-1 findings other than what the task brief carried (M4 description, sampled handler validation, the 5 MB cap) could not be cross-checked; everything in this report was re-derived from the current tree.
2. **M4 verdict is static analysis:** no packaged build was run (contract forbids it). The verdict that nothing breaks in production rests on the absence of `createObjectURL`/`blob:` construction anywhere in `src/` plus the verified `data:`-URL image paths — not on runtime observation. `ImageChip`/`ImageLightbox` call sites were not exhaustively traced individually, but in-app code cannot construct a `blob:` URL to pass them.
3. **Line-number drift vs round 1:** security.ts/updater.ts line references from round 1 (e.g. updater `:44-56`) no longer match the current tree (flags now at `:68-70`); this report cites current-tree lines only.
4. **`FilePreview` HTML iframe (`FilePreview.tsx:56-63`)** allows a user-toggled `sandbox="allow-scripts"` srcdoc preview of workspace HTML files. This is renderer UI behavior outside this workstream's M4/CSP question; a srcdoc frame inherits the page CSP and the sandbox lacks `allow-same-origin`, but a dedicated Xss/preview review would be needed to fully close it — flagged for the appropriate section, not resolved here.
