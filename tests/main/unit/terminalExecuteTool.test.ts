import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { resetTerminalSessionsForTests } from '@main/agent/tools/terminalSessions'

/**
 * End-to-end terminal coverage through executeTool: schema coercion,
 * foreground runs, and the background session_id lifecycle. Uses only
 * commands that exist on every platform shell (echo / node -e).
 */
describe('executeTool terminal', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-terminal-exec-'))
    toolTodoWrite(workspace, [{ id: '1', content: 'Run the shell command', status: 'in_progress' }])
  })

  function termCtx(extra: { runId?: string; invokeId?: number } = {}) {
    return { runDir: workspace, agentMode: 'agent' as const, ...extra }
  }

  afterEach(async () => {
    resetTerminalSessionsForTests()
    // tree-kill is async — give long-running children a beat to exit before rm.
    await new Promise((r) => setTimeout(r, 400))
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (workspace && existsSync(workspace)) rmSync(workspace, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  })

  it('runs a foreground command and reports exit code', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo vyotiq-terminal-ok' }),
      workspace,
      new AbortController().signal,
      termCtx()
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('vyotiq-terminal-ok')
    expect(result.content).toContain('exit_code: 0')
  })

  it('caps captured output at TERMINAL_MAX_OUTPUT with a truncation notice', async () => {
    // Dump ~10 MB of stdout — far past the 64 KB per-stream capture cap.
    const result = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'node -e "process.stdout.write(\'x\'.repeat(10 * 1024 * 1024))"'
      }),
      workspace,
      new AbortController().signal,
      termCtx()
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('[truncated] output exceeded')
    // Framing + capped stdout must stay bounded (64 KB cap + cwd/shell/exit lines).
    expect(result.content.length).toBeLessThan(80 * 1024)
    expect(result.content).toContain('exit_code: 0')
  }, 30_000)

  it('timeoutMs wait expiry keeps the process alive for polling (does not kill)', async () => {
    const signal = new AbortController().signal
    const context = termCtx({ runId: 'term-run-timeout-keep', invokeId: 1 })
    const started = await executeTool(
      'terminal',
      JSON.stringify({
        command:
          "node -e \"setTimeout(() => { console.log('vyotiq-late-done'); process.exit(0) }, 1500)\"",
        timeoutMs: 200
      }),
      workspace,
      signal,
      context
    )
    expect(started.ok).toBe(true)
    expect(started.content).toMatch(/status: timeout/)
    expect(started.content).not.toMatch(/Command timed out after/i)
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()

    const polled = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 10_000 }),
      workspace,
      signal,
      context
    )
    expect(polled.ok).toBe(true)
    expect(polled.content).toContain('vyotiq-late-done')
    expect(polled.content).toMatch(/status: done/)
    expect(polled.content).toContain('exit_code: 0')
  }, 20_000)

  it('dispatches negative block_until_ms without a schema gate', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo hi', block_until_ms: -5 }),
      workspace,
      new AbortController().signal,
      termCtx({ runId: 'term-run-neg', invokeId: 1 })
    )
    expect(result).toBeDefined()
  })

  it('background sessions require run ownership', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({ command: 'echo bg', block_until_ms: 0 }),
      workspace,
      new AbortController().signal,
      termCtx()
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/run ownership/i)
  })

  it('starts a background session and polls it to completion', async () => {
    const signal = new AbortController().signal
    const context = termCtx({ runId: 'term-run-1', invokeId: 1 })

    const started = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'node -e "console.log(\'vyotiq-bg-done\')"',
        block_until_ms: 0
      }),
      workspace,
      signal,
      context
    )
    expect(started.ok).toBe(true)
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()
    expect(started.content).toMatch(/status: (running|done|pattern_matched)/)

    const polled = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 10_000 }),
      workspace,
      signal,
      context
    )
    expect(polled.ok).toBe(true)
    expect(polled.content).toContain('vyotiq-bg-done')
    expect(polled.content).toContain('status: done')
    expect(polled.content).toContain('exit_code: 0')
    expect(polled.summary).toContain('node -e')
    expect(polled.summary).not.toMatch(/^[0-9a-f-]{36}$/)
  }, 20_000)

  it('poll with a pattern returns early on match', async () => {
    const signal = new AbortController().signal
    const context = termCtx({ runId: 'term-run-2', invokeId: 2 })

    const started = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'node -e "console.log(\'vyotiq-marker\'); setInterval(() => {}, 1000)"',
        block_until_ms: 0
      }),
      workspace,
      signal,
      context
    )
    expect(started.ok).toBe(true)
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()

    const polled = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 10_000, pattern: 'vyotiq-marker' }),
      workspace,
      signal,
      context
    )
    expect(polled.content).toContain('status: pattern_matched')
    expect(polled.content).toContain('vyotiq-marker')
  }, 20_000)

  it('rejects a session poll owned by a different run', async () => {
    const signal = new AbortController().signal
    const started = await executeTool(
      'terminal',
      JSON.stringify({ command: 'node -e "setInterval(() => {}, 1000)"', block_until_ms: 0 }),
      workspace,
      signal,
      termCtx({ runId: 'term-run-3', invokeId: 3 })
    )
    const sessionId = started.content.match(/session_id: ([0-9a-f-]{36})/)?.[1]
    expect(sessionId).toBeTruthy()

    const foreign = await executeTool(
      'terminal',
      JSON.stringify({ session_id: sessionId, block_until_ms: 0 }),
      workspace,
      signal,
      termCtx({ runId: 'someone-else', invokeId: 9 })
    )
    expect(foreign.ok).toBe(false)
    expect(foreign.content).toMatch(/does not belong to run/i)
  }, 20_000)

  it('runs command when session_id is also set, including invented UUIDs', async () => {
    const result = await executeTool(
      'terminal',
      JSON.stringify({
        command: 'echo hi',
        session_id: 'e8b8f89f-1b26-4c5b-a1dd-a93800d05fbb',
        pattern: ''
      }),
      workspace,
      new AbortController().signal,
      termCtx()
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/hi/)
    expect(result.content).not.toMatch(/command or session_id, not both/i)
  }, 20_000)

  it('new command with block_until_ms and timeoutMs waits the larger, not 1s', async () => {
    const signal = new AbortController().signal
    const context = termCtx({ runId: 'term-run-wait-larger', invokeId: 4 })
    const startedAt = Date.now()
    const result = await executeTool(
      'terminal',
      JSON.stringify({
        command:
          "node -e \"setTimeout(() => { console.log('vyotiq-wait-larger'); process.exit(0) }, 250)\"",
        block_until_ms: 50,
        timeoutMs: 8_000
      }),
      workspace,
      signal,
      context
    )
    const elapsed = Date.now() - startedAt
    expect(result.ok).toBe(true)
    expect(result.content).toContain('vyotiq-wait-larger')
    expect(result.content).toMatch(/status: done/)
    expect(elapsed).toBeGreaterThan(200)
  }, 20_000)
})
