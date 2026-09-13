import { mkdirSync, rmSync } from 'node:fs'
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
import { recordCrashSnippet, setCrashHistoryPathForTests } from '@main/logging/crashDiagnostics'

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
  // crashDiagnostics resolves its history path via a lazy require('electron'),
  // which vi.mock does not intercept — point it at a temp file instead
  // (same convention as tests/main/unit/crashDiagnostics.test.ts).
  mkdirSync(userData, { recursive: true })
  setCrashHistoryPathForTests(join(userData, 'crash-history.json'))
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
