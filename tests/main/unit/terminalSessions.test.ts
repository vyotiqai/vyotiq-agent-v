import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { stripPowerShellPatternNoise } from '@main/agent/tools/terminal'
import {
  countTerminalSessionsForInvoke,
  disposeTerminalSessionsForInvoke,
  getTerminalSession,
  pollTerminalSession,
  resetTerminalSessionsForTests,
  startBackgroundTerminal
} from '@main/agent/tools/terminalSessions'

describe('stripPowerShellPatternNoise', () => {
  it('removes NativeCommandError chrome so broad Error pattern does not match', () => {
    const chrome = `progress 0%
At line:1 char:1
+ cmd /c "echo progress 0% 1>&2"
+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
    + CategoryInfo          : NotSpecified: (progress 0%:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError`
    const stripped = stripPowerShellPatternNoise(chrome)
    expect(/Error/.test(stripped)).toBe(false)
    expect(stripped).toContain('progress 0%')
  })

  it('still matches real error text after stripping chrome', () => {
    const text = `At line:1 char:1
    + CategoryInfo          : NotSpecified: (:String) [], RemoteException
    + FullyQualifiedErrorId : NativeCommandError
Traceback (most recent call last):`
    const stripped = stripPowerShellPatternNoise(text)
    expect(/Traceback/.test(stripped)).toBe(true)
  })
})

describe('terminalSessions', () => {
  let cwd: string

  afterEach(() => {
    resetTerminalSessionsForTests()
    if (!cwd) return
    try {
      rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* Windows may briefly lock the temp cwd while child handles drain */
    }
  })

  it('starts a background command and polls until done', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32' ? 'cmd /c echo hello-bg' : 'echo hello-bg'

    const first = await startBackgroundTerminal({
      runId: 'run-1',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 5_000
    })
    expect(first).toMatch(/session_id:/)
    expect(first).toMatch(/hello-bg/)

    const sessionId = first.match(/^session_id:\s*(\S+)/m)?.[1]
    expect(sessionId).toBeTruthy()

    const polled = await pollTerminalSession({
      runId: 'run-1',
      invokeId: 1,
      sessionId: sessionId!,
      blockUntilMs: 2_000,
      signal
    })
    expect(polled).toContain(sessionId!)
    expect(polled).toMatch(/status:\s*(done|pattern_matched)/)
  }, 15_000)

  it('emits onOutput chunks while the session runs', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-out-'))
    const signal = new AbortController().signal
    const chunks: string[] = []
    const command =
      process.platform === 'win32' ? 'cmd /c echo stream-chunk' : 'echo stream-chunk'

    await startBackgroundTerminal({
      runId: 'run-1',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 5_000,
      onOutput: (c) => chunks.push(c.text)
    })
    expect(chunks.join('')).toMatch(/stream-chunk/)
  }, 15_000)

  it('enforces invoke ownership and disposes all child processes with the invoke', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-owner-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32'
        ? 'ping -n 30 127.0.0.1 > nul'
        : 'sleep 30'
    const first = await startBackgroundTerminal({
      runId: 'run-owner',
      invokeId: 7,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 0
    })
    const sessionId = first.match(/^session_id:\s*(\S+)/m)?.[1]
    expect(sessionId).toBeTruthy()
    await expect(
      pollTerminalSession({
        runId: 'other-run',
        invokeId: 1,
        sessionId: sessionId!,
        blockUntilMs: 0,
        signal
      })
    ).rejects.toThrow(/does not belong/i)

    expect(disposeTerminalSessionsForInvoke('run-owner', 7)).toBe(1)
    expect(getTerminalSession(sessionId!, 'run-owner', 7)).toBeUndefined()
    expect(getTerminalSession(sessionId!, 'other-run', 1)).toBeUndefined()
  }, 15_000)

  it('rejects an invented session id when polling', async () => {
    await expect(
      pollTerminalSession({
        runId: 'run-1',
        invokeId: 1,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        blockUntilMs: 0,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/Unknown terminal session_id/i)
    await expect(
      pollTerminalSession({
        runId: 'run-1',
        invokeId: 1,
        sessionId: '550e8400-e29b-41d4-a716-446655440000',
        blockUntilMs: 0,
        signal: new AbortController().signal
      })
    ).rejects.toThrow(/app restart/i)
  })

  it.runIf(process.platform === 'win32')(
    'does not pattern-match PowerShell stderr chrome alone',
    async () => {
      cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-pwsh-pattern-'))
      const signal = new AbortController().signal
      const command =
        `node -e "process.stderr.write('    + FullyQualifiedErrorId : NativeCommandError'+String.fromCharCode(10)); setInterval(()=>{}, 8000)"`
      const first = await startBackgroundTerminal({
        runId: 'run-pwsh-pattern',
        invokeId: 1,
        workspaceRoot: cwd,
        command,
        shell: 'powershell',
        pattern: 'Error',
        blockUntilMs: 800,
        signal
      })
      expect(first).not.toMatch(/status:\s*pattern_matched/)
      expect(first).toMatch(/status:\s*(running|timeout)/)
    },
    15_000
  )

  it('poll exits early when pattern matches', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-pattern-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32'
        ? 'cmd /c echo READY && ping -n 30 127.0.0.1 > nul'
        : 'sh -c "echo READY; sleep 30"'

    const started = Date.now()
    const result = await startBackgroundTerminal({
      runId: 'run-pattern',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      pattern: 'READY',
      blockUntilMs: 10_000
    })
    expect(result).toMatch(/status:\s*pattern_matched/)
    expect(Date.now() - started).toBeLessThan(5_000)
    disposeTerminalSessionsForInvoke('run-pattern', 1)
  }, 15_000)

  it('keeps pattern_matched after the child exits', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-pattern-done-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32' ? 'cmd /c echo MATCHED' : 'echo MATCHED'

    const result = await startBackgroundTerminal({
      runId: 'run-pattern-done',
      invokeId: 1,
      workspaceRoot: cwd,
      command,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      pattern: 'MATCHED',
      blockUntilMs: 5_000
    })
    expect(result).toMatch(/status:\s*pattern_matched/)
  }, 15_000)

  it('caps concurrent background sessions per invoke', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-cap-'))
    const signal = new AbortController().signal
    const command =
      process.platform === 'win32'
        ? 'ping -n 60 127.0.0.1 > nul'
        : 'sleep 60'

    for (let i = 0; i < 10; i++) {
      await startBackgroundTerminal({
        runId: 'run-cap',
        invokeId: 3,
        workspaceRoot: cwd,
        command,
        signal,
        shell: process.platform === 'win32' ? 'cmd' : 'auto',
        blockUntilMs: 0
      })
    }

    expect(countTerminalSessionsForInvoke('run-cap', 3)).toBeLessThanOrEqual(8)
    disposeTerminalSessionsForInvoke('run-cap', 3)
    expect(countTerminalSessionsForInvoke('run-cap', 3)).toBe(0)
  }, 15_000)

  it('finished sessions do not consume the concurrency budget', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-cap-done-'))
    const signal = new AbortController().signal
    const quick =
      process.platform === 'win32' ? 'cmd /c echo done-quick' : 'echo done-quick'
    // More than the cap of short-lived commands — each finishes before the
    // next spawn, so none may count against MAX_BACKGROUND_TERMINALS.
    for (let i = 0; i < 12; i++) {
      const result = await startBackgroundTerminal({
        runId: 'run-cap-drain',
        invokeId: 1,
        workspaceRoot: cwd,
        command: quick,
        signal,
        shell: process.platform === 'win32' ? 'cmd' : 'auto',
        blockUntilMs: 10_000
      })
      expect(result).toMatch(/status:\s*done/)
    }
    // A long-running session still starts afterwards.
    const long = await startBackgroundTerminal({
      runId: 'run-cap-drain',
      invokeId: 1,
      workspaceRoot: cwd,
      command: process.platform === 'win32' ? 'ping -n 60 127.0.0.1 > nul' : 'sleep 60',
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 0
    })
    expect(long).not.toMatch(/Too many concurrent background terminal sessions/)
    disposeTerminalSessionsForInvoke('run-cap-drain', 1)
    expect(countTerminalSessionsForInvoke('run-cap-drain', 1)).toBe(0)
  }, 20_000)
})
