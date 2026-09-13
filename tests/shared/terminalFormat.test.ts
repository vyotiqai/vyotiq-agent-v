import { describe, expect, it } from 'vitest'
import {
  isTerminalSessionInProgress,
  parseTerminalOutput,
  sanitizeTerminalDisplayText
} from '@shared/utils/terminalFormat'

describe('parseTerminalOutput', () => {
  it('splits cwd, stdout, stderr, and exit code', () => {
    const parsed = parseTerminalOutput(
      'cwd: /ws\n\nbuild output\nstderr:\nerror line\nexit_code: 1'
    )
    expect(parsed.cwd).toBe('/ws')
    expect(parsed.stdout).toContain('build output')
    expect(parsed.stderr).toContain('error line')
    expect(parsed.exitCode).toBe(1)
  })

  it('handles stdout-only success', () => {
    const parsed = parseTerminalOutput('cwd: /ws\n\nok\nexit_code: 0')
    expect(parsed.stdout).toBe('ok')
    expect(parsed.stderr).toBe('')
    expect(parsed.exitCode).toBe(0)
  })

  it('leaves literal exit_code text in stdout when it is not trailing metadata', () => {
    const parsed = parseTerminalOutput(
      'cwd: /ws\n\nnote exit_code: 9 in the log\nmore output\nexit_code: 0'
    )
    expect(parsed.stdout).toContain('note exit_code: 9 in the log')
    expect(parsed.exitCode).toBe(0)
  })

  it('strips session poll headers from stdout and surfaces status', () => {
    const parsed = parseTerminalOutput(
      [
        'session_id: abc-123',
        'status: timeout',
        'command: sleep 10',
        'cwd: /ws',
        'shell: powershell',
        '',
        'partial out',
        'exit_code: -1'
      ].join('\n')
    )
    expect(parsed.sessionId).toBe('abc-123')
    expect(parsed.sessionStatus).toBe('timeout')
    expect(parsed.command).toBe('sleep 10')
    expect(parsed.cwd).toBe('/ws')
    expect(parsed.stdout).toBe('partial out')
    expect(parsed.stdout).not.toContain('session_id')
    expect(parsed.stdout).not.toContain('command: sleep')
    expect(parsed.exitCode).toBe(-1)
  })
})

describe('isTerminalSessionInProgress', () => {
  it('treats live/pollable statuses as in-progress and finished ones as not', () => {
    expect(isTerminalSessionInProgress('running')).toBe(true)
    expect(isTerminalSessionInProgress('timeout')).toBe(true)
    expect(isTerminalSessionInProgress('pattern_matched')).toBe(true)
    expect(isTerminalSessionInProgress('done')).toBe(false)
    expect(isTerminalSessionInProgress('aborted')).toBe(false)
    expect(isTerminalSessionInProgress(null)).toBe(false)
    expect(isTerminalSessionInProgress(undefined)).toBe(false)
  })
})

describe('sanitizeTerminalDisplayText', () => {
  it('strips ANSI color codes', () => {
    const esc = String.fromCharCode(0x1b)
    const raw = `${esc}[38;2;255;255;255mmodel.safetensors${esc}[0m`
    expect(sanitizeTerminalDisplayText(raw)).toBe('model.safetensors')
  })

  it('applies carriage-return overwrite per line', () => {
    const raw = 'Downloading 10%\rDownloading 50%\rDownloading 100%\nDone'
    expect(sanitizeTerminalDisplayText(raw)).toBe('Downloading 100%\nDone')
  })

  it('preserves Windows CRLF lines instead of wiping them empty', () => {
    const raw = '=====API=====\r\n.panel { color: cyan; }\r\n=====CLASSES===\r\n'
    expect(sanitizeTerminalDisplayText(raw)).toBe(
      '=====API=====\n.panel { color: cyan; }\n=====CLASSES===\n'
    )
  })

  it('applies CR overwrite across joined stream chunks', () => {
    const joined = ['Downloading 10%\r', 'Downloading 50%\r', 'Downloading 100%\nDone'].join('')
    expect(sanitizeTerminalDisplayText(joined)).toBe('Downloading 100%\nDone')
  })

  it('preserves Format-Table rows after stripping escapes', () => {
    const esc = String.fromCharCode(0x1b)
    const raw = `Name    SizeGB\n----    ------\n${esc}[32mmodel.safetensors${esc}[0m  1.23`
    expect(sanitizeTerminalDisplayText(raw)).toBe(
      'Name    SizeGB\n----    ------\nmodel.safetensors  1.23'
    )
  })
})
