import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import {
  enqueueEventAppend,
  EVENTS_FILE_KEEP_BYTES,
  EVENTS_FILE_MAX_BYTES,
  flushEventAppends,
  resetEventAppendQueueForTests,
  takeEventAppendFailureNotice
} from '@main/agent/eventAppendQueue'

const { appendFileMock, unlinkMock } = vi.hoisted(() => ({
  appendFileMock: vi.fn<typeof import('fs/promises').appendFile>(),
  unlinkMock: vi.fn<typeof import('fs/promises').unlink>()
}))

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>()
  appendFileMock.mockImplementation(actual.appendFile)
  unlinkMock.mockImplementation(actual.unlink)
  return {
    ...actual,
    appendFile: appendFileMock,
    unlink: unlinkMock
  }
})

describe('eventAppendQueue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-event-append-'))
    mkdirSync(dir, { recursive: true })
    resetEventAppendQueueForTests()
    appendFileMock.mockClear()
    unlinkMock.mockClear()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    resetEventAppendQueueForTests()
  })

  it('appends events asynchronously in order', async () => {
    const path = join(dir, 'events.jsonl')
    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    enqueueEventAppend(dir, { type: 'status', status: 'done' })
    await flushEventAppends(dir)

    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[0]!).event).toMatchObject({ type: 'status', status: 'running' })
    expect(JSON.parse(lines[1]!).event).toMatchObject({ type: 'status', status: 'done' })
  })

  it('flushEventAppends surfaces append failures', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('append failed'))

    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    await expect(flushEventAppends(dir)).rejects.toThrow('append failed')
  })

  it('exposes the first mid-run append failure as a consumable notice', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('disk full'))

    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    await flushEventAppends(dir).catch(() => undefined)

    const notice = takeEventAppendFailureNotice(dir)
    expect(notice?.message).toBe('disk full')
    expect(takeEventAppendFailureNotice(dir)).toBeUndefined()
  })

  it('flushEventAppends awaits in-flight appends without blocking the main thread', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const actualAppend = appendFileMock.getMockImplementation()
    appendFileMock.mockImplementationOnce(async (...args: Parameters<typeof appendFileMock>) => {
      await gate
      return actualAppend!(...args)
    })

    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    const pending = flushEventAppends(dir)
    let flushed = false
    void pending.then(() => {
      flushed = true
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(flushed).toBe(false)

    release()
    await pending
    const path = join(dir, 'events.jsonl')
    const lines = readFileSync(path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).event).toMatchObject({ type: 'status', status: 'running' })
  })

  it('archives discarded head on rotation and keeps the active tail', async () => {
    const path = join(dir, 'events.jsonl')
    const headLine = `${JSON.stringify({ at: 'old', event: { type: 'status', status: 'head-marker' } })}\n`
    const tailLine = `${JSON.stringify({ at: 'new', event: { type: 'status', status: 'tail-marker' } })}\n`
    const middlePad = `${'x\n'.repeat(EVENTS_FILE_MAX_BYTES / 2)}`
    writeFileSync(path, headLine + middlePad + tailLine, 'utf8')

    enqueueEventAppend(dir, { type: 'status', status: 'rotated' })
    await flushEventAppends(dir)

    const archives = readdirSync(dir).filter((name) => name.startsWith('events.archive.'))
    expect(archives).toHaveLength(1)
    const archived = readFileSync(join(dir, archives[0]!), 'utf8')
    expect(archived).toContain('head-marker')

    const active = readFileSync(path, 'utf8')
    expect(active).toContain('tail-marker')
    expect(active).toContain('rotated')
    expect(active).not.toContain('head-marker')
  })

  it('caps archives at five files and deletes the oldest when creating a sixth', async () => {
    const path = join(dir, 'events.jsonl')
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `events.archive.2026-01-0${i + 1}T00-00-00-000Z.jsonl`), `archive-${i}\n`, 'utf8')
    }
    const line = `${'y'.repeat(80)}\n`
    writeFileSync(
      path,
      line.repeat(Math.ceil((EVENTS_FILE_MAX_BYTES + 64) / line.length)),
      'utf8'
    )

    enqueueEventAppend(dir, { type: 'status', status: 'cap-test' })
    await flushEventAppends(dir)

    const archives = readdirSync(dir)
      .filter((name) => name.startsWith('events.archive.'))
      .sort()
    expect(archives).toHaveLength(5)
    expect(archives.some((name) => name.includes('2026-01-01'))).toBe(false)
    const newestArchive = readFileSync(join(dir, archives[archives.length - 1]!), 'utf8')
    expect(newestArchive).toContain('y'.repeat(64))
  })

  it('skips an undeletable oldest archive instead of failing the append chain', async () => {
    const path = join(dir, 'events.jsonl')
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, `events.archive.2026-01-0${i + 1}T00-00-00-000Z.jsonl`), `archive-${i}\n`, 'utf8')
    }
    const line = `${'y'.repeat(80)}\n`
    writeFileSync(
      path,
      line.repeat(Math.ceil((EVENTS_FILE_MAX_BYTES + 64) / line.length)),
      'utf8'
    )

    // Non-transient (EPERM is absent from TRANSIENT_APPEND_ERROR_CODES), so
    // withTransientAppendRetry cannot mask the missing guard: pre-fix this
    // rejection fails the append chain on the first attempt.
    unlinkMock.mockRejectedValueOnce(Object.assign(new Error('operation not permitted'), { code: 'EPERM' }))

    enqueueEventAppend(dir, { type: 'status', status: 'undeletable-archive' })
    await expect(flushEventAppends(dir)).resolves.toBeUndefined()
    expect(takeEventAppendFailureNotice(dir)).toBeUndefined()

    const active = readFileSync(path, 'utf8')
    expect(active).toContain('undeletable-archive')
    const archives = readdirSync(dir)
      .filter((name) => name.startsWith('events.archive.'))
      .sort()
    // The undeletable oldest archive survives; the new one is still created.
    expect(archives).toHaveLength(6)
    expect(archives.some((name) => name.includes('2026-01-01'))).toBe(true)
  })

  it('keeps the JSONL record that crosses the rotation byte boundary', async () => {
    const path = join(dir, 'events.jsonl')
    const marker = `${JSON.stringify({ at: 'boundary', event: { id: 'MUST_KEEP' } })}\n`
    const prefix = 'C'.repeat(EVENTS_FILE_MAX_BYTES - EVENTS_FILE_KEEP_BYTES + 50)
    const suffix = 'D'.repeat(EVENTS_FILE_KEEP_BYTES - 10)
    writeFileSync(path, prefix + marker + suffix, 'utf8')
    expect(readFileSync(path, 'utf8').length).toBeGreaterThan(EVENTS_FILE_MAX_BYTES)

    enqueueEventAppend(dir, { type: 'status', status: 'after-rotate' })
    await flushEventAppends(dir)

    const archives = readdirSync(dir).filter((name) => name.startsWith('events.archive.'))
    const archived = archives.map((name) => readFileSync(join(dir, name), 'utf8')).join('')
    const active = readFileSync(path, 'utf8')
    expect(archived + active).toContain('MUST_KEEP')
    expect(active).toContain('after-rotate')
  })

  it('keeps UTF-8 JSONL records valid across a rotation boundary', async () => {
    const path = join(dir, 'events.jsonl')
    const unicodeLine = `${JSON.stringify({ at: 'unicode', event: { type: 'status', text: '界'.repeat(512) } })}\n`
    const bytesPerLine = Buffer.byteLength(unicodeLine, 'utf8')
    const prefix = unicodeLine.repeat(Math.ceil((EVENTS_FILE_MAX_BYTES - EVENTS_FILE_KEEP_BYTES) / bytesPerLine) + 1)
    const suffix = unicodeLine.repeat(Math.ceil(EVENTS_FILE_KEEP_BYTES / bytesPerLine) + 1)
    writeFileSync(path, prefix + suffix, 'utf8')

    enqueueEventAppend(dir, { type: 'status', status: 'after-utf8-rotate' })
    await flushEventAppends(dir)

    const files = [
      ...readdirSync(dir)
        .filter((name) => name.startsWith('events.archive.'))
        .map((name) => join(dir, name)),
      path
    ]
    for (const file of files) {
      for (const line of readFileSync(file, 'utf8').trim().split('\n')) {
        expect(() => JSON.parse(line)).not.toThrow()
      }
    }
  })

  it('retries a transient (EBUSY) append failure before persisting', async () => {
    appendFileMock.mockImplementationOnce(async () => {
      throw Object.assign(new Error('resource busy'), { code: 'EBUSY' })
    })

    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    await flushEventAppends(dir)

    expect(takeEventAppendFailureNotice(dir)).toBeUndefined()
    const lines = readFileSync(join(dir, 'events.jsonl'), 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!).event).toMatchObject({ type: 'status', status: 'running' })
  })

  it('does not retry a non-transient (no error code) failure', async () => {
    appendFileMock.mockRejectedValueOnce(new Error('disk full'))

    enqueueEventAppend(dir, { type: 'status', status: 'running' })
    await expect(flushEventAppends(dir)).rejects.toThrow('disk full')
    expect(appendFileMock.mock.calls.length).toBe(1)
  })

  it('surfaces an aggregated notice when several appends fail mid-run', async () => {
    appendFileMock
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))
      .mockRejectedValueOnce(new Error('disk full'))

    enqueueEventAppend(dir, { type: 'a' })
    enqueueEventAppend(dir, { type: 'b' })
    enqueueEventAppend(dir, { type: 'c' })
    await flushEventAppends(dir).catch(() => undefined)

    const notice = takeEventAppendFailureNotice(dir)
    expect(notice?.message).toContain('3 record(s) failed to persist to events.jsonl')
    expect(notice?.message).toContain('disk full')
    // Second read is empty until a new batch of failures occurs.
    expect(takeEventAppendFailureNotice(dir)).toBeUndefined()
  })
})
