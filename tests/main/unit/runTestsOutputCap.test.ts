import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ ...DEFAULT_SETTINGS }) }))

const { runSafeCommand } = vi.hoisted(() => ({ runSafeCommand: vi.fn() }))
vi.mock('@main/agent/tools/diagnostics', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  runSafeCommand
}))

import { toolRunTestsAsync } from '@main/agent/tools/runTests'
import { TERMINAL_MAX_OUTPUT } from '@main/agent/tools/terminal'

describe('run_tests output cap', () => {
  it('keeps a chatty run within the terminal cap, header and summary intact', async () => {
    const noise = 'x'.repeat(200) + '\n'
    runSafeCommand.mockResolvedValue({
      stdout: `start\n${noise.repeat(1500)}Tests  2 failed | 18 passed\n`,
      stderr: '',
      exitCode: 1,
      killed: false
    })
    const result = await toolRunTestsAsync(
      process.cwd(),
      { command: 'vitest run' },
      new AbortController().signal
    )
    expect(result.content.length).toBeLessThan(TERMINAL_MAX_OUTPUT + 200)
    expect(result.content).toContain('Tests: 18 passed, 2 failed (exit 1)')
    expect(result.content).toContain('chars truncated')
    expect(result.content.trimEnd().endsWith('Tests  2 failed | 18 passed')).toBe(true)
  })

  it('leaves normal output untouched', async () => {
    runSafeCommand.mockResolvedValue({
      stdout: 'Tests  3 passed\n',
      stderr: '',
      exitCode: 0,
      killed: false
    })
    const result = await toolRunTestsAsync(
      process.cwd(),
      { command: 'vitest run' },
      new AbortController().signal
    )
    expect(result.content).toBe('command: vitest run\nTests: 3 passed, 0 failed (exit 0)\n\nTests  3 passed')
  })
})
