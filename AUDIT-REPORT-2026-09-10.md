# Codebase Audit Report — 2026-09-10 (Round 2, consolidated)

**Scope:** full audit of the Agent V Electron app — main process (`src/main/**`), agent core (`src/main/agent/**`), renderer (`src/renderer/**`), preload (`src/preload/index.ts`), shared schemas, build/scripts/CI (`scripts/**`, `electron-builder.yml`, `electron.vite.config.ts`, `.github/workflows/**`, `pnpm-workspace.yaml`, `vitest.config.ts`), landing, docs, and runtime state under `%APPDATA%\vyotiq`.

**Method (round 2):** six read-only audit workstreams executed in parallel by child instances, each delivering a detailed section under `audit/sections/`:

1. `audit/sections/01-runtime.md` — runtime state & telemetry: fresh measurements, log-pattern analysis, crash-telemetry root cause
2. `audit/sections/02-agent-core.md` — near-exhaustive agent-core review (all 3989 lines of `loop.ts`, all queue/registry/checkpoint files), with a per-file coverage table
3. `audit/sections/03-tools-security.md` — all 60 tool handlers, registry parity, approval gating, and an **executed** bsdtar path-traversal probe
4. `audit/sections/04-ipc-app-shell.md` — all 193 IPC registrations, preload, CSP/window hardening, updater, secrets
5. `audit/sections/05-renderer-shared.md` — performance-rule adherence per gate, React 19 purity, sanitize paths, a11y
6. `audit/sections/06-build-ci-deps.md` — release/deploy/CI workflows read directly, supply-chain pins, `pnpm audit` executed, docs drift

The parent ran shared verification (`pnpm typecheck`, `pnpm lint`, full `pnpm test`) in the main tree and spot-verified each child's headline claims (including one correction, in M1 below). The tree carries a large in-flight refactor (77 modified files) — findings describe the working tree; `release.yml`, `deploy-landing.yml`, `ci.yml`, `electron.vite.config.ts`, and `pnpm-workspace.yaml` are identical to HEAD, so those findings apply to pushed code too.

**Verification status (all executed this run):**
- `pnpm typecheck` — **PASS** (exit 0)
- `pnpm lint` — **PASS** (exit 0)
- `pnpm test` (full suite; no 40-min valve trip) — **FAIL, exactly 1 failing test: `tests/main/unit/toolsSchema.test.ts:260` "keeps the bundled spine under the token ceiling": `expected 2003 to be less than 2000`.** The in-flight modified `resources/harness/default.md` exceeds the harness token budget by 3 tokens; the run's exit-1 is entirely this assertion (evidence: `audit-test-run.log`).

---

## Executive summary

No Critical findings. The security architecture is strong for its class: sandboxed preload with a single bridge key, **100% zod-validated IPC (152/152 payload channels, zero gaps — full-file read of `register.ts`)**, symlink-aware workspace containment with post-create re-assert, safeStorage-only secrets with corrupt-store refusal, SSRF-guarded fetch with DNS-rebinding pinning, opt-in updater, SHA-pinned CI, tight pnpm supply-chain pins, and **registry parity verified at 60 tools (60 handlers, 1:1)**.

The material risks are:

1. **The tree currently fails its own test gate** (harness token ceiling, 2003 ≥ 2000) — release-blocking for the in-flight work, trivially fixable.
2. **Unbounded disk growth on two paths** — per-workspace storage (measured **+0.9 GB in ~24 h**, never pruned on workspace removal) and checkpoint blobs/`index.json` (never GC'd, up to 20k-file directory-delete snapshots).
3. **Marketplace content has zero integrity verification** and accepts `http://` registries — a compromised registry reaches attacker-specified MCP `command`/`args`. (The round-1 tar-traversal worry is closed on Windows by an executed probe; this integrity gap is the real risk.)
4. **Unsigned release builds** (verified directly from `release.yml` this round) — longest-lead-time trust gap.
5. **Crash telemetry blind spot** — 3 renderer crashes (`UpdateCard` TypeError) are structurally invisible to `crash-history.json`.

Four round-1 verdicts changed materially (table below); one child error was corrected by parent verification (`activityStats.ts` exists).

---

## Round-1 findings — re-verification verdicts

| Round-1 ID | Claim | Round-2 verdict |
|---|---|---|
| H1 | Release builds + update chain unsigned | **VERIFIED directly** from `release.yml:11-15,85-92` + `electron-builder.yml:80-86,127` (→ H1) |
| H2 | Landing deploy broken, serves v1.0.0 | **REFUTED** — live CTA points at `vyotiqai/vyotiq-agent-v-releases/releases/latest`; a deploy succeeded after this morning's releases-repo switch. Residual is docs rot (→ M8, M9) |
| H3 | Regex sanitizer before `dangerouslySetInnerHTML` | **Still open, downgraded to Medium** — only 2 injection sites exist; production CSP blocks inline script; **dev CSP allows `'unsafe-inline'`** (→ M7) |
| M1 | Sync I/O on main-process agent paths | **Confirmed and enlarged**; child's "activityStats.ts does not exist" refutation was wrong — file exists (in-flight, untracked), `readdirSync` verified at `:220-225` (→ M1) |
| M2 | Runtime data grows without retention | **Partially refuted** — trace retention, archive caps, dictation deletion, log rotation all exist; **per-workspace storage genuinely unbounded** (→ H5) |
| M3 | Marketplace tar extraction no integrity check | **Traversal CLOSED on Windows** (executed probe; → M10 for platform caveat) — but **replaced by a bigger verified gap: no checksum/signature anywhere** (→ H3) |
| M4 | Prod CSP omits `blob:` from `img-src` | **Resolved: dead directive** — zero `createObjectURL`/`blob:` usage in `src/**`; all image surfaces render `data:` URLs (→ L9) |
| M5 | Docs drift (tool count, release state) | **Confirmed and extended** (→ M8) |
| M6 | Renderer crashes + edit-tool failure mode | **Confirmed and root-caused** (→ H6, M11) |
| L1 | Repo-root clutter | Confirmed, list refreshed (→ L10) |
| L3 | Coverage floor 40/35/30 | Confirmed (`vitest.config.ts:55-58`) |
| L4 | 40-min valve false-fail | Confirmed **with scoping correction**: only local `pnpm test` goes through the wrapper; CI's `test:coverage` gate is unaffected |
| L5 | GoalRunBanner 1 s always-on interval | **FIXED** — now armed-gated (`GoalRunBanner.tsx:35-39`) |
| L6 | Terminal 30-min max wait | **WORSENED** — the 30-min constant is now documented as a "former upper bound"; `timeoutMs` has no schema max (→ L2) |

---

## Findings — High

### H1. Release builds and auto-update chain are unsigned (round-1 H1, verified from the workflow)
- **Evidence:** `release.yml:11-15` (`CSC_LINK` unset → pack unsigned), `:85-92` (`--config.mac.identity=null` fallback); `electron-builder.yml:80-86` (publisherName "MUST stay unset while release builds are unsigned"), `:127` (`mac.notarize: false`); no `win.forceCodeSigning`; nothing fails an unsigned release. Live v1.1.3 release verified complete in `vyotiqai/vyotiq-agent-v-releases` (all installers + all three `latest*.yml`).
- **Impact:** users cannot verify installer authenticity; updater integrity rests on TLS + GitHub trust.
- **Remediation:** acquire Authenticode/Developer ID; re-add `publisherName` together with `win.forceCodeSigning: true`; enable notarization. Whether signing secrets are actually set in the repo is **UNKNOWN** (unreadable from the tree).

### H2. Harness token ceiling violated — the tree fails its own test gate (NEW, from verification)
- **Evidence:** `tests/main/unit/toolsSchema.test.ts:260` asserts `estimateTextTokens(harness) < 2000`; measured **2003** on the modified `resources/harness/default.md` (this run, `audit-test-run.log`).
- **Impact:** any push of the current tree fails CI's `test:coverage` gate. Release-blocking for the in-flight work; the ceiling is doing its job (the spine must stay under budget).
- **Remediation:** trim the harness spine ≥3 tokens; consider deriving the ceiling check from the registry to prevent recurrence.

### H3. Marketplace content has no integrity verification; registry transport not pinned to HTTPS (NEW)
- **Evidence:** download → extract with no hash/signature gate (`install.ts:602` → `:605`); grep `sha256|checksum|signature|integrity|digest` across `src/main/marketplace/**`: **zero matches**; catalog only zod-shaped (`catalog.ts:60`). `assertRegistryDownloadUrl` (`install.ts:76-92`, verified by parent read) requires only protocol+host match with the configured registry — **`http://` is accepted**. A malicious `kind: mcp` package's `vyotiq.mcp.json` becomes an enabled MCP server with attacker-specified `command`/`args` (`install.ts:244-267,332-345`); only friction is the one-time remote-install ack.
- **Impact:** supply-chain RCE chain from a compromised or cleartext registry into MCP server configuration.
- **Remediation:** verify the downloaded archive against a published digest before extraction; reject `http:` registries; sign/authenticate the catalog.

### H4. Checkpoint blobs and `checkpoints/index.json` are never garbage-collected (NEW)
- **Evidence:** every file-touching invoke appends to the index (`checkpoints.ts:331-352,373-377`); index handlers only append (`:100-121`); resolve/rewind paths stamp meta but never delete (`:595-674,790-821`); only whole-run `deleteRun` reaps. Directory-delete snapshots copy up to `maxDirRestoreFiles = 20000` files each (`:249-275`).
- **Impact:** every agent-edited file keeps a full prior-content copy forever; a `node_modules`-scale delete snapshots 20k files. Compounds H5 on the same disk.
- **Remediation:** retention policy (delete `resolved && undone` blobs; age/count cap; async prune after run end).

### H5. Per-workspace runtime storage grows without bound and survives workspace removal (round-1 M2, confirmed)
- **Evidence (measured 2026-09-10 08:15):** `workspaces/` = **4,492 MB / 12,328 files / 49 dirs** — **+0.9 GB, +5 dirs in ~24 h** vs round 1. A zero-session workspace still holds ~101 MB (codeindex 78 MB + sparsegrep sqlite 23 MB); the active workspace holds 65 session dirs, `messages.jsonl` up to 6 MB, 186 MB instance worktrees. `removeWorkspace` (`workspaces.ts:585-606`) never deletes storage; no session age/count cap exists anywhere (grep: zero hits).
- **Impact:** dominant disk-growth risk of the install; removed workspaces leave permanent footprints. (Partial attribution of 24 h growth to this audit's own worktrees: UNKNOWN.)
- **Remediation:** prune-or-offer on workspace removal; session-dir cap; Settings → Storage surface with per-category sizes + reclaim. Related: trace retention is count-based (10 files ≈ 500 MB worst case, `traceCapture.ts:65,97-114`).

### H6. Renderer React crashes never reach `crash-history.json` (round-1 M6, root-caused)
- **Evidence:** `crash-history.json` = empty while the log holds **3 RENDERER_CRASH records — all the same `TypeError: Cannot read properties of undefined (reading 'length')` in `UpdateCard` (2026-09-08 23:16–23:17)**. Structural cause: crash-history's only writer fires on `render-process-gone`/`child-process-gone` (`crashDiagnostics.ts:172`; wired `logging/init.ts:126,227`); these are error-boundary records (`ErrorBoundary.tsx:49`) that never reach it, and the backfill parser can't match their shape — and is permanently disabled (`backfillVersion: 1`).
- **Impact:** Settings shows empty crash history while the UI crashed repeatedly; the `UpdateCard` bug goes untracked.
- **Remediation:** route error-boundary records into `recordCrashSnippet` (IPC or bridge-side detection of `RENDERER_CRASH` records); fix the `UpdateCard` undefined prop.

---

## Findings — Medium

### M1. Main-thread synchronous I/O on agent hot paths (round-1 M1, enlarged)
- **Evidence (all re-verified):** `checkpoints.ts:88` (sync sha256 of whole files, main thread, in finalize + restore paths); `harnessReview.ts:101-112`; `harnessApply.ts:366,372` (+ `:203,226,233`); `followUpStore.ts:33`; `harness.ts:85,112`; `loopCheckpoint.ts:16`; `loop.ts:1180`. **Correction:** `activityStats.ts` exists (in-flight untracked) — `existsSync`+`readdirSync` scans confirmed at `:220-225` (parent-verified). **Newly found per-step class:** `readGoal` (`runGoal.ts:24-27`) + `readTodos` (`tools/todo.ts:36-38`) sync-read **every step**; skills/plugin-rule rescan every step (`loop.ts:1842` → `skills/index.ts`); every 5 steps a full sync transcript read + sync receipt/trajectory writes (`loop.ts:974-1000`; `runTrajectory.ts:212-214`); broad sync surface in `state.ts` (`:201-209,356-370,436-459,677-703,712-725,1173-1196,1437-1450`).
- **Impact:** main-thread stalls proportional to transcript/blob sizes — UI jank and timer drift; the step loop itself is the hot path.
- **Remediation:** memoize goal/todo reads with mtime invalidation; async background skills rescan; async receipts/trajectory (async loaders already exist in `state.ts`); async hash. Benchmark with `VYOTIQ_PERF=1`.

### M2. `deleteRun` TOCTOU — run directory deletable under a restarting run (NEW)
- **Evidence:** `state.ts:1350` (active check) → `:1358-1375` (multiple awaits) → `rmSync` at `:1387`; `tryRegisterRunAbort` (`runRegistry.ts:150-172`) can admit the same runId during the awaits.
- **Impact:** a live run's dir can be deleted mid-flight → append failures, phantom status dir, receipt errors.
- **Remediation:** tombstone the runId in the registry until delete completes, or re-check `isActive` immediately before `rmSync`.

### M3. Events archive rotation `unlink` is unguarded — one undeletable archive kills the run's event persistence (NEW)
- **Evidence:** `eventAppendQueue.ts:90-113` — `await unlink(oldest)` with no try/catch inside the append chain; a persistent failure (EBUSY/EPERM, common on Windows) fails every subsequent event append and terminates the run with a `PERSIST` error (`loop.ts:1768-1786`). The messages queue guards the identical operation (`messageAppendQueue.ts:172-180`, "best effort").
- **Remediation:** mirror the messages queue (skip-and-log).

### M4. Oldest transcript history silently and permanently lost past 5 archives (NEW)
- **Evidence:** `MAX_MESSAGE_ARCHIVES = 5` (`messageAppendQueue.ts:171-183`); stitched readers concatenate survivors only (`state.ts:356-370,745-764`); nothing logs the eviction; resume, rewind, export, and receipts operate on the truncated view; `appendOrphanToolStubs` can miss rotated-out tool_use pairs.
- **Remediation:** log archive-cap eviction once per run; refuse rewind below the retained window rather than rewinding a partial view.

### M5. `wait_forever` offline mode can hold all 8 run slots indefinitely (NEW)
- **Evidence:** `networkMonitor.ts:16-27` returns `Infinity` for `wait_forever`+autonomous; `:100-125` polls unbounded; `MAX_ACTIVE_RUNS = 8` (`runRegistry.ts:57,150-172`) — 8 offline-waiting runs block every new `chatStart` with `RUN_LIMIT_REACHED`.
- **Remediation:** surface slot exhaustion with cause; consider admitting one interactive run above the cap.

### M6. Silent corrupt-state degradation in cold-start loaders (NEW)
- **Evidence:** `followUpStore.ts:30-36` (queued tasks vanish, no log); `loopCheckpoint.ts:16-20`; `state.ts:201-209`; `runGoal.ts:24-29`; asymmetric catch blocks `loop.ts:1374-1377` (silent) vs `:1402-1409` (logged).
- **Impact:** a corrupt file silently resets user-visible state (task queues, streaks, totals) with nothing to diagnose.
- **Remediation:** warn-level log in each default-return catch; align the two checkpoint persist paths.

### M7. Highlighted-code path still bypasses rehype-sanitize via the regex sanitizer (round-1 H3, downgraded)
- **Evidence:** `sanitizeHighlightedHtml` regex chain (`markdownSanitize.ts:145` with its own NOTE at `:131-138`) injected at `MarkdownContent.tsx:213`; only two `dangerouslySetInnerHTML` sites in the renderer (this + `MermaidDiagram.tsx:69`, which has `securityLevel: 'strict'`). Production CSP `script-src 'self'` blocks inline script; **dev CSP allows `'unsafe-inline'`** (`security.ts:101`) — there the regex is the only barrier.
- **Remediation:** route highlighted code through `hast-util-sanitize` as the file's NOTE prescribes; keep the regex pass as a second belt.

### M8. Docs and runbook drift (round-1 M5, extended — now operator-facing)
- **Evidence:** README claims **61** tools; registry has exactly **60** (recounted twice; test asserts 60). `AGENTS.md` still says "Released so far: v1.0.0 … Next: 1.0.1" vs `package.json` 1.1.3, and names the old publish repo. **`RELEASE-RUNBOOK.md` documents the wrong publish repo (`vyotiqai/vyotiq-agent-v`) and the wrong token name (`GITHUB_TOKEN` vs `RELEASES_TOKEN` used by `release.yml:79`)** and its §4/§7 verification commands query the wrong repo. Landing install docs still name v1.0.0 artifacts; `PRODUCTION-READINESS.md` stops at v1.1.1 and still calls the landing deploy "blocked". The landing release-bake pipeline (`bake-github-release.mjs` → `github-release.json`, baked v1.1.3) is **dead code** — no landing component consumes it.
- **Impact:** an operator following the runbook would query the wrong repo or "fix" the token name and break releases; agents follow stale AGENTS.md.
- **Remediation:** update runbook repo/token/API paths; single-source the tool count; refresh AGENTS.md release section, landing install docs, readiness history; delete or re-consume the bake pipeline.

### M9. `pnpm audit`: 4 moderate / 0 high — one moderate is unpatchable in a runtime dep path (NEW, executed)
- **Evidence (exit 0 at `--audit-level high`):** `adm-zip` (GHSA-vwc7-r8mq-g2x9, symlink-following extraction; **no patched version exists**) via `onnxruntime-node`; the workspace override `adm-zip: '>=0.6.0'` resolves **inside** the vulnerable range. Also `colord` (via `@lobehub/icons`) and `vitest <4.1.11` (dev-only). Whether `adm-zip` is reachable at packaged-app runtime (vs onnxruntime install-time only) is **UNKNOWN**.
- **Remediation:** track the advisory; bump when patched; annotate the override so it isn't mistaken for a fix; adopt vitest 4.1.11+.

### M10. Archive-extraction safety is delegated to the platform tar (round-1 M3 residue)
- **Evidence:** executed probe: Windows bsdtar 3.8.8 with the exact `install.ts:190-193` flags **refused** `../evil.txt` and `..\evil-win.txt` (exit 1 → `execFileAsync` rejects → install aborts) and stripped an absolute entry into the dest dir. But `assertExtractContained` (`install.ts:164-182`) walks only `destDir` — a file written outside it would be invisible. GNU tar on Linux (the typical system tar) is documented to extract `..` members; **not probed — UNKNOWN**.
- **Remediation:** pre-scan entries (`tar -tf`) and reject non-contained paths instead of relying on binary defaults.

### M11. Edit-tool diff-hunk failures remain the top agent-failure mode (round-1 M6, persists)
- **Evidence:** same log window as round 1: 9 "Diff hunk failed to match near line N" + 8 "the bare @@ header declares no line" error entries — identical counts, no regression but no fix. Also 12+10 provider `custom` HTTP/network failures plus a dead `ECONNREFUSED 127.0.0.1:11434` local endpoint burning retries.
- **Remediation:** auto-recover bare-`@@` headers; one-shot re-read+retry on context mismatch; fail fast on local-endpoint connection refusal with a "backend not running" hint.

---

## Findings — Low

- **L1.** `useNetworkStatus.ts:40-43` — unconditional 15 s network probe for the app's lifetime, not visibility-gated (the one renderer interval that ignores visibility).
- **L2.** Terminal `timeoutMs`/`block_until_ms` unbounded — schema has `min(1)` and no max; `TERMINAL_MAX_TIMEOUT_MS = 1_800_000` is documented as a "former upper bound" (`terminal.ts:54-57`). Reinstate a schema-level max. (Round-1 L6, worsened.)
- **L3.** `AboutSection.tsx:124` — `new Date().getFullYear()` in render body: React 19 Compiler purity violation (benign but the pattern the compiler may memoize incorrectly).
- **L4.** All jsx-a11y rules run at `warn` severity (`eslint.config.mjs:77-124`) — findings never fail CI unless `--max-warnings 0` is enforced (enforcement level UNKNOWN).
- **L5.** `writeGuard.ts` path_scope prefix match is case-sensitive on Windows while the parallelism key lowercases (`classify.ts:151-155`) — instance-isolation bypass only, not a workspace escape.
- **L6.** `listRuns` touches `raw` before schema parse (`register.ts:1827-1830`); the editor-flush ack channel is structurally (not zod) validated (`src/main/index.ts:111-121`) — both contained; hygiene only.
- **L7.** Agent-core bounded-leak batch: `runLoopScheduler` meta entries for deleted runs (`runLoopScheduler.ts:29-31,73-81`); `stream_snapshot` events grow O(N·T) per generation (`loop.ts:2375-2390`); circuit-breaker map unbounded by key (`circuitBreaker.ts:62-77`); `startAgentRun` relaunch maps persist until cancel; `renameRun` sync reads (`state.ts:1437-1450`).
- **L8.** Release workflow has **no tag↔`package.json` version-match guard** (`release.yml:90` publishes whatever the package says) — the runbook's worst failure mode is prevented only by discipline. Cheap CI step closes it. Wrangler pinned by major only in `deploy-landing.yml:75-76` (every other action is SHA-pinned).
- **L9.** Dev CSP `img-src … blob:` is a dead directive (zero `createObjectURL` in `src/**`) — delete it or add a CI grep guard so the dev/prod delta can never silently diverge.
- **L10.** Repo clutter (untracked): `asar-list.txt`, `repro-askquestion.mjs`, `screenshots/`, `scripts/tmp-release-notes-v11{2,3}.md`, this audit report and `audit-test-run.log`; committed one-off scripts `brand-variants*.mjs`, `_unbounded-wordmark.mjs`. Add ignore rules; commit or discard the in-flight untracked source files (one `git clean` from loss).
- **L11.** In-file comment inaccuracy: `install.ts:186-187` claims tar "refuses `..` / absolute entry paths" — the probe shows absolute entries are sanitized (drive letter stripped), not refused.
- **L12.** Renderer residual idle polls: 2 s todos/goal fallback while a dock is mounted with no run (`useRunTodos.ts:105-106`); plan-draft readiness poll continues after run end (`ChatView.tsx:998-1023`).

---

## Verified non-issues (round 2, extended)

- **IPC:** 193 registrations; 152/152 payload channels zod-validated; every handler `senderOk`-gated to the main window + main frame (`register.ts:489-506`); errors classified without echoing payloads.
- **Preload:** single `vyotiq` bridge key; every inbound event schema/structurally validated; no Node primitives leak; `browserGetState` re-validates main's response.
- **Electron hardening:** `contextIsolation`/`sandbox` on, `nodeIntegration` off, `webSecurity` on (`window.ts:96-99`); window.open denied, navigation locked, external links https-only; permissions allow-listed to audio-only media; cert failures never bypassed (`security.ts:31-81`).
- **Updater:** opt-in, no polling, deduped, install gated on completed download (`updater/index.ts:68-70,148-161,186-193`).
- **Secrets:** safeStorage-only with `basic_text` refusal, atomic 0600 writes, serialized mutations, corrupt-store write refusal, no values logged (`secrets.ts` full read).
- **Tool layer:** 60/60 registry↔handler parity (compile-time `Record` type + test); zod per tool with prototype-key guard; output caps (terminal 64 KB, webFetch 2 MB, marketplace 100 MB); every writer routes through symlink-aware containment with post-create re-assert; `delete` refuses workspace root; diagnostics/run_tests reject metacharacters and `..`; SSRF suite incl. decimal/hex IPv4 and DNS-rebind pinning; npm packs `--ignore-scripts`; git clones with `protocol.file.allow=never`; MCP `readOnlyHint` untrusted for approval and parallelism; inline-instance `path_scope` enforced for writers and `git_commit` paths; browser tools always approval-gated.
- **Agent core (exhaustively reviewed):** quit quiesce bounded at 15 s; zombie force-finish at 30 s (round 1 conflated the two); append queues serialized with settle-time self-eviction; retry caps all bounded; 429s terminal without retry burn; cancel-vs-flush and turn-complete TOCTOU closed atomically; terminal ordering error → checkpoint → status.
- **Runtime state:** log rotation capped 5 MB; trace recorder memory-bounded (16 MB ring, retention 10); archive caps enforced; dictation-model delete surface exists; zero ENOENT / unhandled rejections / native crashes in the window; secrets never echoed.
- **Renderer:** all quoted performance gates PASS (git status on-demand, todos 500 ms gated, Files 2 s dirty+visible, virtualized transcript, lazy docks, narrow `Object.is`-stable store subscriptions, no `sendSync`); composer paste single-pass insertion sound; stream-start retries bounded with full state restore; consistent unmount guards; stable list keys; a11y ruleset genuinely enforced (warn level).
- **Build/CI:** tag-push-only release with degraded manual dispatch; artifacts `if-no-files-found: error`; job-scoped permissions; all actions SHA-pinned; pnpm 11 pins verified (`minimumReleaseAge`, `nodeLinker: isolated`, `allowBuilds`, per-CVE overrides); `asar: true` with narrow `asarUnpack`; Sentry DSN build-time `define`; `pnpm audit --audit-level high` passes; CI runs typecheck, coverage, lint, build, landing build/check/audit, dir smoke package, and 3-OS GUI e2e.

---

## Unknowns (remaining, explicitly not verified)

- Whether signing secrets (`CSC_LINK`, `APPLE_*`, `RELEASES_TOKEN`) are actually set in the GitHub repo; actual signedness of published v1.1.3 assets (not downloaded/inspected).
- Whether the Cloudflare secrets are now set or the observed landing deploy was manual (live site proves a deploy happened; run history not queried).
- GNU tar / macOS bsdtar `..` behavior (drives M10); `adm-zip` runtime reachability (M9).
- Agent-core files swept but not read line-by-line: `executeStepTools.ts`, `compactRun.ts`, `runReceipt.ts` internals, `rewindRun.ts`, `toolApproval.ts` internals, `skills/*` bodies, providers/SSE abort semantics — see the coverage table in `02-agent-core.md`.
- Full `src/shared` ↔ main schema drift was bounded to the git domain (16 of 17 modules not diffed); `src/shared/vyotiqApi.ts` (27 KB) unread.
- Whether lint treats `warn` as failing (`--max-warnings 0`); runtime a11y gaps (focus restoration, live regions) not audited.
- Renderer storage-management/trace UI surfaces and dictation size disclosure before download; `FilePreview.tsx:56-63` srcdoc `sandbox="allow-scripts"` preview (flagged, unresolved).
- `mcp_read_resource` untrusted-content wrapping; agent-browser window webPreferences (different workstream).
- `gh-cli.json` absolute-path pin (round-1 L2) not re-read.

---

## Prioritized remediation order

1. **H2** — trim the harness spine ≥3 tokens (CI blocker for the in-flight tree; minutes of work).
2. **H6** — fix the `UpdateCard` crash and wire error-boundary records into `crash-history.json` (user-visible crashes, recurring).
3. **H3** — marketplace integrity: archive digest verification + reject `http://` registries (real supply-chain RCE path).
4. **H5 + H4** — one storage workstream: workspace-storage prune-on-removal + session caps + Settings→Storage surface; checkpoint blob GC. Disk is the measured growth risk (+0.9 GB/day).
5. **M2 + M3** — small agent-core reliability fixes: `deleteRun` tombstone; guard the events unlink (one undeletable archive kills a run).
6. **M1** — move per-step sync I/O off the main thread (goal/todo memoization, async skills rescan, async receipts) — top UI-stall class.
7. **M7** — route highlighted code through `hast-util-sanitize` (closes the one real injection channel; file's own NOTE).
8. **M8** — runbook/docs refresh (wrong repo/token names are operator-facing breakage) + tool-count single-sourcing.
9. **H1** — code signing roadmap (biggest trust gap, longest lead time).
10. **M4–M6, M9–M11, L1–L12** — batched follow-ups (silent-loss logging, wait_forever UX, corrupt-state logging, adm-zip tracking, extraction pre-scan, edit-tool auto-recovery, hygiene).

---

**Deliverables:** this report (consolidated) + `audit/sections/01-runtime.md` … `06-build-ci-deps.md` (full evidence, `path:line` citations, per-workstream coverage tables and unknowns) + `audit-test-run.log` (full-suite output). Sections were produced in child-instance worktrees and extracted into the main tree; the main tree's 77 in-flight modified files were not touched.
