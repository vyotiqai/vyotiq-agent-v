import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  countTerminalSessionsGlobalForTests,
  disposeAllTerminalSessions,
  resetTerminalSessionsForTests,
  startBackgroundTerminal
} from '@main/agent/tools/terminalSessions'

// Keep in sync with MAX_BACKGROUND_TERMINALS_GLOBAL (asserted below): the
// app-wide ceiling on concurrent live background shells.
const GLOBAL_CAP = 24

/** Long-lived shell that stays running for the duration of the test. */
const LONG = process.platform === 'win32' ? 'ping -n 60 127.0.0.1 > nul' : 'sleep 60'

describe('terminalSessions app-wide concurrency ceiling', () => {
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

  it('refuses a spawn under a fresh run/invoke once the app-wide budget is full', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-global-'))
    const signal = new AbortController().signal

    // Every session gets its own run id AND invoke id, so the per-invoke cap
    // (8) never fires — only an app-wide ceiling can refuse these.
    for (let i = 0; i < GLOBAL_CAP; i++) {
      const started = await startBackgroundTerminal({
        runId: `run-global-${i}`,
        invokeId: i,
        workspaceRoot: cwd,
        command: LONG,
        signal,
        shell: process.platform === 'win32' ? 'cmd' : 'auto',
        blockUntilMs: 0
      })
      expect(started).toMatch(/session_id:/)
    }
    expect(countTerminalSessionsGlobalForTests()).toBe(GLOBAL_CAP)

    const refused = await startBackgroundTerminal({
      runId: 'run-global-over',
      invokeId: 999,
      workspaceRoot: cwd,
      command: LONG,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 0
    })

    expect(refused).toMatch(/exit_code: 1/)
    // The refusal names the app-wide limit, not the per-invoke one.
    expect(refused).toMatch(/app-wide/i)
    expect(refused).toContain(`limit ${GLOBAL_CAP}`)
    expect(refused).not.toMatch(/for this invoke/)
    expect(refused).not.toMatch(/session_id:/)
    // No shell was actually spawned for the refused call.
    expect(countTerminalSessionsGlobalForTests()).toBe(GLOBAL_CAP)
  }, 60_000)

  it('lets a new spawn through once the app-wide budget is released', async () => {
    cwd = mkdtempSync(join(tmpdir(), 'vyotiq-term-global-drain-'))
    const signal = new AbortController().signal

    for (let i = 0; i < GLOBAL_CAP; i++) {
      await startBackgroundTerminal({
        runId: `run-drain-${i}`,
        invokeId: i,
        workspaceRoot: cwd,
        command: LONG,
        signal,
        shell: process.platform === 'win32' ? 'cmd' : 'auto',
        blockUntilMs: 0
      })
    }
    disposeAllTerminalSessions()
    expect(countTerminalSessionsGlobalForTests()).toBe(0)

    // Refusal must be clean: freeing the budget lets the next run spawn again.
    const after = await startBackgroundTerminal({
      runId: 'run-drain-after',
      invokeId: 1,
      workspaceRoot: cwd,
      command: LONG,
      signal,
      shell: process.platform === 'win32' ? 'cmd' : 'auto',
      blockUntilMs: 0
    })
    expect(after).toMatch(/session_id:/)
    expect(after).not.toMatch(/Too many concurrent background terminal sessions/)
  }, 60_000)
})