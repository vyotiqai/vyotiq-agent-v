import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const { renameMock } = vi.hoisted(() => ({
  renameMock: vi.fn<typeof import('fs/promises').rename>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  renameMock.mockImplementation(actual.rename)
  return {
    ...actual,
    rename: renameMock
  }
})

import {
  enqueueStatusPatch,
  flushStatusWrites,
  pendingPatchForTests,
  resetStatusWriteQueueForTests,
  writeStatusImmediate
} from '@main/agent/statusWriteQueue'

describe('statusWriteQueue', () => {
  let dir: string

  beforeEach(() => {
    resetStatusWriteQueueForTests()
    renameMock.mockClear()
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-status-'))
    writeFileSync(
      join(dir, 'status.json'),
      JSON.stringify({ status: 'running', step: 0, updatedAt: new Date().toISOString() }, null, 2),
      'utf8'
    )
    vi.useFakeTimers()
  })

  afterEach(() => {
    resetStatusWriteQueueForTests()
    vi.useRealTimers()
  })

  it('coalesces step ticks behind the debounce window', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    enqueueStatusPatch(dir, { step: 2, status: 'running' })
    const beforeFlush = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      step: number
    }
    expect(beforeFlush.step).toBe(0)

    await flushStatusWrites(dir)

    const afterSteps = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(afterSteps.step).toBe(2)

    enqueueStatusPatch(dir, { error: 'tool failed' })
    const beforeDebounce = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      error?: string
    }
    expect(beforeDebounce.error).toBeUndefined()

    await vi.advanceTimersByTimeAsync(250)
    await flushStatusWrites(dir)

    const afterDebounce = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      error?: string
    }
    expect(afterDebounce.error).toBe('tool failed')
  })

  it('flushes mode patches immediately', async () => {
    enqueueStatusPatch(dir, { mode: 'plan' })
    // Mode must not sit behind the 250ms coalesce timer (resume reads status.mode).
    await flushStatusWrites(dir)

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      mode?: string
    }
    expect(after.mode).toBe('plan')
  })

  it('flushes terminal status immediately', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    enqueueStatusPatch(dir, { status: 'done' })

    await flushStatusWrites(dir)

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as {
      step: number
      status: string
    }
    expect(after.status).toBe('done')
    expect(after.step).toBe(1)
    expect(existsSync(join(dir, 'status.json'))).toBe(true)
  })

  it('re-merges patch when flush fails', async () => {
    renameMock.mockRejectedValueOnce(new Error('disk full'))

    enqueueStatusPatch(dir, { goal: 'updated goal' })
    await expect(flushStatusWrites(dir)).rejects.toThrow('disk full')
    expect(pendingPatchForTests(dir)).toMatchObject({ goal: 'updated goal' })

    await flushStatusWrites(dir)
    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { goal?: string }
    expect(after.goal).toBe('updated goal')
  })

  it('re-arms a bounded retry after a failed flush', async () => {
    renameMock.mockRejectedValueOnce(new Error('locked'))
    enqueueStatusPatch(dir, { goal: 'keep me' })
    await expect(flushStatusWrites(dir)).rejects.toThrow('locked')
    expect(pendingPatchForTests(dir)).toMatchObject({ goal: 'keep me' })

    await vi.advanceTimersByTimeAsync(250)
    await flushStatusWrites(dir)

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { goal?: string }
    expect(after.goal).toBe('keep me')
    expect(pendingPatchForTests(dir)).toEqual({})
  })

  it('serializes writeStatusImmediate through the async chain', async () => {
    enqueueStatusPatch(dir, { step: 1, status: 'running' })
    const flushPromise = flushStatusWrites(dir)

    await writeStatusImmediate(
      dir,
      { step: 2, status: 'running' },
      (path, next) => writeFileSync(path, JSON.stringify(next, null, 2), 'utf8'),
      (path) => JSON.parse(readFileSync(path, 'utf8')) as { status: 'running'; step: number; updatedAt: string }
    )
    await flushPromise

    const after = JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as { step: number }
    expect(after.step).toBe(2)
  })
})
