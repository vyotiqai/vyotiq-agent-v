import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  atomicWriteJson,
  atomicWriteJsonAsync,
  atomicWriteFileAsync,
  atomicWriteBufferAsync,
  isTransientRenameError,
  renameSyncWithRetry,
  renameWithRetry,
  syncRenameWorstCaseDelayMs
} from '@main/storage/atomicWrite'

function eperm(): NodeJS.ErrnoException {
  const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException
  err.code = 'EPERM'
  err.errno = -4048
  err.syscall = 'rename'
  return err
}

describe('atomicWrite Windows rename retry', () => {
  it('treats EPERM/EACCES/EBUSY as transient', () => {
    expect(isTransientRenameError(Object.assign(new Error('x'), { code: 'EPERM' }))).toBe(true)
    expect(isTransientRenameError(Object.assign(new Error('x'), { code: 'EACCES' }))).toBe(true)
    expect(isTransientRenameError(Object.assign(new Error('x'), { code: 'EBUSY' }))).toBe(true)
    expect(isTransientRenameError(Object.assign(new Error('x'), { code: 'ENOENT' }))).toBe(false)
    expect(isTransientRenameError(new Error('disk full'))).toBe(false)
  })

  it('renameWithRetry succeeds after transient EPERM on Windows', async () => {
    const renameFn = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(eperm())
      .mockResolvedValueOnce(undefined)
    const sleepFn = vi.fn<(ms: number) => Promise<void>>().mockResolvedValue(undefined)

    await renameWithRetry('a.tmp', 'a', {
      isWindows: true,
      delaysMs: [1, 2],
      renameFn,
      sleepFn
    })

    expect(renameFn).toHaveBeenCalledTimes(2)
    expect(sleepFn).toHaveBeenCalledWith(1)
  })

  it('renameWithRetry does not retry non-transient errors', async () => {
    const renameFn = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error('disk full'))
    const sleepFn = vi.fn()

    await expect(
      renameWithRetry('a.tmp', 'a', {
        isWindows: true,
        delaysMs: [1],
        renameFn,
        sleepFn
      })
    ).rejects.toThrow('disk full')
    expect(renameFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  it('renameWithRetry does not retry on non-Windows even for EPERM', async () => {
    const renameFn = vi
      .fn<(from: string, to: string) => Promise<void>>()
      .mockRejectedValueOnce(eperm())
    const sleepFn = vi.fn()

    await expect(
      renameWithRetry('a.tmp', 'a', {
        isWindows: false,
        delaysMs: [1],
        renameFn,
        sleepFn
      })
    ).rejects.toMatchObject({ code: 'EPERM' })
    expect(renameFn).toHaveBeenCalledTimes(1)
    expect(sleepFn).not.toHaveBeenCalled()
  })

  it('renameSyncWithRetry succeeds after EPERM on Windows', () => {
    const renameSyncFn = vi
      .fn<(from: string, to: string) => void>()
      .mockImplementationOnce(() => {
        throw eperm()
      })
      .mockImplementationOnce(() => undefined)
    const sleepSyncFn = vi.fn()

    renameSyncWithRetry('a.tmp', 'a', {
      isWindows: true,
      delaysMs: [1],
      renameSyncFn,
      sleepSyncFn
    })

    expect(renameSyncFn).toHaveBeenCalledTimes(2)
    expect(sleepSyncFn).toHaveBeenCalledWith(1)
  })

  it('keeps the synchronous rename ladder short enough not to freeze the UI', () => {
    // sleepSync parks the whole main thread, and per-step checkpoints write
    // several times per agent step — the old 385ms ladder made those retries
    // (the common path under Windows AV contention) a visible, repeated freeze.
    expect(syncRenameWorstCaseDelayMs()).toBeLessThanOrEqual(20)
  })

  it('renameSyncWithRetry defaults to the short ladder, not the async one', () => {
    const renameSyncFn = vi
      .fn<(from: string, to: string) => void>()
      .mockImplementation(() => {
        throw eperm()
      })
    const sleepSyncFn = vi.fn()

    expect(() =>
      renameSyncWithRetry('a.tmp', 'a', { isWindows: true, renameSyncFn, sleepSyncFn })
    ).toThrow()
    // One attempt per delay + a final attempt.
    expect(renameSyncFn).toHaveBeenCalledTimes(6)
    const total = sleepSyncFn.mock.calls.reduce((sum, [ms]) => sum + (ms as number), 0)
    expect(total).toBe(syncRenameWorstCaseDelayMs())
  })

  it('atomicWriteJson / async round-trip with unique tmp cleanup', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-write-'))
    try {
      const target = join(dir, 'status.json')
      atomicWriteJson(target, { status: 'running', step: 0 })
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ status: 'running', step: 0 })
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])

      await atomicWriteJsonAsync(target, { status: 'done', step: 3 })
      expect(JSON.parse(readFileSync(target, 'utf8'))).toMatchObject({ status: 'done', step: 3 })
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('async text and binary writers replace targets without temp leftovers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-write-'))
    try {
      const textPath = join(dir, 'note.txt')
      const binaryPath = join(dir, 'data.bin')
      await atomicWriteFileAsync(textPath, 'hello\r\n')
      await atomicWriteBufferAsync(binaryPath, Buffer.from([0, 1, 255]))
      expect(readFileSync(textPath, 'utf8')).toBe('hello\r\n')
      expect(readFileSync(binaryPath)).toEqual(Buffer.from([0, 1, 255]))
      expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs an atomic-write guard before writing and replacing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-atomic-write-'))
    try {
      const guard = vi.fn()
      await atomicWriteBufferAsync(join(dir, 'guarded.bin'), Buffer.from([1, 2, 3]), 0o644, guard)
      expect(guard).toHaveBeenCalledTimes(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
