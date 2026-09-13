import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'
import { getLoggerBackend, setLoggerBackend } from '@shared/logger'

describe('executeTool failure summary', () => {
  const prev = getLoggerBackend()
  const warn = vi.fn()
  const error = vi.fn()

  afterEach(() => {
    setLoggerBackend(prev)
    warn.mockReset()
    error.mockReset()
  })

  it('preserves file path in summary on read failure', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'warn') warn({ message, fields })
        if (level === 'error') error({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-fail-'))
    const signal = new AbortController().signal
    const result = await executeTool(
      'read',
      JSON.stringify({ path: 'missing/file.kt' }),
      dir,
      signal
    )
    expect(result.ok).toBe(false)
    expect(result.summary).toBe('missing/file.kt')
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]![0].message).toMatch(/\(not_found\)/)
    expect(warn.mock.calls[0]![0].fields.kind).toBe('not_found')
  })
})
