import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  backfillCrashSnippetsFromLog,
  consumeRendererRecoveryPending,
  countCrashpadReports,
  CRASH_BACKFILL_VERSION,
  formatWindowsExitCode,
  listCrashSnippets,
  markRendererRecoveryPending,
  MAX_CRASH_SNIPPETS,
  parseCrashSnippetsFromLogText,
  recordCrashSnippet,
  rendererBoundaryCrashFromLogMessage,
  sanitizeCrashUrl,
  setCrashHistoryPathForTests,
  shouldReloadRendererAfterCrash
} from '@main/logging/crashDiagnostics'

describe('formatWindowsExitCode', () => {
  it('formats signed exit codes as unsigned hex on Windows', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32' })
    expect(formatWindowsExitCode(-1)).toBe('0xFFFFFFFF')
    expect(formatWindowsExitCode(-1073741819)).toBe('0xC0000005')
    Object.defineProperty(process, 'platform', { value: prev })
  })

  it('returns undefined on non-Windows platforms', () => {
    const prev = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    expect(formatWindowsExitCode(-1)).toBeUndefined()
    Object.defineProperty(process, 'platform', { value: prev })
  })
})

describe('shouldReloadRendererAfterCrash', () => {
  it('reloads for native crash reasons', () => {
    expect(shouldReloadRendererAfterCrash('crashed')).toBe(true)
    expect(shouldReloadRendererAfterCrash('oom')).toBe(true)
    expect(shouldReloadRendererAfterCrash('memory-eviction')).toBe(true)
    expect(shouldReloadRendererAfterCrash('launch-failed')).toBe(true)
  })

  it('does not reload for intentional shutdown reasons', () => {
    expect(shouldReloadRendererAfterCrash('killed')).toBe(false)
    expect(shouldReloadRendererAfterCrash('clean-exit')).toBe(false)
    expect(shouldReloadRendererAfterCrash('abnormal-exit')).toBe(false)
  })
})

describe('sanitizeCrashUrl', () => {
  it('redacts file URLs and keeps safe origins', () => {
    expect(sanitizeCrashUrl('file:///C:/Users/me/project/index.html')).toBe('file://[app]')
    expect(sanitizeCrashUrl('https://example.com/chat')).toBe('https://example.com')
    expect(sanitizeCrashUrl('devtools://devtools/bundled/devtools_app.html')).toBe('devtools:')
  })
})

describe('countCrashpadReports', () => {
  it('returns 0 when reports directory is missing', () => {
    expect(countCrashpadReports('/tmp/nonexistent-crashpad-dir')).toBe(0)
  })
})

describe('crash history persistence', () => {
  let dir: string

  afterEach(() => {
    setCrashHistoryPathForTests(null)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('records snippets and consumes pending recovery once', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-crash-'))
    setCrashHistoryPathForTests(join(dir, 'crash-history.json'))

    recordCrashSnippet({
      at: '2026-08-02T01:00:00.000Z',
      kind: 'renderer',
      reason: 'crashed',
      exitCode: -1,
      exitCodeHex: '0xFFFFFFFF'
    })
    markRendererRecoveryPending({
      at: '2026-08-02T01:00:01.000Z',
      reason: 'crashed',
      exitCodeHex: '0xFFFFFFFF'
    })

    expect(listCrashSnippets()).toHaveLength(1)
    expect(listCrashSnippets()[0]?.reason).toBe('crashed')
    const pending = consumeRendererRecoveryPending()
    expect(pending?.reason).toBe('crashed')
    expect(consumeRendererRecoveryPending()).toBeNull()

    const raw = JSON.parse(readFileSync(join(dir, 'crash-history.json'), 'utf8')) as {
      pendingRecovery: unknown
      snippets: unknown[]
    }
    expect(raw.pendingRecovery).toBeNull()
    expect(raw.snippets).toHaveLength(1)
  })
})

describe('parseCrashSnippetsFromLogText', () => {
  it('parses single-line and multi-line crash entries', () => {
    const text = [
      "[2026-08-01 19:42:35.771] [error] [main] Renderer process gone { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: -1 }",
      '[2026-08-01 23:38:45.504] [error] [main] Child process gone {',
      "  code: 'CHILD_PROCESS_CRASH',",
      "  processType: 'GPU',",
      "  reason: 'crashed',",
      '  exitCode: -1,',
      "  exitCodeHex: '0xFFFFFFFF',",
      "  name: 'GPU'",
      '}',
      "[2026-08-01 20:00:00.000] [info] [main] Renderer process gone { code: 'RENDERER_CRASH', reason: 'killed', exitCode: 0 }"
    ].join('\n')

    const snippets = parseCrashSnippetsFromLogText(text)
    expect(snippets).toHaveLength(2)
    expect(snippets[0]).toMatchObject({ kind: 'renderer', reason: 'crashed', exitCode: -1 })
    expect(snippets[1]).toMatchObject({
      kind: 'child',
      reason: 'crashed',
      processType: 'GPU',
      exitCodeHex: '0xFFFFFFFF'
    })
  })
})

describe('backfillCrashSnippetsFromLog', () => {
  let dir: string

  afterEach(() => {
    setCrashHistoryPathForTests(null)
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it('backfills once, dedupes, caps, and sets backfillVersion', () => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-crash-bf-'))
    const historyPath = join(dir, 'crash-history.json')
    const logPath = join(dir, 'vyotiq.log')
    setCrashHistoryPathForTests(historyPath)

    recordCrashSnippet({
      at: '2026-08-01T19:42:35.771Z',
      kind: 'renderer',
      reason: 'crashed',
      exitCode: -1
    })

    const lines: string[] = []
    for (let i = 0; i < MAX_CRASH_SNIPPETS + 3; i++) {
      const h = String(10 + i).padStart(2, '0')
      lines.push(
        `[2026-08-01 ${h}:00:00.000] [error] [main] Renderer process gone { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: ${i} }`
      )
    }
    // Duplicate of the live-recorded snippet (same at/reason/exit) — should not double-count.
    lines.push(
      "[2026-08-01 19:42:35.771] [error] [main] Renderer process gone { code: 'RENDERER_CRASH', reason: 'crashed', exitCode: -1 }"
    )
    writeFileSync(logPath, lines.join('\n'), 'utf8')

    const added = backfillCrashSnippetsFromLog(logPath)
    expect(added).toBeGreaterThan(0)
    const snippets = listCrashSnippets()
    expect(snippets.length).toBeLessThanOrEqual(MAX_CRASH_SNIPPETS)

    const raw = JSON.parse(readFileSync(historyPath, 'utf8')) as {
      backfillVersion: number
      snippets: unknown[]
    }
    expect(raw.backfillVersion).toBe(CRASH_BACKFILL_VERSION)
    expect(raw.snippets).toHaveLength(snippets.length)

    // Second call is a no-op.
    expect(backfillCrashSnippetsFromLog(logPath)).toBe(0)
    expect(listCrashSnippets()).toHaveLength(snippets.length)
  })

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
