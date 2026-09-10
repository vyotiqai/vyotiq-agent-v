# Remediation 09 — small fixes (audit L1, L3, L5, L9)

Audited findings fixed by exact `old_string` → `new_string` pairs (verbatim from this
clean tree, re-read before writing; each `old_string` is unique in its file), plus one
new guard test (full contents below). Apply pairs grouped per finding, in the order
given within each group. Nothing else in the repo changes.

Test-run note: this worktree has no `node_modules` — run the verification checklist in
the main checkout (`pnpm test`, `pnpm typecheck`).

---

## L1 — `useNetworkStatus`: visibility-gated network probe

File: `src/renderer/src/lib/hooks/useNetworkStatus.ts`

Finding: the hook runs an unconditional 15 s probe interval for the app's lifetime —
`PROBE_INTERVAL_MS = 15_000` at `useNetworkStatus.ts:3`, `window.setInterval` at
`useNetworkStatus.ts:40-42`, cleanup at `useNetworkStatus.ts:43-47` — with no
`document.visibilityState` check.

Repo pattern mirrored (both re-read this run):

- `useWorkspaceManager.ts:1325` — hidden-skip inside the polled callback:
  `if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return`
  (top of `pollActiveRuns`, `useWorkspaceManager.ts:1323-1326`).
- `useWorkspaceManager.ts:1658-1665` — refire-on-regain listeners registered next to
  the interval and torn down in the same effect cleanup:
  `onFocus` (`:1658-1660`), `onVisibility` gating on `visibilityState === 'visible'`
  (`:1661-1663`), `window.addEventListener('focus', onFocus)` + `document.addEventListener('visibilitychange', onVisibility)` (`:1664-1665`), removals in the cleanup (`:1668-1669`).

Constraints honored: no new timers (the single `setInterval` at `:40` is kept at the
same 15 s cadence — `PROBE_INTERVAL_MS` untouched); the probe refires immediately on
visibility regain/focus so offline detection stays fresh; all new listeners are removed
in the existing effect cleanup (`useNetworkStatus.ts:43-47`).

### Pair 1 (of 2) — skip probe ticks while hidden

old_string:
```
    const timer = window.setInterval(() => {
      void refresh()
    }, PROBE_INTERVAL_MS)
    return () => {
      window.removeEventListener('online', onBrowserChange)
      window.removeEventListener('offline', onBrowserChange)
      window.clearInterval(timer)
    }
```

new_string:
```
    const timer = window.setInterval(() => {
      // Hidden windows skip probe ticks (audit L1); the visibilitychange/focus
      // listeners below refire a probe immediately on regain.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      void refresh()
    }, PROBE_INTERVAL_MS)
    const onFocus = (): void => {
      void refresh()
    }
    const onVisibility = (): void => {
      if (document.visibilityState === 'visible') void refresh()
    }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('online', onBrowserChange)
      window.removeEventListener('offline', onBrowserChange)
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
```

(Applied as one pair so the listener registration and its cleanup always land
together; the `old_string` is unique — `window.setInterval` appears exactly once in
the file, `useNetworkStatus.ts:40`.)

---

## L3 — `AboutSection`: hoist the year out of the render body

File: `src/renderer/src/features/settings/sections/AboutSection.tsx`

Finding: `const year = new Date().getFullYear()` runs in the component render body at
`AboutSection.tsx:124`, used at `AboutSection.tsx:165` (`© {year} Vyotiq. …`). Under
React 19 + React Compiler annotation mode, render bodies must be pure; `Date` access
is an impurity. Hoist to a module-level constant.

### Pair 1 (of 3) — module-level constant (anchor: import line, `AboutSection.tsx:9`)

old_string:
```
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

function platformLabel(platform: string, arch: string, osVersion: string): string {
```

new_string:
```
import { SettingsField, SettingsGroup, SettingsStack } from '../components/SettingsField'

// Module-level so render stays pure under React Compiler annotation mode
// (audit L3); Date access in a render body is an impurity.
const CURRENT_YEAR = new Date().getFullYear()

function platformLabel(platform: string, arch: string, osVersion: string): string {
```

### Pair 2 (of 3) — drop the render-body computation (`:123-124`)

old_string:
```
  const dash = '—'
  const year = new Date().getFullYear()
```

new_string:
```
  const dash = '—'
```

### Pair 3 (of 3) — use the constant at the usage site (`:165`)

old_string:
```
            © {year} Vyotiq. Agent V is proprietary Vyotiq software. All rights reserved.
```

new_string:
```
            © {CURRENT_YEAR} Vyotiq. Agent V is proprietary Vyotiq software. All rights reserved.
```

---

## L5 — `writeGuard`: win32 case-insensitive path_scope matching

File: `src/main/agent/tools/writeGuard.ts`

Finding: `isRelPathInPathScope` (`writeGuard.ts:42-51`) normalizes slashes
(`normalizeScopePath`, `writeGuard.ts:31-33`) but compares case-sensitively at
`writeGuard.ts:49` (`return norm === scope || norm.startsWith(`${scope}/`)`). On
Windows a child with `path_scope: ["src/"]` could pass writes under `SRC/` through
the scope check feeding `assertInlineInstancePathScope` (`writeGuard.ts:75-93`,
guard call at `:86`).

Repo pattern mirrored (both re-read this run):

- `classify.ts:128-129` — `parallelMutationPathKey`:
  `return process.platform === 'win32' ? normalized.toLowerCase() : normalized`
  (full body `classify.ts:118-130`; the normalize pipeline at `:127` matches
  `normalizeScopePath`'s shape).
- `mutationQueue.ts:17-22` — `pathKey(relPath)` does slash-normalize + the same
  win32 conditional lowercasing.

The fix lowercases BOTH sides of the comparison (candidate rel path and stored scope
prefix) behind the same `process.platform === 'win32'` conditional, so POSIX behavior
is byte-identical to today. `isSafePathScopePrefix` (`writeGuard.ts:37-40`) is a
validity check, not a match, and is left alone.

### Pair 1 (of 1) — case-insensitive comparison on win32 (`writeGuard.ts:42-51`)

old_string:
```
/** True when relPath equals a scope prefix or is nested under it (no `..` escapes). */
export function isRelPathInPathScope(relPath: string, pathScope: string[]): boolean {
  const norm = normalizeScopePath(relPath)
  if (!norm || !isSafeWorkspaceRelPath(norm)) return false
  return pathScope.some((raw) => {
    if (!isSafePathScopePrefix(raw)) return false
    const scope = normalizeScopePath(raw)
    return norm === scope || norm.startsWith(`${scope}/`)
  })
}
```

new_string:
```
/** True when relPath equals a scope prefix or is nested under it (no `..` escapes). */
export function isRelPathInPathScope(relPath: string, pathScope: string[]): boolean {
  const norm = normalizeScopePath(relPath)
  if (!norm || !isSafeWorkspaceRelPath(norm)) return false
  return pathScope.some((raw) => {
    if (!isSafePathScopePrefix(raw)) return false
    const scope = normalizeScopePath(raw)
    // Windows path matching is case-insensitive, mirroring
    // parallelMutationPathKey (classify.ts) and mutationQueue.pathKey — a
    // `src/` scope must also cover `SRC/`. POSIX behavior is unchanged.
    const relKey = process.platform === 'win32' ? norm.toLowerCase() : norm
    const scopeKey = process.platform === 'win32' ? scope.toLowerCase() : scope
    return relKey === scopeKey || relKey.startsWith(`${scopeKey}/`)
  })
}
```

---

## L9 — CSP dead `blob:` directive: cross-reference comment + guard test

File: `src/main/app/security.ts`

Finding: the dev-only `img-src 'self' data: blob:` at `security.ts:104` (dev block,
inside the `needsViteHmrCsp` branch starting `security.ts:96`) includes `blob:`, which
is a dead directive — a repo-wide grep for `createObjectURL` under `src/**` returns
zero matches (verified this run). The prod policy at `security.ts:113` is
`img-src 'self' data:` (no `blob:`). Per the audit: KEEP `blob:` (dev convenience),
add a cross-referencing comment, and add a guard test so the dev/prod delta can never
silently diverge.

### Pair 1 (of 1) — comment on the dev `img-src` line (`security.ts:104`)

old_string:
```
      "img-src 'self' data: blob:",
```

(Unique — the only `blob:`-bearing `img-src` in the file; the prod line at `:113` is
`"img-src 'self' data:",`.)

new_string:
```
      // `blob:` is a dead directive today: nothing under src/renderer calls
      // URL.createObjectURL (guarded by tests/main/unit/rendererNoObjectUrls.test.ts;
      // audit finding L9 in AUDIT-REPORT-2026-09-10.md). Kept for dev convenience —
      // if the renderer ever adopts object URLs, add `blob:` to the prod policy
      // below too so dev and prod cannot silently diverge.
      "img-src 'self' data: blob:",
```

### New file (full contents) — `tests/main/unit/rendererNoObjectUrls.test.ts`

Conventions followed (verified this run): vitest `globals: false` with explicit
imports (`vitest.config.ts:16`, cf. `tests/main/unit/writeGuard.test.ts:1`); node
environment by default (`vitest.config.ts:17`); include pattern covers
`tests/**/*.test.ts` (`vitest.config.ts:18`); repo-root resolution via
`process.cwd()` as in `tests/main/unit/checkpointCoverage.test.ts:29` and
`tests/main/unit/harnessProbeDelivery.test.ts:5`; plain `fs` + `path` imports like
`tests/main/unit/compactGolden.test.ts:1-3`.

The scan uses the plain substring `createObjectURL`, which is a superset of the
audit's suggested `URL.createObjectURL|createObjectURL(` — it also catches aliased
or paren-less forms.

```ts
import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(process.cwd(), 'src', 'renderer', 'src')

function collectSourceFiles(dir: string, out: string[] = []): string[]): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('renderer object URLs (CSP dev/prod parity, audit L9)', () => {
  it('has zero createObjectURL call sites under src/renderer/src', () => {
    const offenders: string[] = []
    for (const file of collectSourceFiles(RENDERER_SRC)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('createObjectURL')) continue
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('createObjectURL')) {
          offenders.push(`${file.replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }
    expect(
      offenders,
      'Renderer uses object URLs, so `blob:` is live in the dev CSP img-src ' +
        '(src/main/app/security.ts:104). Add `blob:` to the prod img-src there too ' +
        '(audit L9, AUDIT-REPORT-2026-09-10.md) — dev and prod must not diverge.'
    ).toEqual([])
  })
})
```

---

## Parent verification checklist

Run in the main checkout (this worktree lacks `node_modules`).

1. **Apply + typecheck:** land the pairs, then `pnpm typecheck` (or the repo's
   typecheck script) — renderer changes compile under the React Compiler
   annotation pipeline (`AboutSection.tsx` now has no `Date` access in render;
   `useNetworkStatus.ts` effect deps unchanged, still `[refresh]`).
2. **writeGuard suite:** `tests/main/unit/writeGuard.test.ts` — existing
   prefix-boundary and `..`-escape cases at `writeGuard.test.ts:52-61` use
   all-lowercase inputs, so they pass unchanged on POSIX (no behavior change) and
   on win32 (lowercasing is idempotent for these). Suggested added case (optional,
   win32-gated like `tests/main/unit/fileService.test.ts:319`):
   `expect(isRelPathInPathScope('SRC/main/a.ts', ['src/main'])).toBe(process.platform === 'win32')`.
3. **New guard test:** `tests/main/unit/rendererNoObjectUrls.test.ts` passes
   (trivially today — zero `createObjectURL` in `src/**`, re-verified this run) and
   fails with the CSP-pointing message if one is ever introduced.
4. **useNetworkStatus consumers:** `tests/renderer/hooks/useOfflineSendQueue.test.tsx`
   fully mocks the hook (`useOfflineSendQueue.test.tsx:15-28`), so it is unaffected;
   run it anyway. There is no direct `useNetworkStatus` test (grep over `tests/`
   found only that mock).
5. **AboutSection consumers:** `tests/landing/docsTruth.test.ts:444-446` reads
   `AboutSection.tsx` as text — its assertions are brand/product strings (re-read at
   `docsTruth.test.ts:460-475`), not the year expression; run it to confirm.
6. **security.ts:** no test asserts on the CSP string contents beyond
   `needsViteHmrCsp`/structure (comment-only change; grep `tests/` for
   `buildCspPolicy` if adding a regression test later).
7. **Full gate:** `pnpm test` (see memory note: a 40-min valve kill is not a test
   failure) and `pnpm build`/lint if the repo gate includes them.

## Evidence index

- `useNetworkStatus.ts:3` `PROBE_INTERVAL_MS = 15_000`; `:40-42` interval; `:43-47` cleanup.
- `useWorkspaceManager.ts:1323-1326` hidden-skip; `:1658-1665` refire listeners; `:1668-1669` their cleanup.
- `AboutSection.tsx:124` render-body `new Date()`; `:165` `{year}` usage; `:9` import anchor.
- `writeGuard.ts:31-33` `normalizeScopePath`; `:37-40` `isSafePathScopePrefix`; `:42-51` `isRelPathInPathScope` (comparison at `:49`); `:75-93` `assertInlineInstancePathScope` (guard call at `:86`).
- `classify.ts:118-130` `parallelMutationPathKey` (win32 lowercase at `:129`); `mutationQueue.ts:17-22` `pathKey`.
- `security.ts:104` dev `img-src 'self' data: blob:`; `:113` prod `img-src 'self' data:`; zero `createObjectURL` under `src/**` (grep, this run).
- `vitest.config.ts:16-18` globals/env/include; `writeGuard.test.ts:1` import style; `checkpointCoverage.test.ts:29` `process.cwd()` root; `compactGolden.test.ts:1-3` fs/path imports.
- `tests/main/unit/writeGuard.test.ts:52-61` existing scope cases; `useOfflineSendQueue.test.tsx:15-28` hook mock; `docsTruth.test.ts:444-446` AboutSection read.
