import { describe, expect, it, vi, type Mock } from 'vitest'
import { parseTestSummary, toolRunTestsAsync } from '@main/agent/tools/runTests'
import { packageScripts, runSafeCommand } from '@main/agent/tools/diagnostics'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('@main/agent/tools/diagnostics', () => ({
  packageScripts: vi.fn(() => ({ test: 'vitest run' })),
  preferPnpm: () => true,
  parseSafeCommand: (cmd: string) => {
    const [bin, ...args] = String(cmd).split(' ')
    return { bin, args }
  },
  resolveDiagnosticsBin: (_ws: string, bin: string) => bin,
  runSafeCommand: vi.fn(async () => ({ stdout: 'PASS', stderr: '', exitCode: 0, killed: false }))
}))
vi.mock('@main/agent/tools/terminal', () => ({
  sanitizedTerminalEnv: () => ({ ...process.env })
}))
vi.mock('@shared/errors', () => ({
  abortError: () => new Error('aborted')
}))

describe('toolRunTestsAsync', () => {
  it('runs an explicit command and reports success', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { command: 'echo test' }, ac.signal)
      expect(result.ok).toBe(true)
      expect(result.command).toContain('echo test')
      expect(result.content).toContain('PASS')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('falls back to the package test script when no command is given', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, {}, ac.signal)
      expect(result.command).toMatch(/pnpm (run )?test/)
      expect(result.ok).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('skips gracefully when no explicit command and no test script exist', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      ;(packageScripts as Mock).mockReturnValueOnce({})
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, {}, ac.signal)
      expect(result.ok).toBe(true)
      expect(result.command).toBe('')
      expect(result.content).toContain('tests skipped')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('runs a named package script via the package manager', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { script: 'test:unit' }, ac.signal)
      expect(result.command).toBe('pnpm run test:unit')
      expect(result.ok).toBe(true)
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('reports a failure exit with a parsed pass/fail summary header', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      ;(runSafeCommand as Mock).mockResolvedValueOnce({
        stdout: 'Tests  2 failed | 18 passed (20)',
        stderr: '',
        exitCode: 1,
        killed: false
      })
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { command: 'pnpm test' }, ac.signal)
      expect(result.ok).toBe(false)
      expect(result.content).toContain('exit: 1')
      expect(result.content).toContain('Tests: 18 passed, 2 failed (exit 1)')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('reports a killed command as a timeout without claiming output size', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      ;(runSafeCommand as Mock).mockResolvedValueOnce({
        stdout: 'partial',
        stderr: '',
        exitCode: null,
        killed: true
      })
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { command: 'pnpm test' }, ac.signal)
      expect(result.ok).toBe(false)
      expect(result.content).toContain('Test command was killed (timeout)')
      expect(result.content).not.toContain('output too large')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('omits the summary header when the output has no pass/fail summary', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-runtest-'))
    try {
      ;(runSafeCommand as Mock).mockResolvedValueOnce({
        stdout: 'hello world',
        stderr: '',
        exitCode: 0,
        killed: false
      })
      const ac = new AbortController()
      const result = await toolRunTestsAsync(ws, { command: 'echo hi' }, ac.signal)
      expect(result.ok).toBe(true)
      expect(result.content).not.toContain('Tests:')
    } finally {
      rmSync(ws, { recursive: true, force: true })
    }
  })

  it('parseTestSummary reads vitest and jest final summaries', () => {
    expect(parseTestSummary('Tests  2 failed | 18 passed (20)')).toEqual({
      passed: 18,
      failed: 2
    })
    expect(parseTestSummary('Tests:       2 failed, 18 passed, 22 total')).toEqual({
      passed: 18,
      failed: 2
    })
    expect(parseTestSummary('Test Files  5 passed (5)\n     Tests  22 passed (22)')).toEqual({
      passed: 22,
      failed: 0
    })
    expect(parseTestSummary('no summary here')).toBeNull()
  })
})
