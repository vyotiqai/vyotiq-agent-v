import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  disposeTerminalSessionsForInvoke,
  disposeTerminalSessionsForRun,
  keepLiveTerminalSessionsForInvoke,
  killTerminalSession,
  listKeptTerminalSessions,
  onKeptTerminalSessionsChanged,
  pollTerminalSession,
  resetTerminalSessionsForTests,
  startBackgroundTerminal,
  stopKeptTerminalSession,
  writeTerminalSessionInput
} from '@main/agent/tools/terminalSessions'

const win = process.platform === 'win32'
const LONG = win ? 'ping -n 30 127.0.0.1 > nul' : 'sleep 30'
const SHELL = win ? 'cmd' : 'auto'

function sessionIdOf(frame: string): string {
  const id = frame.match(/^session_id:\s*(\S+)/m)?.[1]
  if (!id) throw new Error(`no session id in: ${frame}`)
  return id
}

describe('kept background terminals', () => {
  let cwd = ''

  afterEach(() => {
    resetTerminalSessionsForTests()
    try {
      if (cwd) rmSync(cwd, { recursive: true, force: true })
    } catch {
      /* Windows may hold the cwd briefly */
    }
  })

  async function startLong(runId: string, invokeId: number): Promise<string> {
    cwd ||= mkdtempSync(join(tmpdir(), 'vyotiq-kept-'))
    const frame = await startBackgroundTerminal({
      runId,
      invokeId,
      workspaceRoot: cwd,
      command: LONG,
      signal: new AbortController().signal,
      shell: SHELL,
      blockUntilMs: 0
    })
    return sessionIdOf(frame)
  }

  it('keeps a live process past its turn and lets a later turn of the run own it', async () => {
    const id = await startLong('run-k', 1)
    let changes = 0
    const off = onKeptTerminalSessionsChanged(() => changes++)
    const kept = keepLiveTerminalSessionsForInvoke('run-k', 1)
    off()
    expect(kept.map((k) => k.id)).toEqual([id])
    expect(changes).toBe(1)
    expect(listKeptTerminalSessions(cwd).map((k) => k.id)).toEqual([id])

    // The next turn (invoke 2) can poll it; another run cannot.
    const polled = await pollTerminalSession({
      runId: 'run-k',
      invokeId: 2,
      sessionId: id,
      blockUntilMs: 0,
      signal: new AbortController().signal
    })
    expect(polled).toContain(id)
    await expect(
      pollTerminalSession({ runId: 'other', invokeId: 2, sessionId: id, blockUntilMs: 0, signal: new AbortController().signal })
    ).rejects.toThrow(/does not belong/)

    // Cancelling a later turn does not take it down.
    disposeTerminalSessionsForInvoke('run-k', 2)
    expect(listKeptTerminalSessions(cwd)).toHaveLength(1)

    expect(stopKeptTerminalSession(id)).toBe(true)
    expect(listKeptTerminalSessions(cwd)).toHaveLength(0)
  }, 20_000)

  it('the agent can stop its own session with kill', async () => {
    const id = await startLong('run-x', 1)
    const frame = killTerminalSession({ runId: 'run-x', invokeId: 1, sessionId: id })
    expect(frame).toMatch(/status:\s*aborted/)
    expect(frame).toMatch(/exit_code:\s*-?\d+\s*$/)
    expect(() => killTerminalSession({ runId: 'run-x', invokeId: 1, sessionId: id })).toThrow(/Unknown terminal session_id/)
  }, 20_000)

  it('deleting the task stops what it kept', async () => {
    await startLong('run-d', 1)
    keepLiveTerminalSessionsForInvoke('run-d', 1)
    expect(disposeTerminalSessionsForRun('run-d')).toBe(1)
    expect(listKeptTerminalSessions(cwd)).toHaveLength(0)
  }, 20_000)

  it('writes input to a waiting process', async () => {
    cwd ||= mkdtempSync(join(tmpdir(), 'vyotiq-kept-'))
    writeFileSync(
      join(cwd, 'ask.js'),
      "process.stdin.once('data', (d) => { console.log('got:' + String(d).trim()); process.exit(0) })"
    )
    const signal = new AbortController().signal
    const frame = await startBackgroundTerminal({
      runId: 'run-i',
      invokeId: 1,
      workspaceRoot: cwd,
      command: 'node ask.js',
      signal,
      shell: SHELL,
      blockUntilMs: 300
    })
    const id = sessionIdOf(frame)
    writeTerminalSessionInput({ runId: 'run-i', invokeId: 1, sessionId: id, input: 'yes' })
    const after = await pollTerminalSession({ runId: 'run-i', invokeId: 1, sessionId: id, blockUntilMs: 10_000, signal })
    expect(after).toMatch(/got:yes/)
  }, 30_000)
})
