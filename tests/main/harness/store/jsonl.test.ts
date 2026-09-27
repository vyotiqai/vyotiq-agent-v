import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const fsCalls = vi.hoisted(() => ({ appends: 0, failNext: [] as string[] }))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  return {
    ...actual,
    appendFile: async (...args: Parameters<typeof actual.appendFile>) => {
      fsCalls.appends++
      const code = fsCalls.failNext.shift()
      if (code) throw Object.assign(new Error(`${code}: simulated`), { code })
      return actual.appendFile(...args)
    }
  }
})

import {
  appendLine,
  onStorageLost,
  resetJsonlForTests,
  runSerialized,
  settled,
  takeFailure
} from '@main/harness/store/jsonl'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'vy-jsonl-'))
  fsCalls.appends = 0
  fsCalls.failNext = []
  resetJsonlForTests()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('jsonl appender', () => {
  it('writes lines in the order they were queued', async () => {
    const path = join(dir, 'a.jsonl')
    await Promise.all(Array.from({ length: 50 }, (_, i) => appendLine(path, `${i}\n`)))
    expect(readFileSync(path, 'utf8')).toBe(Array.from({ length: 50 }, (_, i) => `${i}\n`).join(''))
  })

  it('batches lines queued while a write is in flight into one append', async () => {
    const path = join(dir, 'b.jsonl')
    const writes = Array.from({ length: 100 }, (_, i) => appendLine(path, `${i}\n`))
    await Promise.all(writes)
    // The first line starts a write; the other 99 are queued behind it and go out together.
    expect(fsCalls.appends).toBe(2)
    expect(readFileSync(path, 'utf8').split('\n').filter(Boolean)).toHaveLength(100)
  })

  it('runs a serialized task after earlier appends and before later ones', async () => {
    const path = join(dir, 'c.jsonl')
    void appendLine(path, 'first\n')
    const task = runSerialized(path, async () => {
      expect(readFileSync(path, 'utf8')).toBe('first\n')
      writeFileSync(path, 'rewritten\n')
    })
    void appendLine(path, 'after\n')
    await task
    await settled(path)
    expect(readFileSync(path, 'utf8')).toBe('rewritten\nafter\n')
  })

  it('rejects a serialized task that throws without breaking later appends', async () => {
    const path = join(dir, 'd.jsonl')
    await expect(runSerialized(path, async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await appendLine(path, 'ok\n')
    expect(readFileSync(path, 'utf8')).toBe('ok\n')
  })

  it('retries transient errors without recording a failure', async () => {
    const path = join(dir, 'e.jsonl')
    fsCalls.failNext = ['EBUSY', 'EAGAIN']
    await appendLine(path, 'line\n')
    expect(readFileSync(path, 'utf8')).toBe('line\n')
    expect(takeFailure(path)).toBeUndefined()
  })

  it('records a permanent failure for the owner to take, once', async () => {
    const path = join(dir, 'f.jsonl')
    fsCalls.failNext = ['ENOSPC']
    await appendLine(path, 'lost\n')
    await appendLine(path, 'kept\n')
    expect(readFileSync(path, 'utf8')).toBe('kept\n')
    const failure = takeFailure(path)
    expect(failure?.message).toMatch(/^1 record failed to persist to f\.jsonl: ENOSPC/)
    expect(takeFailure(path)).toBeUndefined()
  })

  it('settled() waits for pending writes and never throws', async () => {
    const path = join(dir, 'g.jsonl')
    fsCalls.failNext = ['ENOSPC']
    void appendLine(path, 'x\n')
    await expect(settled(path)).resolves.toBeUndefined()
    expect(takeFailure(path)).toBeDefined()
  })

  it('treats a vanished directory as lost storage and tells the owner', async () => {
    const runDir = join(dir, 'run')
    const handler = vi.fn()
    const unsubscribe = onStorageLost(runDir, handler)
    await appendLine(join(runDir, 'events.jsonl'), 'x\n')
    expect(handler).toHaveBeenCalledTimes(1)
    // A late subscriber hears about it immediately.
    const late = vi.fn()
    onStorageLost(runDir, late)
    expect(late).toHaveBeenCalledTimes(1)
    unsubscribe()
    expect(takeFailure(join(runDir, 'events.jsonl'))).toBeDefined()
  })
})
