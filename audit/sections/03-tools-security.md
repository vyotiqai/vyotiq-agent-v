# Section 03 — Tool Layer Security Review (round 2)

Date: 2026-09-10 · Auditor: Agent V security instance (read-only; only this file written)
Scope: `src/main/agent/tools/**`, `src/main/agent/schemas/tools.ts`, `src/main/agent/toolApproval.ts`, `src/main/workspace/safePath.ts`, `src/main/storage/paths.ts`, `src/main/marketplace/install.ts` (+ `catalog.ts`, `paths.ts`), as they exist in the **current uncommitted tree** of this instance worktree. Tests were not run (audit rule); test-file claims below are reads of source only.

Marker legend: **[VERIFIED]** = observed in code/terminal this run, with `path:line`. **[UNKNOWN]** = not verified this run.

> Note on round-1 report: `AUDIT-REPORT-2026-09-10.md` is **not present in this instance worktree** (it is an untracked file in the main workspace and does not propagate to instance worktrees; `glob **/AUDIT-REPORT*` found nothing). Round-1 M3 content and line anchors below are therefore taken from the run contract, and each was re-verified against the current tree. Several round-1 line anchors have drifted (see L-4).

---

## Executive summary

- **Registry parity: PASS — exactly 60 registered tools, 60 wired handlers, 1:1 match.** `TOOL_REGISTRY` at `src/main/agent/schemas/tools.ts:973` contains 60 entries (grep of per-entry `schema:` fields returns exactly 60 hits, `tools.ts:977`–`tools.ts:1260`); `BUILTIN_HANDLERS` at `src/main/agent/tools/index.ts:517` is typed `Record<AgentToolName, ToolHandler>` (compiler-enforced parity) and all 60 keys were individually located (`index.ts:518`–`index.ts:1933`). A unit test asserts both parity and count 60 (`tests/main/unit/toolsSchema.test.ts:63-68`).
- **M3 (marketplace tar extraction) — CLOSED: mitigated on Windows by an executed probe.** Windows `tar.exe` is bsdtar 3.8.8/libarchive 3.8.8; with the exact flags `install.ts` uses, it **refused** `../evil.txt` and `..\evil-win.txt` entries ("Path contains '..'", non-zero exit, nothing written) and **stripped the drive letter** of an absolute entry, writing it as a contained relative path under `-C <dest>`. Because `execFileAsync` rejects on non-zero exit, a hostile archive aborts the install. Residual risk: the `..` refusal is a property of bsdtar, not of the app, and the post-extract containment walk cannot see files written *outside* the destination — see M-1 (platform dependence) and H-1 (no integrity verification at all).
- **Integrity verification of marketplace content: ABSENT.** No checksum, signature, or digest check exists anywhere in `src/main/marketplace/**` (grep `sha256|checksum|signature|integrity|digest` → zero matches). Combined with a registry transport that is not pinned to HTTPS, a compromised or MITM'd registry can deliver arbitrary package content, which for `kind: mcp` becomes a registered MCP server with attacker-specified `command`/`args` (arbitrary command execution) — H-1.
- The tool-layer containment story is otherwise strong: every filesystem-writing handler routes through `resolveInsideWorkspace` + `assertResolvedInsideWorkspace` (symlink-aware, post-create re-assert), `delete` refuses the workspace root, diagnostics/run_tests reject shell metacharacters and `..` binaries, and webFetch's SSRF suite (private/loopback ranges, decimal/hex IPv4, DNS-rebinding pinning, per-hop redirect validation, byte caps) checks out.

---

## Findings

### H-1 — Marketplace packages have no integrity verification; registry transport not pinned to HTTPS **[VERIFIED]**

**Severity: High** (preconditions: user has configured a remote registry URL, acknowledged install risk, and initiated an install)

**Evidence:**
- Extraction happens immediately after download with no hash/signature gate: `src/main/marketplace/install.ts:602` (`await downloadToFile(downloadUrl, archivePath)`) → `install.ts:605` (`await extractArchive(archivePath, extractDir)`). `downloadToFile` (`install.ts:219-221`) is a bare wrapper over `downloadPublicUrlToFile` (`src/main/agent/tools/webFetch.ts:760`).
- Grep for `sha256|sha-256|checksum|signature|integrity|digest` across `src/main/marketplace/*.ts` → **zero matches**. The catalog is only zod-shaped (`MarketplaceCatalogSchema.parse`, `src/main/marketplace/catalog.ts:60`), never authenticated.
- Origin pinning is relative, not absolute: `assertRegistryDownloadUrl` (`install.ts:77-92`) only requires the download URL's `protocol` and `host` to match the *configured* `registryUrl`. An `http://` registry URL is accepted, so catalog (`catalog.ts:55-57`) and package downloads can run in cleartext. No TLS/cert pinning exists.
- A malicious `kind: mcp` package reaches command configuration: `mcpServerFromManifest` (`install.ts:244-267`) turns `vyotiq.mcp.json` into a settings MCP server with `command`, `args`, `env` (`sanitizeMcpManifestEnv` filters env only), and `registerInstalled` defaults `enabled` to `true` (`install.ts:332-345`, `enabled: prior?.enabled ?? true`). `source: 'remote'` installs take an arbitrary http(s) URL (`install.ts:470-508`).
- Only friction: the one-time ack gate (`install.ts:626-627`, `remoteInstallAcked`) and the same-origin check above.

**Impact:** a compromised registry, or an on-path attacker when the registry URL is http, can serve an archive whose `vyotiq.mcp.json` spawns arbitrary commands the next time the MCP server starts — a supply-chain RCE chain. Even for benign installs, tampering is silent and undetectable after the fact.

**Remediation:** add `sha256` to catalog entries and verify the downloaded archive before `extractArchive`; require `https:` for remote registries (reject `http:` in `assertRegistryDownloadUrl`); consider signing the catalog and pinning the registry identity.

### M-1 — `..` traversal refusal is delegated to the platform tar; post-extract containment cannot see escapes **[VERIFIED on Windows; UNKNOWN on Linux/macOS]**

**Severity: Medium**

**Evidence:**
- Extraction shell-out: `extractArchive` (`install.ts:184-195`) runs `execFileAsync('tar', ['-xf', archivePath, '-C', destDir])` for `.zip` and `['-xzf', ...]` otherwise; the comment at `install.ts:186-187` claims tar "refuses `..` / absolute entry paths".
- Executed probe (this run, fresh `%TEMP%\vyotiq-audit-tarprobe`, since cleaned up; archive hand-crafted with USTAR entries `good.txt`, `../evil.txt`, `..\evil-win.txt`, and an absolute path inside the probe dir):
  - `tar --version` → `bsdtar 3.8.8 - libarchive 3.8.8 zlib/1.2.13.1-motley liblzma/5.8.1 bz2lib/1.0.8 libzstd/1.5.7 cng/2.0 libb2/bundled`
  - `tar -xf evil.tar -C dest` → exit **1**, verbatim stderr:
    ```
    ../evil.txt: Path contains '..': Unknown error
    ..\\evil-win.txt: Path contains '..': Unknown error
    tar.exe: Removing leading drive letter from member names
    tar.exe: Error exit delayed from previous errors
    ```
  - `tar -xzf evil.tgz -C dest2` → identical result (exit 1, same three errors).
  - Post-extract listing: only `dest\good.txt` and `dest\Users\ajay\AppData\Local\Temp\vyotiq-audit-tarprobe\abs-evil.txt` were created (the absolute entry, drive-letter-stripped, **inside** `dest`). No `evil.txt` or `evil-win.txt` appeared anywhere outside the extraction dir; nothing was written at the absolute target.
- However, the app-level gate `assertExtractContained` (`install.ts:164-182`) walks only `destDir`. A file an extractor writes *outside* `destDir` (via a `../` member) is invisible to the walk, and the `cleanup()` `rmSync(tmp)` (`install.ts:519-523`) removes only the temp tree — the escaped file would persist on disk undetected. On Windows this is unreachable *today* because bsdtar errors out and `execFileAsync` throws; the defense is entirely the platform binary's default. On Linux the system `tar` is typically GNU tar, whose default handling of `..` members differs (GNU tar is documented as extracting them — the classic "tar-slip" class); this app does not bundle or pin a tar implementation for that platform. **Windows: verified safe. Linux/macOS: UNKNOWN — unprobed in this environment.**

**Impact:** on any platform whose tar extracts `..` members, a malicious marketplace/zip/npm archive writes outside the temp extraction dir (e.g. into `%TEMP%` parents, or on Linux into the user's home), undetected by `assertExtractContained`.

**Remediation:** stop relying on binary defaults — pre-scan entries (`tar -tf`) and reject any entry whose normalized path is not contained, or extract via a Node libarchive/tar library with explicit `..`/absolute rejection, and run `assertExtractContained` against both the destDir *and* a sentinel check that the parent of destDir is unchanged.

### L-1 — Absolute-path entries are not "refused" but silently sanitized (comment inaccurate) **[VERIFIED]**

**Evidence:** probe above: `tar.exe: Removing leading drive letter from member names` — the absolute entry was written as a nested *relative* path inside `-C dest` (no error). `install.ts:186-187` claims tar "refuses `..` / absolute entry paths"; only the `..` half is accurate for bsdtar 3.8.8. The outcome is still contained, and `assertExtractContained` would also accept it (realpath inside root).

**Impact:** informational; behavior is safe but the code comment overstates the guarantee, which invites future reliance on it.

**Remediation:** correct the comment; keep `assertExtractContained` as the real gate.

### L-2 — `terminal` wait/timeout arguments are unbounded **[VERIFIED]**

**Evidence:** `terminalArgs.timeoutMs` has `min(1)` and no max (`src/main/agent/schemas/tools.ts` — terminalArgs); `TERMINAL_MAX_TIMEOUT_MS = 1_800_000` is explicitly documented as a "Former upper bound … Timeouts may exceed this" (`src/main/agent/tools/terminal.ts:54-57`); the handler clamps only `Math.max(1, requested)` (`index.ts` terminal handler, `requested`/`timeoutMs` lines in the `index.ts:1482-1587` window). The 30-min figure from round 1 (then at `terminal.ts:53,55`) now lives at `terminal.ts:57` but no longer caps anything.

**Impact:** a model can request an arbitrarily long blocking wait for one terminal call. Mitigated by run-abort signals and by the session API (wait expiry returns `session_id` and the process keeps running pollably), so impact is bounded to step liveliness, not memory or data.

**Remediation:** reinstate a hard schema-level `max` on `timeoutMs`/`block_until_ms`.

### L-3 — Agent-mode browser tools may reach loopback/private hosts by design **[VERIFIED]**

**Evidence:** every browser handler sets `const allowLocal = resolveAgentMode(context) === 'agent'` (`src/main/agent/tools/index.ts:725` (search), `:743` (navigate), `:867` (tabs, with an explicit comment that `open` must not default `allowLocal=true`), `:882`, `:895`); tabs default `allowLocalHosts = true` (`src/main/app/agentBrowser.ts:622`); the SSRF gate then permits 127/8, 10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10, ::1, fe80::/10, fc00::/7 (`webFetch.ts:65-68`, allowed-list at `:254-265`). Ask/Plan modes keep `allowLocal=false` and the sync + post-navigation checks enforce it (`agentBrowser.ts:219-229`, `:481-491`, `:842-847`, `:890-893`).

**Impact:** in Agent mode the model can drive the shared agent browser to local admin interfaces on the user's machine (e.g. a router UI or a local dev service) and exfiltrate via navigation. This is a deliberate design (local dev workflows); approval gating applies (`browser_*` are never approval-exempt — `classify.ts:31-34` comment, and `browser_*` ∉ `APPROVAL_EXEMPT_BUILTIN`/`SERIAL_APPROVAL_EXEMPT`, `classify.ts:36-53`).

**Remediation:** none required if intended; consider a per-workspace toggle to force `allowLocal=false` in Agent mode for high-risk environments.

### L-4 — Round-1 line anchors have drifted in the current tree **[VERIFIED]**

**Evidence (old anchor → current, verified this run):** `terminal.ts:36` (64 KB cap) → `terminal.ts:52`; `terminal.ts:53,55` (30-min wait) → `terminal.ts:57` (and demoted to "former upper bound", see L-2); `diagnostics.ts:154-155` (`..` rejection) → `diagnostics.ts:156-158`; `webFetch.ts:80-123` → `webFetch.ts:85-123`; `webFetch.ts:558-575` → `webFetch.ts:560-575`; `writeGuard.ts:70-110` → `writeGuard.ts:73-95` (`assertInlineInstancePathScope` at `:73`); `deletePath.ts:15-20` still accurate (`resolveInsideWorkspace` at `:15`, root refusal through `:22`).

**Impact:** documentation/citation hygiene only; any consumer of round 1 should re-anchor.

### L-5 — `path_scope` prefix matching is case-sensitive on Windows **[VERIFIED]**

**Evidence:** `normalizeScopePath` (`src/main/agent/tools/writeGuard.ts`, `isSafePathScopePrefix`/`isRelPathInPathScope` block feeding `assertInlineInstancePathScope` at `writeGuard.ts:73`) normalizes slashes and trailing `/` but does not lowercase, while the parallelism key explicitly lowercases on win32 (`classify.ts:151-155`, `parallelMutationPathKey`). On Windows a child with `path_scope: ["src/"]` could pass files under `SRC/` through the scope check.

**Impact:** bypasses *instance isolation* only (one child writing another's area); workspace containment (`safePath.ts:46-105`) is unaffected. Not a workspace-escape.

**Remediation:** apply the same win32 lowercasing in `isRelPathInPathScope`.

---

## Verified non-issues

All items below **[VERIFIED]** this run:

**Registry parity & validation**
- `TOOL_REGISTRY` = exactly 60 entries (`tools.ts:973`, per-entry `schema:` at `tools.ts:977-1260`; names enumerated during the full-file read). `BUILTIN_HANDLERS` keys = same 60 names, each a function (`index.ts:517`, keys at `index.ts:518`–`index.ts:1933`, incl. `merge_agent_instance: index.ts:1919`, `cancel_agent_instance: index.ts:1933`); the parity/count test exists at `tests/main/unit/toolsSchema.test.ts:63-68`.
- Validation is zod (not ajv): every registry entry carries a zod schema parsed via `safeParse` in `validateParsedToolArgs` (`tools.ts:1413-1444`); `validateToolArgs` (`tools.ts:1446`) adds malformed-wire and duplicate-JSON-key rejection; dispatch re-validates and prefers schema-coerced data (`index.ts:2149-2153`), and rejects unknown tools via own-property lookup (`index.ts:2176-2179`; prototype-pollution guard `toolRegistryEntry` at `tools.ts:1408-1409`). MCP names bypass canonicalization only for `mcp__` prefix (`tools.ts:1329+`).
- Output caps: terminal 64 KB per stream (`terminal.ts:52`, enforced at `terminal.ts:1154-1193` — buffering stops past the cap while the child keeps draining, with a truncation notice at `:1193`); webFetch body cap 2 MB (`webFetch.ts:29`) with read-body truncation and socket destroy on overrun (`webFetch.ts:560-620`, `:698-707`); marketplace download cap 100 MB (`webFetch.ts:760-766`, enforced by `req.destroy()` in `downloadPinnedHop`); browser snapshots capped via `maxChars` (schema `min(1000)` on all snapshot args, `tools.ts` browser args); grep/search/glob default result caps in schemas.

**Filesystem containment (file-write tools)**
- `resolveInsideWorkspace` (`src/main/workspace/safePath.ts:46-86`): resolves the real root, rejects symlink escapes for existing paths *and* for new-file paths (nearest existing ancestor realpath check); `assertResolvedInsideWorkspace` (`safePath.ts:88-105`) re-asserts containment after create.
- Applied by every writer: `edit.ts:211-214`, `strReplace.ts:79,111-114`, `editNotebook.ts:139-141`, `lsp.ts:129,187-189` (rename), plus `assertWritablePath` binary-extension denial (`writeGuard.ts:23-31`; call sites `edit.ts:224,234`, `editNotebook.ts:141`, `strReplace.ts:111`, `lsp.ts:187`).
- `delete` (`deletePath.ts:15-33`): non-empty path required, `resolveInsideWorkspace`, explicit workspace-root refusal (`:19-22`, realpath-aware comment), `recursive` required for non-empty dirs, post-resolve re-assert (`:27`), `rmSync` with `force: false`, serialized through the workspace mutation queue.
- `memory_read`/`memory_write` (`memory.ts:38-50, 66-77`): `..` rejected, paths restricted to `index.md`, `state.md`, `notes/<name>.md` with a strict `[a-zA-Z0-9._-]+\.md` note-name pattern.
- Run-artifact remap in dispatch prevents `plan.md`/`contract.md` writes from touching the workspace and refuses deleting them (`index.ts:2188-2240`, delete refusal at `:2227-2233`).
- IPC-side run-id hardening: `resolveRunDirInRoot` (`src/main/storage/paths.ts:52-77`) requires run ids to resolve to a direct child dir, rejects symlinks, and re-checks realpaths before `rmSync`/`writeFileSync` use.

**Approval & mode gating**
- `readOnlyHint` is untrusted everywhere: MCP tools are never parallel-safe (`classify.ts:78-85`), never approval-exempt (`classify.ts:36-53`); MCP server tools stay gated even in mode `off` (`toolApproval.ts:112`, `mcpProtection`) and in autonomous mode (`toolApproval.ts:147`, `canonical.startsWith('mcp__')`).
- High-risk tools (`delete`, `terminal`, `edit`, `str_replace`, `edit_notebook`, `git_commit`, `github_*`, `merge_agent_instance`, `mcp__*`, `lsp rename`, any non-builtin) stay user-gated in autonomous mode (`toolApproval.ts:129-155`); approval timeout auto-denies after 15 min (`toolApproval.ts:32`); Ask/Plan mode allowlists enforced at dispatch (`index.ts:2154-2162` via `modePolicy.ts:227` `assertToolAllowedInMode`; Ask set at `modePolicy.ts:21`).
- Inline-instance `path_scope` is enforced at dispatch for `edit`/`str_replace`/`delete`/`edit_notebook` (`index.ts:2240-2264` → `writeGuard.ts:73`), for `git_commit` paths including terminal-generated `mutationPaths` (`index.ts:2297-2312`), and unscoped-tree instances are denied `terminal`/`diagnostics`/`git_commit` outright (`index.ts:2265-2296`, `writeGuard.ts` `assertInlineInstanceUnscopedToolAllowed`), while inline instances can never push (`writeGuard.ts` `assertInlineInstancePushDenied`).

**Shell surfaces**
- `terminal`: `working_directory` contained via `resolveInsideWorkspace` (`index.ts:1499`); background sessions require run ownership (`index.ts:1512-1514`); output cap as above. Full shell execution is by design and is approval-gated (`classify.ts:5-18,36-53`: `terminal` in no exempt set).
- `diagnostics` (`diagnostics.ts:120-164`): command tokenizer rejects shell metacharacters (`/[;|&$`()<>!~[\]{}#\n\r%^]/`, at `diagnostics.ts:138-139`), refuses unclosed quotes, runs via `runSafeCommand` (spawn, no shell); `resolveDiagnosticsBin` rejects `..` (`diagnostics.ts:156-158`), and path-shaped binaries must resolve inside the workspace (`diagnostics.ts:158-164`); capped at 120 s per registry description.
- `run_tests` reuses the same safe-command pipeline (`runTests.ts:91-93` `parseSafeCommand` + `resolveDiagnosticsBin`, `runSafeCommand` at `:102-107`) with a 300 s cap (`runTests.ts:19`).

**Network**
- webFetch SSRF suite (`webFetch.ts`): protocol restricted to http(s) (`:81-83`); hostname/`localhost`-style blocking (`:85-86`); literal IPv4/IPv6 checked against `BLOCKED_V4` (`0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, 224/3`, `:237-245`) and `BLOCKED_V6` (`::1, ::, fe80::/10, fc00::/7`, `:248-252`); decimal/hex IPv4 encodings handled (`:103-105`, parser at `:187`); DNS results all checked (`:111-118`) and **pinned** per connection against rebinding (`createPinnedLookup` `:309-323`, used by `fetchPinnedPublic` `:560-575` and `downloadPinnedHop`); redirects re-validated per hop with `MAX_REDIRECTS = 5` (`:34`, `fetchWithValidatedRedirects` `:505-547`, download loop `:778-802`). Note `web_fetch` is **not** a registered tool — the alias maps to `browser_navigate` (`tools.ts` TOOL_NAME_ALIASES); webFetch.ts is shared infra for marketplace/skills.
- Browser navigation has a sync no-DNS gate plus a post-navigation policy re-check (`agentBrowser.ts:228-229` `isSyncBlockedNavigation` → `webFetch.ts:136`; `agentBrowser.ts:2029` `assertPostNavigationPolicy`), and non-allowLocal navigations re-validate the landed URL (`agentBrowser.ts:842-847`, `:890-893`).

**Marketplace (non-H-1/M-1 items)**
- Registry downloads must stay on the configured registry origin (`install.ts:77-92`, applied at `:600`).
- npm installs use `npm pack --ignore-scripts` (`install.ts:556-560`) — no lifecycle-script execution; git installs use `git clone -c protocol.file.allow=never --depth 1` (`install.ts:531-537`) plus `assertSafeGitCloneUrl`, and the clone gets the same `assertExtractContained` walk (`:542`).
- `path` installs (arbitrary local folder) also get `assertExtractContained` (`install.ts:464`) and require the remote-install ack (`install.ts:626-627`).
- Skill loading: `Skill` tool paths are contained via `resolveSkillResourcePath` → `resolveInsidePackageRoot` (`src/main/agent/skills/index.ts:234-236`), bundled-file listing skips symlinks (`skills/index.ts:215-218`), and all skill/plugin-rule bodies are wrapped as untrusted content (`src/main/agent/tools/skill.ts` `wrapUntrustedContent` call sites) — prompt-injection labeling present.

---

## Unknowns

1. **Round-1 report content — UNKNOWN.** `AUDIT-REPORT-2026-09-10.md` is not present in this instance worktree (verified: `glob **/AUDIT-REPORT*` → no matches; the main-workspace copy is outside this workspace root and unreadable from here). Round-1 findings were taken from the run contract and independently re-verified; any round-1 detail not re-stated above was not re-checked.
2. **GNU tar / macOS bsdtar behavior — UNKNOWN (drives M-1).** Only Windows bsdtar 3.8.8 was probed. Whether the shipped app on Linux/macOS would extract `../` members could not be tested in this environment.
3. **`mcp_read_resource` output wrapping — UNKNOWN.** The handler (`index.ts:1331-1348`) was located but the untrusted-content wrapping of resource bodies was not verified this run.
4. **In-page/renderer security of the agent browser window** (sandbox flags, web preferences) — outside this workstream's file set; not reviewed.
5. **`spawn_agent_instance` path_scope validation beyond the schema** — the zod schema documents the no-absolute/no-`..` rule (`tools.ts`, `spawnAgentInstanceArgs`), and `writeGuard.ts:39-67` implements safe-prefix checks, but the full spawn-time enforcement path in the instance manager was not read this run.

## M3 verdict (summary)

**Mitigated — not a real path-traversal vulnerability on Windows today, but the mitigation is external (bsdtar default) and the integrity gap (H-1) is real.** The executed probe shows the exact `tar -xf`/`-xzf -C` invocations at `install.ts:190-193` fail closed on `..` entries (exit 1, `execFileAsync` rejects) and contain absolute entries (drive letter stripped into the destination). Defense-in-depth `assertExtractContained` (`install.ts:164-182`) catches symlink and in-tree escapes. However: no checksum/signature verification exists for catalog or archive (H-1), and on non-bsdtar platforms the `..` refusal is not guaranteed while `assertExtractContained` is blind to out-of-destination writes (M-1). Recommend closing H-1 and hardening extraction per M-1 before considering M3 fully closed on all platforms.
