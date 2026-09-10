# Section 05 — Renderer (`src/renderer/src/**`) + `src/shared/**` Quality & Performance Audit

**Date:** 2026-09-10 · **Mode:** read-only audit of the current working tree (instance worktree, branch `vyotiq/instance/a5d3ab48-…`, tree clean)

## Context caveats (verified this run)

- `AUDIT-REPORT-2026-09-10.md` is **absent** from this tree (repo root checked; no similarly named file). Round-1 finding text (H3/L5) could not be re-read; re-verification below is against the paths/behaviors named in the audit brief.
- `.cursor/rules/performance.mdc` is **absent** (no `.cursor/` directory exists in this tree). Gates below are audited exactly as quoted in the brief. Any gate phrasing beyond those quotes is marked UNKNOWN.

---

## Executive summary

The renderer is in strong shape on the performance gates quoted in the brief: **all six gates pass** (git-status on demand, todos 500 ms cadence gating, Files 2 s dirty+visible poll, transcript virtualization, lazy docks, narrow store subscriptions), `sendSync` is absent, and **L5 is fixed** (GoalRunBanner's 1 s interval is now armed-gated). The two open items worth attention:

1. **H3 (carried, downgraded to Medium):** the highlighted-code path still runs a **regex-based sanitizer** (`sanitizeHighlightedHtml`) instead of a HAST-level one — the code's own NOTE still acknowledges the gap. Practical exploitability is low (Shiki escapes code text; production CSP has `script-src 'self'`), but **dev builds allow `'unsafe-inline'` scripts**, so the regex sanitizer is the only barrier there.
2. **React 19 render purity:** one real impurity found (`new Date().getFullYear()` in AboutSection render). Two `toLocaleString()` calls in render are deterministic-from-props but read runtime locale.

Reliability surfaces (composer paste, stream retry/error, unmount guards) check out. a11y lint coverage is genuine (recommended rule set + tuned overrides) but everything runs at `warn` severity.

---

## Findings

### F1 — Medium (H3 carried, re-verified) — Highlighted-code path still bypasses rehype-sanitize via a regex sanitizer

**Evidence (verified this run):**
- Markdown *body* is sanitized properly: `MarkdownContent.tsx:112-114` registers `[rehypeSanitize, markdownSanitizeSchema]` (schema = `defaultSchema`, `markdownSanitize.ts:4`), applied at `MarkdownContent.tsx:411`.
- Highlighted *code* does NOT go through rehype-sanitize: `FencedCodeBlock` calls `highlightCode(...)` then `sanitizeHighlightedHtml(result)` at `MarkdownContent.tsx:195`, and injects with `dangerouslySetInnerHTML` at `MarkdownContent.tsx:213`.
- `sanitizeHighlightedHtml` (`markdownSanitize.ts:145`) is a chain of regex replaces — strips comments/CDATA (`:147-149`), dangerous tags + contents (`:150-153`), namespaced tags (`:155-158`), disallowed closers, and rebuilds open tags via `sanitizeOpenTag` with an attr allowlist (`:20-27`) that drops all `on*` attributes (`:69`) and rebuilds `style` from a per-declaration allowlist (`sanitizeStyleValue`, `markdownSanitize.ts:58`; prop allowlist + unsafe-value blocklist at `markdownSanitize.ts:44-52`).
- The code's own NOTE still concedes: *"a regex sanitizer is inherently more brittle than a HAST-level one (rehype-sanitize)… the highlighted-code path should eventually route through `hast-util-sanitize` like the markdown body does"* (`markdownSanitize.ts:131-137`, comment at `:138`).
- Sweep for other injection sites: **only two** `dangerouslySetInnerHTML` in the renderer — `MarkdownContent.tsx:213` and `MermaidDiagram.tsx:69` (grep over `src/**`, this run).
- Mermaid: `MermaidDiagram.tsx:19` initializes mermaid with `securityLevel: 'strict'`; the rendered `svg` is injected at `MermaidDiagram.tsx:69`. Only settled (non-streaming) fences reach it (`MarkdownContent.tsx:271-274` — `unstable` fences stay as plain pre). Mermaid chunk is lazily imported per theme (`MermaidDiagram.tsx:15-25`).
- CSP (main-side, for impact assessment): production `script-src 'self'` (`src/main/app/security.ts:110`); **dev/HMR `script-src 'self' 'unsafe-inline'`** (`security.ts:101`); `connect-src … https:` in both (`:107`, `:113`); `style-src 'self' 'unsafe-inline'` both modes.

**Impact:** Input to this path is agent/tool-controlled text, but Shiki HTML-escapes code content, and the sanitizer allowlists are tight (no `on*`, per-declaration style rebuild, scheme-checked `href`). In **production**, inline scripts and inline handlers are CSP-blocked, so a hypothetical regex-confusion bypass still cannot execute script; `connect-src https:` would permit exfiltration only if active content executed. In **dev builds** (`'unsafe-inline'` allowed), the regex sanitizer is the *only* thing standing between hostile content and executing inline handlers. Net: defense-in-depth gap, not a directly exploitable production hole — downgraded from round-1 High to **Medium**, contingent on the round-1 report's original severity rationale being about the missing HAST sanitize rather than a live exploit.

**Remediation:** Route `highlightCode` output through `hast-util-sanitize` (parse → sanitize → serialize) as the NOTE already prescribes, keeping the regex pass as a second belt. Do the same for the mermaid SVG if a HAST pipeline is added there (mermaid `securityLevel: 'strict'` + CSP currently cover it).

### F2 — Low — Impure read of current time in render: `new Date().getFullYear()`

**Evidence:** `src/renderer/src/features/settings/sections/AboutSection.tsx:124` — `const year = new Date().getFullYear()` executes in the component render body.

**Impact:** Reads ambient time during render. Under React 19 + React Compiler annotation mode this is a purity violation (render output depends on untracked ambient state); practically benign (footer year), but it is the pattern the compiler is entitled to memoize incorrectly.

**Remediation:** Hoist to a module constant or compute in an effect/state initializer.

**Related (informational, not violations):**
- `PrPanel.tsx:242` — `new Date(review.submittedAt).toLocaleString()` and `GeneralSection.tsx:372` — `new Date(snippet.at).toLocaleString()`: deterministic from props, but `toLocaleString()` reads the runtime locale/timezone during render. Acceptable today; note for compiler purity strictness.
- `TerminalBody.tsx:69` — `new Date(startedAt).toISOString()`: deterministic from props; pure. No action.
- `FilesPanel.tsx:1749` — `Date.now()` is inside the async open-tab callback (event path), not render. No action.
- `Math.random()` — **none** in renderer `.tsx` (grep this run).

### F3 — Low — Always-on 15 s network probe at App level, not visibility-gated

**Evidence:** `useNetworkStatus.ts:3` — `PROBE_INTERVAL_MS = 15_000`; unconditional `window.setInterval(() => void refresh(), PROBE_INTERVAL_MS)` at `useNetworkStatus.ts:40-43`, no `visibilityState` check (contrast the other polls below). Consumed at App scope via `useOfflineSendQueue` (`App.tsx:713`).

**Impact:** A main-process IPC probe every 15 s for the entire app lifetime, including while the window is hidden. Not one of the gates quoted verbatim in the brief (and `performance.mdc` is absent from this tree, so the strict no-always-on-polls wording is UNKNOWN), but it is the one remaining renderer interval that ignores visibility.

**Remediation:** Early-return when `document.visibilityState === 'hidden'` and refire on `visibilitychange`/`focus`, matching `useWorkspaceManager.ts:1325,1660-1663`.

### F4 — Low (informational) — Residual 2 s artifact polls continue while a dock is mounted but the run has ended

**Evidence:**
- `useRunTodos.ts:105-106` — interval starts whenever `active && workspacePath && runId`; cadence is `running && live && hasVisibleTodos ? 500 : 2000`. The 500 ms live cadence is correctly gated, but the 2 s fallback polls as long as the hook is `active` (dock mounted), even with no run.
- Same pattern in `useRunGoal.ts:88-90` (500 ms only when `running && (hasVisibleGoal || hasArmedLoop)`).
- `ChatView.tsx:998-1023` — plan-draft readiness poll: `setInterval(check, 2000)` at `ChatView.tsx:1018`, gated on `agentMode === 'plan' && activeRunId && !mounted && !dismissed` — but `running` is in the dep array only; the guard ignores it, so the poll continues after the run ends until the draft is ready or the panel opens/is dismissed.

**Impact:** Bounded (each poll is one artifact read; hooks are per-dock), but these are the only quoted-gate surfaces that keep ticking while idle-mounted.

**Remediation:** Add `running` (or a settled flag) to the guards, or stop the interval once the run ends and refetch on run-end transitions (the `wasRunning && !running` refetch at `useRunTodos.ts:62-66` already covers the terminal refresh).

### F5 — Low (informational) — Full-items scan per store delta in `useGitRevision` while a run is live

**Evidence:** `ChatStreamLeaves.tsx:64-84` — while `running`, every `itemsStore` notification triggers `scan()`, which iterates **all** items (`for (const item of list … :70-78`) to count done/fail mutating tools. Bounded by a debounce (`setTimeout … 400` at `:81-84`) and only bumps revision when the count grows.

**Impact:** O(n) work per stream delta on the leaf component during live runs. Given the coalescing and that it runs off the render path (store callback), this is minor; flagged because the gate brief calls out "narrow store subscriptions".

**Remediation (optional):** Track the done-tool count incrementally in the store, or subscribe to a revision counter for done mutating tools instead of scanning.

---

## Performance-gate adherence verdicts (gates as quoted in the brief)

| Gate | Verdict | Evidence |
|---|---|---|
| Git status only while Changes visible | **PASS** (stronger: not polled at all) | `useGitStatus.ts:21-27` — "Refreshed on demand rather than polled"; no timer in the hook (full read). Fetches gated by `enabled`; `GitChrome.tsx:35` passes through; `ChangesPanel.tsx:204` ties work to `active` (`:160`, `:387`, `:423`, `:442`). Revisions come from `useGitRevision` (run end / workspace change / mutating-tool completion — `ChatStreamLeaves.tsx:37-62`). |
| Todos 500 ms only if `running && live && hasVisibleTodos` | **PASS** | `useRunTodos.ts:103-106` — `const ms = running && live && hasVisibleTodos ? LIVE_POLL_MS : POLL_MS`; interval only while `active` (`:105`). Residual 2 s poll noted in F4. |
| Files 2 s only if dirty + `document.visibilityState==='visible'` | **PASS** | `FilesPanel.tsx:1575-1585` — timer created only when `dirty && documentVisible()`; each tick re-checks `documentVisible()`; `focus`/`visibilitychange` listeners trigger immediate checks (`:1578-1580`). |
| MessageList virtualization | **PASS** | `MessageList.tsx:2` — `useAppVirtualizer`; `:266` `VIRTUALIZE_MIN_ROWS = 160`; three-mode layout (`flow`/`hybrid`/`full-virtual`, `:278`); early live virtualization option (`:851`); memoized row blocks (`:541`). |
| lazy() docks | **PASS** | `ChatView.tsx:80-86` — lazy `FilesPanel`, `TerminalPanel`, `PrPanel`; `App.tsx:64-70` — lazy `SettingsView`, `MarketplaceView`, `HomePage`. Mermaid is also lazily imported per theme (`MermaidDiagram.tsx:15-25`). |
| Narrow store subscriptions (ChatStreamLeaves vs full items) | **PASS** (with note) | `ChatStreamLeaves.tsx:90-110` `useSyncExternalStore` on revision counters; boolean-only snapshots that are `Object.is`-stable across deltas: `useHasTranscriptRunError` (`:113-135`), `useHasChatItems` (`:141-163`). See F5 for the one full-scan subscription. |
| No `sendSync` | **PASS** | Grep over `src/renderer/**`: zero matches for `sendSync`. |
| No sync render I/O | **PASS (observed)** | Highlighting is async + idle-scheduled (`MarkdownContent.tsx:150-155, 192-199`); IPC in render-adjacent hooks is async (`useGitStatus`, `useRunTodos`, `FilesPanel`). Not exhaustively proven over every component — marked observed, not absolute. |
| **L5 re-verify:** GoalRunBanner 1 s always-on interval | **FIXED** | `GoalRunBanner.tsx:35` — `const armed = loop?.status === 'armed'`; `:37-39` — `useEffect` returns early `if (!armed)`, and only then sets the 1 s interval. No longer always-on. `Date.now()` at `:34` is a lazy `useState` initializer (runs once per mount), not a per-render read. |

**Adjacent intervals checked (not in the quoted gates):** active-runs poll 5 s — visibility-gated inside the callback (`useWorkspaceManager.ts:1325`, interval `:1657`, visible/focus refire `:1660-1663`) — compliant in spirit. Shared "now" clock is a single refcounted 1 Hz timer (`useSharedNow.ts:14-31`) — this is the fix for the N-timers problem. Perf dump timer only runs behind a sessionStorage flag (`chatUiPerf.ts:49-55`). PlanPanel 2 s poll is dock-visibility-gated (`PlanPanel.tsx:18, 354, 526-531`).

---

## a11y verdict

**Configured (verified, `eslint.config.mjs`):** plugin imported at `:5`, registered at `:67`; **`...jsxA11y.configs.recommended.rules`** spread at `:77`, then tuned overrides (all `'warn'`) at `:80-124`:
- `click-events-have-key-events: warn` (`:80`)
- `no-static-element-interactions: warn` with explicit handler list + `allowExpressionValues` (`:82-96`)
- `no-noninteractive-element-interactions: warn` with same handlers (`:97-109`)
- `interactive-supports-focus: warn` (`:110`)
- `no-noninteractive-tabindex: warn` with APG role exceptions (`tabpanel/region/application/log/document`, `:111-119`)
- `label-has-associated-control: warn` with `controlComponents: ['Input','Switch','Textarea']`, depth 3 (`:117-123`)
- `no-autofocus: warn` (`:124`); `role-supports-aria-props: warn` (`:125`)

**Verdict:** Coverage is real and thoughtfully tuned (drag/title-bar exclusions are documented in comments at `:78-79`, `:111`). Spot-checked rendered surfaces show the rules are being honored, not suppressed: the composer editable is a proper ARIA 1.2 combobox (`ComposerMentionInput.tsx:495-520` — role/aria-expanded/aria-controls/aria-haspopup/aria-activedescendant/aria-multiline), and `GoalRunBanner.tsx` uses `role="region"` + `aria-label` (`:50-52`).

**Gaps (Medium-confidence, not lint-rule bugs):**
1. Every jsx-a11y rule runs at **`warn`** severity — findings won't fail lint/CI unless `--max-warnings 0` is enforced (enforcement level UNKNOWN — not verified this run).
2. Rule-tuning gaps a linter can't see were not audited (focus traps, focus restoration after panel close, live-region announcements for stream errors). **UNKNOWN** — out of scope for a static pass.

---

## `src/shared` schema drift check (bounded)

**Verified structure:** `src/shared/ipc/index.ts` re-exports 17 zod schema modules (`./schemas/*`), `./types/secrets`, and `./channels` — one curated surface per channel. Spot-check of `schemas/git.ts` (read in full): consistent patterns — discriminated results (`GitStatusResult` `kind: ok|not_repo|unavailable`), bounded strings, regex-validated object ids (`:124-129`), capped arrays (`GitBlame` lines ≤ 20 000, stage paths ≤ 500), and a single `workspacePath` request convention throughout. `markdownSanitize`'s href policy and `GoalRunBanner`/`useRunGoal` all consume `@shared/goalRuntime`/`@shared/ipc` types consistently with what the schemas declare (no mismatch observed at the consumption sites read).

**No duplicated or drifted definitions found in the git domain** (only one `GitStatus`/`GitStatusResult` source, consumed by `useGitStatus.ts:2` and `GitChrome`).

**NOT verified (see Unknowns):** a full 17-module × main-handler drift diff, and the relationship between `src/shared/vyotiqApi.ts` (27 KB, not read) and the zod schemas — a possible second source of truth for the IPC surface.

---

## Verified non-issues

- **L5 resolved** — the 1 s GoalRunBanner timer is armed-gated (`GoalRunBanner.tsx:35-39`); elapsed-time UI elsewhere uses the shared refcounted clock (`useSharedNow.ts`), not per-row timers.
- **Mermaid injection surface contained** — `securityLevel: 'strict'` (`MermaidDiagram.tsx:19`), lazy chunk, settled-only rendering, and production CSP `script-src 'self'` (`security.ts:110`).
- **Composer paste path is sound** — `ComposerMentionInput.tsx:535-546`: `preventDefault`, files extracted via `filesFromDataTransfer` (`dataTransferFiles.ts:1`), plain text inserted in a **single-pass Range fragment** (`insertPlainText`, `:307-345`) instead of per-char `execCommand` (the 8.3 s paste-freeze cause, documented at `:299-305`); manual insertion is followed by `emitFromDom()` so the controlled value cannot desync; out-of-composer selections are re-anchored to the editor end (`:313-321`). Files route to `onPickAttachments` (`Composer.tsx:1067`).
- **Stream start reliability** — bounded retry (`CHAT_START_MAX_ATTEMPTS = 3`, `CHAT_START_RETRY_MS = 500`, `createChatStreamController.ts:86-87`) applied on both send (`:2934-2948`) and resume (`:3060-3067`); on final failure the controller restores prior state, drops the pending user item (`:2951-2971`), and the resume path appends a stable-id `run_error` item (`:3076-3085`); stream patches are skipped while the document is hidden (`:1739`).
- **Unmount/setState guards** — consistent `cancelled` flags / sequence refs across async surfaces: `useRunTodos.ts:41,58,90`; `useGitStatus.ts:33`; `FencedCodeBlock` (`MarkdownContent.tsx:191-203`); `MermaidDiagram.tsx:47-60`; `useWorkspaceManager` visibility listener cleanup (`:1665-1673`).
- **List keys** — stable identity keys on transcript rows (`MessageList.tsx:1806` turns keyed by `group.start`), items (`UserPrompt.tsx:211,223`), tool bodies (`CodebaseSearchBody.tsx:25`, `DiagnosticsBody.tsx:47`, `McpIntrospectBody.tsx:101`). A handful of index-composite keys exist on static lists (`CompactSummaryBlock.tsx:118`, `ComposerAttachments.tsx:55-85`, `HexEditor.tsx:621`); no collision-producing pattern verified — acceptable.
- **No `sendSync`, no main imports from renderer** — enforced both by usage (grep) and lint (`eslint.config.mjs:135-145` bans `@main/*` in renderer).

## Unknowns

- **Round-1 report text** — `AUDIT-REPORT-2026-09-10.md` is absent from this tree; H3's original severity rationale and L5's exact wording could not be re-read.
- **`performance.mdc` rule text** — absent from this tree; gates audited only as quoted in the brief. Any additional strict rules in the file (e.g., blanket no-always-on-interval wording that would harden F3) are unverified.
- **Full `src/shared` ↔ main drift diff** — only the git domain was fully checked; the other 16 schema modules were not diffed against main-process handlers.
- **`src/shared/vyotiqApi.ts` (27 KB)** — not read; whether it duplicates zod schema shapes as a hand-maintained second source of truth is unknown.
- **Lint enforcement level** — whether CI/`pnpm lint` treats `warn` as failing (`--max-warnings 0`) is unknown; affects the a11y gap severity.
- **Runtime behavior** — no tests/build were run (per audit constraints); all findings are static, line-cited evidence from the current tree.
