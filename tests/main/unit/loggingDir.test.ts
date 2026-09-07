import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

const userData = join(tmpdir(), `vyotiq-logs-${process.pid}-${Date.now()}`)

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

// Behavior under test is ensureLogsDirectory (real fs) — only electron's app
// and electron-log's module surface are mocked, never node:fs.
vi.mock('electron-log/main', () => ({ default: {} }))
vi.mock('@main/logging/sentry', () => ({
  initSentryMain: vi.fn(),
  captureExceptionMain: vi.fn()
}))
vi.mock('@main/logging/crashReporter', () => ({
  crashDumpsDirectory: () => null,
  isCrashReporterStarted: () => false,
  crashReporterVersionTag: () => 'test'
}))
vi.mock('@main/logging/crashDiagnostics', () => ({
  backfillCrashSnippetsFromLog: vi.fn(),
  countCrashpadReports: () => 0,
  formatWindowsExitCode: () => undefined,
  markRendererRecoveryPending: vi.fn(),
  recordCrashSnippet: vi.fn(),
  sanitizeCrashUrl: (url: string) => url,
  shouldReloadRendererAfterCrash: () => false,
  planRendererReload: () => ({ action: 'give-up' }),
  RENDERER_HEALTHY_RESET_MS: 0
}))

import { resolvePathFn } from '@main/logging/init'

const logsDir = join(userData, 'logs')

afterEach(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('resolvePathFn self-healing logs directory', () => {
  it('ensures the logs dir exists and resolves to userData/logs/vyotiq.log', () => {
    expect(existsSync(logsDir)).toBe(false)

    const resolved = resolvePathFn()

    expect(resolved).toBe(join(logsDir, 'vyotiq.log'))
    expect(existsSync(logsDir)).toBe(true)
  })

  it('re-creates the logs dir after mid-run deletion', () => {
    resolvePathFn()
    expect(existsSync(logsDir)).toBe(true)

    // Simulate the electron-log v5 failure mode: %APPDATA%\vyotiq\logs
    // disappears while the app is running (File transport stays cached).
    rmSync(logsDir, { recursive: true, force: true })
    expect(existsSync(logsDir)).toBe(false)

    const resolved = resolvePathFn()

    expect(resolved).toBe(join(logsDir, 'vyotiq.log'))
    expect(existsSync(logsDir)).toBe(true)
  })
})
