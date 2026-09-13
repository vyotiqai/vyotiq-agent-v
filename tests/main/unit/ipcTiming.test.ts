import { describe, expect, it, vi } from 'vitest'
import {
  resetIpcTimingForTests,
  timeSyncIpc,
  wrapIpcInvokeListener
} from '@main/perf/ipcTiming'
import type { IpcMainInvokeEvent } from 'electron'

describe('ipcTiming', () => {
  it('logs start and end around an invoke listener', async () => {
    resetIpcTimingForTests()
    const lines: string[] = []
    const listener = wrapIpcInvokeListener(
      'slash-commands:list',
      async () => {
        await new Promise((r) => setTimeout(r, 5))
        return { ok: true }
      },
      (line) => lines.push(line)
    )
    const result = await listener({} as IpcMainInvokeEvent)
    expect(result).toEqual({ ok: true })
    expect(lines[0]).toMatch(/^\[vyotiq-perf\] ipc:start slash-commands:list #\d+$/)
    expect(lines[1]).toMatch(/^\[vyotiq-perf\] ipc:end slash-commands:list #\d+ \d+\.\d+ms$/)
  })

  it('still logs end when the listener throws', async () => {
    resetIpcTimingForTests()
    const lines: string[] = []
    const listener = wrapIpcInvokeListener(
      'bad',
      async () => {
        throw new Error('boom')
      },
      (line) => lines.push(line)
    )
    await expect(listener({} as IpcMainInvokeEvent)).rejects.toThrow('boom')
    expect(lines[0]).toContain('ipc:start bad')
    expect(lines[1]).toContain('ipc:end bad')
  })

  it('times sync handlers when VYOTIQ_PERF is enabled', () => {
    resetIpcTimingForTests()
    const prev = process.env.VYOTIQ_PERF
    process.env.VYOTIQ_PERF = '1'
    try {
      const lines: string[] = []
      timeSyncIpc(
        'workspaces:update-ui-state-sync',
        () => {
          // no-op
        },
        (line) => lines.push(line)
      )
      expect(lines).toHaveLength(2)
      expect(lines[0]).toContain('ipc:start workspaces:update-ui-state-sync')
      expect(lines[1]).toContain('ipc:end workspaces:update-ui-state-sync')
    } finally {
      if (prev === undefined) delete process.env.VYOTIQ_PERF
      else process.env.VYOTIQ_PERF = prev
    }
  })

  it('does not log sync handlers when VYOTIQ_PERF is unset', () => {
    resetIpcTimingForTests()
    const prev = process.env.VYOTIQ_PERF
    delete process.env.VYOTIQ_PERF
    try {
      const lines: string[] = []
      let ran = false
      timeSyncIpc(
        'workspaces:update-ui-state-sync',
        () => {
          ran = true
        },
        (line) => lines.push(line)
      )
      expect(ran).toBe(true)
      expect(lines).toEqual([])
    } finally {
      if (prev === undefined) delete process.env.VYOTIQ_PERF
      else process.env.VYOTIQ_PERF = prev
    }
  })
})
