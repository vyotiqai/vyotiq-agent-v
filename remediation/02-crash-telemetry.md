# H6 remediation — UpdateCard crash fix + renderer-crash → crash-history wiring

Deliverable for audit finding H6 (`AUDIT-REPORT-2026-09-10.md:87-90`). All fixes below are
exact `old_string` → `new_string` pairs copied verbatim from the current tree (verified fresh
this run; `git status` clean). Nothing else is edited. `CRASH_BACKFILL_VERSION` is **not**
bumped and the backfill parser is **not** rewritten — live wiring only.

---

## Part 1 — UpdateCard `.length`-of-undefined crash: diagnosis

### Crash site

`src/renderer/src/features/updates/UpdateCard.tsx:86` holds the component's only `.length`
read (verified: single grep hit in the file):

```tsx
{info.notesSections.length > 0 ? (
```

All three logged crashes are `TypeError: Cannot read properties of undefined (reading 'length')`
with componentStack `at UpdateCard` (`AUDIT-REPORT-2026-09-10.md:88`), so `info.notesSections`
was `undefined` at render time.

### Root cause (verified, and already fixed in-tree)

The root cause is **the shipped v1.1.1 renderer stored the `IpcResult` envelope as `UpdateInfo`**:

- `useUpdater`'s `bridge.check()` resolves an `IpcResult` envelope (`{ ok, data }`), not a raw
  `UpdateInfo`. The v1.1.1 build did `setState({ status: 'available', info })` with
  `info` = the envelope, so `info.notesSections` was `undefined` and
  `info.notesSections.length` (UpdateCard.tsx:86) threw at startup.
- Evidence: commit **`88f72a7`** (2026-09-09, "fix(updates): unwrap the IpcResult envelope in
  the updater bridge — v1.1.1 crash") — its message states verbatim: *"Storing the envelope as
  UpdateInfo made the update card render with garbage info (info.notesSections undefined) and
  crashed the renderer on startup."* (`git show 88f72a7` output, verified this run). The
  crashes occurred 2026-09-08 23:16–23:17 (`AUDIT-REPORT-2026-09-10.md:88`), i.e. in the
  pre-fix shipped build.
- The fix is in the current tree: `src/renderer/src/features/updates/useUpdater.ts:47-48`
  unwraps `res.data`; `src/preload/index.ts:385-387` drops any `updater:state` payload that
  fails `UpdaterStatePayloadSchema.safeParse` (schema requires `notesSections` as an array —
  `src/shared/ipc/schemas/updater.ts:21-29`); main builds `UpdateInfo` only through
  `toUpdateInfo` (`src/main/updater/index.ts:27-34`), whose `parseReleaseNotes` always returns
  an array (`src/shared/utils/releaseNotes.ts:47,80-85`).

So no root-cause code change is outstanding. Because the renderer contract is explicitly
cross-package ("owned by another workstream", `src/renderer/src/features/updates/types.ts:1-6`),
a bridge-shape regression would again crash the whole UI at startup through the root
ErrorBoundary — so we additionally ship the minimal evidence-bounded guard at the crash site
below (renders without a notes block instead of crashing; intended behavior preserved when the
prop is present).

### Pair 1 — guard at the crash site

File: `src/renderer/src/features/updates/UpdateCard.tsx` (`old_string` unique in file — the
only `notesSections.length` occurrence).

```diff
--- old_string
      {info.notesSections.length > 0 ? (
--- new_string
      {(info.notesSections?.length ?? 0) > 0 ? (
```

Not guarded: `section.items.map` (UpdateCard.tsx:96-98) is schema-guaranteed by the same zod
validation and by `parseReleaseNotes` (always sets `items: []`), and it was not the crash
signature — no change.

---

## Part 2 — wire error-boundary crashes into `crash-history.json`

### Why they never land today

`recordCrashSnippet` (`src/main/logging/crashDiagnostics.ts:172`) is called only from
`child-process-gone` (`src/main/logging/init.ts:126`) and `render-process-gone` via
`logRendererProcessGone` (`src/main/logging/init.ts:227`). React-level crashes are caught by
the renderer `ErrorBoundary` (`src/renderer/src/lib/ErrorBoundary.tsx:49-53`,
`code: 'RENDERER_CRASH'` / `'REACT_185'`), which never trips those Electron events. The
backfill parser matches only `Renderer process gone` / `Child process gone` lines and is
permanently disabled (`backfillVersion: 1`, `crashDiagnostics.ts:100,244ff`) — out of scope
here by contract.

### Verified bridge mechanics (electron-log 5.4.4, source read this run from a sibling
worktree's `node_modules/electron-log`)

- Renderer path: `ErrorBoundary` → `logger.fatal(..., { scope: 'renderer', code,
  componentStack, err })` (ErrorBoundary.tsx:49-53) → shared logger scrubs fields
  (`src/shared/logger.ts:56-59`; allowlist keeps `scope`/`code`/`err`/`componentStack`,
  `src/shared/utils/logPolicy.ts:10-70`; `err` → `{ name, message ≤200, stack }`,
  logPolicy.ts:139-152) → renderer backend builds the line `` `[renderer] Renderer crash` ``
  and calls `log.error(line, meta)` (`src/renderer/src/logging/init.ts:41-50`).
- electron-log/main receives renderer records on IPC `__ELECTRON_LOG__` and funnels them
  through `Logger.processMessage` (`electron-log/src/main/index.js`), which runs
  `this.hooks.reduce((msg, hook) => hook(msg, transFn, transName), ...)` per enabled
  transport (`electron-log/src/core/Logger.js`). So **`log.hooks` is the single cheap point
  where bridged renderer records can be detected** — one field check per record, no scan.
- Hook shape (`electron-log/src/index.d.ts`): `(message: LogMessage, transport?, transportName?)
  => LogMessage | false`, with `message.data` = the original args array
  `[ '[renderer] Renderer crash', { code, componentStack, err } ]`.
- Hooks run **once per enabled transport** (console + file in dev) — hence the
  `transportName !== 'file'` check below so each crash is recorded exactly once.
- Disambiguation: main's own `logRendererProcessGone` also logs `code: 'RENDERER_CRASH'` but
  with line `[main] Renderer process gone` (init.ts:186-200) — the `[renderer] ` prefix check
  excludes it (it already records its own snippet at init.ts:227).

### Pair 2 — pure detector next to the other log parsers

File: `src/main/logging/crashDiagnostics.ts` — insert after `parseCrashSnippetsFromLogText`
(`old_string` unique: the only `return out` in the file).

```diff
--- old_string
  return out
}

/**
 * One-shot: seed crash-history.json from recent log crash lines.
--- new_string
  return out
}

/**
 * Extract a React error-boundary crash snippet from one bridged renderer log
 * record. electron-log hands hooks the raw arguments as
 * `data: ['[renderer] <message>', { code, err, ... }]` — main-side
 * `Renderer process gone` records carry the `[main] ` prefix and never match.
 * Returns null for every non-boundary record so live wiring stays a single
 * cheap check per log record.
 */
export function rendererBoundaryCrashFromLogMessage(message: {
  data?: unknown[]
  date?: unknown
}): CrashSnippet | null {
  const line = message.data?.[0]
  if (typeof line !== 'string' || !line.startsWith('[renderer] ')) return null
  if (!line.includes('Renderer crash') && !line.includes('React maximum update depth')) return null
  const meta = message.data?.[1] as { code?: unknown; err?: { message?: unknown } } | undefined
  if (meta?.code !== 'RENDERER_CRASH' && meta?.code !== 'REACT_185') return null
  const at = message.date instanceof Date ? message.date : new Date()
  const reason =
    typeof meta.err?.message === 'string' && meta.err.message
      ? meta.err.message
      : line.slice('[renderer] '.length)
  return { at: at.toISOString(), kind: 'renderer', reason }
}

/**
 * One-shot: seed crash-history.json from recent log crash lines.
```

The snippet fits the existing `CrashSnippet` type (`crashDiagnostics.ts:88-99`; `kind:
'renderer'` + `at`/`reason` strings pass the `readHistory` validation at :140-150) — no type
changes needed. `reason` uses the scrubbed, already-truncated (≤200 chars, logPolicy.ts:150)
error message, which is what Settings renders (`useSettingsForm.tsx:365-366` consumes
`getCrashDiagnostics`).

### Pair 3 — import the detector

File: `src/main/logging/init.ts` (`old_string` unique in the import block).

```diff
--- old_string
  recordCrashSnippet,
  sanitizeCrashUrl,
--- new_string
  recordCrashSnippet,
  rendererBoundaryCrashFromLogMessage,
  sanitizeCrashUrl,
```

### Pair 4 — install the hook on the existing bridge

File: `src/main/logging/init.ts` — inside `initMainLogging`, after transport config
(`old_string` unique: the only `console.level = consoleWritable` assignment, directly followed
by the only `setLoggerBackend({`).

```diff
--- old_string
  log.transports.console.level = consoleWritable ? 'debug' : false

  setLoggerBackend({
--- new_string
  log.transports.console.level = consoleWritable ? 'debug' : false

  // React-level renderer crashes are caught by the renderer ErrorBoundary and
  // reach main only as log records on the electron-log renderer→main bridge —
  // they never trip render-process-gone (the only other recordCrashSnippet
  // trigger). electron-log runs hooks once per enabled transport, so record
  // only on the file pass to keep each crash in crash-history.json exactly once.
  log.hooks.push((message, _transport, transportName) => {
    if (transportName !== 'file') return message
    const snippet = rendererBoundaryCrashFromLogMessage(message)
    if (snippet) recordCrashSnippet(snippet)
    return message
  })

  setLoggerBackend({
```

Notes (no action): repeated boundary fires each record a snippet — `recordCrashSnippet` does
not dedupe (only the backfill does) but caps history at `MAX_CRASH_SNIPPETS = 8`
(`crashDiagnostics.ts:109,172-176`); `initMainLogging` re-entry would push a duplicate hook,
matching the existing unguarded `installProcessHandlers()` pattern (init.ts:186) — left as-is
for minimality.

---

## Part 3 — tests

### Pair 5 — extend `tests/renderer/updates/updateCard.test.tsx` (jsdom already opted in at
file top, line 1)

```diff
--- old_string
    expect(screen.getByText('Faster chat streaming')).toBeTruthy()
  })

  it('stays hidden when check() resolves ok with null data (up to date)', async () => {
--- new_string
    expect(screen.getByText('Faster chat streaming')).toBeTruthy()
  })

  it('renders without a notes block when info.notesSections is undefined', async () => {
    // The v1.1.1 crash shape: a bridge regression that hands back an info
    // without notesSections must degrade to "no notes", not crash the UI.
    const { emit } = installBridge()
    render(<UpdateCard />)
    emit({
      status: 'available',
      info: { ...INFO, notesSections: undefined } as unknown as UpdateInfo
    })
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toBeTruthy()
    expect(screen.getByText('v1.2.0')).toBeTruthy()
    expect(screen.queryByText('What’s new')).toBeNull()
  })

  it('stays hidden when check() resolves ok with null data (up to date)', async () => {
```

(`old_string` unique: only the envelope-unwrap test is followed by the
"stays hidden … null data" test; `What’s new` uses the same curly apostrophe as
UpdateCard.tsx:91. Requires Pair 1's guard to pass — with the unguarded code this test
reproduces the production TypeError.)

### Pair 6 — extend `tests/main/unit/crashDiagnostics.test.ts` imports

```diff
--- old_string
  recordCrashSnippet,
  sanitizeCrashUrl,
--- new_string
  recordCrashSnippet,
  rendererBoundaryCrashFromLogMessage,
  sanitizeCrashUrl,
```

### Pair 7 — append a describe to `tests/main/unit/crashDiagnostics.test.ts`

```diff
--- old_string
  it('marks backfillVersion even when the log file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-crash-bf-miss-'))
    setCrashHistoryPathForTests(join(dir, 'crash-history.json'))
    expect(backfillCrashSnippetsFromLog(join(dir, 'missing.log'))).toBe(0)
    const raw = JSON.parse(readFileSync(join(dir, 'crash-history.json'), 'utf8')) as {
      backfillVersion: number
    }
    expect(raw.backfillVersion).toBe(CRASH_BACKFILL_VERSION)
  })
})
--- new_string
  it('marks backfillVersion even when the log file is missing', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-crash-bf-miss-'))
    setCrashHistoryPathForTests(join(dir, 'crash-history.json'))
    expect(backfillCrashSnippetsFromLog(join(dir, 'missing.log'))).toBe(0)
    const raw = JSON.parse(readFileSync(join(dir, 'crash-history.json'), 'utf8')) as {
      backfillVersion: number
    }
    expect(raw.backfillVersion).toBe(CRASH_BACKFILL_VERSION)
  })
})

describe('rendererBoundaryCrashFromLogMessage', () => {
  it('extracts a snippet from a bridged renderer boundary record', () => {
    const snippet = rendererBoundaryCrashFromLogMessage({
      data: [
        '[renderer] Renderer crash',
        {
          code: 'RENDERER_CRASH',
          componentStack: 'at UpdateCard (file://[app]/index.js)',
          err: {
            name: 'TypeError',
            message: "Cannot read properties of undefined (reading 'length')"
          }
        }
      ],
      date: new Date('2026-09-08T23:16:12.000Z')
    })
    expect(snippet).toEqual({
      at: '2026-09-08T23:16:12.000Z',
      kind: 'renderer',
      reason: "Cannot read properties of undefined (reading 'length')"
    })
  })

  it('falls back to the log line when err has no message', () => {
    const snippet = rendererBoundaryCrashFromLogMessage({
      data: ['[renderer] React maximum update depth (#185)', { code: 'REACT_185' }],
      date: new Date('2026-09-08T23:16:12.000Z')
    })
    expect(snippet).toEqual({
      at: '2026-09-08T23:16:12.000Z',
      kind: 'renderer',
      reason: 'React maximum update depth (#185)'
    })
  })

  it('ignores main-side renderer crash records and non-boundary lines', () => {
    const mainRecord = {
      data: [
        '[main] Renderer process gone',
        { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: -1 }
      ],
      date: new Date('2026-09-08T23:16:12.000Z')
    }
    expect(rendererBoundaryCrashFromLogMessage(mainRecord)).toBeNull()
    expect(
      rendererBoundaryCrashFromLogMessage({
        data: ['[renderer] Renderer crash', { code: 'STALE_CHUNK' }]
      })
    ).toBeNull()
    expect(rendererBoundaryCrashFromLogMessage({ data: [] })).toBeNull()
  })
})
```

### New file — `tests/main/unit/rendererCrashHistory.test.ts` (full contents)

Wiring test: captures the hook electron-log `main` would run, feeds it bridged-record shapes,
asserts `recordCrashSnippet` fires exactly once (file pass only) and never for main-side
process-gone records. Mock layout follows the existing `tests/main/unit/loggingDir.test.ts`
conventions (electron + electron-log mocked, real fs under tmp userData); the
`crashDiagnostics` partial mock keeps the real `rendererBoundaryCrashFromLogMessage` under
test while spying on the writer.

```ts
import { rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-crash-hook-${process.pid}-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: (name: string): string => {
      if (name === 'userData') return userData
      throw new Error(`getPath(${name}) is not available in unit tests`)
    },
    on: vi.fn()
  }
}))

type LogHook = (message: unknown, transport?: unknown, transportName?: string) => unknown
const hooks: LogHook[] = []

vi.mock('electron-log/main', () => ({
  default: {
    initialize: vi.fn(),
    hooks: { push: (fn: LogHook) => hooks.push(fn) },
    transports: { file: {}, console: {} },
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  }
}))

vi.mock('@main/logging/sentry', () => ({
  initSentryMain: vi.fn(),
  captureExceptionMain: vi.fn()
}))
vi.mock('@main/logging/crashReporter', () => ({
  crashDumpsDirectory: () => null,
  isCrashReporterStarted: () => false,
  crashReporterVersionTag: () => 'test'
}))
vi.mock('@main/logging/crashDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/logging/crashDiagnostics')>()
  return { ...actual, recordCrashSnippet: vi.fn() }
})

import { initMainLogging } from '@main/logging/init'
import { recordCrashSnippet } from '@main/logging/crashDiagnostics'

const boundaryMessage = {
  data: [
    '[renderer] Renderer crash',
    {
      code: 'RENDERER_CRASH',
      componentStack: 'at UpdateCard (file://[app]/index.js)',
      err: {
        name: 'TypeError',
        message: "Cannot read properties of undefined (reading 'length')"
      }
    }
  ],
  level: 'error' as const,
  date: new Date('2026-09-08T23:16:12.000Z')
}

beforeEach(() => {
  vi.clearAllMocks()
  hooks.length = 0
  initMainLogging()
})

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('renderer boundary crash → crash-history wiring', () => {
  it('records a bridged RENDERER_CRASH record once (file pass only)', () => {
    const hook = hooks[hooks.length - 1]
    expect(hook).toBeTruthy()
    hook?.(boundaryMessage, undefined, 'file')
    hook?.(boundaryMessage, undefined, 'console')
    expect(vi.mocked(recordCrashSnippet)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(recordCrashSnippet)).toHaveBeenCalledWith({
      at: '2026-09-08T23:16:12.000Z',
      kind: 'renderer',
      reason: "Cannot read properties of undefined (reading 'length')"
    })
  })

  it('does not record main-side renderer process-gone records', () => {
    const hook = hooks[hooks.length - 1]
    hook?.(
      {
        data: [
          '[main] Renderer process gone',
          { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: -1 }
        ],
        level: 'error' as const,
        date: new Date()
      },
      undefined,
      'file'
    )
    expect(vi.mocked(recordCrashSnippet)).not.toHaveBeenCalled()
  })
})
```

---

## Verification checklist (parent; worktree has no `node_modules`)

1. Apply Pairs 1–7 (4 files edited: `UpdateCard.tsx`, `crashDiagnostics.ts`, `init.ts`,
   `crashDiagnostics.test.ts`, `updateCard.test.tsx`) and create
   `tests/main/unit/rendererCrashHistory.test.ts`.
2. Confirm each `old_string` still matches exactly once before applying (all were verified
   unique against the clean tree this run).
3. `pnpm vitest run tests/renderer/updates/updateCard.test.tsx tests/main/unit/crashDiagnostics.test.ts tests/main/unit/rendererCrashHistory.test.ts` — expect all green
   (the new UpdateCard test fails without Pair 1, reproducing the shipped crash).
4. `pnpm typecheck` and lint — the hook types against electron-log's declared
   `hooks: Hook[]` (`Hook = (message, transport?, transportName?) => LogMessage | false`).
5. Optional runtime smoke (dev app, renderer DevTools console):
   `__electronLog.error('[renderer] Renderer crash', { code: 'RENDERER_CRASH', err: { name: 'TypeError', message: 'smoke' } })`
   → `%APPDATA%\vyotiq\crash-history.json` gains `{ kind: 'renderer', reason: 'smoke' }`;
   Settings → General crash list shows it.
6. Confirm `CRASH_BACKFILL_VERSION` is still `1` and `parseCrashSnippetsFromLogText` is
   untouched (out-of-scope by contract).

## Limitations / unknowns

- The 3 historical 2026-09-08 boundary records remain absent from `crash-history.json` (the
  backfill is permanently disabled and must not be rewritten) — only live crashes are wired.
- Boundary records are deduped by neither the detector nor `recordCrashSnippet`; a crash
  storm can evict older snippets under the 8-entry cap (accepted, matches existing live
  process-gone behavior).
- The UpdateCard root cause itself ships in v1.1.2 (commit `88f72a7`); Pair 1 is
  defense-in-depth at the crash site, not a substitute for the bridge contract tests that
  already exist (`updateCard.test.tsx` envelope-unwrap regression test).
