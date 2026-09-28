import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  pollTerminalSession,
  resetTerminalSessionsForTests,
  startBackgroundTerminal
} from '@main/agent/tools/terminalSessions'

/**
 * A soft steer (follow-up message) ends a terminal wait but must not kill the
 * session — only the run's hard cancel does. The tool signal carries both, so
 * a session that listened on it died after it had already been handed back to
 * the model as still running.
 */
const LONG = 'node -e "setTimeout(()=>{},20000)"'
let ws: string | undefined

afterEach(async () => {
  resetTerminalSessionsForTests()
  // tree-kill is async and a live session holds its cwd — retry the rm under load.
  for (let attempt = 0; attempt < 5 && ws; attempt++) {
    await new Promise((r) => setTimeout(r, 400))
    try {
      rmSync(ws, { recursive: true, force: true })
      ws = undefined
    } catch {
      // still held; try again
    }
  }
  ws = undefined
}, 30_000)

function signals(): { run: AbortController; soft: AbortController; tool: AbortSignal } {
  const run = new AbortController()
  const soft = new AbortController()
  return { run, soft, tool: AbortSignal.any([run.signal, soft.signal]) }
}

function sessionIdOf(frame: string): string {
  return /session_id: (\S+)/.exec(frame)![1]!
}

describe('background terminal vs soft steer', () => {
  it('survives a soft abort that lands after the start call returned', async () => {
    ws = mkdtempSync(join(tmpdir(), 'vyotiq-term-steer-'))
    const { run, soft, tool } = signals()
    const started = await startBackgroundTerminal({
      runId: 'r', invokeId: 1, workspaceRoot: ws, command: LONG,
      signal: tool, runSignal: run.signal, blockUntilMs: 1500
    })
    expect(started).toMatch(/status: timeout/)
    soft.abort()
    const polled = await pollTerminalSession({
      runId: 'r', invokeId: 1, sessionId: sessionIdOf(started), blockUntilMs: 0,
      signal: new AbortController().signal, runSignal: run.signal
    })
    expect(polled).toMatch(/status: running/)
  }, 30_000)

  it('a soft steer during a foreground wait returns the live session instead of killing it', async () => {
    ws = mkdtempSync(join(tmpdir(), 'vyotiq-term-steer-'))
    const { run, soft, tool } = signals()
    setTimeout(() => soft.abort(), 1000)
    const started = await startBackgroundTerminal({
      runId: 'r', invokeId: 1, workspaceRoot: ws, command: LONG,
      signal: tool, runSignal: run.signal, blockUntilMs: 15_000, killOnTimeout: true
    })
    expect(started).not.toMatch(/exit_code: 124/)
    const polled = await pollTerminalSession({
      runId: 'r', invokeId: 1, sessionId: sessionIdOf(started), blockUntilMs: 0,
      signal: new AbortController().signal, runSignal: run.signal
    })
    expect(polled).toMatch(/status: running/)
  }, 30_000)

  it('the hard run cancel still kills it', async () => {
    ws = mkdtempSync(join(tmpdir(), 'vyotiq-term-steer-'))
    const { run, tool } = signals()
    const started = await startBackgroundTerminal({
      runId: 'r', invokeId: 1, workspaceRoot: ws, command: LONG,
      signal: tool, runSignal: run.signal, blockUntilMs: 1500
    })
    run.abort()
    const polled = await pollTerminalSession({
      runId: 'r', invokeId: 1, sessionId: sessionIdOf(started), blockUntilMs: 0,
      signal: new AbortController().signal, runSignal: run.signal
    })
    expect(polled).toMatch(/status: aborted/)
  }, 30_000)
})
