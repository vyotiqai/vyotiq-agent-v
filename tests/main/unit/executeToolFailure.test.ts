import { describe, expect, it, vi, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
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

  it('logs read past-end as expected (past_end) with a remedy, not an error', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'warn') warn({ message, fields })
        if (level === 'error') error({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-fail-'))
    writeFileSync(join(dir, 'three.txt'), 'one\ntwo\nthree\n', 'utf8')
    const signal = new AbortController().signal
    const result = await executeTool(
      'read',
      JSON.stringify({ path: 'three.txt', startLine: 230 }),
      dir,
      signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(
      /startLine 230 is past the end of three\.txt \(3 lines\)\. Use startLine <= 3\./
    )
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]![0].message).toMatch(/Tool failed as expected \(past_end\)/)
    expect(warn.mock.calls[0]![0].fields.kind).toBe('past_end')
  })

  it('edit on a directory returns Path is a directory and logs (is_directory), never raw EISDIR', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'warn') warn({ message, fields })
        if (level === 'error') error({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-fail-'))
    mkdirSync(join(dir, 'subdir'))
    const signal = new AbortController().signal
    const result = await executeTool(
      'edit',
      JSON.stringify({ path: 'subdir', diff: '@@ -1 +1 @@\n-a\n+b\n' }),
      dir,
      signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Path is a directory: subdir/)
    expect(result.content).not.toMatch(/EISDIR/)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]![0].message).toMatch(/Tool failed as expected \(is_directory\)/)
    expect(warn.mock.calls[0]![0].fields.kind).toBe('is_directory')
  })

  it('str_replace on a directory returns Path is a directory and logs (is_directory)', async () => {
    setLoggerBackend({
      log: (level, message, fields) => {
        if (level === 'warn') warn({ message, fields })
        if (level === 'error') error({ message, fields })
      }
    })
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-tool-fail-'))
    mkdirSync(join(dir, 'subdir'))
    const signal = new AbortController().signal
    const result = await executeTool(
      'str_replace',
      JSON.stringify({ path: 'subdir', old_string: 'a', new_string: 'b' }),
      dir,
      signal,
      { agentMode: 'agent' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Path is a directory: subdir/)
    expect(result.content).not.toMatch(/EISDIR/)
    expect(warn).toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    expect(warn.mock.calls[0]![0].message).toMatch(/Tool failed as expected \(is_directory\)/)
    expect(warn.mock.calls[0]![0].fields.kind).toBe('is_directory')
  })
})
