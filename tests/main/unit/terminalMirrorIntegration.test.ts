import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ ...DEFAULT_SETTINGS })
}))

import { executeTool } from '@main/agent/tools'
import { toolTodoWrite } from '@main/agent/tools/todo'
import { resetTerminalSessionsForTests } from '@main/agent/tools/terminalSessions'
import { setTerminalMirrorSink } from '@main/agent/tools/terminalMirrorSink'

/**
 * The mirror must be a pure observer.
 *
 * The agent's own commands keep running through child_process.spawn because the
 * frame the model reads needs separate stdout/stderr and a real exit code, so
 * the contract worth protecting is: whatever is mirrored, `result.content` is
 * byte-identical to a run with no sink attached.
 */
describe('terminal mirroring does not change what the model reads', () => {
  let workspace: string
  let mirrored: string[]

  function termCtx() {
    return { runDir: workspace, agentMode: 'agent' as const }
  }

  async function run(command: string) {
    return executeTool(
      'terminal',
      JSON.stringify({ command }),
      workspace,
      new AbortController().signal,
      termCtx()
    )
  }

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-mirror-int-'))
    toolTodoWrite(workspace, [
      { id: '1', content: 'Run the shell command', status: 'in_progress' }
    ])
    mirrored = []
  })

  afterEach(async () => {
    setTerminalMirrorSink(null)
    resetTerminalSessionsForTests()
    await new Promise((r) => setTimeout(r, 400))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        if (workspace && existsSync(workspace)) {
          rmSync(workspace, { recursive: true, force: true })
        }
        break
      } catch {
        await new Promise((r) => setTimeout(r, 400))
      }
    }
  })

  it('produces an identical frame with and without a sink attached', async () => {
    const withoutSink = await run('echo vyotiq-mirror-probe')

    setTerminalMirrorSink((_ws, text) => mirrored.push(text))
    const withSink = await run('echo vyotiq-mirror-probe')

    expect(withSink.ok).toBe(withoutSink.ok)
    expect(withSink.content).toBe(withoutSink.content)
    expect(withSink.content).toContain('exit_code: 0')
  }, 30_000)

  it('mirrors the command, its output and the exit code the model was given', async () => {
    setTerminalMirrorSink((_ws, text) => mirrored.push(text))
    const result = await run('echo vyotiq-mirror-probe')

    const text = mirrored.join('')
    expect(text).toContain('echo vyotiq-mirror-probe')
    expect(text).toContain('vyotiq-mirror-probe')
    expect(text).toContain('exit 0')
    expect(result.content).toContain('exit_code: 0')
  }, 30_000)

  it('keeps the frame intact when the sink throws', async () => {
    const clean = await run('echo vyotiq-mirror-probe')

    setTerminalMirrorSink(() => {
      throw new Error('sink exploded')
    })
    const result = await run('echo vyotiq-mirror-probe')

    expect(result.ok).toBe(true)
    expect(result.content).toBe(clean.content)
  }, 30_000)

  it('mirrors a non-zero exit with the same code the model sees', async () => {
    setTerminalMirrorSink((_ws, text) => mirrored.push(text))
    const result = await run('node -e "process.exit(3)"')

    expect(result.content).toContain('exit_code: 3')
    expect(mirrored.join('')).toContain('exit 3')
  }, 30_000)

  it('runs unchanged when no sink is registered at all', async () => {
    const result = await run('echo vyotiq-no-sink')
    expect(result.ok).toBe(true)
    expect(result.content).toContain('vyotiq-no-sink')
    expect(mirrored).toEqual([])
  }, 30_000)
})
