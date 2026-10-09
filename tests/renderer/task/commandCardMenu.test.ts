/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { commandMenuItems } from '@renderer/features/task/record/WorkItems'
import {
  requestRunInTerminal,
  resetTerminalRunRequestsForTests,
  takeTerminalRunRequest
} from '@renderer/features/chat/terminalRequests'

afterEach(() => resetTerminalRunRequestsForTests())

describe('command card menu', () => {
  it('copies the command and the output, and runs it in your terminal', () => {
    const writeClipboard = vi.fn(() => true)
    window.vyotiq = { writeClipboard } as unknown as typeof window.vyotiq
    const onRun = vi.fn()
    const items = commandMenuItems({ command: 'pnpm test', output: 'ok 3 passed', canRun: true, onRun })
    expect(items.map((i) => ('label' in i ? i.label : ''))).toEqual(['Copy command', 'Copy output', 'Run in my terminal'])
    ;(items[0] as { onSelect: () => void }).onSelect()
    expect(writeClipboard).toHaveBeenLastCalledWith('pnpm test')
    ;(items[1] as { onSelect: () => void }).onSelect()
    expect(writeClipboard).toHaveBeenLastCalledWith('ok 3 passed')
    ;(items[2] as { onSelect: () => void }).onSelect()
    expect(onRun).toHaveBeenCalledOnce()
  })

  it('leaves out Copy output with no output, and Run while it runs', () => {
    const items = commandMenuItems({ command: 'sleep 9', output: '  ', canRun: false, onRun: vi.fn() })
    expect(items.map((i) => ('label' in i ? i.label : ''))).toEqual(['Copy command'])
  })
})

describe('terminal run requests', () => {
  it('hands the request to that workspace’s terminal once', () => {
    requestRunInTerminal('C:\\ws', 'pnpm test')
    expect(takeTerminalRunRequest('C:\\other')).toBeNull()
    expect(takeTerminalRunRequest('C:\\ws')).toMatchObject({ command: 'pnpm test' })
    expect(takeTerminalRunRequest('C:\\ws')).toBeNull()
  })
})
