import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { RunStatus } from '@shared/ipc'
import {
  abandonStatus,
  flushStatus,
  onListVisibleStatusChange,
  patchStatus,
  readStatus,
  resetStatusForTests,
  reviveStatus
} from '@main/harness/store/status'

let root: string
let dir: string

const base: RunStatus = {
  status: 'running',
  step: 0,
  updatedAt: '2026-01-01T00:00:00.000Z',
  goal: 'g',
  workspacePath: '/ws'
}

function onDisk(): RunStatus {
  return JSON.parse(readFileSync(join(dir, 'status.json'), 'utf8')) as RunStatus
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vy-status-'))
  dir = join(root, 'run')
  mkdirSync(dir)
  writeFileSync(join(dir, 'status.json'), JSON.stringify(base))
  resetStatusForTests()
})

afterEach(() => {
  resetStatusForTests()
  vi.useRealTimers()
  rmSync(root, { recursive: true, force: true })
})

describe('status.json', () => {
  it('reads null for a missing or invalid document', () => {
    expect(readStatus(join(root, 'none'))).toBeNull()
    writeFileSync(join(dir, 'status.json'), '{"status":"weird"}')
    expect(readStatus(dir)).toBeNull()
  })

  it('coalesces step ticks and writes them once', async () => {
    void patchStatus(dir, { step: 1 })
    void patchStatus(dir, { step: 2 })
    expect(onDisk().step).toBe(0)
    await flushStatus(dir)
    expect(onDisk().step).toBe(2)
  })

  it('writes terminal statuses and mode switches at once', async () => {
    await patchStatus(dir, { status: 'done' })
    expect(onDisk().status).toBe('done')
    await patchStatus(dir, { mode: 'ask' })
    expect(onDisk().mode).toBe('ask')
  })

  it('removes a key patched to undefined', async () => {
    await patchStatus(dir, { error: 'boom' }, { now: true })
    expect(onDisk().error).toBe('boom')
    await patchStatus(dir, { error: undefined }, { now: true })
    expect('error' in onDisk()).toBe(false)
  })

  it('tells listeners about list-visible changes only', async () => {
    const heard = vi.fn()
    onListVisibleStatusChange(heard)
    await patchStatus(dir, { step: 3 }, { now: true })
    expect(heard).not.toHaveBeenCalled()
    await patchStatus(dir, { status: 'error', error: 'x' })
    expect(heard).toHaveBeenCalledWith('/ws')
  })

  it('never recreates a run directory that is gone', async () => {
    rmSync(dir, { recursive: true, force: true })
    await patchStatus(dir, { status: 'done' })
    expect(existsSync(dir)).toBe(false)
  })

  it('ignores patches for an abandoned (deleted) run until revived', async () => {
    abandonStatus(dir)
    await patchStatus(dir, { status: 'done' })
    expect(onDisk().status).toBe('running')
    reviveStatus(dir)
    await patchStatus(dir, { status: 'done' })
    expect(onDisk().status).toBe('done')
  })

  it('keeps a failed patch and lands it on the next flush', async () => {
    // A directory in the way of the rename makes the write fail.
    rmSync(join(dir, 'status.json'))
    mkdirSync(join(dir, 'status.json'))
    void patchStatus(dir, { step: 7 })
    await expect(flushStatus(dir)).rejects.toThrow()
    rmSync(join(dir, 'status.json'), { recursive: true, force: true })
    await flushStatus(dir)
    expect(onDisk().step).toBe(7)
  })
})
